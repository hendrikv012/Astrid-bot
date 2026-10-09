export interface OutboundLimiterOptions {
    /** Max messages sent per rolling minute (all chats together). */
    maxPerMinute: number;
    /** From this share of the cap (0–1), multi-bubble replies are merged. */
    mergeAt: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface OutboundStats {
    sentLastMinute: number;
    maxPerMinute: number;
    /** True while replies are merged into one message to save sends. */
    merging: boolean;
    /** Sends currently waiting for room under the cap. */
    waiting: number;
}

const WINDOW_MS = 60_000;

/**
 * Keeps the number's outgoing volume under a per-minute cap, which lowers the
 * risk of WhatsApp flagging it. Messages are delayed when the cap is reached,
 * never dropped. When busy, the sender merges bubbles so fewer sends are used.
 */
export class OutboundLimiter {
    private readonly sent: number[] = [];
    private waiting = 0;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    /** Serializes waiters so they get slots in arrival order. */
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly opts: OutboundLimiterOptions) {
        this.now = opts.now ?? Date.now;
        this.sleep =
            opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /** Resolves when one more message may be sent; records the send. */
    acquire(): Promise<void> {
        this.waiting++;
        const turn = this.chain.then(async () => {
            for (;;) {
                this.prune();
                if (this.sent.length < this.opts.maxPerMinute) break;
                await this.sleep(this.sent[0]! + WINDOW_MS - this.now() + 1);
            }
            this.sent.push(this.now());
            this.waiting--;
        });
        this.chain = turn.catch(() => {});
        return turn;
    }

    /**
     * Counts a send that must not wait (owner alerts, a human's own reply), so
     * bot replies still respect the cap around it.
     */
    note(): void {
        this.sent.push(this.now());
    }

    /** Share of the per-minute cap used, 0–1+. */
    load(): number {
        this.prune();
        return (this.sent.length + this.waiting) / this.opts.maxPerMinute;
    }

    shouldMerge(): boolean {
        return this.load() >= this.opts.mergeAt;
    }

    stats(): OutboundStats {
        this.prune();
        return {
            sentLastMinute: this.sent.length,
            maxPerMinute: this.opts.maxPerMinute,
            merging: this.shouldMerge(),
            waiting: this.waiting,
        };
    }

    private prune(): void {
        const cutoff = this.now() - WINDOW_MS;
        while (this.sent.length && this.sent[0]! <= cutoff) this.sent.shift();
    }
}
