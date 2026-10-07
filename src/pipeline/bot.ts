import type { WAMessageKey } from 'baileys';
import {
    checkInbound,
    checkReply,
    detectPurchaseKeywords,
    type GuardResult,
} from '../brain/guard.js';
import {
    LlmOutputError,
    type ChatMessage,
    type LlmClient,
} from '../brain/llm.js';
import { detectLanguage, LANGUAGE_NAMES } from '../brain/language.js';
import { buildPrompt } from '../brain/prompt.js';
import {
    maxStage,
    replySchema,
    type BotReply,
    type PurchaseStage,
} from '../brain/reply.js';
import type { ImageLibrary, PreloadedImage } from '../config/images.js';
import type { Persona } from '../config/persona.js';
import { matchesKeyword, type LoadedSop, type SopFlow } from '../config/sop.js';
import type { Logger } from '../logger.js';
import { ChatMemory } from '../memory/ChatMemory.js';
import type { DB } from '../memory/db.js';
import { runExtraction } from '../memory/extractor.js';
import { LeakIndex } from '../memory/leakIndex.js';
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

/** One consistent SOP + persona for a whole turn, even if the dashboard swaps them mid-turn. */
interface TurnConfig {
    sop: LoadedSop;
    persona: Persona;
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
    /** Other customers' identifiers for the privacy check (cached, never prompted). */
    private readonly leakIndex: LeakIndex;

    constructor(private readonly d: BotDeps) {
        this.leakIndex = new LeakIndex(d.db);
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
        // Send to the address WhatsApp uses for this chat (may be a LID), not the memory key.
        const replyJid = new ChatMemory(this.d.db, chatJid).getReplyJid();
        await this.d.sender.sendRaw(replyJid, text);
        this.humanTookOver(chatJid, text, null);
    }

    /** Entry point for every normalized inbound message. */
    receive(msg: InboundMessage): void {
        const { settings, log } = this.d;
        const from = { chat: msg.chatJid, name: msg.pushName };
        if (
            settings.allowedJids.length &&
            !settings.allowedJids.includes(msg.chatJid)
        ) {
            log.info(
                { ...from, allowed: settings.allowedJids },
                'message ignored: sender not in ALLOWED_JIDS',
            );
            return;
        }
        if (
            settings.ownerJid &&
            msg.chatJid === settings.ownerJid &&
            msg.text.startsWith('!')
        ) {
            log.info(from, 'owner command received');
            void this.ownerCommand(msg.text).catch((err) =>
                log.error({ err }, 'owner command failed'),
            );
            return;
        }

        const mem = new ChatMemory(this.d.db, msg.chatJid);
        mem.ensureChat({
            name: msg.isGroup ? null : msg.pushName,
            isGroup: msg.isGroup,
            replyJid: msg.replyJid,
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

        if (msg.isGroup && !(settings.replyInGroups && msg.addressedToBot)) {
            log.info(from, 'group message stored; not replying in groups');
            return;
        }
        const holdUntil = this.coldStartHold(mem);
        log.info(
            holdUntil
                ? {
                      ...from,
                      firstReplyInSec: Math.round(
                          (holdUntil - Date.now()) / 1000,
                      ),
                  }
                : from,
            holdUntil
                ? 'message received; new chat, waiting before the first reply'
                : 'message received',
        );
        this.queue.push(msg.chatJid, { msg, rowId }, holdUntil);
    }

    /** A human replied from the business phone: store it and let them take over. */
    humanTookOver(chatJid: string, text: string, waMsgId: string | null): void {
        const mem = new ChatMemory(this.d.db, chatJid);
        mem.addMessage({ waMsgId, direction: 'out', text, sopHash: 'human' });
        const minutes = this.d.sop.sop.human_takeover.pause_bot_minutes;
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
        const turn: TurnConfig = { sop: this.d.sop, persona: this.d.persona };
        const { sop } = turn.sop;
        const { sender, log } = this.d;
        const mem = new ChatMemory(this.d.db, chatJid);
        const last = batch.at(-1)!.msg;
        const lastRowId = batch.at(-1)!.rowId;
        const combined = batch.map((b) => b.msg.text).join('\n');
        const keys: WAMessageKey[] = batch.map((b) => b.msg.key);
        const notPaused = () => mem.getPausedUntil() <= Date.now();
        // A brand-new customer (nothing ever sent to this chat) gets the welcome picture first.
        const welcome =
            mem.lastOutboundAt() === null ? this.welcomeImage() : null;

        if (!notPaused()) {
            log.info(
                { chat: chatJid },
                'bot paused in this chat; not replying',
            );
            return;
        }

        log.info({ chat: chatJid, messages: batch.length }, 'replying');
        await sender.markRead(keys, combined.length);

        // 1. SOP checks in code, before the LLM.
        const verdict = checkInbound(combined, sop);
        if (verdict.kind === 'forbidden') {
            log.info(
                { chat: chatJid, topic: verdict.topicId },
                'forbidden topic',
            );
            await this.sendAndStore(mem, turn, last.replyJid, {
                messages: [sop.templates.refusal],
                image: welcome,
                imageFirst: !!welcome,
            });
            return;
        }

        // 2. Generate under the SOP.
        const started = Date.now();
        const activeFlow = this.resolveFlow(mem, turn, combined, batch.length);
        // An image the customer asked for by keyword is sent by code, not left to the model.
        const requested = welcome ?? this.requestedImage(mem, combined);
        const reply = await this.generate(
            mem,
            turn,
            combined,
            activeFlow,
            last,
            requested,
        );

        // 3. Purchase alerts go out right away; the customer's reply is paced.
        await this.handlePurchaseSignal(
            mem,
            turn,
            last,
            lastRowId,
            combined,
            reply,
        );

        await sender.think(Date.now() - started);
        if (!notPaused()) {
            log.info(
                { chat: chatJid },
                'human took over during the turn; reply dropped',
            );
            return;
        }

        // 4. Send like a human (stopping if a human takes over meanwhile), then remember.
        const image =
            requested ??
            (reply.image_id
                ? (this.d.images.get(reply.image_id) ?? null)
                : null);
        await this.sendAndStore(mem, turn, last.replyJid, {
            messages: reply.messages,
            image,
            imageFirst: !!welcome,
        });

        if (reply.flow_done && activeFlow) mem.setFlowState(null);
        this.scheduleExtraction(mem);
    }

    /**
     * Alerts the owner ONLY when a customer wants to buy or agrees to buy.
     * Combines the model's judgement with SOP keywords, and alerts each stage
     * at most once per chat within `renotify_after_hours`.
     */
    private async handlePurchaseSignal(
        mem: ChatMemory,
        turn: TurnConfig,
        msg: InboundMessage,
        rowId: number,
        text: string,
        reply: BotReply,
    ): Promise<void> {
        const { sales, templates } = turn.sop.sop;
        const { settings, sender, log } = this.d;
        const windowMs = sales.renotify_after_hours * 3_600_000;
        const recent = (stages: ('interested' | 'agreed')[]) => {
            const at = mem.lastSalesEventAt(stages);
            return at !== null && Date.now() - at < windowMs;
        };

        const keywordStage = detectPurchaseKeywords(
            text,
            turn.sop.sop,
            reply.purchase !== 'none' || recent(['interested']),
        );
        const stage: PurchaseStage = maxStage(reply.purchase, keywordStage);
        if (stage === 'none') return;

        const already =
            stage === 'agreed'
                ? recent(['agreed'])
                : recent(['interested', 'agreed']);
        if (already) return;

        const summary = (reply.purchase_summary?.trim() || msg.text)
            .replace(/\s+/g, ' ')
            .slice(0, 300);
        mem.recordSalesEvent(stage, summary, rowId);
        log.info({ chat: mem.chatJid, stage, summary }, 'purchase signal');

        if (!sales.notify_owner || !settings.ownerJid) return;
        const number = mem.chatJid.split('@')[0]!;
        const alert = fillTemplate(
            stage === 'agreed'
                ? templates.owner_agreed
                : templates.owner_interested,
            {
                customer: msg.isGroup
                    ? `${msg.pushName ?? number} (group)`
                    : (msg.pushName ?? number),
                number,
                summary,
                message: msg.text.replace(/\s+/g, ' ').slice(0, 300),
            },
        );
        await sender
            .sendRaw(settings.ownerJid, alert)
            .catch((err) => log.error({ err }, 'owner alert failed'));
    }

    private async generate(
        mem: ChatMemory,
        turn: TurnConfig,
        query: string,
        activeFlow: SopFlow | null,
        last: InboundMessage,
        attached: PreloadedImage | null = null,
    ): Promise<BotReply> {
        const { llm, images, settings, log } = this.d;
        const { sop } = turn.sop;
        const { persona } = turn;
        const fallback = (text: string): BotReply => ({
            messages: [text],
            image_id: null,
            purchase: 'none',
            purchase_summary: null,
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

        const imageOptions = [...images.values()].map((img) => ({
            id: img.id,
            whenToUse: img.whenToUse,
            recentlySent: this.sentRecently(mem, img),
        }));
        const allowedImageIds = new Set(
            imageOptions.filter((i) => !i.recentlySent).map((i) => i.id),
        );

        // R4: answer in the customer's language. This turn decides; earlier messages break a tie.
        const customerText = history
            .filter((m) => m.direction === 'in')
            .map((m) => m.text);
        const replyLanguage =
            detectLanguage(query) ??
            detectLanguage(customerText.slice(-5).join('\n'));

        const prompt = buildPrompt({
            persona,
            sop,
            activeFlow,
            images: imageOptions,
            replyLanguage,
            attachedImage: attached
                ? { id: attached.id, viewOnce: attached.viewOnce }
                : null,
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
            foreignIdentifiers: this.leakIndex.forChat(
                mem.chatJid,
                // What the customer wrote themselves may be repeated back.
                history
                    .filter((m) => m.direction === 'in')
                    .map((m) => m.text)
                    .join('\n'),
            ),
            allowedImageIds,
            language: replyLanguage,
            exampleNames: persona.exampleNames,
            chatText: [
                ...customerText,
                query,
                last.pushName ?? '',
                ...mem.getFacts().map((f) => f.value),
            ].join('\n'),
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
            const reasons = result.violations.flatMap((v) => {
                switch (v.kind) {
                    case 'leak':
                        return [
                            'it mentioned information that does not belong to this chat',
                        ];
                    case 'drift':
                        return [
                            'it broke character (mentioned AI models, prompts or instructions)',
                        ];
                    case 'forbidden':
                        return ['it touched a forbidden topic'];
                    case 'false_promise':
                        return [
                            'it promised to check, find out or get back later, which nobody will do (say honestly that you do not know instead)',
                        ];
                    case 'language':
                        return [
                            `it was written in ${LANGUAGE_NAMES[v.got]} but the customer writes in ${LANGUAGE_NAMES[v.expected]} (write the whole reply in ${LANGUAGE_NAMES[v.expected]})`,
                        ];
                    case 'example_name':
                        return [
                            `it called the customer "${v.name}", a name from the example conversations, not this customer's name`,
                        ];
                    default:
                        return [];
                }
            });
            messages = [
                ...prompt,
                {
                    role: 'system',
                    content: `Your previous draft was rejected because ${[...new Set(reasons)].join(' and ')}. Write a new reply that follows the HARD RULES, as ${sop.identity.name}, using only this chat's memory and the knowledge section.`,
                },
            ];
        }
        log.warn(
            { chat: mem.chatJid },
            'falling back to SOP "unknown" template',
        );
        return fallback(sop.templates.unknown);
    }

    /** Whether this image was sent to the chat within its resend window. */
    private sentRecently(mem: ChatMemory, img: PreloadedImage): boolean {
        const hours = img.resendAfterHours ?? this.d.settings.imageResendHours;
        const lastAt = mem.lastImageSentAt(img.id);
        return lastAt !== null && Date.now() - lastAt < hours * 3_600_000;
    }

    /** The image marked first_contact in images.yaml, if any. */
    private welcomeImage(): PreloadedImage | null {
        for (const img of this.d.images.values())
            if (img.firstContact) return img;
        return null;
    }

    /** First image whose request_keywords appear in the customer's messages. */
    private requestedImage(
        mem: ChatMemory,
        text: string,
    ): PreloadedImage | null {
        for (const img of this.d.images.values()) {
            if (
                img.requestKeywords.length &&
                matchesKeyword(text, img.requestKeywords) &&
                !this.sentRecently(mem, img)
            ) {
                return img;
            }
        }
        return null;
    }

    private resolveFlow(
        mem: ChatMemory,
        turn: TurnConfig,
        text: string,
        batchSize: number,
    ): SopFlow | null {
        const { flows } = turn.sop.sop;
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
        turn: TurnConfig,
        replyJid: string,
        plan: {
            messages: string[];
            image: ReturnType<ImageLibrary['get']> | null;
            imageFirst?: boolean;
        },
    ): Promise<void> {
        const sent = await this.d.sender.send({
            replyJid,
            messages: plan.messages,
            image: plan.image ?? null,
            imageFirst: plan.imageFirst,
            // Stop mid-reply if a human takes over or the chat is paused meanwhile.
            shouldContinue: () => mem.getPausedUntil() <= Date.now(),
        });
        for (const s of sent) {
            mem.addMessage({
                waMsgId: s.waMsgId,
                direction: 'out',
                text: s.text,
                imageId: s.imageId,
                sopHash: turn.sop.hash,
            });
            if (s.imageId) mem.recordImageSent(s.imageId);
        }
        this.d.log.info(
            {
                chat: mem.chatJid,
                sent: sent.length,
                planned: plan.messages.length + (plan.image ? 1 : 0),
            },
            'reply sent',
        );
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
            // Protect freshly learned details from the next reply in other chats.
            .then(() => this.leakIndex.noteFacts(mem.chatJid, mem.getFacts()))
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

/** Replaces {key} placeholders; unknown placeholders are left as-is. */
export function fillTemplate(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
