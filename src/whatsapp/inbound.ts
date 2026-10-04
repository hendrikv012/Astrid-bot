import {
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isJidStatusBroadcast,
    isLidUser,
    isPnUser,
    jidNormalizedUser,
    normalizeMessageContent,
    type WAMessage,
    type WAMessageKey,
} from 'baileys';

export interface InboundMessage {
    /** Stable memory key for the chat (phone-number JID when known, else LID / group JID). */
    chatJid: string;
    /** JID to reply to — exactly what WhatsApp gave us. */
    replyJid: string;
    /** Stable sender key (same as chatJid in private chats). */
    senderJid: string;
    pushName: string | null;
    isGroup: boolean;
    /** True when the bot was @mentioned or the message replies to the bot. */
    addressedToBot: boolean;
    text: string;
    waMsgId: string;
    key: WAMessageKey;
    ts: number;
}

export interface SelfIds {
    pn: string | null;
    lid: string | null;
}

/**
 * Converts a raw Baileys message into an InboundMessage, or null when the bot
 * should ignore it (own messages, status, broadcasts, channels, protocol noise).
 */
export function normalizeInbound(
    msg: WAMessage,
    self: SelfIds,
): InboundMessage | null {
    const key = msg.key;
    const remote = key.remoteJid;
    if (!remote || key.fromMe || !key.id) return null;
    if (
        isJidStatusBroadcast(remote) ||
        isJidBroadcast(remote) ||
        isJidNewsletter(remote)
    ) {
        return null;
    }

    const content = normalizeMessageContent(msg.message);
    if (!content || content.protocolMessage || content.reactionMessage)
        return null;

    const isGroup = !!isJidGroup(remote);
    const chatJid = isGroup ? remote : preferPn(remote, key.remoteJidAlt);
    const senderJid = isGroup
        ? preferPn(key.participant ?? '', key.participantAlt)
        : chatJid;
    if (!senderJid) return null;

    const text = extractText(content);
    if (text === null) return null;

    const ctx =
        content.extendedTextMessage?.contextInfo ??
        content.imageMessage?.contextInfo ??
        content.videoMessage?.contextInfo ??
        null;
    const mine = [self.pn, self.lid].filter((j): j is string => !!j);
    const mentioned = (ctx?.mentionedJid ?? []).some((j) =>
        mine.includes(jidNormalizedUser(j)),
    );
    const repliedToMe =
        !!ctx?.participant && mine.includes(jidNormalizedUser(ctx.participant));

    const tsRaw = msg.messageTimestamp;
    const ts = tsRaw ? Number(tsRaw) * 1000 : Date.now();

    return {
        chatJid,
        replyJid: remote,
        senderJid,
        pushName: msg.pushName ?? null,
        isGroup,
        addressedToBot: !isGroup || mentioned || repliedToMe,
        text,
        waMsgId: key.id,
        key,
        ts,
    };
}

/**
 * WhatsApp addresses users by phone-number JID or by LID. The same person can
 * show up either way; using the PN when available keeps one memory per person.
 */
export function preferPn(jid: string, alt: string | null | undefined): string {
    if (!jid) return '';
    if (isLidUser(jid) && alt && isPnUser(alt)) return jidNormalizedUser(alt);
    return jidNormalizedUser(jid);
}

type Content = NonNullable<ReturnType<typeof normalizeMessageContent>>;

/** Text for the model; non-text media becomes a short marker. null = ignore. */
function extractText(c: Content): string | null {
    const caption = (s: string | null | undefined) => (s ? ` ${s}` : '');
    if (c.conversation) return c.conversation;
    if (c.extendedTextMessage?.text) return c.extendedTextMessage.text;
    if (c.imageMessage)
        return `[sent a photo]${caption(c.imageMessage.caption)}`;
    if (c.videoMessage)
        return `[sent a video]${caption(c.videoMessage.caption)}`;
    if (c.audioMessage) return '[sent a voice message]';
    if (c.documentMessage)
        return `[sent a document: ${c.documentMessage.fileName ?? 'file'}]`;
    if (c.stickerMessage) return '[sent a sticker]';
    if (c.locationMessage) return '[shared a location]';
    if (c.contactMessage) return '[shared a contact]';
    if (c.buttonsResponseMessage?.selectedDisplayText)
        return c.buttonsResponseMessage.selectedDisplayText;
    if (c.listResponseMessage?.title) return c.listResponseMessage.title;
    return null;
}
