import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

const id = z
    .string()
    .regex(/^[a-z0-9_]+$/i, 'ids may only contain letters, digits and _');

const keywords = z.array(z.string().min(1)).min(1);

const FlowTrigger = z.union([
    z.object({ first_contact: z.literal(true) }).strict(),
    z.object({ keywords }).strict(),
]);

export const SopSchema = z
    .object({
        version: z.literal(1),
        identity: z
            .object({
                name: z.string().min(1),
                role: z.string().min(1),
                business: z.string().min(1),
                languages: z.array(z.string().min(2)).min(1),
            })
            .strict(),
        hard_rules: z
            .array(z.object({ id, rule: z.string().min(1) }).strict())
            .min(1),
        forbidden_topics: z
            .array(
                z
                    .object({
                        id,
                        description: z.string().min(1),
                        keywords,
                    })
                    .strict(),
            )
            .default([]),
        sales: z
            .object({
                /** Send the owner a WhatsApp alert for purchase signals. */
                notify_owner: z.boolean().default(true),
                /** Code-level backup: these mark a customer as wanting to buy. */
                interest_keywords: z.array(z.string().min(1)).default([]),
                /**
                 * Code-level backup for "agreed to buy". Only counts when the
                 * chat already showed purchase interest, so a stray "deal" or
                 * "akkoord" elsewhere never triggers an alert.
                 */
                agreed_keywords: z.array(z.string().min(1)).default([]),
                /** Don't alert again for the same stage in a chat within this window. */
                renotify_after_hours: z.number().min(0).max(720).default(24),
            })
            .strict()
            .default({
                notify_owner: true,
                interest_keywords: [],
                agreed_keywords: [],
                renotify_after_hours: 24,
            }),
        human_takeover: z
            .object({
                /**
                 * When a person replies (phone or dashboard), the bot stays
                 * silent in that chat for this long. 0 turns takeover off.
                 */
                pause_bot_minutes: z.number().int().nonnegative().default(60),
            })
            .strict()
            .default({ pause_bot_minutes: 60 }),
        flows: z
            .array(
                z
                    .object({
                        id,
                        description: z.string().min(1),
                        trigger: FlowTrigger,
                        steps: z.array(z.string().min(1)).min(1),
                    })
                    .strict(),
            )
            .default([]),
        templates: z
            .object({
                refusal: z.string().min(1),
                unknown: z.string().min(1),
                /** Owner alerts. Placeholders: {customer} {number} {summary} {message} */
                owner_interested: z
                    .string()
                    .min(1)
                    .default(
                        '🛒 Wants to buy: {customer}\nWhat: {summary}\nLast message: "{message}"',
                    ),
                owner_agreed: z
                    .string()
                    .min(1)
                    .default(
                        '✅ Agreed to buy: {customer}\nWhat: {summary}\nLast message: "{message}"',
                    ),
            })
            .strict(),
        limits: z
            .object({
                max_messages_per_reply: z.number().int().min(1).max(10),
                max_chars_per_message: z.number().int().min(20).max(4000),
            })
            .strict(),
    })
    .strict()
    .superRefine((sop, ctx) => {
        const seen = new Set<string>();
        const all = [
            ...sop.hard_rules.map((r) => r.id),
            ...sop.forbidden_topics.map((t) => t.id),
            ...sop.flows.map((f) => f.id),
        ];
        for (const i of all) {
            if (seen.has(i)) {
                ctx.addIssue({
                    code: 'custom',
                    message: `duplicate id "${i}"`,
                });
            }
            seen.add(i);
        }
    });

export type Sop = z.infer<typeof SopSchema>;
export type SopFlow = Sop['flows'][number];

export interface LoadedSop {
    sop: Sop;
    /** SHA-256 of the raw file; stored with every outgoing message. */
    hash: string;
}

export function parseSop(raw: string, source = 'SOP'): LoadedSop {
    let data: unknown;
    try {
        data = YAML.parse(raw);
    } catch (err) {
        throw new Error(`${source}: invalid YAML: ${(err as Error).message}`);
    }
    if (data && typeof data === 'object' && 'escalation' in data) {
        throw new Error(
            `${source}: the "escalation" section was replaced. Use "sales" (owner alerts when a customer wants to buy or agrees to buy) and "human_takeover" (pause_bot_minutes), and remove templates.escalation.`,
        );
    }
    const parsed = SopSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error(
            `${source} failed validation — the bot will not start with an invalid SOP:\n` +
                z.prettifyError(parsed.error),
        );
    }
    const hash = crypto
        .createHash('sha256')
        .update(raw)
        .digest('hex')
        .slice(0, 16);
    return { sop: parsed.data, hash };
}

export function loadSop(file: string): LoadedSop {
    return parseSop(fs.readFileSync(file, 'utf8'), file);
}

/** Case-insensitive whole-word/phrase match. */
export function matchesKeyword(text: string, kws: string[]): string | null {
    const haystack = ` ${normalize(text)} `;
    for (const kw of kws) {
        if (haystack.includes(` ${normalize(kw)} `)) return kw;
    }
    return null;
}

function normalize(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^\p{L}\p{N}+@.]+/gu, ' ')
        .trim();
}
