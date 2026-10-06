import { type DB, toVec, vecRowId } from './db.js';

export type Direction = 'in' | 'out';

export interface StoredMessage {
    id: number;
    waMsgId: string | null;
    senderJid: string | null;
    direction: Direction;
    text: string;
    imageId: string | null;
    ts: number;
    /** SOP version that produced a bot reply; 'human' for operator messages. */
    sopHash: string | null;
}

export interface Fact {
    id: number;
    subject: string;
    key: string;
    value: string;
    confidence: number;
    updatedAt: number;
}

export interface NewMessage {
    waMsgId?: string | null;
    senderJid?: string | null;
    direction: Direction;
    text: string;
    imageId?: string | null;
    ts?: number;
    sopHash?: string | null;
}

interface MessageRow {
    id: number;
    wa_msg_id: string | null;
    sender_jid: string | null;
    direction: Direction;
    text: string;
    image_id: string | null;
    ts: number;
    sop_hash: string | null;
}

const toMessage = (r: MessageRow): StoredMessage => ({
    id: r.id,
    waMsgId: r.wa_msg_id,
    senderJid: r.sender_jid,
    direction: r.direction,
    text: r.text,
    imageId: r.image_id,
    ts: r.ts,
    sopHash: r.sop_hash,
});

const MESSAGE_COLS =
    'id, wa_msg_id, sender_jid, direction, text, image_id, ts, sop_hash';

/**
 * All memory access for exactly ONE chat.
 *
 * Isolation guarantee: every query in this class is bound to `this.chatJid`.
 * There is intentionally no way to read another chat's messages, facts,
 * summary or vectors through this API. Code that builds prompts must only
 * ever receive a ChatMemory for the chat it is answering.
 */
export class ChatMemory {
    constructor(
        private readonly db: DB,
        readonly chatJid: string,
    ) {
        if (!chatJid) throw new Error('ChatMemory requires a chat JID');
    }

    ensureChat(
        opts: {
            name?: string | null;
            isGroup?: boolean;
            /** The JID WhatsApp used for this chat; replies are sent there. */
            replyJid?: string | null;
        } = {},
    ): void {
        const now = Date.now();
        this.db
            .prepare(
                `INSERT INTO chats (jid, name, is_group, first_seen, last_seen, reply_jid)
                 VALUES (@jid, @name, @isGroup, @now, @now, @replyJid)
                 ON CONFLICT (jid) DO UPDATE SET
                    last_seen = @now,
                    name = COALESCE(@name, chats.name),
                    reply_jid = COALESCE(@replyJid, chats.reply_jid)`,
            )
            .run({
                jid: this.chatJid,
                name: opts.name ?? null,
                isGroup: opts.isGroup ? 1 : 0,
                replyJid: opts.replyJid ?? null,
                now,
            });
    }

    /** Where to send messages for this chat (falls back to the memory key). */
    getReplyJid(): string {
        const row = this.db
            .prepare(`SELECT reply_jid FROM chats WHERE jid = ?`)
            .get(this.chatJid) as { reply_jid: string | null } | undefined;
        return row?.reply_jid ?? this.chatJid;
    }

    /** Returns the new row id, or null if this WhatsApp message was already stored. */
    addMessage(msg: NewMessage): number | null {
        this.ensureChat();
        const res = this.db
            .prepare(
                `INSERT OR IGNORE INTO messages
                    (chat_jid, wa_msg_id, sender_jid, direction, text, image_id, ts, sop_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                this.chatJid,
                msg.waMsgId ?? null,
                msg.senderJid ?? null,
                msg.direction,
                msg.text,
                msg.imageId ?? null,
                msg.ts ?? Date.now(),
                msg.sopHash ?? null,
            );
        return res.changes ? Number(res.lastInsertRowid) : null;
    }

    /** Most recent messages, oldest first. */
    recentMessages(limit: number): StoredMessage[] {
        const rows = this.db
            .prepare(
                `SELECT ${MESSAGE_COLS} FROM messages
                 WHERE chat_jid = ? ORDER BY id DESC LIMIT ?`,
            )
            .all(this.chatJid, limit) as MessageRow[];
        return rows.reverse().map(toMessage);
    }

    /** Messages with id > afterId, oldest first. */
    messagesAfter(afterId: number, limit = 1000): StoredMessage[] {
        const rows = this.db
            .prepare(
                `SELECT ${MESSAGE_COLS} FROM messages
                 WHERE chat_jid = ? AND id > ? ORDER BY id ASC LIMIT ?`,
            )
            .all(this.chatJid, afterId, limit) as MessageRow[];
        return rows.map(toMessage);
    }

    getMessagesByIds(ids: number[]): StoredMessage[] {
        if (ids.length === 0) return [];
        const rows = this.db
            .prepare(
                `SELECT ${MESSAGE_COLS} FROM messages
                 WHERE chat_jid = ? AND id IN (SELECT value FROM json_each(?))
                 ORDER BY id ASC`,
            )
            .all(this.chatJid, JSON.stringify(ids)) as MessageRow[];
        return rows.map(toMessage);
    }

    /** Timestamp of the last message sent to this chat (bot or human), or null. */
    lastOutboundAt(): number | null {
        const row = this.db
            .prepare(
                `SELECT MAX(ts) AS ts FROM messages WHERE chat_jid = ? AND direction = 'out'`,
            )
            .get(this.chatJid) as { ts: number | null };
        return row.ts;
    }

    countInbound(): number {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND direction = 'in'`,
            )
            .get(this.chatJid) as { n: number };
        return row.n;
    }

    getFacts(): Fact[] {
        return this.db
            .prepare(
                `SELECT id, subject, key, value, confidence, updated_at AS updatedAt
                 FROM facts WHERE chat_jid = ? ORDER BY subject, key`,
            )
            .all(this.chatJid) as Fact[];
    }

    upsertFact(fact: {
        subject?: string;
        key: string;
        value: string;
        confidence?: number;
        sourceMsgId?: number | null;
    }): void {
        this.ensureChat();
        this.db
            .prepare(
                `INSERT INTO facts (chat_jid, subject, key, value, confidence, source_msg_id, updated_at)
                 VALUES (@chat, @subject, @key, @value, @confidence, @source, @now)
                 ON CONFLICT (chat_jid, subject, key) DO UPDATE SET
                    value = excluded.value,
                    confidence = excluded.confidence,
                    source_msg_id = excluded.source_msg_id,
                    updated_at = excluded.updated_at`,
            )
            .run({
                chat: this.chatJid,
                subject: fact.subject ?? 'chat',
                key: fact.key,
                value: fact.value,
                confidence: fact.confidence ?? 1,
                source: this.ownMessageId(fact.sourceMsgId),
                now: Date.now(),
            });
    }

    deleteFact(subject: string, key: string): void {
        this.db
            .prepare(
                `DELETE FROM facts WHERE chat_jid = ? AND subject = ? AND key = ?`,
            )
            .run(this.chatJid, subject, key);
    }

    getSummary(): { summary: string; uptoMsgId: number } | null {
        const row = this.db
            .prepare(
                `SELECT summary, upto_msg_id AS uptoMsgId FROM summaries WHERE chat_jid = ?`,
            )
            .get(this.chatJid) as
            { summary: string; uptoMsgId: number } | undefined;
        return row ?? null;
    }

    setSummary(summary: string, uptoMsgId: number): void {
        this.ensureChat();
        this.db
            .prepare(
                `INSERT INTO summaries (chat_jid, summary, upto_msg_id, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (chat_jid) DO UPDATE SET
                    summary = excluded.summary,
                    upto_msg_id = excluded.upto_msg_id,
                    updated_at = excluded.updated_at`,
            )
            .run(this.chatJid, summary, uptoMsgId, Date.now());
    }

    getFlowState(): string | null {
        const row = this.db
            .prepare(`SELECT flow_state FROM chats WHERE jid = ?`)
            .get(this.chatJid) as { flow_state: string | null } | undefined;
        return row?.flow_state ?? null;
    }

    setFlowState(state: string | null): void {
        this.ensureChat();
        this.db
            .prepare(`UPDATE chats SET flow_state = ? WHERE jid = ?`)
            .run(state, this.chatJid);
    }

    getExtractedUpto(): number {
        const row = this.db
            .prepare(`SELECT extracted_upto FROM chats WHERE jid = ?`)
            .get(this.chatJid) as { extracted_upto: number } | undefined;
        return row?.extracted_upto ?? 0;
    }

    setExtractedUpto(msgId: number): void {
        this.db
            .prepare(`UPDATE chats SET extracted_upto = ? WHERE jid = ?`)
            .run(msgId, this.chatJid);
    }

    /** Bot stays silent in this chat until this time (human takeover or manual pause). */
    getPausedUntil(): number {
        const row = this.db
            .prepare(`SELECT paused_until FROM chats WHERE jid = ?`)
            .get(this.chatJid) as { paused_until: number } | undefined;
        return row?.paused_until ?? 0;
    }

    setPausedUntil(at: number): void {
        this.ensureChat();
        this.db
            .prepare(`UPDATE chats SET paused_until = ? WHERE jid = ?`)
            .run(at, this.chatJid);
    }

    recordImageSent(imageId: string, at = Date.now()): void {
        this.ensureChat();
        this.db
            .prepare(
                `INSERT INTO images_sent (chat_jid, image_id, sent_at) VALUES (?, ?, ?)`,
            )
            .run(this.chatJid, imageId, at);
    }

    lastImageSentAt(imageId: string): number | null {
        const row = this.db
            .prepare(
                `SELECT MAX(sent_at) AS at FROM images_sent WHERE chat_jid = ? AND image_id = ?`,
            )
            .get(this.chatJid, imageId) as { at: number | null };
        return row.at;
    }

    recordSalesEvent(
        stage: 'interested' | 'agreed',
        summary: string | null,
        msgId: number | null,
        at = Date.now(),
    ): void {
        this.ensureChat();
        this.db
            .prepare(
                `INSERT INTO sales_events (chat_jid, stage, summary, msg_id, created_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(this.chatJid, stage, summary, this.ownMessageId(msgId), at);
    }

    /** Latest time the owner was alerted for any of `stages` in this chat, or null. */
    lastSalesEventAt(stages: ('interested' | 'agreed')[]): number | null {
        const row = this.db
            .prepare(
                `SELECT MAX(created_at) AS at FROM sales_events
                 WHERE chat_jid = ? AND stage IN (SELECT value FROM json_each(?))`,
            )
            .get(this.chatJid, JSON.stringify(stages)) as { at: number | null };
        return row.at;
    }

    /** Messages of this chat that still need a vector embedding. */
    unembeddedMessages(limit = 50): StoredMessage[] {
        const rows = this.db
            .prepare(
                `SELECT ${MESSAGE_COLS} FROM messages
                 WHERE chat_jid = ? AND embedded = 0 AND text != ''
                 ORDER BY id ASC LIMIT ?`,
            )
            .all(this.chatJid, limit) as MessageRow[];
        return rows.map(toMessage);
    }

    storeMessageEmbedding(msgId: number, embedding: number[]): void {
        if (this.ownMessageId(msgId) === null) {
            throw new Error(`Message ${msgId} does not belong to this chat`);
        }
        this.db.transaction(() => {
            this.db
                .prepare(`DELETE FROM vec_messages WHERE rowid = ?`)
                .run(vecRowId(msgId));
            this.db
                .prepare(
                    `INSERT INTO vec_messages (rowid, chat_jid, embedding) VALUES (?, ?, ?)`,
                )
                .run(vecRowId(msgId), this.chatJid, toVec(embedding));
            this.db
                .prepare(`UPDATE messages SET embedded = 1 WHERE id = ?`)
                .run(msgId);
        })();
    }

    /** Semantically similar older messages from THIS chat only. */
    recallSimilar(
        embedding: number[],
        k: number,
        excludeIds: number[] = [],
    ): StoredMessage[] {
        const rows = this.db
            .prepare(
                `SELECT rowid AS id FROM vec_messages
                 WHERE embedding MATCH ? AND k = ? AND chat_jid = ?
                 ORDER BY distance`,
            )
            .all(toVec(embedding), k + excludeIds.length, this.chatJid) as {
            id: number;
        }[];
        const exclude = new Set(excludeIds);
        const ids = rows
            .map((r) => Number(r.id))
            .filter((id) => !exclude.has(id))
            .slice(0, k);
        // Re-read through the chat-bound query as a second isolation check.
        return this.getMessagesByIds(ids);
    }

    /** Returns id if the message belongs to this chat, else null. */
    private ownMessageId(id: number | null | undefined): number | null {
        if (id == null) return null;
        const row = this.db
            .prepare(`SELECT id FROM messages WHERE id = ? AND chat_jid = ?`)
            .get(id, this.chatJid) as { id: number } | undefined;
        return row ? row.id : null;
    }
}
