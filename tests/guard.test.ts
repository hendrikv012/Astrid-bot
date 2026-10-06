import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    checkInbound,
    checkReply,
    cleanWhatsAppText,
    detectPurchaseKeywords,
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
    purchase: 'none',
    purchase_summary: null,
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
    it('only blocks forbidden topics (complaints go to the model)', () => {
        expect(checkInbound('Ik wil een klacht indienen', sop)).toEqual({
            kind: 'ok',
        });
        expect(
            checkInbound('wat vind je van de verkiezingen', sop),
        ).toMatchObject({ kind: 'forbidden' });
        expect(checkInbound('wat kost knippen?', sop)).toEqual({ kind: 'ok' });
    });
});

describe('detectPurchaseKeywords', () => {
    it('flags interest and gates agreement on prior interest', () => {
        expect(detectPurchaseKeywords('ik wil bestellen', sop, false)).toBe(
            'interested',
        );
        expect(detectPurchaseKeywords('akkoord', sop, false)).toBe('none');
        expect(detectPurchaseKeywords('akkoord', sop, true)).toBe('agreed');
        expect(detectPurchaseKeywords('wat kost knippen?', sop, false)).toBe(
            'none',
        );
        // "order" alone is not a keyword ("in order to")
        expect(
            detectPurchaseKeywords('in order to know, what time?', sop, false),
        ).toBe('none');
    });
});

describe('checkReply', () => {
    it.each([
        'Goeie vraag, ik check het even!',
        'Ik zoek het uit en kom erop terug.',
        'Ik laat het je zo weten.',
        'Ik ga het navragen.',
        "I'll check and get back to you.",
        'Let me find out for you.',
    ])('blocks the false promise in %j', (text) => {
        const r = checkReply(reply({ messages: [text] }), ctx());
        expect(r.blocked).toBe(true);
        expect(r.violations[0]).toMatchObject({ kind: 'false_promise' });
    });

    it.each([
        'Een collega neemt contact met je op om het te bevestigen.',
        'Mag ik vragen hoe je heet?',
        'Laat het me weten als je nog vragen hebt!',
        'Dat weet ik helaas niet zeker.',
    ])('allows %j', (text) => {
        expect(checkReply(reply({ messages: [text] }), ctx()).blocked).toBe(
            false,
        );
    });

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
