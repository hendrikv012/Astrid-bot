import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadImages } from '../src/config/images.js';
import { loadPersona, parsePersona } from '../src/config/persona.js';
import { loadSop, matchesKeyword, parseSop } from '../src/config/sop.js';

const root = path.resolve(import.meta.dirname, '..');

describe('shipped config', () => {
    it('SOP, persona and images in config/ are valid', () => {
        const { sop, hash } = loadSop(
            path.join(root, 'config/astrid.sop.yaml'),
        );
        expect(sop.identity.name).toBe('Astrid');
        expect(hash).toMatch(/^[0-9a-f]{16}$/);

        const persona = loadPersona(
            path.join(root, 'config/persona.md'),
            sop.identity.name,
        );
        expect(persona.text).not.toMatch(/## Examples/);
        expect(persona.examples.length).toBeGreaterThanOrEqual(5);

        const images = loadImages(
            path.join(root, 'config/images.yaml'),
            path.join(root, 'assets/images'),
        );
        expect(images.get('price_list')?.data.length).toBeGreaterThan(0);
        expect(images.get('price_list')?.viewOnce).toBe(false);
        expect(images.get('photo')).toMatchObject({
            viewOnce: true,
            resendAfterHours: 0,
        });
    });
});

describe('parseSop', () => {
    const valid = `
version: 1
identity: { name: A, role: r, business: b, languages: [nl] }
hard_rules: [{ id: R1, rule: x }]
templates: { refusal: a, unknown: c }
limits: { max_messages_per_reply: 2, max_chars_per_message: 100 }
`;
    it('accepts a minimal SOP with sales and takeover defaults', () => {
        const { sop } = parseSop(valid);
        expect(sop.flows).toEqual([]);
        expect(sop.sales.notify_owner).toBe(true);
        expect(sop.human_takeover.pause_bot_minutes).toBe(60);
        expect(sop.templates.owner_agreed).toContain('{summary}');
    });
    it('explains that the old escalation section was replaced', () => {
        expect(() => parseSop(`${valid}\nescalation: {}`)).toThrow(
            /replaced.*sales.*human_takeover/,
        );
    });
    it('rejects unknown keys, missing rules and duplicate ids', () => {
        expect(() => parseSop(`${valid}\nextra: 1`)).toThrow(
            /failed validation/,
        );
        expect(() =>
            parseSop(valid.replace('[{ id: R1, rule: x }]', '[]')),
        ).toThrow();
        expect(() =>
            parseSop(
                valid.replace(
                    '[{ id: R1, rule: x }]',
                    '[{ id: R1, rule: x }, { id: R1, rule: y }]',
                ),
            ),
        ).toThrow(/duplicate id/);
    });
    it('rejects invalid YAML', () => {
        expect(() => parseSop('version: [1')).toThrow(/invalid YAML/);
    });
});

describe('matchesKeyword', () => {
    it('matches whole words/phrases, case- and accent-insensitive', () => {
        expect(matchesKeyword('Ik wil GELD TERUG!', ['geld terug'])).toBe(
            'geld terug',
        );
        expect(matchesKeyword('ik ben ontevréden', ['ontevreden'])).toBe(
            'ontevreden',
        );
        expect(matchesKeyword('humanity', ['human'])).toBeNull();
    });
});

describe('parsePersona: speakers', () => {
    it('accepts "Bot:" for replies and reports ignored speakers', () => {
        const p = parsePersona(
            'You are B.\n\n## Examples\n\nUser: hi\nBot: hey\n\nUser: yo\nAstrid: old name\n',
            'Bella',
        );
        expect(p.examples).toEqual([{ user: 'hi', assistant: ['hey'] }]);
        expect(p.ignoredSpeakers).toEqual(['Astrid']);
    });
});

describe('parsePersona', () => {
    it('groups consecutive bot lines into one exchange', () => {
        const p = parsePersona(
            'You are A.\n\n## Examples\n\nUser: hi\nA: hey\nA: what’s up?\n\nUser: bye\nA: ciao\n',
            'A',
        );
        expect(p.text).toBe('You are A.');
        expect(p.examples).toEqual([
            { user: 'hi', assistant: ['hey', 'what’s up?'] },
            { user: 'bye', assistant: ['ciao'] },
        ]);
    });
});
