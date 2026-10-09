import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmPriority } from '../src/brain/llm.js';
import { ScheduledLlm } from '../src/brain/scheduler.js';
import { SplitLlm } from '../src/brain/split.js';

function recorder(name: string, calls: string[]): LlmClient {
    return {
        chatJson: async <T>(
            _m: unknown,
            _s: unknown,
            o?: { priority?: LlmPriority },
        ) => {
            calls.push(`${name}:chat:${o?.priority ?? 'reply'}`);
            return {} as T;
        },
        embed: async (texts, o) => {
            calls.push(`${name}:embed:${o?.priority ?? 'reply'}`);
            return texts.map(() => [0]);
        },
    };
}

describe('SplitLlm (GPU for replies, helper server for the rest)', () => {
    it('routes replies to main and embeddings + memory work to the helper', async () => {
        const calls: string[] = [];
        const q = (c: LlmClient) =>
            new ScheduledLlm(c, { concurrency: 1, backgroundMaxWaitMs: 1000 });
        const llm = new SplitLlm(
            q(recorder('gpu', calls)),
            q(recorder('helper', calls)),
        );
        const schema = {} as never;
        await llm.chatJson([], schema);
        await llm.chatJson([], schema, { priority: 'background' });
        await llm.embed(['x']);
        await llm.embed(['y'], { priority: 'background' });
        expect(calls).toEqual([
            'gpu:chat:reply',
            'helper:chat:background',
            'helper:embed:reply',
            'helper:embed:background',
        ]);
        await new Promise((r) => setTimeout(r, 0)); // slots free one tick later
        expect(llm.stats()).toMatchObject({ running: 0, queuedReplies: 0 });
    });
});
