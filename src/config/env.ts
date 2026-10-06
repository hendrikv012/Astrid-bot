import 'dotenv/config';
import { z } from 'zod';

const bool = z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
    v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);

/**
 * Turns `37255512345`, `+372 555 12345` or a full JID into a WhatsApp JID.
 * Returns null for anything else (e.g. a placeholder left in .env).
 */
export function normalizeJid(raw: string): string | null {
    const v = raw.trim();
    const lid = /^(\d{5,20})@lid$/.exec(v);
    if (lid) return `${lid[1]}@lid`;
    const pn = /^\+?([\d\s-]{6,25})(@s\.whatsapp\.net|@c\.us)?$/.exec(v);
    if (!pn) return null;
    const digits = pn[1]!.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15 || digits.startsWith('0'))
        return null;
    return `${digits}@s.whatsapp.net`;
}

const jidHelp =
    'use the number with country code, e.g. 31612345678 (no leading 0) or 31612345678@s.whatsapp.net';

const jid = z.string().transform((v, ctx) => {
    const j = normalizeJid(v);
    if (!j) {
        ctx.addIssue({
            code: 'custom',
            message: `"${v}" is not a WhatsApp number: ${jidHelp}`,
        });
        return z.NEVER;
    }
    return j;
});

const jidList = csv.transform((list, ctx) =>
    list.map((v) => {
        const j = normalizeJid(v);
        if (!j)
            ctx.addIssue({
                code: 'custom',
                message: `"${v}" is not a WhatsApp number: ${jidHelp}`,
            });
        return j ?? '';
    }),
);

const EnvSchema = z
    .object({
        LOG_LEVEL: z
            .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
            .default('info'),

        OLLAMA_HOST: z.string().url().default('http://127.0.0.1:11434'),
        CHAT_MODEL: z.string().default('qwen2.5:14b-instruct'),
        EXTRACT_MODEL: z.string().optional(),
        EMBED_MODEL: z.string().default('nomic-embed-text'),
        EMBED_DIM: z.coerce.number().int().positive().default(768),
        LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
        LLM_SEED: z.coerce.number().int().default(42),
        LLM_NUM_CTX: z.coerce.number().int().positive().default(8192),
        // Max tokens per model reply; stops a stuck model instead of waiting forever.
        LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(600),
        // Model calls at the same time; set Ollama's OLLAMA_NUM_PARALLEL to the same value.
        LLM_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
        // Background memory work waiting longer than this goes ahead of replies.
        BACKGROUND_MAX_WAIT_SEC: z.coerce
            .number()
            .int()
            .min(5)
            .max(3600)
            .default(120),

        DB_PATH: z.string().default('data/astrid.db'),
        AUTH_DIR: z.string().default('data/auth'),
        CONFIG_DIR: z.string().default('config'),
        KNOWLEDGE_DIR: z.string().default('knowledge'),

        OWNER_JID: jid.optional(),
        PAIRING_NUMBER: z.string().optional(),
        ALLOWED_JIDS: jidList.default([]),
        REPLY_IN_GROUPS: bool.default(false),

        DASHBOARD_ENABLED: bool.default(true),
        DASHBOARD_HOST: z.string().default('127.0.0.1'),
        DASHBOARD_PORT: z.coerce.number().int().min(0).max(65535).default(3210),
        DASHBOARD_TOKEN: z.string().min(16).optional(),

        // Outgoing messages per minute for the whole number (lower = lower ban risk);
        // replies wait when it's reached, never dropped.
        OUTBOUND_MAX_PER_MIN: z.coerce
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(120),
        // From this share of the cap, multi-bubble replies are merged into one message.
        OUTBOUND_MERGE_AT: z.coerce.number().min(0).max(1).default(0.5),

        HUMANIZE: bool.default(true),
        // Bounds below match src/config/runtime.ts (dashboard settings).
        TYPING_CPS_MIN: z.coerce.number().min(1).max(30).default(5),
        TYPING_CPS_MAX: z.coerce.number().min(1).max(30).default(7),
        FIRST_REPLY_MIN_MS: z.coerce
            .number()
            .int()
            .min(0)
            .max(3_600_000)
            .default(20000),
        FIRST_REPLY_MAX_MS: z.coerce
            .number()
            .int()
            .min(0)
            .max(3_600_000)
            .default(150000),
        COLD_START_AFTER_MIN: z.coerce.number().min(0).max(10080).default(60),
        TYPING_PAUSE_CHANCE: z.coerce.number().min(0).max(1).default(0.25),
        DISTRACTION_CHANCE: z.coerce.number().min(0).max(1).default(0.1),
        DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(3000),
        DEBOUNCE_MAX_MS: z.coerce.number().int().nonnegative().default(10000),

        HISTORY_MESSAGES: z.coerce.number().int().min(2).max(200).default(20),
        SUMMARIZE_AFTER: z.coerce.number().int().positive().default(40),
        RAG_TOP_K: z.coerce.number().int().min(0).max(30).default(6),
        RAG_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.6),
        IMAGE_RESEND_HOURS: z.coerce.number().min(0).max(720).default(24),
    })
    .refine((e) => e.TYPING_CPS_MIN <= e.TYPING_CPS_MAX, {
        message: 'TYPING_CPS_MIN must be ≤ TYPING_CPS_MAX',
        path: ['TYPING_CPS_MIN'],
    })
    .refine((e) => e.FIRST_REPLY_MIN_MS <= e.FIRST_REPLY_MAX_MS, {
        message: 'FIRST_REPLY_MIN_MS must be ≤ FIRST_REPLY_MAX_MS',
        path: ['FIRST_REPLY_MIN_MS'],
    });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
    // Treat `KEY=` lines in .env as unset so defaults apply.
    const cleaned = Object.fromEntries(
        Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
    );
    const parsed = EnvSchema.safeParse(cleaned);
    if (!parsed.success) {
        throw new Error(
            `Invalid environment configuration:\n${z.prettifyError(parsed.error)}`,
        );
    }
    return parsed.data;
}
