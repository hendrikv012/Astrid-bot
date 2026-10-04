export type Rng = () => number;

export interface TypingConfig {
    cpsMin: number;
    cpsMax: number;
}

const between = (rng: Rng, min: number, max: number) =>
    min + rng() * (max - min);

/** Time before blue ticks: a person picks up the phone and reads. */
export function readDelayMs(
    incomingChars: number,
    rng: Rng = Math.random,
): number {
    const reading = Math.min(incomingChars * 30, 4000); // ~30ms/char, capped
    return Math.round(
        between(rng, 1000, 3000) + reading * between(rng, 0.5, 1),
    );
}

/** Minimum "thinking" pause before typing starts (LLM time counts toward it). */
export function thinkDelayMs(rng: Rng = Math.random): number {
    return Math.round(between(rng, 500, 2000));
}

/**
 * How long to show "typing…" for a bubble: characters / typing speed, with
 * ±20% jitter, clamped so short bubbles still look typed and long ones don't
 * stall the chat.
 */
export function typingDurationMs(
    chars: number,
    cfg: TypingConfig,
    rng: Rng = Math.random,
): number {
    const cps = between(rng, cfg.cpsMin, cfg.cpsMax);
    const jitter = between(rng, 0.8, 1.2);
    const ms = (chars / cps) * 1000 * jitter;
    return Math.round(Math.min(Math.max(ms, 1500), 25000));
}

/** Pause between two bubbles of the same reply. */
export function interBubbleGapMs(rng: Rng = Math.random): number {
    return Math.round(between(rng, 800, 2500));
}

/** "Typing…" before an image is shown as choosing a file. */
export function imagePickDelayMs(rng: Rng = Math.random): number {
    return Math.round(between(rng, 1000, 3000));
}

/** WhatsApp clears the composing indicator after ~10s; refresh before that. */
export const COMPOSING_REFRESH_MS = 8000;
