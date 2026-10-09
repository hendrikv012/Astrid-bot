import { describe, expect, it } from 'vitest';
import {
    distractionDelayMs,
    firstReplyDelayMs,
    pickTurnCps,
    readDelayMs,
    typingDurationMs,
    typingSegments,
} from '../src/humanize/typing.js';
import { chunkText } from '../src/rag/chunk.js';

const seq = (...vals: number[]) => {
    let i = 0;
    return () => vals[i++ % vals.length]!;
};

describe('typing delays', () => {
    it('scales with message length and stays within clamps', () => {
        expect(typingDurationMs(60, 6, () => 0.5)).toBe(10000); // 60 chars / 6 cps
        expect(typingDurationMs(1, 6, () => 1)).toBe(1500);
        expect(typingDurationMs(10_000, 5, () => 0)).toBe(25000);
    });
    it('picks one speed per reply inside the configured range', () => {
        expect(pickTurnCps({ cpsMin: 5, cpsMax: 7 }, () => 0)).toBe(5);
        expect(pickTurnCps({ cpsMin: 5, cpsMax: 7 }, () => 1)).toBe(7);
    });
    it('read delay is bounded', () => {
        expect(readDelayMs(0, () => 0)).toBe(1000);
        expect(readDelayMs(100_000, () => 1)).toBe(7000);
    });
});

describe('first reply delay', () => {
    const cfg = { firstReplyMinMs: 20_000, firstReplyMaxMs: 150_000 };
    it('stays within bounds and is skewed toward short waits', () => {
        expect(firstReplyDelayMs(cfg, () => 0)).toBe(20_000);
        expect(firstReplyDelayMs(cfg, () => 1)).toBe(150_000);
        // log-uniform: the midpoint draw is well below the arithmetic mean
        expect(firstReplyDelayMs(cfg, () => 0.5)).toBeLessThan(85_000);
    });
    it('is disabled when max is 0', () => {
        expect(
            firstReplyDelayMs({ firstReplyMinMs: 5, firstReplyMaxMs: 0 }),
        ).toBe(0);
    });
});

describe('typingSegments', () => {
    it('keeps total typing time and adds pauses only between stretches', () => {
        const segs = typingSegments(20_000, { pauseChance: 1 }, () => 0);
        expect(segs.reduce((n, s) => n + s.composeMs, 0)).toBe(20_000);
        expect(segs.at(-1)!.pauseMs).toBe(0);
        expect(segs.slice(0, -1).every((s) => s.pauseMs >= 1000)).toBe(true);
    });
    it('never pauses when the chance is 0', () => {
        const segs = typingSegments(20_000, { pauseChance: 0 });
        expect(segs.every((s) => s.pauseMs === 0)).toBe(true);
    });
});

describe('distraction', () => {
    it('happens only with the configured chance', () => {
        expect(distractionDelayMs({ distractionChance: 0.1 }, seq(0.5))).toBe(
            0,
        );
        expect(
            distractionDelayMs({ distractionChance: 0.1 }, seq(0.05, 0)),
        ).toBe(3000);
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
