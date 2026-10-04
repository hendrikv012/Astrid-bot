import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    checkInbound,
    checkReply,
    cleanWhatsAppText,
    splitBubble,
} from '../src/brain/guard.js';
import type { BotReply } from '../src/brain/reply.js';
import { loadSop } from '../src/config/sop.js';

const { sop } = loadSop(
    path.resolve(import.meta.dirname, '../config/astrid.sop.yaml'),
);

const reply = (over: Partial<BotReply>): BotReply => ({
    messages: ['Hoi!'],
    image_id: null,
    escalate: false,
    escalate_reason: null,
    flow_done: false,
    ...over,
});

const ctx = (over: Partial<Parameters<typeof checkReply>[1]> = {}) => ({
    sop,
    foreignIdentifiers: [],
    allowedImageIds: new Set(['price_list']),
    ...over,
});

describe('checkInbound', () => {
    it('detects escalation before forbidden topics', () => {
        expect(checkInbound('Ik wil een klacht indienen', sop)).toMatchObject({
            kind: 'escalate',
            triggerId: 'E2_complaint',
        });
        expect(
            checkInbound('wat vind je van de verkiezingen', sop),
        ).toMatchObject({ kind: 'forbidden' });
        expect(checkInbound('wat kost knippen?', sop)).toEqual({ kind: 'ok' });
    });
});

describe('checkReply', () => {
    it('blocks replies that mention another chat’s identifiers', () => {
        const r = checkReply(
            reply({ messages: ['Sanne had dezelfde vraag!'] }),
            ctx({ foreignIdentifiers: ['sanne'] }),
        );
        expect(r.blocked).toBe(true);
        expect(r.violations).toContainEqual({ kind: 'leak', value: 'sanne' });
    });

    it('does not flag substrings of other words', () => {
        const r = checkReply(
            reply({ messages: ['Annelies? Nee.'] }),
            ctx({ foreignIdentifiers: ['anne'] }),
        );
        expect(r.blocked).toBe(false);
    });

    it('blocks persona drift', () => {
        const r = checkReply(
            reply({ messages: ['As an AI language model I cannot do that'] }),
            ctx(),
        );
        expect(r.blocked).toBe(true);
        expect(r.violations[0]).toMatchObject({ kind: 'drift' });
    });

    it('allows an honest "digital assistant" answer', () => {
        const r = checkReply(
            reply({
                messages: ['Nee, ik ben Astrid, de digitale assistent 🙂'],
            }),
            ctx(),
        );
        expect(r.blocked).toBe(false);
    });

    it('enforces SOP limits and drops disallowed images', () => {
        const long = 'Dit is een zin. '.repeat(60);
        const r = checkReply(
            reply({
                messages: [long, 'b', 'c', 'd'],
                image_id: 'unknown' as never,
            }),
            ctx(),
        );
        expect(r.reply.messages.length).toBe(sop.limits.max_messages_per_reply);
        for (const m of r.reply.messages)
            expect(m.length).toBeLessThanOrEqual(
                sop.limits.max_chars_per_message,
            );
        expect(r.reply.image_id).toBeNull();
        expect(r.blocked).toBe(false);
    });

    it('replaces an empty reply with the unknown template', () => {
        const r = checkReply(reply({ messages: ['  '] }), ctx());
        expect(r.reply.messages).toEqual([sop.templates.unknown]);
    });
});

describe('text helpers', () => {
    it('strips markdown', () => {
        expect(cleanWhatsAppText('## Prijzen\n- **Knippen**: €45')).toBe(
            'Prijzen\nKnippen: €45',
        );
    });
    it('splits long bubbles at sentence boundaries', () => {
        const parts = splitBubble('Een. Twee. Drie.', 10);
        expect(parts).toEqual(['Een. Twee.', 'Drie.']);
    });
});
