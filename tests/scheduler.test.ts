import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LlmClient } from '../src/brain/llm.js';
import { ScheduledLlm } from '../src/brain/scheduler.js';

/** Fake model: each call resolves only when the test releases it. */
function gatedLlm() {
    const order: string[] = [];
    const gates: (() => void)[] = [];
    const llm: LlmClient = {
        chatJson: async <T>(messages: { content: string }[]) => {
            order.push(messages[0]!.content);
            await new Promise<void>((r) => gates.push(r));
            return { ok: true } as T;
        },
        embed: async (texts) => texts.map(() => [1]),
    };
    const releaseOne = async () => {
        gates.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
    };
    return { llm, order, releaseOne, gates };
}

const schema = z.object({ ok: z.boolean() });
const msg = (content: string) => [{ role: 'user' as const, content }];

describe('ScheduledLlm', () => {
    it('runs replies before queued background work', async () => {
        const { llm, order, releaseOne } = gatedLlm();
        const s = new ScheduledLlm(llm, {
            concurrency: 1,
            backgroundMaxWaitMs: 60_000,
        });
        const all = [
            s.chatJson(msg('bg1'), schema, { priority: 'background' }),
            s.chatJson(msg('bg2'), schema, { priority: 'background' }),
            s.chatJson(msg('reply1'), schema),
            s.chatJson(msg('reply2'), schema),
        ];
        expect(s.stats()).toMatchObject({
            running: 1,
            queuedReplies: 2,
            queuedBackground: 1,
        });
        for (let i = 0; i < 4; i++) await releaseOne();
        await Promise.all(all);
        expect(order).toEqual(['bg1', 'reply1', 'reply2', 'bg2']);
    });

    it('promotes background work that waited too long', async () => {
        let now = 0;
        const { llm, order, releaseOne } = gatedLlm();
        const s = new ScheduledLlm(llm, {
            concurrency: 1,
            backgroundMaxWaitMs: 1000,
            now: () => now,
        });
        const all = [
            s.chatJson(msg('first'), schema),
            s.chatJson(msg('old-bg'), schema, { priority: 'background' }),
        ];
        now = 5000;
        all.push(s.chatJson(msg('late-reply'), schema));
        for (let i = 0; i < 3; i++) await releaseOne();
        await Promise.all(all);
        expect(order).toEqual(['first', 'old-bg', 'late-reply']);
    });

    it('respects the concurrency limit and reports reply waits', async () => {
        let now = 0;
        const { llm, releaseOne } = gatedLlm();
        const s = new ScheduledLlm(llm, {
            concurrency: 2,
            backgroundMaxWaitMs: 60_000,
            now: () => now,
        });
        const all = [1, 2, 3].map((i) => s.chatJson(msg(`r${i}`), schema));
        expect(s.stats().running).toBe(2);
        now = 3000;
        expect(s.stats().replyWaitMaxMs).toBe(3000); // r3 is still waiting
        for (let i = 0; i < 3; i++) await releaseOne();
        await Promise.all(all);
        expect(s.stats().running).toBe(0);
    });
});
