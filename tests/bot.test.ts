import path from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../src/brain/llm.js';
import type { BotReply } from '../src/brain/reply.js';
import { loadImages } from '../src/config/images.js';
import { loadPersona } from '../src/config/persona.js';
import { loadSop } from '../src/config/sop.js';
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
            escalate: false,
            escalate_reason: null,
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
    raw: { jid: string; text: string }[] = [];
    reads = 0;
    async markRead() {
        this.reads++;
    }
    async think() {}
    async send(plan: SendPlan) {
        this.sent.push(plan);
        return [
            ...plan.messages.map((text) => ({
                waMsgId: null,
                text,
                imageId: null,
            })),
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
let llm: FakeLlm;
let sender: FakeSender;
let bot: Bot;

async function say(chat: string, text: string, pushName?: string) {
    currentChat = chat;
    bot.receive(inbound(chat, text, pushName));
    await bot.idle();
}

const allText = (msgs: ChatMessage[]) => msgs.map((m) => m.content).join('\n');

beforeEach(() => {
    db = openDb({ path: ':memory:', embedDim: DIM });
    llm = new FakeLlm();
    sender = new FakeSender();
    bot = new Bot({
        db,
        llm,
        sender,
        sop,
        persona,
        images,
        log: pino({ level: 'silent' }),
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
        },
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
        llm.facts.set(A, [{ key: 'name', value: 'Marieke' }]);
        await say(A, 'Ik ben Marieke', 'Marieke');

        llm.replies.push(
            () => ({ messages: ['Marieke vroeg dat ook al!'] }),
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

    it('escalates in code, notifies the owner and pauses the bot', async () => {
        await say(A, 'Ik wil mijn geld terug');
        expect(llm.prompts).toHaveLength(0);
        expect(sender.sent.at(-1)!.messages).toEqual([
            sop.sop.templates.escalation,
        ]);
        expect(sender.raw[0]!.jid).toBe(OWNER);

        await say(A, 'hallo??');
        expect(sender.sent).toHaveLength(1); // paused: no reply

        bot.receive({
            ...inbound(OWNER, '!resume 31600000001'),
            text: '!resume 31600000001',
        });
        await new Promise((r) => setTimeout(r, 20));
        await say(A, 'hallo?');
        expect(sender.sent).toHaveLength(2);
    });

    it('refuses forbidden topics without calling the model', async () => {
        await say(A, 'Wat vind jij van de verkiezingen?');
        expect(llm.prompts).toHaveLength(0);
        expect(sender.sent.at(-1)!.messages).toEqual([
            sop.sop.templates.refusal,
        ]);
    });

    it('sends a preloaded image once, then not again within the resend window', async () => {
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
