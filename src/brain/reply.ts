import { z } from 'zod';

export const PURCHASE_STAGES = ['none', 'interested', 'agreed'] as const;
export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

/**
 * The JSON contract every model reply must satisfy. Built per turn so the
 * image id enum only contains images that exist.
 */
export function replySchema(imageIds: string[], maxMessages: number) {
    const imageId =
        imageIds.length > 0
            ? z.enum(imageIds as [string, ...string[]]).nullable()
            : z.null();
    return z.object({
        messages: z.array(z.string()).min(1).max(maxMessages),
        image_id: imageId,
        /** Purchase signal in the customer's latest messages (drives owner alerts). */
        purchase: z.enum(PURCHASE_STAGES),
        /** One line: what they want to buy, when, quantity, name. */
        purchase_summary: z.string().nullable(),
        flow_done: z.boolean(),
    });
}

export interface BotReply {
    messages: string[];
    image_id: string | null;
    purchase: PurchaseStage;
    purchase_summary: string | null;
    flow_done: boolean;
}

/**
 * How past bot turns are rendered in history and few-shot examples. Only the
 * visible parts: labelling every past turn `purchase: "none"` would teach the
 * model to under-report purchases. The full contract is enforced by the JSON
 * schema passed to Ollama anyway.
 */
export function renderAssistantTurn(
    messages: string[],
    imageId: string | null = null,
): string {
    return JSON.stringify({ messages, image_id: imageId });
}

const RANK: Record<PurchaseStage, number> = {
    none: 0,
    interested: 1,
    agreed: 2,
};

export function maxStage(a: PurchaseStage, b: PurchaseStage): PurchaseStage {
    return RANK[a] >= RANK[b] ? a : b;
}
