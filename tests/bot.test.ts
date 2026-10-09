import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../src/brain/llm.js';
import type { BotReply } from '../src/brain/reply.js';
import { loadImages } from '../src/config/images.js';
import { loadPersona } from '../src/config/persona.js';
import { loadSop } from '../src/config/sop.js';
import { buildPrompt } from '../src/brain/prompt.js';
import { ChatMemory } from '../src/memory/ChatMemory.js';
import { openDb, type DB } from '../src/memory/db.js';
import { Bot } from '../src/pipeline/bot.js';
import type { InboundMessage } from '../src/whatsapp/inbound.js';
import type { SendPlan, Sender } from '../src/whatsapp/sender.js';

const root = path.resolve(import.meta.dirname, '..');
const sop = loadSop(path.join(root, 'config/astrid.sop.yaml'));
const persona = loadPersona(path.join(root, 'config/persona.md'), 'Astrid');
const images = loadImages(
    path.join(root, 'config/images.yaml'),
    path.join(root, 'assets/images'),
);

const DIM = 8;
const A = '31600000001@s.whatsapp.net';
const B = '31600000002@s.whatsapp.net';
const OWNER = '31600000099@s.whatsapp.net';

/** Deterministic toy embedding: character histogram. */
function embedText(t: string): number[] {
    const v = new Array<number>(DIM).fill(0.01);
    for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % DIM]! += 1;
    return v;
}

type ReplyFn = (prompt: ChatMessage[], chat: string) => Partial<BotReply>;

class FakeLlm implements LlmClient {
    prompts: { chat: string; messages: ChatMessage[] }[] = [];
    replies: ReplyFn[] = [];
    facts = new Map<string, { key: string; value: string }[]>();

    async chatJson<T>(messages: ChatMessage[]): Promise<T> {
        const system = messages[0]!.content;
        if (system.includes('fact sheet')) {
            const chat = [...this.facts.keys()].find((jid) =>
                messages[1]!.content.includes(`#${jid}`),
            );
            const facts = (chat && this.facts.get(chat)) || [];
            return {
                facts: facts.map((f) => ({
                    subject: 'chat',
                    confidence: 1,
                    ...f,
                })),
                forget: [],
            } as T;
        }
        if (system.includes('running summary'))
            return { summary: 'summary' } as T;

        const chat = currentChat;
        this.prompts.push({ chat, messages });
        const fn = this.replies.shift() ?? (() => ({ messages: ['Oké!'] }));
        return {
            messages: ['Oké!'],
            image_id: null,
            purchase: 'none',
            purchase_summary: null,
            flow_done: false,
            ...fn(messages, chat),
        } as T;
    }

    async embed(texts: string[]): Promise<number[][]> {
        return texts.map(embedText);
    }
}

class FakeSender implements Sender {
    sent: SendPlan[] = [];
    /** Bubbles actually delivered (after shouldContinue checks). */
    delivered: string[] = [];
    raw: { jid: string; text: string }[] = [];
    reads = 0;
    /** Runs before each bubble, e.g. to simulate a human taking over mid-reply. */
    beforeBubble: (i: number) => void = () => {};
    async markRead() {
        this.reads++;
    }
    async think() {}
    async send(plan: SendPlan) {
        this.sent.push(plan);
        const out: { waMsgId: null; text: string; imageId: string | null }[] =
            [];
        for (const [i, text] of plan.messages.entries()) {
            this.beforeBubble(i);
            if (plan.shouldContinue && !plan.shouldContinue()) return out;
            this.delivered.push(text);
            out.push({ waMsgId: null, text, imageId: null });
        }
        return [
            ...out,
            ...(plan.image
                ? [
                      {
                          waMsgId: null,
                          text: plan.image.caption,
                          imageId: plan.image.id,
                      },
                  ]
                : []),
        ];
    }
    async sendRaw(jid: string, text: string) {
        this.raw.push({ jid, text });
        return null;
    }
}

let currentChat = '';
let n = 0;
function inbound(
    chatJid: string,
    text: string,
    pushName = 'Klant',
): InboundMessage {
    // Tag text with the chat so the fake extractor knows which chat it is reading.
    const id = `M${++n}`;
    return {
        chatJid,
        replyJid: chatJid,
        senderJid: chatJid,
        pushName,
        isGroup: false,
        addressedToBot: true,
        text: `${text} #${chatJid}`,
        waMsgId: id,
        key: { remoteJid: chatJid, id, fromMe: false },
        ts: Date.now(),
    };
}

let db: DB;
let settingsOverride: Record<string, unknown> = {};
let llm: FakeLlm;
let sender: FakeSender;
let bot: Bot;

async function say(chat: string, text: string, pushName?: string) {
    currentChat = chat;
    bot.receive(inbound(chat, text, pushName));
    await bot.idle();
}

const allText = (msgs: ChatMessage[]) => msgs.map((m) => m.content).join('\n');

function makeBot(log = pino({ level: 'silent' })): Bot {
    return new Bot({
        db,
        llm,
        sender,
        sop,
        persona,
        images,
        log,
        settings: {
            ownerJid: OWNER,
            allowedJids: [],
            replyInGroups: false,
            historyMessages: 20,
            summarizeAfter: 40,
            ragTopK: 6,
            ragMaxDistance: 2,
            imageResendHours: 24,
            numCtx: 8192,
            debounceMs: 0,
            debounceMaxMs: 0,
            firstReply: { minMs: 0, maxMs: 0, coldAfterMs: 0 },
            ...settingsOverride,
        },
    });
}

beforeEach(() => {
    db = openDb({ path: ':memory:', embedDim: DIM });
    llm = new FakeLlm();
    sender = new FakeSender();
    bot = makeBot();
});

describe('cold-start delay', () => {
    beforeEach(() => {
        settingsOverride = {
            firstReply: { minMs: 150, maxMs: 200, coldAfterMs: 60_000 },
        };
    });
    afterEach(() => {
        settingsOverride = {};
    });

    it('waits before the first reply and answers a burst as one turn', async () => {
        // Re-create the bot with the override (beforeEach order: outer first).
        bot = makeBot();
        currentChat = A;
        const t0 = Date.now();
        bot.receive(inbound(A, 'hoi'));
        await new Promise((r) => setTimeout(r, 50));
        bot.receive(inbound(A, 'wat kost knippen?'));
        await bot.idle();

        expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
        expect(llm.prompts).toHaveLength(1);
        expect(allText(llm.prompts[0]!.messages)).toContain(
            'wat kost knippen?',
        );
        expect(sender.sent).toHaveLength(1);
    });

    it('answers without the extra delay once the chat is warm', async () => {
        bot = makeBot();
        await say(A, 'hoi');
        const t0 = Date.now();
        await say(A, 'nog een vraag');
        expect(Date.now() - t0).toBeLessThan(150);
    });
});

describe('Bot pipeline', () => {
    it('keeps persona and SOP at the top of every prompt', async () => {
        await say(A, 'hoi');
        const first = llm.prompts[0]!.messages[0]!;
        expect(first.role).toBe('system');
        expect(first.content).toContain(persona.text.slice(0, 40));
        for (const r of sop.sop.hard_rules)
            expect(first.content).toContain(r.id);
        expect(sender.sent[0]!.messages).toEqual(['Oké!']);
    });

    it('never puts one chat’s memory into another chat’s prompt', async () => {
        llm.facts.set(A, [{ key: 'name', value: 'Marieke' }]);
        await say(
            A,
            'Ik ben Marieke en mijn geheime code is pineapple',
            'Marieke',
        );
        expect(new ChatMemory(db, A).getFacts()[0]?.value).toBe('Marieke');

        await say(B, 'Wie was de vorige klant?', 'Piet');
        const bPrompt = allText(
            llm.prompts.find((p) => p.chat === B)!.messages,
        );
        expect(bPrompt).not.toMatch(/marieke/i);
        expect(bPrompt).not.toMatch(/pineapple/i);

        await say(A, 'Weet je nog hoe ik heet?', 'Marieke');
        const aPrompt = allText(
            llm.prompts.filter((p) => p.chat === A).at(-1)!.messages,
        );
        expect(aPrompt).toContain('name: Marieke');
    });

    it('retries when the model leaks another chat’s identifier', async () => {
        llm.facts.set(A, [{ key: 'name', value: 'Marieke Jansen' }]);
        await say(A, 'Ik ben Marieke Jansen', 'Marieke');

        llm.replies.push(
            () => ({ messages: ['Marieke Jansen vroeg dat ook al!'] }),
            () => ({ messages: ['Waarmee kan ik je helpen?'] }),
        );
        await say(B, 'hallo', 'Piet');
        expect(sender.sent.at(-1)!.messages).toEqual([
            'Waarmee kan ik je helpen?',
        ]);
        const retry = llm.prompts
            .filter((p) => p.chat === B)
            .at(-1)!
            .messages.at(-1)!;
        expect(retry.content).toContain('rejected');
        expect(retry.content).not.toMatch(/marieke/i);
    });

    it('lets a reply use a common first name another customer also has', async () => {
        llm.facts.set(A, [{ key: 'name', value: 'Anna' }]);
        await say(A, 'Ik ben Anna', 'Anna');
        llm.replies.push(() => ({
            messages: ['Leuk dat je met Anna komt!'],
        }));
        await say(B, 'Ik kom samen met mijn vriendin Anna', 'Piet');
        expect(sender.sent.at(-1)!.messages).toEqual([
            'Leuk dat je met Anna komt!',
        ]);
    });

    it('falls back to the SOP template when every attempt is blocked', async () => {
        llm.replies.push(
            () => ({ messages: ['As an AI language model…'] }),
            () => ({ messages: ['As an AI language model…'] }),
        );
        await say(A, 'hoi');
        expect(sender.sent.at(-1)!.messages).toEqual([
            sop.sop.templates.unknown,
        ]);
    });

    it('alerts the owner when a customer wants to buy, once per window', async () => {
        llm.replies.push(() => ({
            messages: ['Leuk! Welke dag wil je komen?'],
            purchase: 'interested',
            purchase_summary: 'Knippen dames, zaterdag',
        }));
        await say(A, 'Ik wil graag een knipbeurt', 'Marieke');
        expect(sender.raw).toHaveLength(1);
        expect(sender.raw[0]!.jid).toBe(OWNER);
        expect(sender.raw[0]!.text).toContain('Marieke');
        expect(sender.raw[0]!.text).toContain('Knippen dames, zaterdag');
        expect(sender.raw[0]!.text).toContain('31600000001');

        // Still interested in the next turn: no second alert.
        llm.replies.push(() => ({
            messages: ['Hoe laat?'],
            purchase: 'interested',
            purchase_summary: 'Knippen dames, zaterdag',
        }));
        await say(A, 'zaterdag', 'Marieke');
        expect(sender.raw).toHaveLength(1);

        // Agreeing is a new stage: alerted, and the bot keeps chatting.
        llm.replies.push(() => ({
            messages: ['Top, een collega neemt contact met je op!'],
            purchase: 'agreed',
            purchase_summary: 'Knippen dames, zaterdag 14:00, Marieke',
        }));
        await say(A, 'ja klopt, 14:00', 'Marieke');
        expect(sender.raw).toHaveLength(2);
        expect(sender.raw[1]!.text).toContain('14:00');
        expect(new ChatMemory(db, A).getPausedUntil()).toBe(0);

        llm.replies.push(() => ({ messages: ['Graag gedaan!'] }));
        await say(A, 'dankjewel', 'Marieke');
        expect(sender.sent.at(-1)!.messages).toEqual(['Graag gedaan!']);
    });

    it('uses SOP keywords as a backup when the model misses a purchase', async () => {
        await say(A, 'Ik wil graag bestellen');
        expect(sender.raw).toHaveLength(1);

        // "akkoord" only counts as agreeing after interest was shown.
        await say(A, 'akkoord');
        expect(sender.raw).toHaveLength(2);
        expect(sender.raw[1]!.text).toMatch(/akkoord|agreed/i);

        await say(B, 'akkoord');
        expect(sender.raw).toHaveLength(2); // no prior interest in chat B
    });

    it('does not alert the owner about complaints or requests for a human', async () => {
        await say(A, 'Ik wil een klacht indienen en mijn geld terug');
        await say(A, 'Ik wil een echt persoon spreken');
        expect(sender.raw).toHaveLength(0);
        expect(llm.prompts).toHaveLength(2); // the bot answers itself
        expect(new ChatMemory(db, A).getPausedUntil()).toBe(0);
    });

    it('rewrites replies that promise to check or get back later', async () => {
        llm.replies.push(
            () => ({
                messages: ['Goeie vraag, ik check het even en kom erop terug!'],
            }),
            () => ({ messages: ['Dat weet ik helaas niet zeker.'] }),
        );
        await say(A, 'Verkopen jullie cadeaubonnen?');
        expect(sender.sent.at(-1)!.messages).toEqual([
            'Dat weet ik helaas niet zeker.',
        ]);
        const retry = llm.prompts.at(-1)!.messages.at(-1)!;
        expect(retry.content).toMatch(/promised to check/);
    });

    it('stops mid-reply when a human takes over while the bot is typing', async () => {
        llm.replies.push(() => ({ messages: ['Een', 'Twee', 'Drie'] }));
        sender.beforeBubble = (i) => {
            if (i === 1) bot.humanTookOver(A, 'Ik neem het over', null);
        };
        await say(A, 'hoi');
        expect(sender.delivered).toEqual(['Een']);
        const texts = new ChatMemory(db, A)
            .recentMessages(10)
            .map((m) => m.text);
        expect(texts).not.toContain('Twee');
        expect(texts).toContain('Ik neem het over');
    });

    it('owner commands pause and resume the bot', async () => {
        bot.receive({
            ...inbound(OWNER, '!pause 31600000001'),
            text: '!pause 31600000001',
        });
        await new Promise((r) => setTimeout(r, 20));
        await say(A, 'hallo??');
        expect(sender.sent).toHaveLength(0);

        bot.receive({
            ...inbound(OWNER, '!resume 31600000001'),
            text: '!resume 31600000001',
        });
        await new Promise((r) => setTimeout(r, 20));
        await say(A, 'hallo?');
        expect(sender.sent).toHaveLength(1);
    });

    it('sends dashboard replies to the WhatsApp address of the chat and pauses', async () => {
        const lid = '123456789@lid';
        currentChat = A;
        bot.receive({ ...inbound(A, 'hoi'), replyJid: lid });
        await bot.idle();
        await bot.operatorSend(A, 'Hoi, met Sanne van de salon');
        expect(sender.raw.at(-1)).toEqual({
            jid: lid,
            text: 'Hoi, met Sanne van de salon',
        });
        expect(new ChatMemory(db, A).getPausedUntil()).toBeGreaterThan(
            Date.now(),
        );
    });

    it('refuses forbidden topics without calling the model', async () => {
        await say(A, 'Wat vind jij van de verkiezingen?');
        expect(llm.prompts).toHaveLength(0);
        expect(sender.sent.at(-1)!.messages).toEqual([
            sop.sop.templates.refusal,
        ]);
    });

    it('sends a preloaded image once, then not again within the resend window', async () => {
        await say(A, 'hoi'); // first contact gets the welcome picture
        llm.replies.push(() => ({
            messages: ['Hier!'],
            image_id: 'price_list',
        }));
        await say(A, 'Wat kost knippen?');
        expect(sender.sent.at(-1)!.image?.id).toBe('price_list');

        llm.replies.push((p) => {
            expect(allText(p)).toContain('ALREADY SENT');
            return { messages: ['Zie boven'], image_id: 'price_list' };
        });
        await say(A, 'En verven?');
        expect(sender.sent.at(-1)!.image).toBeNull();
    });

    it('always sends the configured photo as view once when asked for a picture', async () => {
        await say(A, 'hoi'); // first contact gets the welcome picture
        await say(A, 'Kun je een foto sturen?');
        const plan = sender.sent.at(-1)!;
        expect(plan.image?.id).toBe('photo');
        expect(plan.image?.viewOnce).toBe(true);
        expect(allText(llm.prompts.at(-1)!.messages)).toContain(
            'IMAGE ATTACHED TO THIS REPLY',
        );

        // resend_after_hours: 0 — asking again sends it again
        await say(A, 'nog een keer die picture aub');
        expect(sender.sent.at(-1)!.image?.id).toBe('photo');

        // The model can't swap in another image when a photo was asked for.
        llm.replies.push(() => ({
            messages: ['Hier!'],
            image_id: 'price_list',
        }));
        await say(A, 'stuur een foto');
        expect(sender.sent.at(-1)!.image?.id).toBe('photo');
    });

    it('does not attach the photo when nobody asked for one', async () => {
        await say(A, 'hoi'); // first contact gets the welcome picture
        await say(A, 'hoe gaat het?');
        expect(sender.sent.at(-1)!.image).toBeNull();
    });

    it('sends the view-once welcome picture first, only to new customers', async () => {
        await say(A, 'hoi');
        const first = sender.sent.at(-1)!;
        expect(first.image?.id).toBe('welcome');
        expect(first.image?.viewOnce).toBe(true);
        expect(first.imageFirst).toBe(true);
        expect(allText(llm.prompts.at(-1)!.messages)).toContain(
            'IMAGE ATTACHED TO THIS REPLY',
        );

        await say(A, 'en nog iets');
        expect(sender.sent.at(-1)!.image).toBeNull();

        // A different new customer gets it too, even if their first message is refused.
        await say(B, 'Wat vind jij van de verkiezingen?');
        expect(sender.sent.at(-1)!.image?.id).toBe('welcome');
        expect(sender.sent.at(-1)!.messages).toEqual([
            sop.sop.templates.refusal,
        ]);
    });

    it('starts the first_contact flow on the first message', async () => {
        await say(A, 'hoi');
        expect(allText(llm.prompts[0]!.messages)).toContain(
            'ACTIVE PROCEDURE: first_contact',
        );
    });

    it('ignores groups unless configured and addressed', async () => {
        const g = '123-456@g.us';
        currentChat = g;
        bot.receive({ ...inbound(g, 'hoi'), isGroup: true, senderJid: A });
        await bot.idle();
        expect(sender.sent).toHaveLength(0);
        expect(new ChatMemory(db, g).recentMessages(5)).toHaveLength(1); // still remembered
    });
});

describe('inbound logging', () => {
    function capture() {
        const lines: { msg: string; [k: string]: unknown }[] = [];
        const log = pino(
            { level: 'info' },
            { write: (l: string) => void lines.push(JSON.parse(l)) },
        );
        return { lines, log };
    }
    afterEach(() => {
        settingsOverride = {};
    });

    it('says why a message from a number outside ALLOWED_JIDS is ignored', async () => {
        settingsOverride = { allowedJids: [B] };
        const { lines, log } = capture();
        bot = makeBot(log);
        await say(A, 'hoi');
        expect(sender.sent).toHaveLength(0);
        expect(lines.map((l) => l.msg)).toContain(
            'message ignored: sender not in ALLOWED_JIDS',
        );
    });

    it('logs receipt, reply and send for a normal message', async () => {
        const { lines, log } = capture();
        bot = makeBot(log);
        await say(A, 'hoi');
        const msgs = lines.map((l) => l.msg);
        expect(msgs).toEqual(
            expect.arrayContaining([
                'message received',
                'replying',
                'reply sent',
            ]),
        );
    });
});

describe('language rule R4 in code', () => {
    it('tells the model the language and retries a reply in the wrong one', async () => {
        llm.replies.push(
            () => ({ messages: ['Hallo, wat wil je nu even doen?'] }),
            () => ({ messages: ['Hi! What can I do for you today?'] }),
        );
        await say(A, 'hey, what do you do? i am so tired today');
        expect(allText(llm.prompts[0]!.messages)).toContain(
            'Write your reply in English',
        );
        expect(llm.prompts).toHaveLength(2);
        expect(allText(llm.prompts[1]!.messages)).toContain(
            'the customer writes in English',
        );
        expect(sender.delivered).toEqual(['Hi! What can I do for you today?']);
    });
});

describe('speed', () => {
    it('starts the model while "reading" but sends only after the read receipt', async () => {
        const events: string[] = [];
        sender.markRead = async () => {
            events.push('read:start');
            await new Promise((r) => setTimeout(r, 50));
            events.push('read:done');
        };
        llm.replies.push(() => {
            events.push('model');
            return { messages: ['Hoi!'] };
        });
        const send = sender.send.bind(sender);
        sender.send = async (plan) => {
            events.push('send');
            return send(plan);
        };
        await say(A, 'hoi');
        expect(events).toEqual(['read:start', 'model', 'read:done', 'send']);
    });

    it('keeps the cacheable prompt prefix identical across chats and turns', () => {
        const base = {
            persona,
            sop: sop.sop,
            facts: [],
            summary: null,
            recalled: [],
            kb: [],
            maxTokens: 8192,
        };
        const imgs = (sent: boolean) => [
            { id: 'price_list', whenToUse: 'prices', recentlySent: sent },
        ];
        const newCustomer = buildPrompt({
            ...base,
            activeFlow: null,
            images: imgs(false),
            attachedImage: { id: 'welcome', viewOnce: true },
            chat: { name: 'Anna', isGroup: false },
            history: [],
        });
        const midFlow = buildPrompt({
            ...base,
            activeFlow: sop.sop.flows[0]!,
            images: imgs(true),
            attachedImage: null,
            chat: { name: 'Bram', isGroup: false },
            history: [],
        });
        // Everything before the per-chat context message must match exactly.
        const prefix = (p: ChatMessage[]) =>
            p.slice(0, 1 + persona.examples.length * 2);
        expect(prefix(newCustomer)).toEqual(prefix(midFlow));
        expect(allText(prefix(newCustomer))).not.toMatch(
            /IMAGE ATTACHED|ACTIVE PROCEDURE|ALREADY SENT/,
        );
    });
});
