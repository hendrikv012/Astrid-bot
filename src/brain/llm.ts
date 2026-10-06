import { Ollama } from 'ollama';
import { z } from 'zod';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LlmClient {
    /** Calls the chat model constrained to `schema`; returns parsed + validated output. */
    chatJson<T>(
        messages: ChatMessage[],
        schema: z.ZodType<T>,
        opts?: { model?: string },
    ): Promise<T>;
    /** Embeds each text; returns one vector per input. */
    embed(texts: string[]): Promise<number[][]>;
}

export class LlmOutputError extends Error {}

export interface OllamaLlmOptions {
    host: string;
    chatModel: string;
    embedModel: string;
    temperature: number;
    seed: number;
    numCtx: number;
}

export class OllamaLlm implements LlmClient {
    private readonly client: Ollama;

    private readonly opts: OllamaLlmOptions;

    constructor(opts: OllamaLlmOptions) {
        this.opts = { ...opts };
        this.client = new Ollama({ host: opts.host });
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
        const res = await this.client.chat({
            model: model ?? this.opts.chatModel,
            messages,
            format: z.toJSONSchema(schema),
            stream: false,
            options: {
                temperature: this.opts.temperature,
                seed: this.opts.seed,
                num_ctx: this.opts.numCtx,
            },
        });
        return parseJsonOutput(res.message.content, schema);
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
