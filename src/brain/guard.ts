import { matchesKeyword, type Sop } from '../config/sop.js';
import type { BotReply } from './reply.js';

export type InboundVerdict =
    | { kind: 'ok' }
    | { kind: 'escalate'; triggerId: string; reason: string }
    | { kind: 'forbidden'; topicId: string };

/** Runs BEFORE the LLM: SOP escalation triggers and forbidden topics are code, not hope. */
export function checkInbound(text: string, sop: Sop): InboundVerdict {
    for (const t of sop.escalation.triggers) {
        if (matchesKeyword(text, t.keywords)) {
            return { kind: 'escalate', triggerId: t.id, reason: t.reason };
        }
    }
    for (const t of sop.forbidden_topics) {
        if (matchesKeyword(text, t.keywords)) {
            return { kind: 'forbidden', topicId: t.id };
        }
    }
    return { kind: 'ok' };
}

export type Violation =
    | { kind: 'leak'; value: string }
    | { kind: 'drift'; match: string }
    | { kind: 'forbidden'; topicId: string }
    | { kind: 'image_dropped'; imageId: string; why: string }
    | { kind: 'trimmed'; detail: string };

export interface GuardContext {
    sop: Sop;
    /** Identifying values from OTHER chats (see memory/leakIndex.ts). */
    foreignIdentifiers: string[];
    /** Image ids that exist AND were not sent recently in this chat. */
    allowedImageIds: Set<string>;
}

export interface GuardResult {
    reply: BotReply;
    violations: Violation[];
    /** True when the reply must not be sent as-is (caller retries or uses a template). */
    blocked: boolean;
}

/**
 * Phrases that mean the model fell out of character. Kept narrow on purpose:
 * false positives cost a retry, misses cost the persona.
 */
const DRIFT_PATTERNS: RegExp[] = [
    /\bas an? (ai|artificial intelligence|language model|llm)\b/i,
    /\bals (een )?(ai|taalmodel|kunstmatige intelligentie)\b/i,
    /\b(chatgpt|openai|qwen|llama|mistral|gemma|ollama|anthropic|claude)\b/i,
    /\b(system prompt|systeemprompt|my instructions|mijn instructies)\b/i,
];

/** Runs AFTER the LLM: enforces SOP limits and isolation on the reply. */
export function checkReply(raw: BotReply, ctx: GuardContext): GuardResult {
    const violations: Violation[] = [];
    const { limits, templates } = ctx.sop;

    let messages = raw.messages.map(cleanWhatsAppText).filter(Boolean);
    if (messages.length === 0) messages = [templates.unknown];

    // Length: split long bubbles at sentence boundaries, then cap the count.
    messages = messages.flatMap((m) =>
        splitBubble(m, limits.max_chars_per_message),
    );
    if (messages.length > limits.max_messages_per_reply) {
        violations.push({
            kind: 'trimmed',
            detail: `${messages.length} bubbles > ${limits.max_messages_per_reply}`,
        });
        messages = messages.slice(0, limits.max_messages_per_reply);
    }

    let imageId = raw.image_id;
    if (imageId && !ctx.allowedImageIds.has(imageId)) {
        violations.push({
            kind: 'image_dropped',
            imageId,
            why: 'unknown or sent recently',
        });
        imageId = null;
    }

    const joined = messages.join('\n').toLowerCase();
    let blocked = false;

    for (const value of ctx.foreignIdentifiers) {
        if (containsToken(joined, value)) {
            violations.push({ kind: 'leak', value });
            blocked = true;
        }
    }
    for (const re of DRIFT_PATTERNS) {
        const m = re.exec(joined);
        if (m) {
            violations.push({ kind: 'drift', match: m[0] });
            blocked = true;
        }
    }
    for (const t of ctx.sop.forbidden_topics) {
        if (matchesKeyword(joined, t.keywords)) {
            violations.push({ kind: 'forbidden', topicId: t.id });
            blocked = true;
        }
    }

    return {
        reply: { ...raw, messages, image_id: imageId },
        violations,
        blocked,
    };
}

/** Strip markdown the model may emit; WhatsApp is plain text. */
export function cleanWhatsAppText(s: string): string {
    return s
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '$1 $2')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function splitBubble(text: string, max: number): string[] {
    if (text.length <= max) return [text];
    const sentences = text.match(/[^.!?\n]+[.!?]*[\s\n]*/g) ?? [text];
    const out: string[] = [];
    let cur = '';
    for (const s of sentences) {
        if (cur && (cur + s).trim().length > max) {
            out.push(cur.trim());
            cur = '';
        }
        cur += s;
        while (cur.trim().length > max) {
            const cut = cur.lastIndexOf(' ', max);
            const at = cut > max / 2 ? cut : max;
            out.push(cur.slice(0, at).trim());
            cur = cur.slice(at);
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function containsToken(haystack: string, needle: string): boolean {
    const n = needle.toLowerCase();
    let i = haystack.indexOf(n);
    while (i !== -1) {
        const before = haystack[i - 1];
        const after = haystack[i + n.length];
        if (!isWordChar(before) && !isWordChar(after)) return true;
        i = haystack.indexOf(n, i + 1);
    }
    return false;
}

function isWordChar(c: string | undefined): boolean {
    return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}
