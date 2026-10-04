import type { WAMessageKey, WASocket } from 'baileys';
import type { PreloadedImage } from '../config/images.js';
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
    /** Plain immediate send without humanizing (owner notifications). */
    sendRaw(jid: string, text: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSender(
    getSock: () => WASocket | null,
    opts: { humanize: boolean; typing: HumanizeConfig },
): Sender {
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

        async send({ replyJid, messages, image }) {
            const sent: SentMessage[] = [];
            if (opts.humanize)
                await sock()
                    .presenceSubscribe(replyJid)
                    .catch(() => {});

            // Sometimes the person gets distracted before starting to type.
            await wait(distractionDelayMs(opts.typing));
            const cps = pickTurnCps(opts.typing);

            for (let i = 0; i < messages.length; i++) {
                const text = messages[i]!;
                await typeFor(replyJid, typingDurationMs(text.length, cps));
                const res = await sock().sendMessage(replyJid, { text });
                sent.push({
                    waMsgId: res?.key.id ?? null,
                    text,
                    imageId: null,
                });
                if (i < messages.length - 1 || image)
                    await wait(interBubbleGapMs());
            }

            if (image) {
                await typeFor(replyJid, imagePickDelayMs());
                const res = await sock().sendMessage(replyJid, {
                    image: image.data,
                    mimetype: image.mimetype,
                    caption: image.caption || undefined,
                });
                sent.push({
                    waMsgId: res?.key.id ?? null,
                    text: image.caption,
                    imageId: image.id,
                });
            }

            return sent;
        },

        async sendRaw(jid, text) {
            await sock().sendMessage(jid, { text });
        },
    };
}
