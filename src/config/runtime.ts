import { z } from 'zod';
import type { DB } from '../memory/db.js';
import type { Env } from './env.js';

/**
 * Settings that can be changed while the bot runs (from the dashboard).
 * Startup values come from .env; dashboard changes are saved in the DB `meta`
 * table as overrides of only the keys that differ from .env.
 *
 * Bounds here must match src/config/env.ts so any valid .env is also a valid
 * runtime setting (tests/runtime.test.ts checks this).
 */
const RuntimeSettingsObject = z
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
    .strict();

export const RuntimeSettingsSchema = RuntimeSettingsObject.refine(
    (s) => s.typingCpsMin <= s.typingCpsMax,
    { message: 'typingCpsMin must be ≤ typingCpsMax', path: ['typingCpsMin'] },
).refine((s) => s.firstReplyMinSec <= s.firstReplyMaxSec, {
    message: 'firstReplyMinSec must be ≤ firstReplyMaxSec',
    path: ['firstReplyMinSec'],
});

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type RuntimeKey = keyof RuntimeSettings;

const FIELDS = RuntimeSettingsObject.shape;
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

function readOverrides(db: DB): Record<string, unknown> {
    const row = db
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .get(META_KEY) as { value: string } | undefined;
    if (!row) return {};
    try {
        const parsed: unknown = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/**
 * .env values with saved dashboard overrides on top. Each saved key is
 * validated on its own, so one stale or invalid key is dropped (and reported)
 * instead of silently discarding every saved setting.
 */
export function loadRuntimeSettings(
    db: DB,
    base: RuntimeSettings,
    warn: (msg: string) => void = () => {},
): RuntimeSettings {
    const kept: Partial<Record<RuntimeKey, unknown>> = {};
    for (const [key, value] of Object.entries(readOverrides(db))) {
        const field = FIELDS[key as RuntimeKey];
        if (!field) {
            warn(`Ignoring unknown saved dashboard setting "${key}".`);
        } else if (!field.safeParse(value).success) {
            warn(`Ignoring invalid saved dashboard setting "${key}".`);
        } else {
            kept[key as RuntimeKey] = value;
        }
    }

    let merged = RuntimeSettingsSchema.safeParse({ ...base, ...kept });
    if (!merged.success) {
        // Cross-field checks (min ≤ max): drop the saved keys involved.
        for (const issue of merged.error.issues) {
            const key = issue.path[0] as RuntimeKey | undefined;
            if (key && key in kept) {
                warn(
                    `Ignoring saved dashboard setting "${key}": ${issue.message}.`,
                );
                delete kept[key];
            }
        }
        merged = RuntimeSettingsSchema.safeParse({ ...base, ...kept });
    }
    return merged.success ? merged.data : base;
}

/** Stores only the keys that differ from .env, so other .env edits still apply. */
export function saveRuntimeSettings(
    db: DB,
    s: RuntimeSettings,
    base: RuntimeSettings,
): RuntimeKey[] {
    const diff: Partial<RuntimeSettings> = {};
    for (const key of Object.keys(s) as RuntimeKey[]) {
        if (s[key] !== base[key])
            (diff as Record<string, unknown>)[key] = s[key];
    }
    db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(META_KEY, JSON.stringify(diff));
    return Object.keys(diff) as RuntimeKey[];
}

/**
 * Live settings: holds the current values, persists dashboard changes and
 * pushes every change into the running bot via the attached `apply`.
 */
export class RuntimeStore {
    private current: RuntimeSettings;
    private apply: (s: RuntimeSettings) => void = () => {};

    constructor(
        private readonly db: DB,
        readonly defaults: RuntimeSettings,
        warn: (msg: string) => void = () => {},
    ) {
        this.current = loadRuntimeSettings(db, defaults, warn);
    }

    get(): RuntimeSettings {
        return this.current;
    }

    /** Keys currently overriding .env. */
    overrides(): RuntimeKey[] {
        return (Object.keys(this.current) as RuntimeKey[]).filter(
            (k) => this.current[k] !== this.defaults[k],
        );
    }

    /** Starts pushing settings into the live bot (applies the current ones now). */
    attach(apply: (s: RuntimeSettings) => void): void {
        this.apply = apply;
        apply(this.current);
    }

    /** `next` must already be validated with RuntimeSettingsSchema. */
    set(next: RuntimeSettings): void {
        this.current = next;
        saveRuntimeSettings(this.db, next, this.defaults);
        this.apply(next);
    }

    /** Drops all dashboard overrides and goes back to .env. */
    reset(): void {
        this.set({ ...this.defaults });
    }
}
