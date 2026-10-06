import type { WASocket } from 'baileys';
import { describe, expect, it } from 'vitest';
import type { PreloadedImage } from '../src/config/images.js';
import { OutboundLimiter } from '../src/whatsapp/outboundLimiter.js';
import { createSender } from '../src/whatsapp/sender.js';

/** Fake clock where sleeping advances time instantly. */
function clock() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => {
            t += ms;
        },
        advance: (ms: number) => (t += ms),
    };
}

describe('OutboundLimiter', () => {
    it('never exceeds the cap per rolling minute and delays instead of dropping', async () => {
        const c = clock();
        const l = new OutboundLimiter({ maxPerMinute: 3, mergeAt: 0.5, ...c });
        const times: number[] = [];
        for (let i = 0; i < 7; i++) {
            await l.acquire();
            times.push(c.now());
        }
        expect(times.slice(0, 3)).toEqual([0, 0, 0]);
        // 4th waits until the first send leaves the window
        expect(times[3]).toBeGreaterThan(60_000);
        for (let i = 3; i < times.length; i++) {
            const inWindow = times.filter(
                (t) => t > times[i]! - 60_000 && t <= times[i]!,
            ).length;
            expect(inWindow).toBeLessThanOrEqual(3);
        }
        expect(times).toHaveLength(7);
    });

    it('counts urgent sends without making them wait', () => {
        const c = clock();
        const l = new OutboundLimiter({ maxPerMinute: 1, mergeAt: 0.5, ...c });
        l.note();
        l.note();
        expect(c.now()).toBe(0);
        expect(l.stats().sentLastMinute).toBe(2);
    });

    it('turns on merging from the configured share of the cap', async () => {
        const c = clock();
        const l = new OutboundLimiter({ maxPerMinute: 10, mergeAt: 0.5, ...c });
        for (let i = 0; i < 4; i++) await l.acquire();
        expect(l.shouldMerge()).toBe(false);
        await l.acquire();
        expect(l.shouldMerge()).toBe(true);
        c.advance(61_000);
        expect(l.stats()).toMatchObject({ sentLastMinute: 0, merging: false });
    });
});

describe('sender with limiter', () => {
    function fakeSock() {
        const sent: Record<string, unknown>[] = [];
        const sock = {
            sendMessage: async (
                _jid: string,
                content: Record<string, unknown>,
            ) => {
                sent.push(content);
                return { key: { id: `ID${sent.length}` } };
            },
            sendPresenceUpdate: async () => {},
            presenceSubscribe: async () => {},
        } as unknown as WASocket;
        return { sock, sent };
    }
    const typing = {
        cpsMin: 5,
        cpsMax: 7,
        firstReplyMinMs: 0,
        firstReplyMaxMs: 0,
        pauseChance: 0,
        distractionChance: 0,
    };
    const welcome: PreloadedImage = {
        id: 'welcome',
        caption: '',
        whenToUse: '',
        viewOnce: true,
        requestKeywords: [],
        resendAfterHours: null,
        firstContact: true,
        mimetype: 'image/png',
        data: Buffer.from([1]),
    };

    it('merges bubbles into one message when busy', async () => {
        const c = clock();
        const limiter = new OutboundLimiter({
            maxPerMinute: 2,
            mergeAt: 0.5,
            ...c,
        });
        await limiter.acquire(); // already at 50%
        const { sock, sent } = fakeSock();
        const sender = createSender(() => sock, {
            humanize: false,
            typing,
            limiter,
        });
        const out = await sender.send({
            replyJid: 'x@s.whatsapp.net',
            messages: ['Hoi!', 'Hoe kan ik helpen?'],
            image: null,
        });
        expect(sent).toEqual([{ text: 'Hoi!\n\nHoe kan ik helpen?' }]);
        expect(out).toHaveLength(1);
    });

    it('keeps separate bubbles when quiet', async () => {
        const limiter = new OutboundLimiter({
            maxPerMinute: 100,
            mergeAt: 0.5,
        });
        const { sock, sent } = fakeSock();
        const sender = createSender(() => sock, {
            humanize: false,
            typing,
            limiter,
        });
        await sender.send({
            replyJid: 'x@s.whatsapp.net',
            messages: ['Hoi!', 'Hoe kan ik helpen?'],
            image: null,
        });
        expect(sent).toHaveLength(2);
    });

    it('sends the image first when asked', async () => {
        const { sock, sent } = fakeSock();
        const sender = createSender(() => sock, { humanize: false, typing });
        await sender.send({
            replyJid: 'x@s.whatsapp.net',
            messages: ['Welkom!'],
            image: welcome,
            imageFirst: true,
        });
        expect(sent[0]).toMatchObject({ viewOnce: true });
        expect(sent[1]).toEqual({ text: 'Welkom!' });
    });
});
