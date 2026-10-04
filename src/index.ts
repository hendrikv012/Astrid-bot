import path from 'node:path';
import { OllamaLlm } from './brain/llm.js';
import { loadEnv } from './config/env.js';
import { loadImages } from './config/images.js';
import { loadPersona } from './config/persona.js';
import { loadSop } from './config/sop.js';
import { logger } from './logger.js';
import { openDb } from './memory/db.js';
import { Bot } from './pipeline/bot.js';
import { ingestKnowledge } from './rag/ingest.js';
import { startConnection } from './whatsapp/connection.js';
import { normalizeInbound, preferPn } from './whatsapp/inbound.js';
import { createSender } from './whatsapp/sender.js';

async function main(): Promise<void> {
    const env = loadEnv();
    logger.level = env.LOG_LEVEL;

    // Config first: an invalid SOP, persona or image manifest stops startup.
    const sop = loadSop(path.join(env.CONFIG_DIR, 'astrid.sop.yaml'));
    const persona = loadPersona(
        path.join(env.CONFIG_DIR, 'persona.md'),
        sop.sop.identity.name,
    );
    const images = loadImages(
        path.join(env.CONFIG_DIR, 'images.yaml'),
        'assets/images',
    );
    logger.info(
        {
            sopHash: sop.hash,
            examples: persona.examples.length,
            images: images.size,
        },
        'configuration loaded',
    );

    const db = openDb({ path: env.DB_PATH, embedDim: env.EMBED_DIM });
    const llm = new OllamaLlm({
        host: env.OLLAMA_HOST,
        chatModel: env.CHAT_MODEL,
        embedModel: env.EMBED_MODEL,
        temperature: env.LLM_TEMPERATURE,
        seed: env.LLM_SEED,
        numCtx: env.LLM_NUM_CTX,
    });
    await llm.assertReady([
        env.CHAT_MODEL,
        env.EMBED_MODEL,
        ...(env.EXTRACT_MODEL ? [env.EXTRACT_MODEL] : []),
    ]);

    // Keep the knowledge base in sync on every start (only changed files are re-embedded).
    const kb = await ingestKnowledge(db, llm, env.KNOWLEDGE_DIR, (m) =>
        logger.info(`knowledge: ${m}`),
    );
    logger.info(
        {
            added: kb.added.length,
            updated: kb.updated.length,
            unchanged: kb.unchanged.length,
            removed: kb.removed.length,
        },
        'knowledge base synced',
    );

    let bot: Bot | null = null;
    const botSentIds = new Set<string>();

    const conn = await startConnection({
        authDir: env.AUTH_DIR,
        pairingNumber: env.PAIRING_NUMBER,
        log: logger,
        onMessages: (messages) => {
            if (!bot) return;
            for (const m of messages) {
                const msg = normalizeInbound(m, conn.self());
                if (msg) {
                    bot.receive(msg);
                    continue;
                }
                // Sent from the business phone by a human (not by the bot) → human takeover.
                const id = m.key.id;
                const remote = m.key.remoteJid;
                const text =
                    m.message?.conversation ??
                    m.message?.extendedTextMessage?.text;
                if (
                    m.key.fromMe &&
                    id &&
                    remote &&
                    text &&
                    !botSentIds.has(id) &&
                    !remote.endsWith('@g.us')
                ) {
                    const self = conn.self();
                    const chatJid = preferPn(remote, m.key.remoteJidAlt);
                    if (chatJid !== self.pn && chatJid !== self.lid)
                        bot.humanTookOver(chatJid, text, id);
                }
            }
        },
    });

    const rawSender = createSender(conn.getSock, {
        humanize: env.HUMANIZE,
        typing: { cpsMin: env.TYPING_CPS_MIN, cpsMax: env.TYPING_CPS_MAX },
    });
    // Remember ids of bot-sent messages so they aren't mistaken for a human takeover.
    const sender: typeof rawSender = {
        ...rawSender,
        send: async (plan) => {
            const sent = await rawSender.send(plan);
            for (const s of sent) if (s.waMsgId) botSentIds.add(s.waMsgId);
            return sent;
        },
    };

    bot = new Bot({
        db,
        llm,
        sender,
        sop,
        persona,
        images,
        log: logger,
        settings: {
            ownerJid: env.OWNER_JID,
            allowedJids: env.ALLOWED_JIDS,
            replyInGroups: env.REPLY_IN_GROUPS,
            historyMessages: env.HISTORY_MESSAGES,
            summarizeAfter: env.SUMMARIZE_AFTER,
            ragTopK: env.RAG_TOP_K,
            ragMaxDistance: env.RAG_MAX_DISTANCE,
            imageResendHours: env.IMAGE_RESEND_HOURS,
            numCtx: env.LLM_NUM_CTX,
            debounceMs: env.DEBOUNCE_MS,
            debounceMaxMs: env.DEBOUNCE_MAX_MS,
            extractModel: env.EXTRACT_MODEL,
        },
    });

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'shutting down');
        await conn.close();
        await Promise.race([
            bot?.idle(),
            new Promise((r) => setTimeout(r, 10_000)),
        ]);
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
    logger.fatal({ err }, 'startup failed');
    process.exit(1);
});
