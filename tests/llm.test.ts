import type { Ollama } from 'ollama';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmOutputError, OllamaLlm } from '../src/brain/llm.js';

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
        expect(calls[0]).toMatchObject({
            model: 'm',
            stream: true,
            options: { num_predict: 600 },
        });
        expect(timings).toHaveLength(1);
    });

    function streamingLlm(chunks: string[], delayMs = 0) {
        let aborted = false;
        const client = {
            chat: async () => {
                const gen = (async function* () {
                    for (const c of chunks) {
                        if (delayMs)
                            await new Promise((r) => setTimeout(r, delayMs));
                        yield { message: { content: c } };
                    }
                })();
                return Object.assign(gen, { abort: () => (aborted = true) });
            },
        } as unknown as Ollama;
        const progress: number[] = [];
        const llm = new OllamaLlm({
            host: 'http://x',
            chatModel: 'm',
            embedModel: 'e',
            temperature: 0,
            seed: 1,
            numCtx: 2048,
            client,
            progressEveryMs: 10,
            onChatProgress: ({ chars }) => progress.push(chars),
        });
        return { llm, progress, wasAborted: () => aborted };
    }

    it('stops a model that only writes whitespace', async () => {
        const { llm, wasAborted } = streamingLlm([
            '{"a":',
            ...Array<string>(30).fill('          '),
        ]);
        await expect(
            llm.chatJson([], z.object({ a: z.number() })),
        ).rejects.toBeInstanceOf(LlmOutputError);
        expect(wasAborted()).toBe(true);
    });

    it('reports progress while a slow model is still working', async () => {
        const { llm, progress } = streamingLlm(['{"a":', '1}'], 30);
        await llm.chatJson([], z.object({ a: z.number() }));
        expect(progress.length).toBeGreaterThan(0);
    });

    it('tells reasoning models not to think', async () => {
        const calls: Record<string, unknown>[] = [];
        const client = {
            show: async () => ({ capabilities: ['completion', 'thinking'] }),
            chat: async (req: Record<string, unknown>) => {
                calls.push(req);
                return (async function* () {
                    yield { message: { content: '{"a":1}' } };
                })();
            },
        } as unknown as Ollama;
        const llm = new OllamaLlm({
            host: 'http://x',
            chatModel: 'm',
            embedModel: 'e',
            temperature: 0,
            seed: 1,
            numCtx: 2048,
            client,
        });
        await llm.chatJson([], z.object({ a: z.number() }));
        expect(calls[0]).toMatchObject({ think: false });
    });
});
