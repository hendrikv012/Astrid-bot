import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadImages } from '../src/config/images.js';
import type { Persona } from '../src/config/persona.js';
import {
    loadRuntimeSettings,
    RuntimeStore,
    saveRuntimeSettings,
    type RuntimeSettings,
} from '../src/config/runtime.js';
import { loadSop, type LoadedSop } from '../src/config/sop.js';
import { applyRuntimeSettings } from '../src/dashboard/admin.js';
import { startDashboard } from '../src/dashboard/server.js';
import type { HumanizeConfig } from '../src/humanize/typing.js';
import { ChatMemory } from '../src/memory/ChatMemory.js';
import { openDb, type DB } from '../src/memory/db.js';
import type { BotSettings } from '../src/pipeline/bot.js';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'test-token-0123456789abcdef';
const A = '31600000001@s.whatsapp.net';
const B = '31600000002@s.whatsapp.net';

const baseSettings: RuntimeSettings = {
    chatModel: 'qwen2.5:14b-instruct',
    temperature: 0.4,
    humanize: true,
    typingCpsMin: 5,
    typingCpsMax: 7,
    firstReplyMinSec: 20,
    firstReplyMaxSec: 150,
    coldStartAfterMin: 60,
    typingPauseChance: 0.25,
    distractionChance: 0.1,
    replyInGroups: false,
    historyMessages: 20,
    ragTopK: 6,
    ragMaxDistance: 0.6,
    imageResendHours: 24,
};

let dir: string;
let db: DB;
let server: http.Server;
let base: string;
let runtime: RuntimeStore;
let reingestCalls = 0;
const bot = {
    sop: null as unknown as LoadedSop,
    persona: null as Persona | null,
    sent: [] as { jid: string; text: string }[],
    updateSop(s: LoadedSop) {
        this.sop = s;
    },
    updatePersona(p: Persona) {
        this.persona = p;
    },
    async operatorSend(jid: string, text: string) {
        this.sent.push({ jid, text });
        new ChatMemory(db, jid).setPausedUntil(Date.now() + 60_000);
    },
};
const llmCalls: unknown[] = [];
const senderOpts = {
    humanize: true,
    typing: {} as HumanizeConfig,
};
const botSettings = { firstReply: {} } as BotSettings;

const call = (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
) =>
    fetch(`${base}${url}`, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            ...(body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

/** Parsed response body; assertions check its shape, not the type system. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response | Promise<Response>): Promise<any> =>
    (await res).json();

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-dash-'));
    fs.cpSync(path.join(root, 'config'), path.join(dir, 'config'), {
        recursive: true,
    });
    fs.mkdirSync(path.join(dir, 'knowledge'));
    fs.writeFileSync(
        path.join(dir, 'knowledge', 'hours.md'),
        '# Hours\n\nTue-Sat',
    );

    db = openDb({ path: ':memory:', embedDim: 4 });
    bot.sop = loadSop(path.join(dir, 'config/astrid.sop.yaml'));
    bot.sent = [];
    reingestCalls = 0;

    const a = new ChatMemory(db, A);
    a.ensureChat({ name: 'Marieke' });
    a.addMessage({ direction: 'in', text: 'hoi' });
    a.addMessage({ direction: 'out', text: 'Hoi! Hoe kan ik helpen?' });
    a.upsertFact({ key: 'name', value: 'Marieke' });
    new ChatMemory(db, B).addMessage({ direction: 'in', text: 'hallo' });

    runtime = new RuntimeStore(db, baseSettings);
    runtime.attach((s) =>
        applyRuntimeSettings(s, {
            llm: { setOptions: (o) => llmCalls.push(o) },
            sender: senderOpts,
            bot: botSettings,
        }),
    );
    llmCalls.length = 0;

    server = await startDashboard({
        db,
        log: pino({ level: 'silent' }),
        token: TOKEN,
        host: '127.0.0.1',
        port: 0,
        bot,
        paths: {
            sopFile: path.join(dir, 'config/astrid.sop.yaml'),
            personaFile: path.join(dir, 'config/persona.md'),
            knowledgeDir: path.join(dir, 'knowledge'),
            publicDir: path.join(root, 'dashboard'),
        },
        images: loadImages(
            path.join(dir, 'config/images.yaml'),
            path.join(root, 'assets/images'),
        ),
        runtime,
        connection: () => ({
            status: 'open',
            qrText: null,
            user: '31600000099@s.whatsapp.net',
        }),
        listChatModels: async () => ['qwen2.5:14b-instruct', 'llama3.1:8b'],
        load: () => ({
            scheduler: {
                running: 2,
                queuedReplies: 40,
                queuedBackground: 10,
                replyWaitAvgMs: 150_000,
                replyWaitMaxMs: 200_000,
            },
            outbound: {
                sentLastMinute: 100,
                maxPerMinute: 120,
                merging: true,
                waiting: 3,
            },
        }),
        reingest: async () => {
            reingestCalls++;
            await new Promise((r) => setTimeout(r, 30));
            return {
                added: [],
                updated: ['hours.md'],
                unchanged: [],
                removed: [],
            };
        },
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('dashboard security', () => {
    it('serves the page without a token but requires it for the API', async () => {
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('Astrid');

        expect((await fetch(`${base}/api/chats`)).status).toBe(401);
        expect(
            (
                await call('GET', '/api/chats', undefined, {
                    Authorization: 'Bearer wrong',
                })
            ).status,
        ).toBe(401);
        expect((await call('GET', '/api/chats')).status).toBe(200);
    });

    it('rejects foreign Host headers (DNS rebinding)', async () => {
        const http = await import('node:http');
        const status = await new Promise<number>((resolve) => {
            const port = (server.address() as { port: number }).port;
            http.get(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/api/chats',
                    headers: {
                        Host: 'evil.example:80',
                        Authorization: `Bearer ${TOKEN}`,
                    },
                },
                (res) => resolve(res.statusCode ?? 0),
            );
        });
        expect(status).toBe(403);
    });

    it('keeps knowledge file access inside the knowledge folder', async () => {
        const r = await call(
            'GET',
            `/api/knowledge/file?path=${encodeURIComponent('../config/astrid.sop.yaml')}`,
        );
        expect(r.status).toBe(400);
        const r2 = await call('PUT', `/api/knowledge/file?path=evil.sh`, {
            raw: 'x',
        });
        expect(r2.status).toBe(400);
    });
});

describe('chats', () => {
    it('lists chats and shows one chat’s messages and facts', async () => {
        const { chats } = await json(call('GET', '/api/chats'));
        expect(chats.map((c: { jid: string }) => c.jid).sort()).toEqual(
            [A, B].sort(),
        );

        const chat = await json(
            call('GET', `/api/chats/${encodeURIComponent(A)}`),
        );
        expect(chat.messages.map((m: { text: string }) => m.text)).toEqual([
            'hoi',
            'Hoi! Hoe kan ik helpen?',
        ]);
        expect(chat.facts[0].value).toBe('Marieke');

        const other = await json(
            call('GET', `/api/chats/${encodeURIComponent(B)}`),
        );
        expect(JSON.stringify(other)).not.toContain('Marieke');
    });

    it('pauses, resumes, forgets facts and sends operator replies', async () => {
        const jid = encodeURIComponent(A);
        const p = await json(
            call('POST', `/api/chats/${jid}/pause`, { minutes: 30 }),
        );
        expect(p.pausedUntil).toBeGreaterThan(Date.now());
        await call('POST', `/api/chats/${jid}/resume`, {});
        expect(new ChatMemory(db, A).getPausedUntil()).toBe(0);

        await call('DELETE', `/api/chats/${jid}/facts?subject=chat&key=name`);
        expect(new ChatMemory(db, A).getFacts()).toEqual([]);

        expect(
            (await call('POST', `/api/chats/${jid}/send`, { text: '  ' }))
                .status,
        ).toBe(400);
        await call('POST', `/api/chats/${jid}/send`, {
            text: 'Ik help je verder!',
        });
        expect(bot.sent).toEqual([{ jid: A, text: 'Ik help je verder!' }]);
    });

    it('keeps /api/status light and serves stats separately', async () => {
        const status = await json(call('GET', '/api/status'));
        expect(status.connection.status).toBe('open');
        expect(status.stats).toBeUndefined();
        expect(status.load).toMatchObject({
            behind: true,
            outbound: { merging: true },
        });
        const { stats } = await json(call('GET', '/api/stats'));
        expect(stats.chats).toBe(2);
        expect(stats).toHaveProperty('agreedToday', 0);
    });

    it('clamps the message limit', async () => {
        const jid = encodeURIComponent(A);
        for (const limit of ['-1', '1.5', 'abc', '0']) {
            const r = await call('GET', `/api/chats/${jid}?limit=${limit}`);
            expect(r.status).toBe(200);
        }
        const one = await json(call('GET', `/api/chats/${jid}?limit=-1`));
        expect(one.messages).toHaveLength(1);
    });

    it('404s unknown chats', async () => {
        expect(
            (await call('GET', '/api/chats/nobody%40s.whatsapp.net')).status,
        ).toBe(404);
    });
});

describe('SOP and persona editing', () => {
    it('refuses an invalid SOP and leaves the file untouched', async () => {
        const file = path.join(dir, 'config/astrid.sop.yaml');
        const before = fs.readFileSync(file, 'utf8');
        const r = await call('PUT', '/api/sop', {
            raw: 'version: 1\nidentity: {}',
        });
        expect(r.status).toBe(422);
        expect((await json(r)).error).toMatch(/failed validation/);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('saves a valid SOP, hot-swaps it and reloads the persona', async () => {
        const file = path.join(dir, 'config/astrid.sop.yaml');
        const raw = fs
            .readFileSync(file, 'utf8')
            .replace('max_messages_per_reply: 3', 'max_messages_per_reply: 2');
        const r = await call('PUT', '/api/sop', { raw });
        expect(r.status).toBe(200);
        expect(bot.sop.sop.limits.max_messages_per_reply).toBe(2);
        expect(bot.persona?.examples.length).toBeGreaterThan(0);
        expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    });

    it('refuses a rename that would drop the persona examples', async () => {
        const file = path.join(dir, 'config/astrid.sop.yaml');
        const before = fs.readFileSync(file, 'utf8');
        const r = await call('PUT', '/api/sop', {
            raw: before.replace('name: Astrid', 'name: Bella'),
        });
        expect(r.status).toBe(422);
        expect((await json(r)).error).toMatch(/"Astrid:".*"Bella:" or "Bot:"/);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('refuses persona example lines that would be ignored', async () => {
        const r = await call('PUT', '/api/persona', {
            raw: 'You are Astrid.\n\n## Examples\n\nUser: hi\nBella: hoi!\n',
        });
        expect(r.status).toBe(422);
        expect((await json(r)).error).toMatch(/"Bella:"/);
    });

    it('saves the persona', async () => {
        const r = await call('PUT', '/api/persona', {
            raw: 'You are Astrid.\n\n## Examples\n\nUser: hi\nAstrid: hoi!\n',
        });
        expect(await json(r)).toEqual({ examples: 1 });
        expect(bot.persona?.text).toBe('You are Astrid.');
    });
});

describe('settings', () => {
    it('validates, applies to live objects and returns models', async () => {
        const got = (await json(call('GET', '/api/settings'))) as {
            models: string[];
        };
        expect(got.models).toContain('llama3.1:8b');

        const bad = await call('PUT', '/api/settings', {
            ...runtime.get(),
            typingCpsMin: 9,
            typingCpsMax: 5,
        });
        expect(bad.status).toBe(422);
        for (const chatModel of ['not-pulled', 'nomic-embed-text']) {
            const r = await call('PUT', '/api/settings', {
                ...runtime.get(),
                chatModel,
            });
            expect(r.status).toBe(422);
        }

        const ok = await call('PUT', '/api/settings', {
            ...runtime.get(),
            temperature: 0.8,
            humanize: false,
            chatModel: 'llama3.1:8b',
            firstReplyMaxSec: 90,
        });
        expect(ok.status).toBe(200);
        expect(llmCalls.at(-1)).toEqual({
            chatModel: 'llama3.1:8b',
            temperature: 0.8,
        });
        expect(senderOpts.humanize).toBe(false);
        expect(botSettings.firstReply.maxMs).toBe(0); // humanize off disables the first-reply wait
    });

    it('stores only overrides and can reset to .env', async () => {
        await call('PUT', '/api/settings', {
            ...runtime.get(),
            temperature: 1.1,
        });
        const got = await json(call('GET', '/api/settings'));
        expect(got.overrides).toEqual(['temperature']);
        expect(got.defaults.temperature).toBe(0.4);

        // A later .env change to another key still applies on restart.
        const newEnv = { ...baseSettings, historyMessages: 50 };
        const reloaded = loadRuntimeSettings(db, newEnv);
        expect(reloaded.temperature).toBe(1.1);
        expect(reloaded.historyMessages).toBe(50);

        const reset = await call('DELETE', '/api/settings');
        expect((await json(reset)).overrides).toEqual([]);
        expect(runtime.get().temperature).toBe(0.4);
    });

    it('keeps valid saved keys when one saved key is invalid or unknown', () => {
        const warnings: string[] = [];
        db.prepare(
            `INSERT INTO meta (key, value) VALUES ('runtime_settings', ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        ).run(
            JSON.stringify({
                temperature: 1.2,
                ragTopK: 999,
                removedSetting: true,
                typingCpsMin: 20, // > typingCpsMax (7) in .env
            }),
        );
        const s = loadRuntimeSettings(db, baseSettings, (m) =>
            warnings.push(m),
        );
        expect(s.temperature).toBe(1.2);
        expect(s.ragTopK).toBe(baseSettings.ragTopK);
        expect(s.typingCpsMin).toBe(baseSettings.typingCpsMin);
        expect(warnings.join('\n')).toMatch(/ragTopK/);
        expect(warnings.join('\n')).toMatch(/removedSetting/);
        expect(warnings.join('\n')).toMatch(/typingCpsMin/);
    });

    it('saves nothing when settings equal .env', () => {
        expect(saveRuntimeSettings(db, baseSettings, baseSettings)).toEqual([]);
    });
});

describe('knowledge', () => {
    it('lists, edits and re-ingests files', async () => {
        const k = (await json(call('GET', '/api/knowledge'))) as {
            files: { path: string }[];
        };
        expect(k.files.map((f: { path: string }) => f.path)).toEqual([
            'hours.md',
        ]);

        await call('PUT', '/api/knowledge/file?path=prices.md', {
            raw: '# Prices\n\nCut €45',
        });
        const f = (await json(
            call('GET', '/api/knowledge/file?path=prices.md'),
        )) as { raw: string };
        expect(f.raw).toContain('€45');

        const [r1, r2] = await Promise.all([
            json(call('POST', '/api/knowledge/reingest')),
            json(call('POST', '/api/knowledge/reingest')),
        ]);
        expect(r1.updated).toEqual(['hours.md']);
        expect(r2.updated).toEqual(['hours.md']);
        expect(reingestCalls).toBe(1); // second click joined the running ingest
    });
});

describe('images', () => {
    it('serves images with a query token only', async () => {
        expect((await fetch(`${base}/api/images/price_list`)).status).toBe(401);
        const img = await fetch(`${base}/api/images/price_list?token=${TOKEN}`);
        expect(img.headers.get('content-type')).toBe('image/png');
        expect((await fetch(`${base}/api/chats?token=${TOKEN}`)).status).toBe(
            401,
        );
    });
});
