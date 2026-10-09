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
import type { ILogger } from 'baileys/lib/Utils/logger.js';
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

export type ConnectionStatus =
    'connecting' | 'waiting_for_qr' | 'open' | 'reconnecting' | 'logged_out';

export interface ConnectionState {
    status: ConnectionStatus;
    /** Latest QR rendered as text (for the dashboard), while waiting for a scan. */
    qrText: string | null;
    user: string | null;
}

export interface Connection {
    getSock: () => WASocket | null;
    state: () => ConnectionState;
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
    const baileysLog = log.child({ module: 'baileys' });
    baileysLog.level = log.level === 'trace' ? 'debug' : 'warn';
    const waLog = quietAppStateNoise(baileysLog);

    // Baileys needs recently sent messages to answer re-send (retry) requests.
    const sentCache = new Map<string, proto.IMessage>();

    let sock: WASocket | null = null;
    const connState: ConnectionState = {
        status: 'connecting',
        qrText: null,
        user: null,
    };
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
                connState.status = 'waiting_for_qr';
                qrcode.generate(qr, { small: true }, (text) => {
                    connState.qrText = text;
                });
                log.info('Scan this QR code with WhatsApp → Linked devices:');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                connState.status = 'open';
                connState.qrText = null;
                connState.user = s.user?.id
                    ? jidNormalizedUser(s.user.id)
                    : null;
                attempt = 0;
                log.info({ user: s.user?.id }, 'WhatsApp connected');
            }
            if (connection === 'close') {
                const code = (
                    lastDisconnect?.error as
                        { output?: { statusCode?: number } } | undefined
                )?.output?.statusCode;
                // An old QR can't be scanned any more; a new one follows on reconnect.
                connState.status = 'reconnecting';
                connState.qrText = null;
                if (code === DisconnectReason.loggedOut) {
                    connState.status = 'logged_out';
                    connState.user = null;
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
            else
                log.debug(
                    { type, count: messages.length },
                    'skipped non-live messages',
                );
        });
    };

    await connect();

    return {
        getSock: () => sock,
        state: () => ({ ...connState }),
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

/**
 * Right after linking, WhatsApp's settings sync (archive, mute, labels) can't
 * be decoded until the phone shares its keys. The bot doesn't use that sync,
 * so those warnings are logged at debug. Messages are not affected.
 */
const APP_STATE_NOISE = /missing key|failed to find key|decode mutation/i;

function quietAppStateNoise(l: ILogger): ILogger {
    const noisy = (args: unknown[]) =>
        args.some((a) => typeof a === 'string' && APP_STATE_NOISE.test(a));
    type Args = [unknown, string?];
    return {
        get level() {
            return l.level;
        },
        set level(v: string) {
            l.level = v;
        },
        child: (obj) => quietAppStateNoise(l.child(obj)),
        trace: (...a: Args) => l.trace(...a),
        debug: (...a: Args) => l.debug(...a),
        info: (...a: Args) => l.info(...a),
        warn: (...a: Args) => (noisy(a) ? l.debug(...a) : l.warn(...a)),
        error: (...a: Args) => (noisy(a) ? l.debug(...a) : l.error(...a)),
    };
}
