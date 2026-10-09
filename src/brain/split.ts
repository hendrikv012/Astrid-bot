import type { z } from 'zod';
import type { ChatMessage, LlmClient, LlmPriority } from './llm.js';
import type { SchedulerStats } from './scheduler.js';

/** An LLM client that reports its queue (ScheduledLlm or SplitLlm). */
export type QueuedLlm = LlmClient & { stats(): SchedulerStats };

/**
 * Sends customer replies to the main model server (the GPU) and everything
 * else to a helper server: embeddings (knowledge search, message recall) and
 * background memory work (facts, summaries). The GPU then only writes replies.
 *
 * If the helper is down, the bot still answers: embedding failures fall back
 * to "no knowledge found" and memory updates are retried on the next turn.
 */
export class SplitLlm implements QueuedLlm {
    constructor(
        private readonly main: QueuedLlm,
        private readonly helper: QueuedLlm,
    ) {}

    chatJson<T>(
        messages: ChatMessage[],
        schema: z.ZodType<T>,
        opts: { model?: string; priority?: LlmPriority } = {},
    ): Promise<T> {
        return opts.priority === 'background'
            ? this.helper.chatJson(messages, schema, opts)
            : this.main.chatJson(messages, schema, opts);
    }

    embed(
        texts: string[],
        opts: { priority?: LlmPriority } = {},
    ): Promise<number[][]> {
        return this.helper.embed(texts, opts);
    }

    /** Reply waits come from the main server; queues are added up. */
    stats(): SchedulerStats {
        const m = this.main.stats();
        const h = this.helper.stats();
        return {
            running: m.running + h.running,
            queuedReplies: m.queuedReplies + h.queuedReplies,
            queuedBackground: m.queuedBackground + h.queuedBackground,
            replyWaitAvgMs: m.replyWaitAvgMs,
            replyWaitMaxMs: m.replyWaitMaxMs,
        };
    }
}
