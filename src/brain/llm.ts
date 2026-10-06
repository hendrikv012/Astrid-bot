import { Ollama } from 'ollama';
import { z } from 'zod';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** Customer replies go first; background work (memory upkeep, ingest) waits. */
export type LlmPriority = 'reply' | 'background';

export interface LlmClient {
    /** Calls the chat model constrained to `schema`; returns parsed + validated output. */
    chatJson<T>(
        messages: ChatMessage[],
        schema: z.ZodType<T>,
        opts?: { model?: string; priority?: LlmPriority },
    ): Promise<T>;
    /** Embeds each text; returns one vector per input. */
    embed(
        texts: string[],
        opts?: { priority?: LlmPriority },
    ): Promise<number[][]>;
}

export class LlmOutputError extends Error {}

const DEFAULT_MAX_TOKENS = 600;
/** This many whitespace characters in a row means the model is stuck. */
const STUCK_WHITESPACE = 200;

export interface OllamaLlmOptions {
    host: string;
    chatModel: string;
    embedModel: string;
    temperature: number;
    seed: number;
    numCtx: number;
    /** Upper limit on tokens per reply, so a stuck model can't write forever. */
    maxTokens?: number;
    /** Called every `progressEveryMs` while the model is still busy. */
    onChatProgress?: (info: {
        model: string;
        chars: number;
        seconds: number;
    }) => void;
    progressEveryMs?: number;
    /** Receives the model's output as it is written (sandbox). */
    onChunk?: (text: string) => void;
    /** Called after each chat call with how long the model took. */
    onChatDone?: (info: { model: string; ms: number }) => void;
    /** For tests: a stand-in for the Ollama client. */
    client?: Pick<Ollama, 'chat' | 'embed' | 'list' | 'show'>;
}

export class OllamaLlm implements LlmClient {
    private readonly client: Pick<Ollama, 'chat' | 'embed' | 'list' | 'show'>;

    private readonly opts: OllamaLlmOptions;

    constructor(opts: OllamaLlmOptions) {
        this.opts = { ...opts };
        this.client = opts.client ?? new Ollama({ host: opts.host });
    }

    /** Live-tune generation (dashboard). Takes effect on the next call. */
    setOptions(
        patch: Partial<Pick<OllamaLlmOptions, 'chatModel' | 'temperature'>>,
    ): void {
        Object.assign(this.opts, patch);
    }

    /**
     * Installed models that can chat. Embedding-only models (like the one used
     * for RAG) are left out, because picking one as the chat model would make
     * every reply fail.
     */
    async listChatModels(): Promise<string[]> {
        const { models } = await this.client.list();
        const checked = await Promise.all(
            models.map(async (m) => {
                const caps = await this.client
                    .show({ model: m.name })
                    .then((r) => r.capabilities ?? [])
                    .catch(() => [] as string[]);
                const canChat = caps.length
                    ? caps.includes('completion')
                    : !/embed/i.test(m.name); // older Ollama without capabilities
                const isEmbedModel = sameModel(m.name, this.opts.embedModel);
                return canChat && !isEmbedModel ? m.name : null;
            }),
        );
        return checked.filter((n): n is string => n !== null);
    }

    async chatJson<T>(
        messages: ChatMessage[],
        schema: z.ZodType<T>,
        { model }: { model?: string } = {},
    ): Promise<T> {
        const started = Date.now();
        const name = model ?? this.opts.chatModel;
        // Streamed so slow machines don't hit fetch's 5-minute wait for
        // response headers (a non-streamed reply sends nothing until it's done).
        const stream = await this.client.chat({
            model: name,
            messages,
            format: z.toJSONSchema(schema),
            stream: true,
            options: {
                temperature: this.opts.temperature,
                seed: this.opts.seed,
                num_ctx: this.opts.numCtx,
                num_predict: this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            },
        });
        let content = '';
        // On slow machines, show that the model is still working ("chars: 0" = still reading the prompt).
        const progress = setInterval(
            () =>
                this.opts.onChatProgress?.({
                    model: name,
                    chars: content.length,
                    seconds: Math.round((Date.now() - started) / 1000),
                }),
            this.opts.progressEveryMs ?? 30_000,
        );
        try {
            for await (const part of stream) {
                content += part.message.content;
                this.opts.onChunk?.(part.message.content);
                // Small models under a JSON grammar sometimes emit whitespace forever.
                if (
                    content.length >= STUCK_WHITESPACE &&
                    !content.slice(-STUCK_WHITESPACE).trim()
                ) {
                    stream.abort();
                    throw new LlmOutputError(
                        'model got stuck writing whitespace',
                    );
                }
            }
        } finally {
            clearInterval(progress);
        }
        this.opts.onChatDone?.({ model: name, ms: Date.now() - started });
        return parseJsonOutput(content, schema);
    }

    async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const res = await this.client.embed({
            model: this.opts.embedModel,
            input: texts,
        });
        return res.embeddings;
    }

    /** Fails fast at startup if Ollama is down or a model is not pulled. */
    async assertReady(models: string[]): Promise<void> {
        const { models: installed } = await this.client.list().catch((err) => {
            throw new Error(
                `Cannot reach Ollama at ${this.opts.host} — is \`ollama serve\` running? (${(err as Error).message})`,
            );
        });
        const names = new Set(
            installed.flatMap((m) => [m.name, m.name.replace(/:latest$/, '')]),
        );
        const missing = models.filter((m) => !names.has(m));
        if (missing.length) {
            throw new Error(
                `Ollama is missing model(s): ${missing.join(', ')}. Run: ollama pull ${missing.join(' && ollama pull ')}`,
            );
        }
    }
}

/** "llama3.1" and "llama3.1:latest" are the same Ollama model. */
export function sameModel(a: string, b: string): boolean {
    const norm = (m: string) => (m.includes(':') ? m : `${m}:latest`);
    return norm(a) === norm(b);
}

export function parseJsonOutput<T>(raw: string, schema: z.ZodType<T>): T {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new LlmOutputError(
            `Model returned non-JSON: ${raw.slice(0, 200)}`,
        );
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
        throw new LlmOutputError(
            `Model output failed schema: ${z.prettifyError(parsed.error)}`,
        );
    }
    return parsed.data;
}
