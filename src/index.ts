import crypto from 'node:crypto';
import path from 'node:path';
import { WAMessageStubType } from 'baileys';
import { createModelClients } from './brain/clients.js';
import { sameModel } from './brain/llm.js';
import { corePromptTokens } from './brain/prompt.js';
import { isBehind } from './brain/scheduler.js';
import { loadEnv } from './config/env.js';
import { loadImages } from './config/images.js';
import { loadPersona } from './config/persona.js';
import { RuntimeStore, settingsFromEnv } from './config/runtime.js';
import { loadSop } from './config/sop.js';
import { applyRuntimeSettings } from './dashboard/admin.js';
import { startDashboard } from './dashboard/server.js';
import type { DB } from './memory/db.js';
import { logger } from './logger.js';
import { BoundedSet } from './util/boundedSet.js';
import { openDb } from './memory/db.js';
import { Bot } from './pipeline/bot.js';
import { ingestKnowledge } from './rag/ingest.js';
import { startConnection } from './whatsapp/connection.js';
import { normalizeInbound, preferPn } from './whatsapp/inbound.js';
import { OutboundLimiter } from './whatsapp/outboundLimiter.js';
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

    warnIfContextTooSmall(
        corePromptTokens(persona, sop.sop),
        env.LLM_NUM_CTX,
        env.LLM_MAX_TOKENS,
    );

    const db = openDb({ path: env.DB_PATH, embedDim: env.EMBED_DIM });
    const models = createModelClients(env, {
        onChatProgress: (p) => logger.info(p, 'model still working'),
        onChatDone: ({ model, ms }) =>
            logger.info(
                { model, seconds: Math.round(ms / 100) / 10 },
                'model answered',
            ),
    });
    const llm = models.main;
    await models.assertModels();
    if (models.helper)
        logger.info(
            { replies: env.OLLAMA_HOST, helper: env.HELPER_OLLAMA_HOST },
            'replies on the main server; embeddings and memory work on the helper',
        );

    // Live-tunable settings: .env values with saved dashboard changes on top.
    const runtime = new RuntimeStore(db, settingsFromEnv(env), (m) =>
        logger.warn(m),
    );
    // Check the chat model the bot will actually use (a dashboard choice wins over .env).
    const chatModels = await llm.listChatModels();
    const usable = (m: string) => chatModels.some((c) => sameModel(c, m));
    const chosen = runtime.get().chatModel;
    const chatModelSet = !!process.env.CHAT_MODEL?.trim();
    if (!usable(chosen)) {
        if (chosen !== env.CHAT_MODEL && usable(env.CHAT_MODEL)) {
            logger.warn(
                `Chat model "${chosen}" picked in the dashboard is not installed; falling back to CHAT_MODEL "${env.CHAT_MODEL}".`,
            );
            runtime.set({ ...runtime.get(), chatModel: env.CHAT_MODEL });
        } else if (!chatModelSet && chatModels.length === 1) {
            // No CHAT_MODEL in .env and only one chat model installed: use it.
            logger.warn(
                `CHAT_MODEL is not set in .env; using the only installed chat model "${chatModels[0]}".`,
            );
            runtime.set({ ...runtime.get(), chatModel: chatModels[0]! });
        } else {
            const installed = chatModels.length
                ? `Installed chat models: ${chatModels.join(', ')}. Put one of these in .env as CHAT_MODEL=<name>`
                : 'No chat models are installed in Ollama (ollama list)';
            throw new Error(
                `Chat model "${chosen}" is not installed in Ollama (or can't chat)` +
                    (chatModelSet
                        ? ''
                        : ` — CHAT_MODEL is not set in .env (run from the folder that has .env)`) +
                    `. ${installed}.`,
            );
        }
    }

    // Keep the knowledge base in sync on every start (only changed files are re-embedded).
    const kb = await ingestKnowledge(
        db,
        models.embedder,
        env.KNOWLEDGE_DIR,
        (m) => logger.info(`knowledge: ${m}`),
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

    // Queued model calls: customer replies before background work (which goes
    // to the helper server when HELPER_OLLAMA_HOST is set).
    const scheduledLlm = models.queued;

    let bot: Bot | null = null;
    // Only recent ids matter (echoes arrive within seconds); keep memory flat.
    const botSentIds = new BoundedSet<string>(5000);

    const conn = await startConnection({
        authDir: env.AUTH_DIR,
        pairingNumber: env.PAIRING_NUMBER,
        log: logger,
        onMessages: (messages) => {
            if (!bot) return;
            for (const m of messages) {
                if (
                    !m.key.fromMe &&
                    m.messageStubType === WAMessageStubType.CIPHERTEXT
                ) {
                    // Common right after linking: WhatsApp resends it once keys are exchanged.
                    logger.warn(
                        {
                            chat: preferPn(
                                m.key.remoteJid ?? '',
                                m.key.remoteJidAlt,
                            ),
                            reason: m.messageStubParameters?.[0],
                        },
                        'could not decrypt an incoming message yet; WhatsApp usually resends it within a minute',
                    );
                    continue;
                }
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

    const outbound = new OutboundLimiter({
        maxPerMinute: env.OUTBOUND_MAX_PER_MIN,
        mergeAt: env.OUTBOUND_MERGE_AT,
    });
    const senderOpts = {
        limiter: outbound,
        humanize: env.HUMANIZE,
        typing: {
            cpsMin: env.TYPING_CPS_MIN,
            cpsMax: env.TYPING_CPS_MAX,
            firstReplyMinMs: env.FIRST_REPLY_MIN_MS,
            firstReplyMaxMs: env.FIRST_REPLY_MAX_MS,
            pauseChance: env.TYPING_PAUSE_CHANCE,
            distractionChance: env.DISTRACTION_CHANCE,
        },
    };
    // Same object the dashboard mutates (applyRuntimeSettings), so no copies.
    const rawSender = createSender(conn.getSock, senderOpts);
    // Remember ids of bot-sent messages so they aren't mistaken for a human takeover.
    const sender: typeof rawSender = {
        ...rawSender,
        send: async (plan) => {
            const sent = await rawSender.send(plan);
            for (const s of sent) if (s.waMsgId) botSentIds.add(s.waMsgId);
            return sent;
        },
        sendRaw: async (jid, text) => {
            const id = await rawSender.sendRaw(jid, text);
            if (id) botSentIds.add(id);
            return id;
        },
    };

    bot = new Bot({
        db,
        llm: scheduledLlm,
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
            firstReply: {
                minMs: env.FIRST_REPLY_MIN_MS,
                maxMs: env.HUMANIZE ? env.FIRST_REPLY_MAX_MS : 0,
                coldAfterMs: env.COLD_START_AFTER_MIN * 60_000,
            },
        },
    });

    logger.info(
        {
            owner: env.OWNER_JID ?? 'not set (no purchase alerts)',
            answers: env.ALLOWED_JIDS.length
                ? env.ALLOWED_JIDS
                : 'everyone who messages the bot',
            firstReplySec: env.HUMANIZE
                ? `${env.FIRST_REPLY_MIN_MS / 1000}-${env.FIRST_REPLY_MAX_MS / 1000}`
                : 0,
            humanize: env.HUMANIZE,
        },
        'bot ready',
    );

    const liveBot = bot;
    runtime.attach((s) =>
        applyRuntimeSettings(s, {
            llm,
            sender: senderOpts,
            bot: liveBot.settings,
        }),
    );

    const knowledgeSync = () =>
        ingestKnowledge(db, scheduledLlm, env.KNOWLEDGE_DIR, (m) =>
            logger.info(`knowledge: ${m}`),
        );

    let dashboard: Awaited<ReturnType<typeof startDashboard>> | null = null;
    if (env.DASHBOARD_ENABLED) {
        const token = env.DASHBOARD_TOKEN ?? dashboardToken(db);
        try {
            dashboard = await startDashboard({
                db,
                log: logger,
                token,
                host: env.DASHBOARD_HOST,
                port: env.DASHBOARD_PORT,
                bot: liveBot,
                paths: {
                    sopFile: path.join(env.CONFIG_DIR, 'astrid.sop.yaml'),
                    personaFile: path.join(env.CONFIG_DIR, 'persona.md'),
                    knowledgeDir: env.KNOWLEDGE_DIR,
                    publicDir: 'dashboard',
                },
                images,
                runtime,
                connection: conn.state,
                load: () => ({
                    scheduler: scheduledLlm.stats(),
                    outbound: outbound.stats(),
                }),
                listChatModels: () => llm.listChatModels(),
                reingest: knowledgeSync,
            });
            const addr = dashboard.address() as { port: number };
            logger.info(
                `Dashboard: http://${env.DASHBOARD_HOST === '0.0.0.0' ? 'localhost' : env.DASHBOARD_HOST}:${addr.port}/#token=${token}`,
            );
            if (
                env.DASHBOARD_HOST !== '127.0.0.1' &&
                env.DASHBOARD_HOST !== 'localhost'
            ) {
                logger.warn(
                    'Dashboard is reachable from other machines. It shows customer chats — keep the token secret.',
                );
            }
        } catch (err) {
            // The dashboard is optional: never take the WhatsApp bot down with it.
            logger.error(
                { err },
                `Dashboard could not start on ${env.DASHBOARD_HOST}:${env.DASHBOARD_PORT}; the bot keeps running without it. Change DASHBOARD_PORT or set DASHBOARD_ENABLED=false.`,
            );
        }
    }

    // Warn in the log (at most once a minute) when replies fall behind.
    let lastBehindWarn = 0;
    setInterval(() => {
        const s = scheduledLlm.stats();
        if (isBehind(s) && Date.now() - lastBehindWarn > 60_000) {
            lastBehindWarn = Date.now();
            logger.warn(
                { ...s, outbound: outbound.stats() },
                `Behind: replies wait ~${Math.round(s.replyWaitAvgMs / 1000)}s for the model. Consider a smaller CHAT_MODEL, EXTRACT_MODEL, more OLLAMA_NUM_PARALLEL/LLM_CONCURRENCY or another GPU.`,
            );
        }
    }, 30_000).unref();

    const shutdown = async (signal: string) => {
        dashboard?.close();
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

/**
 * The rules, persona and examples are never trimmed. When they don't fit in
 * LLM_NUM_CTX next to the reply, Ollama cuts off the start of the prompt
 * (the rules), so the bot ignores its SOP.
 */
function warnIfContextTooSmall(
    core: number,
    numCtx: number,
    maxTokens: number,
): void {
    // Room left for memory, knowledge and the conversation itself.
    const room = numCtx - maxTokens - core;
    if (room < 512) {
        logger.warn(
            {
                rulesTokens: core,
                LLM_NUM_CTX: numCtx,
                LLM_MAX_TOKENS: maxTokens,
            },
            `LLM_NUM_CTX is too small: the SOP, persona and examples alone need ~${core} tokens, leaving ${room} for knowledge and the conversation. The model will lose rules or context. Use LLM_NUM_CTX=${Math.max(4096, 2 ** Math.ceil(Math.log2(core + maxTokens + 1024)))} or shorten the persona/SOP.`,
        );
    }
}

/** A random dashboard token, generated once and kept in the DB across restarts. */
function dashboardToken(db: DB): string {
    const row = db
        .prepare(`SELECT value FROM meta WHERE key = 'dashboard_token'`)
        .get() as { value: string } | undefined;
    if (row) return row.value;
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare(
        `INSERT INTO meta (key, value) VALUES ('dashboard_token', ?)`,
    ).run(token);
    return token;
}

main().catch((err) => {
    logger.fatal({ err }, 'startup failed');
    process.exit(1);
});
