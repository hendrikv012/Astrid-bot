import { z } from 'zod';
import type { ChatMessage, LlmClient } from '../brain/llm.js';
import type { Logger } from '../logger.js';
import type { ChatMemory, StoredMessage } from './ChatMemory.js';

export interface ExtractorOptions {
    llm: LlmClient;
    model?: string;
    log: Logger;
    /** Messages kept verbatim in the prompt; older ones get summarized. */
    historyMessages: number;
    /** Summarize once this many messages exist beyond the current summary. */
    summarizeAfter: number;
}

const FactsOutput = z.object({
    facts: z.array(
        z.object({
            subject: z.string(),
            key: z.string().regex(/^[a-z0-9_]{1,40}$/),
            value: z.string().min(1).max(300),
            confidence: z.number().min(0).max(1),
        }),
    ),
    forget: z.array(z.object({ subject: z.string(), key: z.string() })),
});

const SummaryOutput = z.object({ summary: z.string().min(1).max(2000) });

/**
 * Background memory maintenance for ONE chat. It only ever reads from and
 * writes to the ChatMemory it is given, so extraction for chat A can never
 * produce facts in chat B.
 */
export async function runExtraction(
    mem: ChatMemory,
    opts: ExtractorOptions,
    senderNames: Map<string, string> = new Map(),
): Promise<void> {
    await embedPending(mem, opts);
    await extractFacts(mem, opts, senderNames);
    await maybeSummarize(mem, opts);
}

async function embedPending(
    mem: ChatMemory,
    { llm }: ExtractorOptions,
): Promise<void> {
    const pending = mem.unembeddedMessages(64);
    if (!pending.length) return;
    const vectors = await llm.embed(
        pending.map((m) => `search_document: ${m.text}`),
        { priority: 'background' },
    );
    pending.forEach((m, i) => mem.storeMessageEmbedding(m.id, vectors[i]!));
}

async function extractFacts(
    mem: ChatMemory,
    { llm, model, log }: ExtractorOptions,
    senderNames: Map<string, string>,
): Promise<void> {
    const upto = mem.getExtractedUpto();
    const fresh = mem.messagesAfter(upto, 30);
    const newInbound = fresh.filter((m) => m.direction === 'in');
    if (!newInbound.length) {
        if (fresh.length) mem.setExtractedUpto(fresh.at(-1)!.id);
        return;
    }

    // Subjects the model may use: 'chat' (private partner) or a group member label.
    const labelToJid = new Map<string, string>();
    for (const m of newInbound) {
        if (m.senderJid && senderNames.size) {
            labelToJid.set(
                senderNames.get(m.senderJid) ?? m.senderJid,
                m.senderJid,
            );
        }
    }
    const isGroup = labelToJid.size > 0;

    const known = mem
        .getFacts()
        .map((f) => `- [${f.subject}] ${f.key}: ${f.value}`)
        .join('\n');

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: [
                'You maintain a small fact sheet about the customer(s) in ONE WhatsApp conversation.',
                'Extract only durable facts the customer stated about themselves: name, preferences, appointments they asked for, products they own, important dates, contact details they volunteered.',
                'Do NOT store business information, guesses, the assistant’s statements, or anything the customer did not say.',
                'Keys are short snake_case like name, preferred_day, allergy, requested_service.',
                isGroup
                    ? `This is a group chat. "subject" must be one of: ${[...labelToJid.keys()].map((l) => JSON.stringify(l)).join(', ')}.`
                    : 'This is a private chat. "subject" must be "chat".',
                'Use "forget" for facts the customer corrected or withdrew.',
                'Return {"facts": [], "forget": []} if nothing new.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: `Current facts:\n${known || '(none)'}\n\nNew messages:\n${renderTranscript(fresh, senderNames)}`,
        },
    ];

    try {
        const out = await llm.chatJson(messages, FactsOutput, {
            model,
            priority: 'background',
        });
        const lastInbound = newInbound.at(-1)!.id;
        for (const f of out.facts) {
            const subject = isGroup ? labelToJid.get(f.subject) : 'chat';
            if (!subject || f.confidence < 0.6) continue;
            mem.upsertFact({
                subject,
                key: f.key,
                value: f.value,
                confidence: f.confidence,
                sourceMsgId: lastInbound,
            });
        }
        for (const f of out.forget) {
            const subject = isGroup ? labelToJid.get(f.subject) : 'chat';
            if (subject) mem.deleteFact(subject, f.key);
        }
        mem.setExtractedUpto(fresh.at(-1)!.id);
    } catch (err) {
        log.warn(
            { err, chat: mem.chatJid },
            'fact extraction failed; will retry next turn',
        );
    }
}

async function maybeSummarize(
    mem: ChatMemory,
    { llm, model, log, historyMessages, summarizeAfter }: ExtractorOptions,
): Promise<void> {
    const current = mem.getSummary();
    const unsummarized = mem.messagesAfter(
        current?.uptoMsgId ?? 0,
        summarizeAfter + historyMessages + 1,
    );
    if (unsummarized.length <= summarizeAfter + historyMessages) return;

    // Fold everything except the most recent window (which stays verbatim).
    const toFold = unsummarized.slice(0, unsummarized.length - historyMessages);
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'Update the running summary of ONE WhatsApp conversation between a business assistant and a customer. ' +
                'Keep what matters for future replies: what the customer wanted, decisions, open questions, promises made. ' +
                'Max 8 sentences, third person, no invented details.',
        },
        {
            role: 'user',
            content: `Existing summary:\n${current?.summary ?? '(none)'}\n\nMessages to add:\n${renderTranscript(toFold)}`,
        },
    ];
    try {
        const out = await llm.chatJson(messages, SummaryOutput, {
            model,
            priority: 'background',
        });
        mem.setSummary(out.summary, toFold.at(-1)!.id);
    } catch (err) {
        log.warn({ err, chat: mem.chatJid }, 'summary update failed');
    }
}

function renderTranscript(
    msgs: StoredMessage[],
    names: Map<string, string> = new Map(),
): string {
    return msgs
        .map((m) => {
            const who =
                m.direction === 'out'
                    ? 'Assistant'
                    : m.senderJid && names.size
                      ? (names.get(m.senderJid) ?? m.senderJid)
                      : 'Customer';
            return `${who}: ${m.text || (m.imageId ? `[image ${m.imageId}]` : '')}`;
        })
        .join('\n');
}
