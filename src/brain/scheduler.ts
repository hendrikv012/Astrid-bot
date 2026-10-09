import type { z } from 'zod';
import type { ChatMessage, LlmClient, LlmPriority } from './llm.js';

export interface SchedulerOptions {
    /** Model calls allowed at the same time (match OLLAMA_NUM_PARALLEL). */
    concurrency: number;
    /**
     * Background work that waited this long is treated like a reply, so
     * memory updates still happen during a long busy period.
     */
    backgroundMaxWaitMs: number;
    now?: () => number;
}

export interface SchedulerStats {
    running: number;
    queuedReplies: number;
    queuedBackground: number;
    /** Average/max time replies waited for a free model slot, last 5 minutes. */
    replyWaitAvgMs: number;
    replyWaitMaxMs: number;
}

interface Job {
    priority: LlmPriority;
    enqueuedAt: number;
    start: () => void;
}

const WAIT_WINDOW_MS = 5 * 60_000;

/** Replies waiting this long on average for the model means the bot is behind. */
export const BEHIND_WAIT_MS = 120_000;

export function isBehind(s: SchedulerStats): boolean {
    return s.replyWaitAvgMs > BEHIND_WAIT_MS;
}

/**
 * Puts every model call in one queue with a concurrency limit. Customer
 * replies always go before background work (fact extraction, summaries,
 * message embeddings), so a busy minute delays memory updates, not replies.
 */
export class ScheduledLlm implements LlmClient {
    private running = 0;
    private readonly replies: Job[] = [];
    private readonly background: Job[] = [];
    private readonly waits: { at: number; ms: number }[] = [];
    private readonly now: () => number;

    constructor(
        private readonly inner: LlmClient,
        private readonly opts: SchedulerOptions,
    ) {
        this.now = opts.now ?? Date.now;
    }

    chatJson<T>(
        messages: ChatMessage[],
        schema: z.ZodType<T>,
        opts: { model?: string; priority?: LlmPriority } = {},
    ): Promise<T> {
        return this.run(opts.priority ?? 'reply', () =>
            this.inner.chatJson(messages, schema, opts),
        );
    }

    embed(
        texts: string[],
        opts: { priority?: LlmPriority } = {},
    ): Promise<number[][]> {
        return this.run(opts.priority ?? 'reply', () =>
            this.inner.embed(texts, opts),
        );
    }

    stats(): SchedulerStats {
        const cutoff = this.now() - WAIT_WINDOW_MS;
        while (this.waits.length && this.waits[0]!.at < cutoff)
            this.waits.shift();
        const ms = this.waits.map((w) => w.ms);
        // Replies still waiting count too: a stuck queue must show up.
        const now = this.now();
        for (const j of this.replies) ms.push(now - j.enqueuedAt);
        return {
            running: this.running,
            queuedReplies: this.replies.length,
            queuedBackground: this.background.length,
            replyWaitAvgMs: ms.length
                ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)
                : 0,
            replyWaitMaxMs: ms.length ? Math.max(...ms) : 0,
        };
    }

    private run<T>(priority: LlmPriority, fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const job: Job = {
                priority,
                enqueuedAt: this.now(),
                start: () => {
                    if (priority === 'reply') {
                        this.waits.push({
                            at: this.now(),
                            ms: this.now() - job.enqueuedAt,
                        });
                        if (this.waits.length > 1000) this.waits.shift();
                    }
                    this.running++;
                    fn()
                        .then(resolve, reject)
                        .finally(() => {
                            this.running--;
                            this.pump();
                        });
                },
            };
            (priority === 'reply' ? this.replies : this.background).push(job);
            this.pump();
        });
    }

    private pump(): void {
        while (this.running < this.opts.concurrency) {
            const job = this.next();
            if (!job) return;
            job.start();
        }
    }

    private next(): Job | undefined {
        const oldBg = this.background[0];
        if (
            oldBg &&
            this.now() - oldBg.enqueuedAt >= this.opts.backgroundMaxWaitMs
        ) {
            return this.background.shift();
        }
        return this.replies.shift() ?? this.background.shift();
    }
}
