import type { HumanizeConfig } from '../humanize/typing.js';
import type { DB } from '../memory/db.js';
import type { BotSettings } from '../pipeline/bot.js';
import type { RuntimeSettings } from '../config/runtime.js';

/**
 * Admin-only reads for the dashboard. Like leakIndex.ts, these cross chat
 * boundaries, so their results must NEVER be passed into a prompt. Per-chat
 * detail views go through ChatMemory.
 */

export interface ChatSummaryRow {
    jid: string;
    name: string | null;
    isGroup: boolean;
    lastSeen: number;
    pausedUntil: number;
    flowState: string | null;
    messageCount: number;
    lastText: string | null;
    lastDirection: 'in' | 'out' | null;
    /** Latest purchase alert in this chat, if any. */
    salesStage: 'interested' | 'agreed' | null;
    salesAt: number | null;
}

export function listChats(db: DB, search = '', limit = 200): ChatSummaryRow[] {
    const like = `%${search.replace(/[%_]/g, '')}%`;
    return db
        .prepare(
            `SELECT c.jid, c.name, c.is_group AS isGroup, c.last_seen AS lastSeen,
                    c.paused_until AS pausedUntil, c.flow_state AS flowState,
                    (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS messageCount,
                    (SELECT text FROM messages m WHERE m.chat_jid = c.jid ORDER BY id DESC LIMIT 1) AS lastText,
                    (SELECT direction FROM messages m WHERE m.chat_jid = c.jid ORDER BY id DESC LIMIT 1) AS lastDirection,
                    (SELECT stage FROM sales_events e WHERE e.chat_jid = c.jid ORDER BY created_at DESC LIMIT 1) AS salesStage,
                    (SELECT MAX(created_at) FROM sales_events e WHERE e.chat_jid = c.jid) AS salesAt
             FROM chats c
             WHERE c.jid LIKE @like OR IFNULL(c.name, '') LIKE @like
             ORDER BY c.last_seen DESC
             LIMIT @limit`,
        )
        .all({ like, limit })
        .map((r) => {
            const row = r as Omit<ChatSummaryRow, 'isGroup'> & {
                isGroup: number;
            };
            return { ...row, isGroup: !!row.isGroup };
        });
}

export interface Stats {
    chats: number;
    messagesToday: number;
    repliesToday: number;
    pausedChats: number;
    /** Owner alerts today: customer wants to buy. */
    interestedToday: number;
    /** Owner alerts today: customer agreed to buy. */
    agreedToday: number;
    kbDocuments: number;
    kbChunks: number;
}

export function getStats(db: DB, now = Date.now()): Stats {
    const one = (sql: string, ...args: unknown[]) =>
        (db.prepare(sql).get(...args) as { n: number }).n;
    // Today's counts come from stats_daily (kept by triggers), not full scans.
    const today = db
        .prepare(
            `SELECT kind, n FROM stats_daily
             WHERE day = date(? / 1000, 'unixepoch', 'localtime')`,
        )
        .all(now) as { kind: string; n: number }[];
    const count = (kind: string) => today.find((r) => r.kind === kind)?.n ?? 0;
    return {
        chats: one(`SELECT COUNT(*) AS n FROM chats`),
        messagesToday: count('msg_in'),
        repliesToday: count('msg_out'),
        pausedChats: one(
            `SELECT COUNT(*) AS n FROM chats WHERE paused_until > ?`,
            now,
        ),
        interestedToday: count('sale_interested'),
        agreedToday: count('sale_agreed'),
        kbDocuments: one(`SELECT COUNT(*) AS n FROM kb_documents`),
        kbChunks: one(`SELECT COUNT(*) AS n FROM kb_chunks`),
    };
}

export interface KbDocumentRow {
    path: string;
    chunks: number;
    ingestedAt: number;
}

export function listKnowledge(db: DB): KbDocumentRow[] {
    return db
        .prepare(
            `SELECT d.path, d.ingested_at AS ingestedAt,
                    (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunks
             FROM kb_documents d ORDER BY d.path`,
        )
        .all() as KbDocumentRow[];
}

export interface RuntimeTargets {
    llm: {
        setOptions(p: { chatModel?: string; temperature?: number }): void;
    };
    sender: { humanize: boolean; typing: HumanizeConfig };
    bot: BotSettings;
}

/** Pushes settings into the live objects; takes effect on the next turn. */
export function applyRuntimeSettings(
    s: RuntimeSettings,
    t: RuntimeTargets,
): void {
    t.llm.setOptions({ chatModel: s.chatModel, temperature: s.temperature });

    t.sender.humanize = s.humanize;
    Object.assign(t.sender.typing, {
        cpsMin: s.typingCpsMin,
        cpsMax: s.typingCpsMax,
        firstReplyMinMs: s.firstReplyMinSec * 1000,
        firstReplyMaxMs: s.firstReplyMaxSec * 1000,
        pauseChance: s.typingPauseChance,
        distractionChance: s.distractionChance,
    } satisfies HumanizeConfig);

    Object.assign(t.bot, {
        replyInGroups: s.replyInGroups,
        historyMessages: s.historyMessages,
        ragTopK: s.ragTopK,
        ragMaxDistance: s.ragMaxDistance,
        imageResendHours: s.imageResendHours,
    } satisfies Partial<BotSettings>);
    t.bot.firstReply = {
        minMs: s.firstReplyMinSec * 1000,
        maxMs: s.humanize ? s.firstReplyMaxSec * 1000 : 0,
        coldAfterMs: s.coldStartAfterMin * 60_000,
    };
}
