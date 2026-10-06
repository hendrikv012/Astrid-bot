import fs from 'node:fs';

export interface PersonaExample {
    user: string;
    assistant: string[];
}

export interface Persona {
    /** Persona text without the examples section. */
    text: string;
    /** Few-shot exchanges that anchor tone and style. */
    examples: PersonaExample[];
    /**
     * Speaker labels in the examples that are neither "User" nor the bot
     * (e.g. "Astrid:" after the bot was renamed). Those lines are ignored.
     */
    ignoredSpeakers: string[];
}

const EXAMPLES_HEADING = /^##\s+Examples\s*$/im;

/**
 * Parses config/persona.md. Everything before "## Examples" is the persona
 * description. The examples section holds exchanges written as:
 *
 *     User: hoi, wat kost een knipbeurt?
 *     Astrid: Hoi! 😊
 *     Astrid: Een knipbeurt kost €35.
 *
 * Consecutive "Astrid:" lines become separate WhatsApp bubbles. A blank line
 * or a new "User:" line starts the next exchange. "Bot:" works too and keeps
 * working if the bot is renamed in the SOP.
 */
export function parsePersona(raw: string, botName: string): Persona {
    const match = EXAMPLES_HEADING.exec(raw);
    const text = (match ? raw.slice(0, match.index) : raw).trim();
    if (!text) throw new Error('persona.md: persona description is empty');

    const examples: PersonaExample[] = [];
    const ignored = new Set<string>();
    if (match) {
        const section = raw.slice(match.index + match[0].length);
        const botPrefix = new RegExp(
            `^(${escapeRegExp(botName)}|bot):\\s*`,
            'i',
        );
        let current: PersonaExample | null = null;

        for (const line of section.split('\n')) {
            const trimmed = line.trim();
            if (/^##\s/.test(trimmed)) break;
            if (/^user:\s*/i.test(trimmed)) {
                if (current?.assistant.length) examples.push(current);
                current = {
                    user: trimmed.replace(/^user:\s*/i, ''),
                    assistant: [],
                };
            } else if (botPrefix.test(trimmed)) {
                current?.assistant.push(trimmed.replace(botPrefix, ''));
            } else if (!trimmed && current?.assistant.length) {
                examples.push(current);
                current = null;
            } else {
                const speaker = /^([\p{L}][\p{L}\p{N} _-]{0,30}):/u.exec(
                    trimmed,
                );
                if (speaker) ignored.add(speaker[1]!);
            }
        }
        if (current?.assistant.length) examples.push(current);
    }
    return { text, examples, ignoredSpeakers: [...ignored] };
}

export function loadPersona(file: string, botName: string): Persona {
    return parsePersona(fs.readFileSync(file, 'utf8'), botName);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
