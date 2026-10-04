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

    push(chatKey: string, item: T): void {
        let slot = this.slots.get(chatKey);
        if (!slot) {
            slot = { pending: [], firstAt: 0, timer: null, running: false };
            this.slots.set(chatKey, slot);
        }
        if (slot.pending.length === 0) slot.firstAt = Date.now();
        slot.pending.push(item);
        this.schedule(chatKey, slot);
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
        const waited = Date.now() - slot.firstAt;
        const delay = Math.max(
            0,
            Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited),
        );
        slot.timer = setTimeout(() => void this.run(chatKey, slot), delay);
    }

    private async run(chatKey: string, slot: Slot<T>): Promise<void> {
        slot.timer = null;
        if (slot.running || slot.pending.length === 0) return;
        slot.running = true;
        const batch = slot.pending.splice(0);
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
