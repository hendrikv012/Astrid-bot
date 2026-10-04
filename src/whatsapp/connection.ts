import fs from 'node:fs';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    useMultiFileAuthState,
    type proto,
    type WAMessage,
    type WASocket,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import type { Logger } from '../logger.js';
import type { SelfIds } from './inbound.js';

export interface ConnectionOptions {
    authDir: string;
    /** Digits only, with country code. When set, a pairing code is used instead of a QR. */
    pairingNumber?: string;
    log: Logger;
    onMessages: (messages: WAMessage[]) => void;
}

export interface Connection {
    getSock: () => WASocket | null;
    self: () => SelfIds;
    close: () => Promise<void>;
}

const MAX_BACKOFF_MS = 60_000;
const SENT_CACHE_SIZE = 500;

/**
 * Keeps a Baileys socket alive: QR / pairing-code login, credential
 * persistence, and reconnect with backoff. Only a logout stops it.
 */
export async function startConnection(
    opts: ConnectionOptions,
): Promise<Connection> {
    const { log } = opts;
    fs.mkdirSync(opts.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
    const waLog = log.child({ module: 'baileys' });
    waLog.level = log.level === 'trace' ? 'debug' : 'warn';

    // Baileys needs recently sent messages to answer re-send (retry) requests.
    const sentCache = new Map<string, proto.IMessage>();

    let sock: WASocket | null = null;
    let stopped = false;
    let attempt = 0;

    const connect = async () => {
        const { version } = await fetchLatestBaileysVersion().catch(() => ({
            version: undefined,
        }));
        const s = makeWASocket({
            auth: state,
            version,
            logger: waLog,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false, // keep the phone getting notifications
            syncFullHistory: false,
            getMessage: async (key) =>
                key.id ? sentCache.get(key.id) : undefined,
        });
        sock = s;

        s.ev.on('creds.update', saveCreds);

        if (opts.pairingNumber && !state.creds.registered) {
            const number = opts.pairingNumber.replace(/\D/g, '');
            setTimeout(async () => {
                try {
                    const code = await s.requestPairingCode(number);
                    log.info(
                        `Pairing code for ${number}: ${code}  (WhatsApp → Linked devices → Link with phone number)`,
                    );
                } catch (err) {
                    log.error({ err }, 'could not request pairing code');
                }
            }, 3000);
        }

        s.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr && !opts.pairingNumber) {
                log.info('Scan this QR code with WhatsApp → Linked devices:');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                attempt = 0;
                log.info({ user: s.user?.id }, 'WhatsApp connected');
            }
            if (connection === 'close') {
                const code = (
                    lastDisconnect?.error as
                        { output?: { statusCode?: number } } | undefined
                )?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    log.error(
                        `Logged out of WhatsApp. Delete ${opts.authDir} and restart to link again.`,
                    );
                    stopped = true;
                    return;
                }
                if (stopped) return;
                const delay =
                    code === DisconnectReason.restartRequired
                        ? 0
                        : Math.min(1000 * 2 ** attempt++, MAX_BACKOFF_MS);
                log.warn(
                    { code, delay },
                    'WhatsApp connection closed; reconnecting',
                );
                setTimeout(
                    () =>
                        connect().catch((err) =>
                            log.error({ err }, 'reconnect failed'),
                        ),
                    delay,
                );
            }
        });

        s.ev.on('messages.upsert', ({ messages, type }) => {
            for (const m of messages) {
                if (m.key.fromMe && m.key.id && m.message) {
                    sentCache.set(m.key.id, m.message);
                    if (sentCache.size > SENT_CACHE_SIZE) {
                        sentCache.delete(sentCache.keys().next().value!);
                    }
                }
            }
            // 'append' = history sync / offline backlog; only react to live messages.
            if (type === 'notify') opts.onMessages(messages);
        });
    };

    await connect();

    return {
        getSock: () => sock,
        self: () => ({
            pn: sock?.user?.id ? jidNormalizedUser(sock.user.id) : null,
            lid: sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
        }),
        close: async () => {
            stopped = true;
            sock?.end(undefined);
        },
    };
}
