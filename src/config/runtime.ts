import { z } from 'zod';
import type { DB } from '../memory/db.js';
import type { Env } from './env.js';

/**
 * Settings that can be changed while the bot runs (from the dashboard).
 * Startup values come from .env; saved changes live in the DB `meta` table
 * and override .env on the next start.
 */
export const RuntimeSettingsSchema = z
    .object({
        chatModel: z.string().min(1),
        temperature: z.number().min(0).max(2),
        humanize: z.boolean(),
        typingCpsMin: z.number().min(1).max(30),
        typingCpsMax: z.number().min(1).max(30),
        firstReplyMinSec: z.number().min(0).max(3600),
        firstReplyMaxSec: z.number().min(0).max(3600),
        coldStartAfterMin: z.number().min(0).max(10080),
        typingPauseChance: z.number().min(0).max(1),
        distractionChance: z.number().min(0).max(1),
        replyInGroups: z.boolean(),
        historyMessages: z.number().int().min(2).max(200),
        ragTopK: z.number().int().min(0).max(30),
        ragMaxDistance: z.number().min(0).max(2),
        imageResendHours: z.number().min(0).max(720),
    })
    .strict()
    .refine((s) => s.typingCpsMin <= s.typingCpsMax, {
        message: 'typingCpsMin must be ≤ typingCpsMax',
        path: ['typingCpsMin'],
    })
    .refine((s) => s.firstReplyMinSec <= s.firstReplyMaxSec, {
        message: 'firstReplyMinSec must be ≤ firstReplyMaxSec',
        path: ['firstReplyMinSec'],
    });

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

const META_KEY = 'runtime_settings';

export function settingsFromEnv(env: Env): RuntimeSettings {
    return {
        chatModel: env.CHAT_MODEL,
        temperature: env.LLM_TEMPERATURE,
        humanize: env.HUMANIZE,
        typingCpsMin: env.TYPING_CPS_MIN,
        typingCpsMax: env.TYPING_CPS_MAX,
        firstReplyMinSec: env.FIRST_REPLY_MIN_MS / 1000,
        firstReplyMaxSec: env.FIRST_REPLY_MAX_MS / 1000,
        coldStartAfterMin: env.COLD_START_AFTER_MIN,
        typingPauseChance: env.TYPING_PAUSE_CHANCE,
        distractionChance: env.DISTRACTION_CHANCE,
        replyInGroups: env.REPLY_IN_GROUPS,
        historyMessages: env.HISTORY_MESSAGES,
        ragTopK: env.RAG_TOP_K,
        ragMaxDistance: env.RAG_MAX_DISTANCE,
        imageResendHours: env.IMAGE_RESEND_HOURS,
    };
}

/** .env values with any saved dashboard changes on top. Invalid saved data is ignored. */
export function loadRuntimeSettings(
    db: DB,
    base: RuntimeSettings,
): RuntimeSettings {
    const row = db
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .get(META_KEY) as { value: string } | undefined;
    if (!row) return base;
    try {
        const saved = JSON.parse(row.value) as Partial<RuntimeSettings>;
        const merged = RuntimeSettingsSchema.safeParse({ ...base, ...saved });
        return merged.success ? merged.data : base;
    } catch {
        return base;
    }
}

export function saveRuntimeSettings(db: DB, s: RuntimeSettings): void {
    db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(META_KEY, JSON.stringify(s));
}
