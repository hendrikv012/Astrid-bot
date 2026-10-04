export interface ChatQueueOptions<T> {
    /** Quiet period after the last message before handling the burst. */
    debounceMs: number;
    /** Never wait longer than this after the first message of a burst. */
    maxWaitMs: number;
    handler: (chatKey: string, batch: T[]) => Promise<void>;
    onError: (chatKey: string, err: unknown) => void;
}

interface Slot<T> {
    pending: T[];
    firstAt: number;
    /** Don't handle the batch before this time (e.g. first-reply delay). */
    holdUntil: number;
    timer: NodeJS.Timeout | null;
    running: boolean;
}

/**
 * Per-chat serial queue with burst debouncing. People often send several short
 * messages in a row; they are answered together as one turn. Chats are
 * independent: a slow or failing chat never blocks another.
 */
export class ChatQueue<T> {
    private readonly slots = new Map<string, Slot<T>>();

    constructor(private readonly opts: ChatQueueOptions<T>) {}

    /**
     * Queues `item`. `holdUntil` (epoch ms) delays handling of the batch at
     * least until then; messages arriving meanwhile join the same batch.
     */
    push(chatKey: string, item: T, holdUntil = 0): void {
        let slot = this.slots.get(chatKey);
        if (!slot) {
            slot = {
                pending: [],
                firstAt: 0,
                holdUntil: 0,
                timer: null,
                running: false,
            };
            this.slots.set(chatKey, slot);
        }
        if (slot.pending.length === 0) slot.firstAt = Date.now();
        slot.holdUntil = Math.max(slot.holdUntil, holdUntil);
        slot.pending.push(item);
        this.schedule(chatKey, slot);
    }

    /** True while a chat has messages waiting or a turn running. */
    isBusy(chatKey: string): boolean {
        const slot = this.slots.get(chatKey);
        return !!slot && (slot.running || slot.pending.length > 0);
    }

    /** Resolves when no chat has pending or running work (for tests/shutdown). */
    async idle(): Promise<void> {
        while (
            [...this.slots.values()].some((s) => s.running || s.pending.length)
        ) {
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    private schedule(chatKey: string, slot: Slot<T>): void {
        if (slot.running) return; // picked up when the current run finishes
        if (slot.timer) clearTimeout(slot.timer);
        const now = Date.now();
        const waited = now - slot.firstAt;
        const debounce = Math.min(
            this.opts.debounceMs,
            this.opts.maxWaitMs - waited,
        );
        const delay = Math.max(0, debounce, slot.holdUntil - now);
        slot.timer = setTimeout(() => void this.run(chatKey, slot), delay);
    }

    private async run(chatKey: string, slot: Slot<T>): Promise<void> {
        slot.timer = null;
        if (slot.running || slot.pending.length === 0) return;
        slot.running = true;
        const batch = slot.pending.splice(0);
        slot.holdUntil = 0;
        try {
            await this.opts.handler(chatKey, batch);
        } catch (err) {
            this.opts.onError(chatKey, err);
        } finally {
            slot.running = false;
            if (slot.pending.length) {
                slot.firstAt = Date.now();
                this.schedule(chatKey, slot);
            } else {
                this.slots.delete(chatKey);
            }
        }
    }
}
