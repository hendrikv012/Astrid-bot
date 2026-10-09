import type { WASocket } from 'baileys';
import { describe, expect, it } from 'vitest';
import { loadEnv, normalizeJid } from '../src/config/env.js';
import {
    RuntimeSettingsSchema,
    settingsFromEnv,
} from '../src/config/runtime.js';
import { createSender } from '../src/whatsapp/sender.js';

describe('.env and dashboard settings agree', () => {
    it('defaults are valid dashboard settings', () => {
        expect(
            RuntimeSettingsSchema.safeParse(settingsFromEnv(loadEnv({})))
                .success,
        ).toBe(true);
    });

    it('the most extreme valid .env values are valid dashboard settings', () => {
        const env = loadEnv({
            LLM_TEMPERATURE: '2',
            TYPING_CPS_MIN: '30',
            TYPING_CPS_MAX: '30',
            FIRST_REPLY_MIN_MS: '3600000',
            FIRST_REPLY_MAX_MS: '3600000',
            COLD_START_AFTER_MIN: '10080',
            HISTORY_MESSAGES: '200',
            RAG_TOP_K: '0',
            RAG_MAX_DISTANCE: '2',
            IMAGE_RESEND_HOURS: '720',
        });
        expect(
            RuntimeSettingsSchema.safeParse(settingsFromEnv(env)).success,
        ).toBe(true);
    });

    it('rejects .env values the dashboard could never save', () => {
        expect(() => loadEnv({ HISTORY_MESSAGES: '1' })).toThrow();
        expect(() => loadEnv({ RAG_TOP_K: '40' })).toThrow();
        expect(() => loadEnv({ FIRST_REPLY_MAX_MS: '7200000' })).toThrow();
        expect(() =>
            loadEnv({ TYPING_CPS_MIN: '9', TYPING_CPS_MAX: '5' }),
        ).toThrow(/TYPING_CPS_MIN/);
    });
});

describe('sender', () => {
    function fakeSock() {
        const sent: unknown[] = [];
        const sock = {
            sendMessage: async (_jid: string, content: unknown) => {
                sent.push(content);
                return { key: { id: `ID${sent.length}` } };
            },
            sendPresenceUpdate: async () => {},
            presenceSubscribe: async () => {},
            readMessages: async () => {},
        } as unknown as WASocket;
        return { sock, sent };
    }
    const typing = {
        cpsMin: 5,
        cpsMax: 7,
        firstReplyMinMs: 0,
        firstReplyMaxMs: 0,
        pauseChance: 0,
        distractionChance: 0,
    };

    it('stops the rest of a reply once shouldContinue turns false', async () => {
        const { sock, sent } = fakeSock();
        const sender = createSender(() => sock, { humanize: false, typing });
        // e.g. a human takes over right after the first bubble went out
        const out = await sender.send({
            replyJid: 'x@s.whatsapp.net',
            messages: ['een', 'twee', 'drie'],
            image: null,
            shouldContinue: () => sent.length < 1,
        });
        expect(out.map((m) => m.text)).toEqual(['een']);
        expect(sent).toHaveLength(1);
    });

    it('sends view-once images as view once', async () => {
        const { sock, sent } = fakeSock();
        const sender = createSender(() => sock, { humanize: false, typing });
        await sender.send({
            replyJid: 'x@s.whatsapp.net',
            messages: ['Hier is de foto'],
            image: {
                id: 'photo',
                caption: '',
                whenToUse: '',
                viewOnce: true,
                requestKeywords: [],
                resendAfterHours: 0,
                firstContact: false,
                mimetype: 'image/png',
                data: Buffer.from([1]),
            },
        });
        expect(sent[1]).toMatchObject({ viewOnce: true });
    });

    it('returns the message id from sendRaw', async () => {
        const { sock } = fakeSock();
        const sender = createSender(() => sock, { humanize: false, typing });
        expect(await sender.sendRaw('x@s.whatsapp.net', 'hoi')).toBe('ID1');
    });
});

describe('WhatsApp numbers in .env', () => {
    it('accepts a bare number, +number or JID and normalizes them', () => {
        expect(normalizeJid('37255512345')).toBe('37255512345@s.whatsapp.net');
        expect(normalizeJid('+372 5551 2345')).toBe(
            '37255512345@s.whatsapp.net',
        );
        expect(normalizeJid('37255512345@s.whatsapp.net')).toBe(
            '37255512345@s.whatsapp.net',
        );
        expect(normalizeJid('123456789012345@lid')).toBe('123456789012345@lid');
        const env = loadEnv({
            OWNER_JID: '+31612345678',
            ALLOWED_JIDS: '31612345678, 37255512345@s.whatsapp.net',
        });
        expect(env.OWNER_JID).toBe('31612345678@s.whatsapp.net');
        expect(env.ALLOWED_JIDS).toEqual([
            '31612345678@s.whatsapp.net',
            '37255512345@s.whatsapp.net',
        ]);
    });

    it('rejects placeholders and local numbers with a clear error', () => {
        expect(normalizeJid('CHANGE31612345678@s.whatsapp.net')).toBeNull();
        expect(normalizeJid('0612345678')).toBeNull();
        expect(() =>
            loadEnv({ OWNER_JID: 'CHANGE31612345678@s.whatsapp.net' }),
        ).toThrow(/not a WhatsApp number/);
        expect(() => loadEnv({ ALLOWED_JIDS: '31612345678,me' })).toThrow(
            /"me" is not a WhatsApp number/,
        );
    });
});
