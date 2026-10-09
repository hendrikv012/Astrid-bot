import type { Env } from '../config/env.js';
import { OllamaLlm, type OllamaLlmOptions } from './llm.js';
import { ScheduledLlm } from './scheduler.js';
import { SplitLlm, type QueuedLlm } from './split.js';

export interface ModelClients {
    /** The server that writes customer replies (the GPU). */
    main: OllamaLlm;
    /** Optional second server for embeddings and memory work (HELPER_OLLAMA_HOST). */
    helper: OllamaLlm | null;
    /** Where embeddings go: the helper when set, else the main server. */
    embedder: OllamaLlm;
    /** Queued client for the bot: replies first, background work routed to the helper. */
    queued: QueuedLlm;
    /** Fails with a clear message when a model is missing on the server that needs it. */
    assertModels(): Promise<void>;
}

/** Builds the Ollama clients from .env, with or without a helper server. */
export function createModelClients(
    env: Env,
    hooks: Pick<
        OllamaLlmOptions,
        'onChatDone' | 'onChatProgress' | 'onChunk' | 'progressEveryMs'
    > = {},
): ModelClients {
    const common = {
        embedModel: env.EMBED_MODEL,
        temperature: env.LLM_TEMPERATURE,
        seed: env.LLM_SEED,
        numCtx: env.LLM_NUM_CTX,
        maxTokens: env.LLM_MAX_TOKENS,
    };
    const main = new OllamaLlm({
        ...common,
        ...hooks,
        host: env.OLLAMA_HOST,
        chatModel: env.CHAT_MODEL,
    });
    const helper = env.HELPER_OLLAMA_HOST
        ? new OllamaLlm({
              ...common,
              host: env.HELPER_OLLAMA_HOST,
              // Memory work uses EXTRACT_MODEL, or the chat model if none is set.
              chatModel: env.EXTRACT_MODEL ?? env.CHAT_MODEL,
          })
        : null;
    const backgroundMaxWaitMs = env.BACKGROUND_MAX_WAIT_SEC * 1000;
    const mainQ = new ScheduledLlm(main, {
        concurrency: env.LLM_CONCURRENCY,
        backgroundMaxWaitMs,
    });
    const queued = helper
        ? new SplitLlm(
              mainQ,
              new ScheduledLlm(helper, {
                  concurrency: env.HELPER_CONCURRENCY,
                  backgroundMaxWaitMs,
              }),
          )
        : mainQ;

    return {
        main,
        helper,
        embedder: helper ?? main,
        queued,
        async assertModels() {
            if (helper) {
                await helper
                    .assertReady([
                        env.EMBED_MODEL,
                        env.EXTRACT_MODEL ?? env.CHAT_MODEL,
                    ])
                    .catch((err: Error) => {
                        throw new Error(
                            `Helper server (HELPER_OLLAMA_HOST): ${err.message}`,
                        );
                    });
            } else {
                await main.assertReady([
                    env.EMBED_MODEL,
                    ...(env.EXTRACT_MODEL ? [env.EXTRACT_MODEL] : []),
                ]);
            }
        },
    };
}
