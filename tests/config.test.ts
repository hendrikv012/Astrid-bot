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
    });
});

describe('parseSop', () => {
    const valid = `
version: 1
identity: { name: A, role: r, business: b, languages: [nl] }
hard_rules: [{ id: R1, rule: x }]
escalation: {}
templates: { refusal: a, escalation: b, unknown: c }
limits: { max_messages_per_reply: 2, max_chars_per_message: 100 }
`;
    it('accepts a minimal SOP', () => {
        expect(parseSop(valid).sop.flows).toEqual([]);
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
