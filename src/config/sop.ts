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
        escalation: z
            .object({
                notify_owner: z.boolean().default(true),
                pause_bot_minutes: z.number().int().nonnegative().default(0),
                triggers: z
                    .array(
                        z
                            .object({
                                id,
                                reason: z.string().min(1),
                                keywords,
                            })
                            .strict(),
                    )
                    .default([]),
            })
            .strict(),
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
                escalation: z.string().min(1),
                unknown: z.string().min(1),
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
            ...sop.escalation.triggers.map((t) => t.id),
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
