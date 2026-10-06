/**
 * Load test: pushes simulated customer messages through the real bot pipeline
 * (memory, SOP checks, RAG, model queue, send limiter) with a fake WhatsApp,
 * and reports how long customers wait for a reply.
 *
 *   npm run loadtest -- --rate 200 --chats 5000 --minutes 3
 *   npm run loadtest -- --fake-llm --fake-latency 4000 --rate 200 --minutes 2
 *
 * Without --fake-llm it uses the Ollama models from .env, so it measures your
 * real machine. Human-like delays are switched off; only model time, queueing
 * and the outgoing cap count. Nothing is sent to WhatsApp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import type { LlmClient } from '../brain/llm.js';
import { OllamaLlm } from '../brain/llm.js';
import { isBehind, ScheduledLlm } from '../brain/scheduler.js';
import { loadEnv } from '../config/env.js';
import { loadImages } from '../config/images.js';
import { loadPersona } from '../config/persona.js';
import { loadSop } from '../config/sop.js';
import { openDb } from '../memory/db.js';
import { Bot } from '../pipeline/bot.js';
import { ingestKnowledge } from '../rag/ingest.js';
import type { InboundMessage } from '../whatsapp/inbound.js';
import { OutboundLimiter } from '../whatsapp/outboundLimiter.js';
import type { Sender, SentMessage } from '../whatsapp/sender.js';

const { values: args } = parseArgs({
    options: {
        rate: { type: 'string', default: '150' },
        chats: { type: 'string', default: '2000' },
        minutes: { type: 'string', default: '3' },
        'fake-llm': { type: 'boolean', default: false },
        'fake-latency': { type: 'string', default: '3000' },
        concurrency: { type: 'string' },
    },
});

const env = loadEnv();
const RATE = Number(args.rate);
const CHATS = Number(args.chats);
const MINUTES = Number(args.minutes);
const FAKE = args['fake-llm'];
const FAKE_MS = Number(args['fake-latency']);
const CONCURRENCY = Number(args.concurrency ?? env.LLM_CONCURRENCY);

const SAMPLE_TEXTS = [
    'Hoi! Wat kost knippen?',
    'Zijn jullie zaterdag open?',
    'Ik wil graag een afspraak maken',
    'Hoe laat sluiten jullie op donderdag?',
    'Kan ik met pin betalen?',
    'Waar kan ik parkeren?',
    'Hoeveel kost balayage?',
    'Doen jullie ook kinderen?',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake model: fixed latency per call, valid output for every schema. */
function fakeLlm(): LlmClient {
    return {
        async chatJson<T>(messages: { content: string }[]): Promise<T> {
            await sleep(FAKE_MS * (0.7 + Math.random() * 0.6));
            const sys = messages[0]!.content;
            if (sys.includes('fact sheet'))
                return { facts: [], forget: [] } as T;
            if (sys.includes('running summary'))
                return { summary: 'Klant vroeg naar prijzen.' } as T;
            return {
                messages: ['Hoi! Knippen kost €45.', 'Wil je een afspraak?'],
                image_id: null,
                purchase: 'none',
                purchase_summary: null,
                flow_done: false,
            } as T;
        },
        async embed(texts: string[]) {
            await sleep(30);
            return texts.map(() =>
                Array.from({ length: env.EMBED_DIM }, () => Math.random()),
            );
        },
    };
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-load-'));
    const db = openDb({
        path: path.join(dir, 'load.db'),
        embedDim: env.EMBED_DIM,
    });
    const sop = loadSop(path.join(env.CONFIG_DIR, 'astrid.sop.yaml'));
    const persona = loadPersona(
        path.join(env.CONFIG_DIR, 'persona.md'),
        sop.sop.identity.name,
    );
    const images = loadImages(
        path.join(env.CONFIG_DIR, 'images.yaml'),
        'assets/images',
    );

    let base: LlmClient;
    if (FAKE) {
        base = fakeLlm();
    } else {
        const ollama = new OllamaLlm({
            host: env.OLLAMA_HOST,
            chatModel: env.CHAT_MODEL,
            embedModel: env.EMBED_MODEL,
            temperature: env.LLM_TEMPERATURE,
            seed: env.LLM_SEED,
            numCtx: env.LLM_NUM_CTX,
        });
        await ollama.assertReady([env.CHAT_MODEL, env.EMBED_MODEL]);
        base = ollama;
    }
    const llm = new ScheduledLlm(base, {
        concurrency: CONCURRENCY,
        backgroundMaxWaitMs: env.BACKGROUND_MAX_WAIT_SEC * 1000,
    });
    await ingestKnowledge(db, llm, env.KNOWLEDGE_DIR);

    const limiter = new OutboundLimiter({
        maxPerMinute: env.OUTBOUND_MAX_PER_MIN,
        mergeAt: env.OUTBOUND_MERGE_AT,
    });

    // Latency bookkeeping: when did each chat's oldest unanswered message arrive?
    const waitingSince = new Map<string, number>();
    let latencies: number[] = [];
    let repliesThisMinute = 0;
    let sentMessages = 0;
    let n = 0;

    const sender: Sender = {
        async markRead() {},
        async think() {},
        async send(plan) {
            const bubbles =
                plan.messages.length > 1 && limiter.shouldMerge()
                    ? [plan.messages.join('\n\n')]
                    : plan.messages;
            const out: SentMessage[] = [];
            for (const text of [...bubbles, ...(plan.image ? [''] : [])]) {
                await limiter.acquire();
                sentMessages++;
                out.push({ waMsgId: `L${++n}`, text, imageId: null });
            }
            const since = waitingSince.get(plan.replyJid);
            if (since !== undefined) {
                latencies.push(Date.now() - since);
                waitingSince.delete(plan.replyJid);
            }
            repliesThisMinute++;
            return out;
        },
        async sendRaw() {
            await limiter.acquire();
            return null;
        },
    };

    const bot = new Bot({
        db,
        llm,
        sender,
        sop,
        persona,
        images,
        log: pino({ level: 'silent' }),
        settings: {
            allowedJids: [],
            replyInGroups: false,
            historyMessages: env.HISTORY_MESSAGES,
            summarizeAfter: env.SUMMARIZE_AFTER,
            ragTopK: env.RAG_TOP_K,
            ragMaxDistance: env.RAG_MAX_DISTANCE,
            imageResendHours: env.IMAGE_RESEND_HOURS,
            numCtx: env.LLM_NUM_CTX,
            debounceMs: env.DEBOUNCE_MS,
            debounceMaxMs: env.DEBOUNCE_MAX_MS,
            extractModel: env.EXTRACT_MODEL,
            firstReply: { minMs: 0, maxMs: 0, coldAfterMs: 0 },
        },
    });

    console.log(
        `Load test: ${RATE} msgs/min over ${CHATS} chats for ${MINUTES} min · ` +
            `${FAKE ? `fake model (${FAKE_MS} ms/call)` : `Ollama ${env.CHAT_MODEL}`} · ` +
            `concurrency ${CONCURRENCY} · send cap ${env.OUTBOUND_MAX_PER_MIN}/min\n`,
    );
    console.log(
        'min | received | replies | sent msgs | p50 wait | p95 wait | max wait | model queue | memory backlog | merging',
    );

    const pct = (xs: number[], p: number) => {
        if (!xs.length) return 0;
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
    };
    const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`.padStart(8);

    let received = 0;
    let receivedThisMinute = 0;
    let minute = 0;
    let lastP95 = 0;
    const report = () => {
        minute++;
        const sch = llm.stats();
        const out = limiter.stats();
        lastP95 = pct(latencies, 95);
        console.log(
            `${String(minute).padStart(3)} | ${String(receivedThisMinute).padStart(8)} | ${String(repliesThisMinute).padStart(7)} | ${String(sentMessages).padStart(9)} |${fmt(pct(latencies, 50))} |${fmt(lastP95)} |${fmt(Math.max(0, ...latencies))} | ${String(sch.queuedReplies).padStart(11)} | ${String(sch.queuedBackground).padStart(14)} | ${out.merging ? 'yes' : 'no'}`,
        );
        latencies = [];
        repliesThisMinute = 0;
        receivedThisMinute = 0;
        sentMessages = 0;
    };
    const reporter = setInterval(report, 60_000);

    // Generate traffic at a steady rate across random chats.
    const end = Date.now() + MINUTES * 60_000;
    const gap = 60_000 / RATE;
    while (Date.now() < end) {
        const c = Math.floor(Math.random() * CHATS);
        const jid = `3169${String(c).padStart(7, '0')}@s.whatsapp.net`;
        const id = `IN${++n}`;
        if (!waitingSince.has(jid)) waitingSince.set(jid, Date.now());
        const msg: InboundMessage = {
            chatJid: jid,
            replyJid: jid,
            senderJid: jid,
            pushName: `Klant ${c}`,
            isGroup: false,
            addressedToBot: true,
            text: SAMPLE_TEXTS[n % SAMPLE_TEXTS.length]!,
            waMsgId: id,
            key: { remoteJid: jid, id, fromMe: false },
            ts: Date.now(),
        };
        bot.receive(msg);
        received++;
        receivedThisMinute++;
        await sleep(gap);
    }

    console.log(
        `\nStopped sending after ${received} messages; letting the queue drain (max 3 min)…`,
    );
    await Promise.race([bot.idle(), sleep(180_000)]);
    clearInterval(reporter);
    report();

    const behind =
        isBehind(llm.stats()) || lastP95 > 60_000 || waitingSince.size > 0;
    console.log(
        behind
            ? `\nVerdict: FALLS BEHIND at ${RATE} msgs/min. ${waitingSince.size} chats still waiting. Try a smaller CHAT_MODEL, a small EXTRACT_MODEL, higher OLLAMA_NUM_PARALLEL + --concurrency, or a faster GPU.`
            : `\nVerdict: KEEPS UP at ${RATE} msgs/min (p95 wait last minute ${(lastP95 / 1000).toFixed(1)}s).`,
    );
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
