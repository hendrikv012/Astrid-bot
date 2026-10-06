import type { Ollama } from 'ollama';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OllamaLlm } from '../src/brain/llm.js';

describe('OllamaLlm.chatJson', () => {
    it('streams the reply and joins the chunks before parsing', async () => {
        const calls: Record<string, unknown>[] = [];
        const client = {
            chat: async (req: Record<string, unknown>) => {
                calls.push(req);
                return (async function* () {
                    for (const c of ['{"a":', '1,"b"', ':"x"}'])
                        yield { message: { content: c } };
                })();
            },
        } as unknown as Ollama;
        const timings: number[] = [];
        const llm = new OllamaLlm({
            host: 'http://x',
            chatModel: 'm',
            embedModel: 'e',
            temperature: 0,
            seed: 1,
            numCtx: 2048,
            client,
            onChatDone: ({ ms }) => timings.push(ms),
        });
        const out = await llm.chatJson(
            [{ role: 'user', content: 'hi' }],
            z.object({ a: z.number(), b: z.string() }),
        );
        expect(out).toEqual({ a: 1, b: 'x' });
        expect(calls[0]).toMatchObject({ model: 'm', stream: true });
        expect(timings).toHaveLength(1);
    });
});
