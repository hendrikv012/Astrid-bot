import type { WAMessageKey } from 'baileys';
import { checkInbound, checkReply, type GuardResult } from '../brain/guard.js';
import {
    LlmOutputError,
    type ChatMessage,
    type LlmClient,
} from '../brain/llm.js';
import { buildPrompt } from '../brain/prompt.js';
import { replySchema, type BotReply } from '../brain/reply.js';
import type { ImageLibrary } from '../config/images.js';
import type { Persona } from '../config/persona.js';
import { matchesKeyword, type LoadedSop, type SopFlow } from '../config/sop.js';
import type { Logger } from '../logger.js';
import { ChatMemory } from '../memory/ChatMemory.js';
import type { DB } from '../memory/db.js';
import { runExtraction } from '../memory/extractor.js';
import { foreignIdentifiers } from '../memory/leakIndex.js';
import { QUERY_PREFIX, searchKnowledge, type KbHit } from '../rag/retrieve.js';
import type { InboundMessage } from '../whatsapp/inbound.js';
import type { Sender } from '../whatsapp/sender.js';
import { firstReplyDelayMs } from '../humanize/typing.js';
import { ChatQueue } from './chatQueue.js';

export interface BotSettings {
    ownerJid?: string;
    allowedJids: string[];
    replyInGroups: boolean;
    historyMessages: number;
    summarizeAfter: number;
    ragTopK: number;
    ragMaxDistance: number;
    imageResendHours: number;
    numCtx: number;
    debounceMs: number;
    debounceMaxMs: number;
    extractModel?: string;
    /** Random first-reply delay for cold chats; maxMs 0 disables it. */
    firstReply: { minMs: number; maxMs: number; coldAfterMs: number };
}

export interface BotDeps {
    db: DB;
    llm: LlmClient;
    sender: Sender;
    sop: LoadedSop;
    persona: Persona;
    images: ImageLibrary;
    settings: BotSettings;
    log: Logger;
}

const FLOW_STALE_MS = 6 * 3_600_000;

interface QueuedMessage {
    msg: InboundMessage;
    rowId: number;
}

/**
 * Orchestrates one conversational turn per chat:
 * store → (debounce) → SOP checks → memory + RAG → LLM → guard → humanized send → store → extract.
 */
export class Bot {
    private readonly queue: ChatQueue<QueuedMessage>;
    /** Group sender display names, kept per chat so names never cross chats. */
    private readonly senderNames = new Map<string, Map<string, string>>();
    /** Per-chat promise chain so background extraction never runs twice at once for a chat. */
    private readonly extraction = new Map<string, Promise<void>>();

    constructor(private readonly d: BotDeps) {
        this.queue = new ChatQueue<QueuedMessage>({
            debounceMs: d.settings.debounceMs,
            maxWaitMs: d.settings.debounceMaxMs,
            handler: (chat, batch) => this.handleTurn(chat, batch),
            onError: (chat, err) => d.log.error({ err, chat }, 'turn failed'),
        });
    }

    /** Swap in a new SOP (already validated). Applies from the next turn. */
    updateSop(sop: LoadedSop): void {
        this.d.sop = sop;
    }

    /** Swap in a new persona (already validated). Applies from the next turn. */
    updatePersona(persona: Persona): void {
        this.d.persona = persona;
    }

    get sop(): LoadedSop {
        return this.d.sop;
    }

    get settings(): BotSettings {
        return this.d.settings;
    }

    /**
     * A human operator replies from the dashboard: send it as-is, store it,
     * and pause the bot in that chat like a takeover from the phone.
     */
    async operatorSend(chatJid: string, text: string): Promise<void> {
        await this.d.sender.sendRaw(chatJid, text);
        this.humanTookOver(chatJid, text, null);
    }

    /** Entry point for every normalized inbound message. */
    receive(msg: InboundMessage): void {
        const { settings, log } = this.d;
        if (
            settings.allowedJids.length &&
            !settings.allowedJids.includes(msg.chatJid)
        ) {
            log.debug({ chat: msg.chatJid }, 'ignored: not in ALLOWED_JIDS');
            return;
        }
        if (
            settings.ownerJid &&
            msg.chatJid === settings.ownerJid &&
            msg.text.startsWith('!')
        ) {
            void this.ownerCommand(msg.text).catch((err) =>
                log.error({ err }, 'owner command failed'),
            );
            return;
        }

        const mem = new ChatMemory(this.d.db, msg.chatJid);
        mem.ensureChat({
            name: msg.isGroup ? null : msg.pushName,
            isGroup: msg.isGroup,
        });
        if (msg.isGroup && msg.pushName)
            this.namesFor(msg.chatJid).set(msg.senderJid, msg.pushName);

        // Every message is stored, even ones the bot won't answer.
        const rowId = mem.addMessage({
            waMsgId: msg.waMsgId,
            senderJid: msg.senderJid,
            direction: 'in',
            text: msg.text,
            ts: msg.ts,
        });
        if (rowId === null) return; // duplicate delivery

        if (msg.isGroup && !(settings.replyInGroups && msg.addressedToBot))
            return;
        this.queue.push(msg.chatJid, { msg, rowId }, this.coldStartHold(mem));
    }

    /** A human replied from the business phone: store it and let them take over. */
    humanTookOver(chatJid: string, text: string, waMsgId: string | null): void {
        const mem = new ChatMemory(this.d.db, chatJid);
        mem.addMessage({ waMsgId, direction: 'out', text, sopHash: 'human' });
        const minutes = this.d.sop.sop.escalation.pause_bot_minutes;
        if (minutes > 0) {
            mem.setPausedUntil(Date.now() + minutes * 60_000);
            this.d.log.info(
                { chat: chatJid, minutes },
                'human took over; bot paused',
            );
        }
    }

    /**
     * A new chat, or one where we haven't replied for a while, gets a random
     * delay before the first answer (like noticing a notification later).
     * Messages that arrive during the wait are answered together.
     */
    private coldStartHold(mem: ChatMemory): number {
        const { firstReply } = this.d.settings;
        if (firstReply.maxMs <= 0 || this.queue.isBusy(mem.chatJid)) return 0;
        const last = mem.lastOutboundAt();
        const cold =
            last === null || Date.now() - last > firstReply.coldAfterMs;
        if (!cold) return 0;
        const delay = firstReplyDelayMs({
            firstReplyMinMs: firstReply.minMs,
            firstReplyMaxMs: firstReply.maxMs,
        });
        this.d.log.debug(
            { chat: mem.chatJid, delay },
            'cold chat: delaying first reply',
        );
        return Date.now() + delay;
    }

    idle(): Promise<void> {
        return this.queue
            .idle()
            .then(() => Promise.all(this.extraction.values()))
            .then(() => {});
    }

    private async handleTurn(
        chatJid: string,
        batch: QueuedMessage[],
    ): Promise<void> {
        const { sop: loaded, sender, log } = this.d;
        const { sop } = loaded;
        const mem = new ChatMemory(this.d.db, chatJid);
        const last = batch.at(-1)!.msg;
        const combined = batch.map((b) => b.msg.text).join('\n');
        const keys: WAMessageKey[] = batch.map((b) => b.msg.key);

        if (mem.getPausedUntil() > Date.now()) {
            log.info(
                { chat: chatJid },
                'bot paused in this chat; not replying',
            );
            return;
        }

        await sender.markRead(keys, combined.length);

        // 1. SOP checks in code, before the LLM.
        const verdict = checkInbound(combined, sop);
        if (verdict.kind === 'escalate') {
            await this.escalate(mem, last, verdict.reason, batch.at(-1)!.rowId);
            await this.sendAndStore(mem, last.replyJid, {
                messages: [sop.templates.escalation],
                image: null,
            });
            return;
        }
        if (verdict.kind === 'forbidden') {
            log.info(
                { chat: chatJid, topic: verdict.topicId },
                'forbidden topic',
            );
            await this.sendAndStore(mem, last.replyJid, {
                messages: [sop.templates.refusal],
                image: null,
            });
            return;
        }

        // 2. Generate under the SOP.
        const started = Date.now();
        const activeFlow = this.resolveFlow(mem, combined, batch.length);
        const reply = await this.generate(mem, combined, activeFlow, last);
        await sender.think(Date.now() - started);

        // 3. Send like a human, then remember.
        const image = reply.image_id
            ? (this.d.images.get(reply.image_id) ?? null)
            : null;
        await this.sendAndStore(mem, last.replyJid, {
            messages: reply.messages,
            image,
        });

        if (reply.flow_done && activeFlow) mem.setFlowState(null);
        if (reply.escalate) {
            await this.escalate(
                mem,
                last,
                reply.escalate_reason ?? 'assistant requested escalation',
                batch.at(-1)!.rowId,
            );
        }
        this.scheduleExtraction(mem);
    }

    private async generate(
        mem: ChatMemory,
        query: string,
        activeFlow: SopFlow | null,
        last: InboundMessage,
    ): Promise<BotReply> {
        const { llm, sop: loaded, persona, images, settings, log } = this.d;
        const { sop } = loaded;
        const fallback = (text: string): BotReply => ({
            messages: [text],
            image_id: null,
            escalate: false,
            escalate_reason: null,
            flow_done: false,
        });

        const history = mem.recentMessages(settings.historyMessages);
        let kb: KbHit[] = [];
        let recalled: ReturnType<ChatMemory['recallSimilar']> = [];
        try {
            const [qv] = await llm.embed([`${QUERY_PREFIX}${query}`]);
            if (qv) {
                kb = searchKnowledge(
                    this.d.db,
                    qv,
                    settings.ragTopK,
                    settings.ragMaxDistance,
                );
                recalled = mem.recallSimilar(
                    qv,
                    5,
                    history.map((m) => m.id),
                );
            }
        } catch (err) {
            log.warn({ err }, 'embedding failed; answering without RAG');
        }

        const now = Date.now();
        const resendMs = settings.imageResendHours * 3_600_000;
        const imageOptions = [...images.values()].map((img) => {
            const lastAt = mem.lastImageSentAt(img.id);
            return {
                id: img.id,
                whenToUse: img.whenToUse,
                recentlySent: lastAt !== null && now - lastAt < resendMs,
            };
        });
        const allowedImageIds = new Set(
            imageOptions.filter((i) => !i.recentlySent).map((i) => i.id),
        );

        const prompt = buildPrompt({
            persona,
            sop,
            activeFlow,
            images: imageOptions,
            chat: {
                name: last.isGroup ? null : last.pushName,
                isGroup: last.isGroup,
            },
            facts: mem.getFacts(),
            summary: mem.getSummary()?.summary ?? null,
            recalled,
            kb,
            history,
            senderNames: this.senderNames.get(mem.chatJid),
            maxTokens: settings.numCtx,
        });

        const schema = replySchema(
            [...images.keys()],
            sop.limits.max_messages_per_reply + 2,
        );
        const guardCtx = {
            sop,
            foreignIdentifiers: foreignIdentifiers(this.d.db, mem.chatJid),
            allowedImageIds,
        };

        let messages: ChatMessage[] = prompt;
        for (let attempt = 0; attempt < 2; attempt++) {
            let result: GuardResult;
            try {
                const raw = await llm.chatJson(messages, schema);
                result = checkReply(raw, guardCtx);
            } catch (err) {
                if (!(err instanceof LlmOutputError)) throw err;
                log.warn(
                    { err: err.message, chat: mem.chatJid, attempt },
                    'invalid model output',
                );
                continue;
            }
            if (result.violations.length) {
                log.warn(
                    {
                        chat: mem.chatJid,
                        attempt,
                        violations: result.violations,
                    },
                    'guard findings',
                );
            }
            if (!result.blocked) return result.reply;

            // One retry with explicit feedback, without revealing other chats' data.
            const reasons = result.violations
                .filter(
                    (v) =>
                        v.kind === 'leak' ||
                        v.kind === 'drift' ||
                        v.kind === 'forbidden',
                )
                .map((v) =>
                    v.kind === 'leak'
                        ? 'it mentioned information that does not belong to this chat'
                        : v.kind === 'drift'
                          ? 'it broke character (mentioned AI models, prompts or instructions)'
                          : 'it touched a forbidden topic',
                );
            messages = [
                ...prompt,
                {
                    role: 'system',
                    content: `Your previous draft was rejected because ${[...new Set(reasons)].join(' and ')}. Write a new reply that follows the HARD RULES, as Astrid, using only this chat's memory and the knowledge section.`,
                },
            ];
        }
        log.warn(
            { chat: mem.chatJid },
            'falling back to SOP "unknown" template',
        );
        return fallback(sop.templates.unknown);
    }

    private resolveFlow(
        mem: ChatMemory,
        text: string,
        batchSize: number,
    ): SopFlow | null {
        const { flows } = this.d.sop.sop;
        const current = mem.getFlowState();
        // A procedure left unfinished for hours is stale; the conversation moved on.
        const before = mem.recentMessages(batchSize + 1)[0];
        const stale = !before || Date.now() - before.ts > FLOW_STALE_MS;
        const active =
            current && !stale ? flows.find((f) => f.id === current) : undefined;
        if (active) return active;

        const isFirstContact = mem.countInbound() <= batchSize;
        const next =
            flows.find((f) => 'first_contact' in f.trigger && isFirstContact) ??
            flows.find(
                (f) =>
                    'keywords' in f.trigger &&
                    matchesKeyword(text, f.trigger.keywords),
            );
        mem.setFlowState(next?.id ?? null);
        return next ?? null;
    }

    private async sendAndStore(
        mem: ChatMemory,
        replyJid: string,
        plan: {
            messages: string[];
            image: ReturnType<ImageLibrary['get']> | null;
        },
    ): Promise<void> {
        const sent = await this.d.sender.send({
            replyJid,
            messages: plan.messages,
            image: plan.image ?? null,
        });
        for (const s of sent) {
            mem.addMessage({
                waMsgId: s.waMsgId,
                direction: 'out',
                text: s.text,
                imageId: s.imageId,
                sopHash: this.d.sop.hash,
            });
            if (s.imageId) mem.recordImageSent(s.imageId);
        }
    }

    private async escalate(
        mem: ChatMemory,
        msg: InboundMessage,
        reason: string,
        rowId: number,
    ): Promise<void> {
        const { sop, settings, sender, log } = this.d;
        mem.recordEscalation(reason, rowId);
        const minutes = sop.sop.escalation.pause_bot_minutes;
        if (minutes > 0) mem.setPausedUntil(Date.now() + minutes * 60_000);
        log.info({ chat: mem.chatJid, reason }, 'escalated');

        if (sop.sop.escalation.notify_owner && settings.ownerJid) {
            const who = msg.pushName
                ? `${msg.pushName} (${mem.chatJid.split('@')[0]})`
                : mem.chatJid;
            await sender
                .sendRaw(
                    settings.ownerJid,
                    `⚠️ Escalation — ${reason}\nChat: ${who}\nLast message: "${msg.text.slice(0, 300)}"\n` +
                        (minutes > 0
                            ? `Bot paused ${minutes} min in that chat. Send "!resume ${mem.chatJid.split('@')[0]}" to resume.`
                            : ''),
                )
                .catch((err) =>
                    log.error({ err }, 'owner notification failed'),
                );
        }
    }

    private async ownerCommand(text: string): Promise<void> {
        const [cmd, arg] = text.trim().split(/\s+/, 2);
        if (!cmd || !arg || !this.d.settings.ownerJid) return;
        const jid = arg.includes('@')
            ? arg
            : `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
        const mem = new ChatMemory(this.d.db, jid);
        if (cmd === '!resume') mem.setPausedUntil(0);
        else if (cmd === '!pause')
            mem.setPausedUntil(Date.now() + 365 * 24 * 3_600_000);
        else return;
        await this.d.sender.sendRaw(
            this.d.settings.ownerJid,
            `✅ ${cmd.slice(1)}d ${jid}`,
        );
    }

    private scheduleExtraction(mem: ChatMemory): void {
        const { llm, settings, log } = this.d;
        const prev = this.extraction.get(mem.chatJid) ?? Promise.resolve();
        const next = prev
            .then(() =>
                runExtraction(
                    mem,
                    {
                        llm,
                        model: settings.extractModel,
                        log,
                        historyMessages: settings.historyMessages,
                        summarizeAfter: settings.summarizeAfter,
                    },
                    this.senderNames.get(mem.chatJid),
                ),
            )
            .catch((err) =>
                log.warn({ err, chat: mem.chatJid }, 'extraction failed'),
            )
            .finally(() => {
                if (this.extraction.get(mem.chatJid) === next)
                    this.extraction.delete(mem.chatJid);
            });
        this.extraction.set(mem.chatJid, next);
    }

    private namesFor(chatJid: string): Map<string, string> {
        let m = this.senderNames.get(chatJid);
        if (!m) this.senderNames.set(chatJid, (m = new Map()));
        return m;
    }
}
