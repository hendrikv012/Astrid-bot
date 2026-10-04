import { describe, expect, it } from 'vitest';
import { readDelayMs, typingDurationMs } from '../src/humanize/typing.js';
import { chunkText } from '../src/rag/chunk.js';

const cfg = { cpsMin: 5, cpsMax: 7 };

describe('typing delays', () => {
    it('scales with message length and stays within clamps', () => {
        const fixed = () => 0.5;
        expect(typingDurationMs(60, cfg, fixed)).toBe(10000); // 60 chars / 6 cps
        expect(typingDurationMs(1, cfg, () => 1)).toBe(1500);
        expect(typingDurationMs(10_000, cfg, () => 0)).toBe(25000);
    });
    it('read delay is bounded', () => {
        expect(readDelayMs(0, () => 0)).toBe(1000);
        expect(readDelayMs(100_000, () => 1)).toBe(7000);
    });
});

describe('chunkText', () => {
    it('keeps heading trail and never crosses sections', () => {
        const chunks = chunkText(
            '# Salon\n\nIntro\n\n## Prices\n\nCut €45\n\n## Hours\n\nTue-Sat',
        );
        expect(chunks).toEqual([
            { heading: 'Salon', text: 'Intro' },
            { heading: 'Salon › Prices', text: 'Cut €45' },
            { heading: 'Salon › Hours', text: 'Tue-Sat' },
        ]);
    });
    it('splits long sections with bounded size', () => {
        const para = 'word '.repeat(100).trim();
        const chunks = chunkText(Array(10).fill(para).join('\n\n'), {
            maxChars: 1200,
            overlapChars: 100,
        });
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks)
            expect(c.text.length).toBeLessThanOrEqual(1200 + 100);
    });
});
