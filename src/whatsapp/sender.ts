import type { WAMessageKey, WASocket } from 'baileys';
import type { PreloadedImage } from '../config/images.js';
import type { OutboundLimiter } from './outboundLimiter.js';
import {
    COMPOSING_REFRESH_MS,
    distractionDelayMs,
    imagePickDelayMs,
    interBubbleGapMs,
    pickTurnCps,
    readDelayMs,
    thinkDelayMs,
    typingDurationMs,
    typingSegments,
    type HumanizeConfig,
} from '../humanize/typing.js';

export interface SendPlan {
    replyJid: string;
    messages: string[];
    image: PreloadedImage | null;
    /**
     * Checked before each bubble and image. Returning false stops the rest of
     * the reply, e.g. when a human took over the chat while the bot was typing.
     */
    shouldContinue?: () => boolean;
    /** Send the image before the text (e.g. the welcome picture). */
    imageFirst?: boolean;
}

export interface SentMessage {
    waMsgId: string | null;
    text: string;
    imageId: string | null;
}

export interface Sender {
    /** Pause like a person picking up the phone, then mark messages read. */
    markRead(keys: WAMessageKey[], incomingChars: number): Promise<void>;
    /** Wait out the remaining "thinking" time given how long generation took. */
    think(elapsedMs: number): Promise<void>;
    /** Send bubbles (and optional image) with typing indicators and pacing. */
    send(plan: SendPlan): Promise<SentMessage[]>;
    /** Immediate send, no humanizing and no waiting for the send cap (owner alerts, operator replies). Returns the message id. */
    sendRaw(jid: string, text: string): Promise<string | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSender(
    getSock: () => WASocket | null,
    opts: {
        humanize: boolean;
        typing: HumanizeConfig;
        /** Caps outgoing messages per minute and signals when to merge bubbles. */
        limiter?: OutboundLimiter;
    },
): Sender {
    const slot = () => opts.limiter?.acquire() ?? Promise.resolve();
    const sock = () => {
        const s = getSock();
        if (!s) throw new Error('WhatsApp socket not connected');
        return s;
    };
    const wait = (ms: number) =>
        opts.humanize ? sleep(ms) : Promise.resolve();

    /** Shows "typing…" in a WhatsApp-safe way: refreshed before it expires. */
    async function compose(jid: string, ms: number): Promise<void> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            await sock().sendPresenceUpdate('composing', jid);
            await sleep(Math.min(COMPOSING_REFRESH_MS, end - Date.now()));
        }
    }

    /** Types for `ms` total, with occasional stops mid-message. */
    async function typeFor(jid: string, ms: number): Promise<void> {
        if (!opts.humanize) return;
        for (const seg of typingSegments(ms, opts.typing)) {
            await compose(jid, seg.composeMs);
            if (seg.pauseMs) {
                await sock().sendPresenceUpdate('paused', jid);
                await sleep(seg.pauseMs);
            }
        }
        await sock().sendPresenceUpdate('paused', jid);
    }

    return {
        async markRead(keys, incomingChars) {
            await wait(readDelayMs(incomingChars));
            await sock().readMessages(keys);
        },

        async think(elapsedMs) {
            await wait(Math.max(0, thinkDelayMs() - elapsedMs));
        },

        async send({ replyJid, messages, image, shouldContinue, imageFirst }) {
            const sent: SentMessage[] = [];
            const keepGoing = () => !shouldContinue || shouldContinue();
            const stop = async () => {
                if (opts.humanize)
                    await sock()
                        .sendPresenceUpdate('paused', replyJid)
                        .catch(() => {});
                return sent;
            };
            if (opts.humanize)
                await sock()
                    .presenceSubscribe(replyJid)
                    .catch(() => {});

            // Sometimes the person gets distracted before starting to type.
            await wait(distractionDelayMs(opts.typing));
            const cps = pickTurnCps(opts.typing);

            // When the number is busy, one message instead of several saves sends.
            const bubbles =
                messages.length > 1 && opts.limiter?.shouldMerge()
                    ? [messages.join('\n\n')]
                    : messages;

            const sendImage = async (): Promise<boolean> => {
                if (!image) return true;
                if (!keepGoing()) return false;
                await typeFor(replyJid, imagePickDelayMs());
                if (!keepGoing()) return false;
                await slot();
                const res = await sock().sendMessage(replyJid, {
                    image: image.data,
                    mimetype: image.mimetype,
                    caption: image.caption || undefined,
                    viewOnce: image.viewOnce || undefined,
                });
                sent.push({
                    waMsgId: res?.key.id ?? null,
                    text: image.caption,
                    imageId: image.id,
                });
                return true;
            };

            if (image && imageFirst) {
                if (!(await sendImage())) return stop();
                if (bubbles.length) await wait(interBubbleGapMs());
            }

            for (let i = 0; i < bubbles.length; i++) {
                const text = bubbles[i]!;
                if (!keepGoing()) return stop();
                await typeFor(replyJid, typingDurationMs(text.length, cps));
                if (!keepGoing()) return stop();
                await slot();
                const res = await sock().sendMessage(replyJid, { text });
                sent.push({
                    waMsgId: res?.key.id ?? null,
                    text,
                    imageId: null,
                });
                if (i < bubbles.length - 1 || (image && !imageFirst))
                    await wait(interBubbleGapMs());
            }

            if (image && !imageFirst && !(await sendImage())) return stop();

            return sent;
        },

        async sendRaw(jid, text) {
            // Owner alerts and human replies go out immediately but still count.
            opts.limiter?.note();
            const res = await sock().sendMessage(jid, { text });
            return res?.key.id ?? null;
        },
    };
}
