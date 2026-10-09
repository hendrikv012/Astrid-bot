export type Rng = () => number;

export interface HumanizeConfig {
    /** Typing speed range in characters per second (5–7 ≈ 40–55 wpm). */
    cpsMin: number;
    cpsMax: number;
    /** Random delay before the first reply in a new or long-silent chat. */
    firstReplyMinMs: number;
    firstReplyMaxMs: number;
    /** Chance per typing stretch of stopping to "think" mid-message (0–1). */
    pauseChance: number;
    /** Chance per reply of getting briefly distracted before typing (0–1). */
    distractionChance: number;
}

const between = (rng: Rng, min: number, max: number) =>
    min + rng() * (max - min);

/**
 * Delay before answering a cold chat (first contact, or after a long
 * silence): the phone is in a pocket and the notification is seen a while
 * later. Log-uniform, so short waits are common and long ones occasional.
 */
export function firstReplyDelayMs(
    cfg: Pick<HumanizeConfig, 'firstReplyMinMs' | 'firstReplyMaxMs'>,
    rng: Rng = Math.random,
): number {
    if (cfg.firstReplyMaxMs <= 0) return 0;
    const min = Math.max(1, cfg.firstReplyMinMs);
    const max = Math.max(min, cfg.firstReplyMaxMs);
    return Math.round(Math.exp(between(rng, Math.log(min), Math.log(max))));
}

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
 * Sometimes a person reads, then gets distracted for a few seconds before
 * starting to type. Returns 0 most of the time.
 */
export function distractionDelayMs(
    cfg: Pick<HumanizeConfig, 'distractionChance'>,
    rng: Rng = Math.random,
): number {
    return rng() < cfg.distractionChance
        ? Math.round(between(rng, 3000, 15000))
        : 0;
}

/**
 * One typing speed per reply: the same person types at a consistent pace
 * within a reply, but not identically every time.
 */
export function pickTurnCps(
    cfg: Pick<HumanizeConfig, 'cpsMin' | 'cpsMax'>,
    rng: Rng = Math.random,
): number {
    return between(rng, cfg.cpsMin, cfg.cpsMax);
}

/**
 * How long to show "typing…" for a bubble at `cps`, with ±15% jitter per
 * bubble, clamped so short bubbles still look typed and long ones don't stall
 * the chat. Mid-message pauses (see typingSegments) come on top of this.
 */
export function typingDurationMs(
    chars: number,
    cps: number,
    rng: Rng = Math.random,
): number {
    const ms = (chars / cps) * 1000 * between(rng, 0.85, 1.15);
    return Math.round(Math.min(Math.max(ms, 1500), 25000));
}

export interface TypingSegment {
    /** Show "typing…" for this long. */
    composeMs: number;
    /** Then stop typing (indicator off) for this long; 0 for the last one. */
    pauseMs: number;
}

/**
 * Splits a typing duration into stretches separated by short stops, like a
 * person who pauses to think or re-reads before continuing. Each stretch of
 * ~4–9s has `pauseChance` of being followed by a 1–4s pause.
 */
export function typingSegments(
    totalMs: number,
    cfg: Pick<HumanizeConfig, 'pauseChance'>,
    rng: Rng = Math.random,
): TypingSegment[] {
    const segments: TypingSegment[] = [];
    let left = totalMs;
    while (left > 0) {
        const stretch = Math.min(left, Math.round(between(rng, 4000, 9000)));
        left -= stretch;
        const pause =
            left > 0 && rng() < cfg.pauseChance
                ? Math.round(between(rng, 1000, 4000))
                : 0;
        segments.push({ composeMs: stretch, pauseMs: pause });
    }
    return segments;
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
