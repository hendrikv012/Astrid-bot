import { z } from 'zod';

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
        escalate: z.boolean(),
        escalate_reason: z.string().nullable(),
        flow_done: z.boolean(),
    });
}

export interface BotReply {
    messages: string[];
    image_id: string | null;
    escalate: boolean;
    escalate_reason: string | null;
    flow_done: boolean;
}

/** How past bot turns are rendered in history, so the model keeps the format. */
export function renderAssistantTurn(
    messages: string[],
    imageId: string | null = null,
): string {
    const turn: BotReply = {
        messages,
        image_id: imageId,
        escalate: false,
        escalate_reason: null,
        flow_done: false,
    };
    return JSON.stringify(turn);
}
