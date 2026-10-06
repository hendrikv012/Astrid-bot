import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { ImageLibrary } from '../config/images.js';
import { parsePersona } from '../config/persona.js';
import {
    RuntimeSettingsSchema,
    type RuntimeKey,
    type RuntimeSettings,
} from '../config/runtime.js';
import { sameModel } from '../brain/llm.js';
import { parseSop, type LoadedSop } from '../config/sop.js';
import type { Persona } from '../config/persona.js';
import type { Logger } from '../logger.js';
import { ChatMemory } from '../memory/ChatMemory.js';
import type { DB } from '../memory/db.js';
import type { IngestResult } from '../rag/ingest.js';
import type { ConnectionState } from '../whatsapp/connection.js';
import { getStats, listChats, listKnowledge } from './admin.js';

export interface DashboardDeps {
    db: DB;
    log: Logger;
    token: string;
    host: string;
    port: number;
    bot: {
        readonly sop: LoadedSop;
        updateSop(sop: LoadedSop): void;
        updatePersona(persona: Persona): void;
        operatorSend(chatJid: string, text: string): Promise<void>;
    };
    paths: {
        sopFile: string;
        personaFile: string;
        knowledgeDir: string;
        publicDir: string;
    };
    images: ImageLibrary;
    runtime: {
        get(): RuntimeSettings;
        /** Validated settings: apply to live objects and persist. */
        set(s: RuntimeSettings): void;
        /** Drop dashboard overrides, back to .env values. */
        reset(): void;
        /** Keys currently overriding .env. */
        overrides(): RuntimeKey[];
        readonly defaults: RuntimeSettings;
    };
    connection: () => ConnectionState;
    /** Installed Ollama models that can chat (embedding models excluded). */
    listChatModels: () => Promise<string[]>;
    reingest: () => Promise<IngestResult>;
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

type Handler = (ctx: {
    req: http.IncomingMessage;
    url: URL;
    params: string[];
    body: () => Promise<unknown>;
}) => Promise<unknown> | unknown;

interface Route {
    method: string;
    pattern: RegExp;
    handler: Handler;
}

const MAX_BODY = 1_000_000;
const KNOWLEDGE_EXT = new Set(['.md', '.markdown', '.txt']);

/**
 * Local admin dashboard. Binds to 127.0.0.1 by default, requires a bearer
 * token for every API call, and rejects foreign Host headers (DNS rebinding).
 */
export function startDashboard(deps: DashboardDeps): Promise<http.Server> {
    const routes = buildRoutes(deps);
    const allowedHosts = new Set([
        `127.0.0.1:${deps.port}`,
        `localhost:${deps.port}`,
        `[::1]:${deps.port}`,
        `${deps.host}:${deps.port}`,
    ]);
    const anyHost = deps.host === '0.0.0.0' || deps.host === '::';

    const server = http.createServer(async (req, res) => {
        const send = (
            status: number,
            body: unknown,
            type = 'application/json',
        ) => {
            res.writeHead(status, {
                'Content-Type': type,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
            });
            res.end(type === 'application/json' ? JSON.stringify(body) : body);
        };

        try {
            const port = (server.address() as { port: number } | null)?.port;
            if (
                !anyHost &&
                !isAllowedHost(req.headers.host, allowedHosts, port)
            ) {
                throw new HttpError(403, 'forbidden host');
            }
            const url = new URL(req.url ?? '/', 'http://localhost');

            if (
                req.method === 'GET' &&
                (url.pathname === '/' || url.pathname === '/index.html')
            ) {
                const html = fs.readFileSync(
                    path.join(deps.paths.publicDir, 'index.html'),
                );
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy':
                        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
                    'X-Frame-Options': 'DENY',
                });
                res.end(html);
                return;
            }

            if (!url.pathname.startsWith('/api/'))
                throw new HttpError(404, 'not found');
            authorize(req, url, deps.token);

            const route = routes.find(
                (r) => r.method === req.method && r.pattern.test(url.pathname),
            );
            if (!route) throw new HttpError(404, 'not found');
            const params = (route.pattern.exec(url.pathname) ?? [])
                .slice(1)
                .map((p) => decodeURIComponent(p));

            const result = await route.handler({
                req,
                url,
                params,
                body: () => readJson(req),
            });
            if (isBinary(result)) {
                send(200, result.binary, result.type);
            } else {
                send(200, result ?? { ok: true });
            }
        } catch (err) {
            if (err instanceof HttpError) {
                send(err.status, { error: err.message });
            } else if (err instanceof z.ZodError) {
                send(400, { error: z.prettifyError(err) });
            } else {
                deps.log.error({ err }, 'dashboard request failed');
                send(500, { error: 'internal error' });
            }
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.port, deps.host, () => resolve(server));
    });
}

function buildRoutes(d: DashboardDeps): Route[] {
    const routes: Route[] = [];
    const on = (method: string, pattern: string, handler: Handler) =>
        routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

    const chatOr404 = (jid: string) => {
        const exists = d.db
            .prepare(`SELECT 1 FROM chats WHERE jid = ?`)
            .get(jid);
        if (!exists) throw new HttpError(404, 'chat not found');
        return new ChatMemory(d.db, jid);
    };

    // Polled every few seconds by every tab, so it must stay cheap: no DB scans.
    on('GET', '/api/status', () => ({
        connection: d.connection(),
        sopHash: d.bot.sop.hash,
        botName: d.bot.sop.sop.identity.name,
    }));

    on('GET', '/api/stats', () => ({ stats: getStats(d.db) }));

    // --- chats ---
    on('GET', '/api/chats', ({ url }) => ({
        chats: listChats(d.db, url.searchParams.get('q') ?? ''),
    }));

    on('GET', '/api/chats/([^/]+)', ({ params, url }) => {
        const mem = chatOr404(params[0]!);
        const requested = Number.parseInt(
            url.searchParams.get('limit') ?? '',
            10,
        );
        const limit = Number.isFinite(requested)
            ? Math.min(Math.max(requested, 1), 1000)
            : 200;
        return {
            jid: mem.chatJid,
            messages: mem.recentMessages(limit),
            facts: mem.getFacts(),
            summary: mem.getSummary(),
            pausedUntil: mem.getPausedUntil(),
            flowState: mem.getFlowState(),
        };
    });

    on('POST', '/api/chats/([^/]+)/pause', async ({ params, body }) => {
        const { minutes } = z
            .object({ minutes: z.number().positive().max(525_600).nullable() })
            .parse(await body());
        const until =
            minutes === null
                ? Date.now() + 365 * 24 * 3_600_000
                : Date.now() + minutes * 60_000;
        chatOr404(params[0]!).setPausedUntil(until);
        return { pausedUntil: until };
    });

    on('POST', '/api/chats/([^/]+)/resume', ({ params }) => {
        chatOr404(params[0]!).setPausedUntil(0);
        return { pausedUntil: 0 };
    });

    on('POST', '/api/chats/([^/]+)/send', async ({ params, body }) => {
        const { text } = z
            .object({ text: z.string().trim().min(1).max(4000) })
            .parse(await body());
        const mem = chatOr404(params[0]!);
        await d.bot.operatorSend(mem.chatJid, text);
        return { pausedUntil: mem.getPausedUntil() };
    });

    on('DELETE', '/api/chats/([^/]+)/facts', ({ params, url }) => {
        const subject = url.searchParams.get('subject');
        const key = url.searchParams.get('key');
        if (!subject || !key)
            throw new HttpError(400, 'subject and key are required');
        chatOr404(params[0]!).deleteFact(subject, key);
        return { ok: true };
    });

    on('DELETE', '/api/chats/([^/]+)/flow', ({ params }) => {
        chatOr404(params[0]!).setFlowState(null);
        return { ok: true };
    });

    // --- SOP & persona ---
    on('GET', '/api/sop', () => ({
        raw: fs.readFileSync(d.paths.sopFile, 'utf8'),
        hash: d.bot.sop.hash,
    }));

    on('PUT', '/api/sop', async ({ body }) => {
        const { raw } = z
            .object({ raw: z.string().max(MAX_BODY) })
            .parse(await body());
        let loaded: LoadedSop;
        try {
            loaded = parseSop(raw, 'SOP');
        } catch (err) {
            throw new HttpError(422, (err as Error).message);
        }
        // The persona's example lines are keyed by the bot name, which lives in
        // the SOP. Renaming must not silently drop every few-shot example.
        const oldName = d.bot.sop.sop.identity.name;
        const newName = loaded.sop.identity.name;
        const persona = parsePersona(
            fs.readFileSync(d.paths.personaFile, 'utf8'),
            newName,
        );
        if (newName !== oldName && persona.ignoredSpeakers.length) {
            throw new HttpError(
                422,
                `Renaming the bot to "${newName}" would make the persona ignore its example replies (they start with ${persona.ignoredSpeakers.map((n) => `"${n}:"`).join(', ')}). In the Persona tab, change those lines to "${newName}:" or "Bot:" first, then save the SOP again.`,
            );
        }
        writeAtomic(d.paths.sopFile, raw);
        d.bot.updateSop(loaded);
        d.bot.updatePersona(persona);
        d.log.info({ sopHash: loaded.hash }, 'SOP updated from dashboard');
        return { hash: loaded.hash };
    });

    on('GET', '/api/persona', () => ({
        raw: fs.readFileSync(d.paths.personaFile, 'utf8'),
    }));

    on('PUT', '/api/persona', async ({ body }) => {
        const { raw } = z
            .object({ raw: z.string().max(MAX_BODY) })
            .parse(await body());
        const botName = d.bot.sop.sop.identity.name;
        let persona: Persona;
        try {
            persona = parsePersona(raw, botName);
        } catch (err) {
            throw new HttpError(422, (err as Error).message);
        }
        if (persona.ignoredSpeakers.length) {
            throw new HttpError(
                422,
                `Example lines starting with ${persona.ignoredSpeakers.map((n) => `"${n}:"`).join(', ')} would be ignored. Use "User:" for the customer and "${botName}:" or "Bot:" for replies.`,
            );
        }
        writeAtomic(d.paths.personaFile, raw);
        d.bot.updatePersona(persona);
        d.log.info(
            { examples: persona.examples.length },
            'persona updated from dashboard',
        );
        return { examples: persona.examples.length };
    });

    // --- runtime settings ---
    on('GET', '/api/settings', async () => ({
        settings: d.runtime.get(),
        defaults: d.runtime.defaults,
        overrides: d.runtime.overrides(),
        models: await d.listChatModels().catch(() => []),
    }));

    on('PUT', '/api/settings', async ({ body }) => {
        const parsed = RuntimeSettingsSchema.safeParse(await body());
        if (!parsed.success)
            throw new HttpError(422, z.prettifyError(parsed.error));
        const { chatModel } = parsed.data;
        const models = await d.listChatModels().catch(() => null);
        if (models && !models.some((m) => sameModel(m, chatModel))) {
            throw new HttpError(
                422,
                `"${chatModel}" is not an installed chat model. Embedding models can't chat; to install a chat model run: ollama pull ${chatModel}`,
            );
        }
        d.runtime.set(parsed.data);
        d.log.info(
            { overrides: d.runtime.overrides() },
            'settings updated from dashboard',
        );
        return { settings: parsed.data, overrides: d.runtime.overrides() };
    });

    on('DELETE', '/api/settings', () => {
        d.runtime.reset();
        d.log.info('dashboard settings reset to .env');
        return { settings: d.runtime.get(), overrides: [] };
    });

    // --- knowledge ---
    on('GET', '/api/knowledge', () => ({
        documents: listKnowledge(d.db),
        files: listKnowledgeFiles(d.paths.knowledgeDir),
    }));

    on('GET', '/api/knowledge/file', ({ url }) => {
        const file = knowledgePath(
            d.paths.knowledgeDir,
            url.searchParams.get('path'),
        );
        if (!fs.existsSync(file)) throw new HttpError(404, 'file not found');
        return { raw: fs.readFileSync(file, 'utf8') };
    });

    on('PUT', '/api/knowledge/file', async ({ url, body }) => {
        const file = knowledgePath(
            d.paths.knowledgeDir,
            url.searchParams.get('path'),
        );
        const { raw } = z
            .object({ raw: z.string().max(MAX_BODY) })
            .parse(await body());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, raw);
        return { ok: true };
    });

    on('DELETE', '/api/knowledge/file', ({ url }) => {
        const file = knowledgePath(
            d.paths.knowledgeDir,
            url.searchParams.get('path'),
        );
        if (fs.existsSync(file)) fs.rmSync(file);
        return { ok: true };
    });

    // One ingest at a time: a second click joins the running one instead of
    // embedding everything twice and colliding on kb_documents.path.
    let ingesting: Promise<IngestResult> | null = null;
    on('POST', '/api/knowledge/reingest', async () => {
        try {
            ingesting ??= d.reingest().finally(() => {
                ingesting = null;
            });
            return await ingesting;
        } catch (err) {
            throw new HttpError(
                502,
                `re-ingest failed: ${(err as Error).message}`,
            );
        }
    });

    // --- images (read-only) ---
    on('GET', '/api/images', () => ({
        images: [...d.images.values()].map((i) => ({
            id: i.id,
            caption: i.caption,
            whenToUse: i.whenToUse,
            viewOnce: i.viewOnce,
            requestKeywords: i.requestKeywords,
            mimetype: i.mimetype,
            bytes: i.data.length,
        })),
    }));

    on('GET', '/api/images/([a-z0-9_]+)', ({ params }) => {
        const img = d.images.get(params[0]!);
        if (!img) throw new HttpError(404, 'image not found');
        return { binary: img.data, type: img.mimetype };
    });

    return routes;
}

function isBinary(r: unknown): r is { binary: Buffer; type: string } {
    return !!r && typeof r === 'object' && 'binary' in r;
}

function authorize(req: http.IncomingMessage, url: URL, token: string): void {
    const header = req.headers.authorization ?? '';
    // Query tokens are only accepted for image GETs (an <img> can't send headers).
    const query =
        req.method === 'GET' && url.pathname.startsWith('/api/images/')
            ? (url.searchParams.get('token') ?? '')
            : '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : query;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new HttpError(401, 'missing or wrong dashboard token');
    }
}

function isAllowedHost(
    host: string | undefined,
    allowed: Set<string>,
    actualPort: number | undefined,
): boolean {
    if (!host) return false;
    if (allowed.has(host)) return true;
    // port 0 in config (tests): compare against the real listening port.
    return (
        actualPort !== undefined &&
        ['127.0.0.1', 'localhost', '[::1]'].some(
            (h) => host === `${h}:${actualPort}`,
        )
    );
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new HttpError(413, 'body too large');
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
        throw new HttpError(400, 'invalid JSON');
    }
}

function writeAtomic(file: string, content: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

function knowledgePath(dir: string, rel: string | null): string {
    if (!rel) throw new HttpError(400, 'path is required');
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep))
        throw new HttpError(400, 'path must stay inside the knowledge folder');
    if (!KNOWLEDGE_EXT.has(path.extname(file).toLowerCase())) {
        throw new HttpError(
            400,
            'only .md, .markdown and .txt files are allowed',
        );
    }
    return file;
}

function listKnowledgeFiles(dir: string): { path: string; bytes: number }[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(
            (e) =>
                e.isFile() &&
                KNOWLEDGE_EXT.has(path.extname(e.name).toLowerCase()),
        )
        .map((e) => {
            const full = path.join(e.parentPath, e.name);
            return {
                path: path.relative(dir, full),
                bytes: fs.statSync(full).size,
            };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}
