import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { getStats } from '../src/dashboard/admin.js';
import { ChatMemory } from '../src/memory/ChatMemory.js';
import { openDb } from '../src/memory/db.js';
import { BoundedSet } from '../src/util/boundedSet.js';

const DIM = 4;

describe('vector storage migration', () => {
    it('moves vectors from the old table to the compact one and drops it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-vec-'));
        const file = path.join(dir, 'old.db');
        // Simulate a database from before the fix.
        const db0 = openDb({ path: file, embedDim: DIM });
        const mem0 = new ChatMemory(db0, 'a@s.whatsapp.net');
        const id = mem0.addMessage({ direction: 'in', text: 'hoi' })!;
        db0.exec(`
            CREATE VIRTUAL TABLE vec_messages USING vec0(
                chat_jid TEXT PARTITION KEY,
                embedding float[${DIM}] distance_metric=cosine
            );`);
        db0.prepare(
            `INSERT INTO vec_messages (rowid, chat_jid, embedding) VALUES (?, ?, ?)`,
        ).run(BigInt(id), 'a@s.whatsapp.net', new Float32Array([1, 0, 0, 0]));
        db0.prepare(`UPDATE messages SET embedded = 1 WHERE id = ?`).run(id);
        db0.close();

        const db = openDb({ path: file, embedDim: DIM });
        const tables = db
            .prepare(
                `SELECT name FROM sqlite_master WHERE name = 'vec_messages'`,
            )
            .all();
        expect(tables).toEqual([]);
        const mem = new ChatMemory(db, 'a@s.whatsapp.net');
        expect(mem.recallSimilar([1, 0, 0, 0], 5).map((m) => m.id)).toEqual([
            id,
        ]);
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps per-chat storage small', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-vec-'));
        const file = path.join(dir, 'size.db');
        const db = openDb({ path: file, embedDim: 768 });
        for (let c = 0; c < 200; c++) {
            const mem = new ChatMemory(db, `c${c}@s.whatsapp.net`);
            const id = mem.addMessage({ direction: 'in', text: 'hoi' })!;
            mem.storeMessageEmbedding(id, new Array(768).fill(0.1));
        }
        db.close();
        // The old default reserved ~3 MB per chat (≈ 600 MB here).
        expect(fs.statSync(file).size).toBeLessThan(30_000_000);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sqlite-vec is loadable in the test runner', () => {
        const db = new Database(':memory:');
        sqliteVec.load(db);
        expect(db.prepare('select vec_version() v').get()).toBeTruthy();
    });
});

describe('stats counters', () => {
    it('count today’s messages and sales from triggers', () => {
        const db = openDb({ path: ':memory:', embedDim: DIM });
        const mem = new ChatMemory(db, 'a@s.whatsapp.net');
        mem.addMessage({ direction: 'in', text: '1' });
        mem.addMessage({ direction: 'in', text: '2' });
        mem.addMessage({ direction: 'out', text: '3' });
        mem.addMessage({
            direction: 'in',
            text: 'old',
            ts: Date.now() - 3 * 86_400_000,
        });
        mem.recordSalesEvent('interested', 'x', null);
        mem.recordSalesEvent('agreed', 'x', null);
        expect(getStats(db)).toMatchObject({
            chats: 1,
            messagesToday: 2,
            repliesToday: 1,
            interestedToday: 1,
            agreedToday: 1,
        });
    });
});

describe('BoundedSet', () => {
    it('forgets the oldest entries', () => {
        const s = new BoundedSet<number>(3);
        [1, 2, 3, 4].forEach((n) => s.add(n));
        expect(s.has(1)).toBe(false);
        expect(s.has(4)).toBe(true);
        expect(s.size).toBe(3);
    });
});
