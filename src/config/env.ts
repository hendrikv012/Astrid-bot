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

const EnvSchema = z.object({
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

    DB_PATH: z.string().default('data/astrid.db'),
    AUTH_DIR: z.string().default('data/auth'),
    CONFIG_DIR: z.string().default('config'),
    KNOWLEDGE_DIR: z.string().default('knowledge'),

    OWNER_JID: z.string().optional(),
    PAIRING_NUMBER: z.string().optional(),
    ALLOWED_JIDS: csv.default([]),
    REPLY_IN_GROUPS: bool.default(false),

    HUMANIZE: bool.default(true),
    TYPING_CPS_MIN: z.coerce.number().positive().default(5),
    TYPING_CPS_MAX: z.coerce.number().positive().default(7),
    DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(3000),
    DEBOUNCE_MAX_MS: z.coerce.number().int().nonnegative().default(10000),

    HISTORY_MESSAGES: z.coerce.number().int().positive().default(20),
    SUMMARIZE_AFTER: z.coerce.number().int().positive().default(40),
    RAG_TOP_K: z.coerce.number().int().positive().default(6),
    RAG_MAX_DISTANCE: z.coerce.number().positive().default(0.6),
    IMAGE_RESEND_HOURS: z.coerce.number().nonnegative().default(24),
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
