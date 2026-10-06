/**
 * Sandbox: chat with the bot in the terminal, without WhatsApp. Runs the real
 * pipeline (SOP checks, memory, knowledge, guards, purchase alerts) against
 * the Ollama model from .env, prints every step and the model's raw output as
 * it is written, and never waits like a human.
 *
 *   npm run chat
 *
 * Uses a throwaway database, so the real chats are not touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import pino from 'pino';
import { OllamaLlm } from '../brain/llm.js';
import { loadEnv } from '../config/env.js';
import { loadImages } from '../config/images.js';
import { loadPersona } from '../config/persona.js';
import { loadSop } from '../config/sop.js';
import { openDb } from '../memory/db.js';
import { Bot } from '../pipeline/bot.js';
import { ingestKnowledge } from '../rag/ingest.js';
import type { InboundMessage } from '../whatsapp/inbound.js';
import type { Sender } from '../whatsapp/sender.js';

const CHAT = '31600000000@s.whatsapp.net';
const OWNER = '31699999999@s.whatsapp.net';
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Compact, readable log lines instead of JSON. */
const log = pino(
    { level: 'info' },
    {
        write(line: string) {
            const { msg, ...rest } = JSON.parse(line) as Record<
                string,
                unknown
            >;
            for (const k of ['level', 'time', 'pid', 'hostname'])
                delete rest[k];
            const extra = Object.entries(rest)
                .map(
                    ([k, v]) =>
                        `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
                )
                .join(' ');
            process.stdout.write(dim(`  · ${String(msg)} ${extra}`) + '\n');
        },
    },
);

async function main() {
    const env = loadEnv();
    const sop = loadSop(path.join(env.CONFIG_DIR, 'astrid.sop.yaml'));
    const persona = loadPersona(
        path.join(env.CONFIG_DIR, 'persona.md'),
        sop.sop.identity.name,
    );
    const images = loadImages(
        path.join(env.CONFIG_DIR, 'images.yaml'),
        'assets/images',
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-chat-'));
    const db = openDb({
        path: path.join(dir, 'chat.db'),
        embedDim: env.EMBED_DIM,
    });

    let writing = false;
    const llm = new OllamaLlm({
        host: env.OLLAMA_HOST,
        chatModel: env.CHAT_MODEL,
        embedModel: env.EMBED_MODEL,
        temperature: env.LLM_TEMPERATURE,
        seed: env.LLM_SEED,
        numCtx: env.LLM_NUM_CTX,
        maxTokens: env.LLM_MAX_TOKENS,
        progressEveryMs: 10_000,
        onChatProgress: ({ chars, thinkingChars, seconds }) => {
            if (thinkingChars && !chars)
                log.info(
                    { seconds, thinkingChars },
                    'model is thinking before it answers',
                );
            else if (!chars)
                log.info(
                    { seconds },
                    'model is still reading the prompt (nothing written yet)',
                );
        },
        onChunk: (t) => {
            if (!writing) {
                process.stdout.write(dim('  model output: '));
                writing = true;
            }
            process.stdout.write(dim(t));
        },
        onChatDone: ({ model, ms }) => {
            if (writing) process.stdout.write('\n');
            writing = false;
            log.info(
                { model, seconds: Math.round(ms / 100) / 10 },
                'model answered',
            );
        },
    });
    await llm.assertReady([env.CHAT_MODEL, env.EMBED_MODEL]);
    await ingestKnowledge(db, llm, env.KNOWLEDGE_DIR);

    const sender: Sender = {
        async markRead() {},
        async think() {},
        async send(plan) {
            const out = [];
            if (plan.image && plan.imageFirst)
                console.log(bold(`  [picture: ${plan.image.id}]`));
            for (const text of plan.messages) {
                console.log(bold(`${sop.sop.identity.name}: `) + text);
                out.push({ waMsgId: null, text, imageId: null });
            }
            if (plan.image && !plan.imageFirst)
                console.log(bold(`  [picture: ${plan.image.id}]`));
            if (plan.image)
                out.push({
                    waMsgId: null,
                    text: plan.image.caption,
                    imageId: plan.image.id,
                });
            return out;
        },
        async sendRaw(jid, text) {
            console.log(dim(`  [alert to owner] ${text}`));
            void jid;
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
        log,
        settings: {
            ownerJid: OWNER,
            allowedJids: [],
            replyInGroups: false,
            historyMessages: env.HISTORY_MESSAGES,
            summarizeAfter: env.SUMMARIZE_AFTER,
            ragTopK: env.RAG_TOP_K,
            ragMaxDistance: env.RAG_MAX_DISTANCE,
            imageResendHours: env.IMAGE_RESEND_HOURS,
            numCtx: env.LLM_NUM_CTX,
            debounceMs: 0,
            debounceMaxMs: 0,
            extractModel: env.EXTRACT_MODEL,
            firstReply: { minMs: 0, maxMs: 0, coldAfterMs: 0 },
        },
    });

    console.log(
        `Sandbox chat with ${sop.sop.identity.name} · model ${env.CHAT_MODEL} · no WhatsApp, no waiting.\nType a message and press Enter. Ctrl+C to quit.\n`,
    );
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    rl.on('close', () => process.exit(0));
    let n = 0;
    for (;;) {
        const text = (await rl.question('You: ')).trim();
        if (!text) continue;
        const id = `SANDBOX${++n}`;
        const msg: InboundMessage = {
            chatJid: CHAT,
            replyJid: CHAT,
            senderJid: CHAT,
            pushName: 'Test',
            isGroup: false,
            addressedToBot: true,
            text,
            waMsgId: id,
            key: { remoteJid: CHAT, id, fromMe: false },
            ts: Date.now(),
        };
        bot.receive(msg);
        await bot.idle();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
