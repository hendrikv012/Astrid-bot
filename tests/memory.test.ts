import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/memory/db.js';
import { ChatMemory } from '../src/memory/ChatMemory.js';
import { foreignIdentifiers } from '../src/memory/leakIndex.js';

const DIM = 4;
const A = '111@s.whatsapp.net';
const B = '222@s.whatsapp.net';

let db: DB;
let a: ChatMemory;
let b: ChatMemory;

beforeEach(() => {
    db = openDb({ path: ':memory:', embedDim: DIM });
    a = new ChatMemory(db, A);
    b = new ChatMemory(db, B);
});

describe('ChatMemory isolation', () => {
    it('keeps messages, facts and summaries per chat', () => {
        a.addMessage({ direction: 'in', text: 'my secret is pineapple' });
        a.upsertFact({ key: 'name', value: 'Annelies' });
        a.setSummary('Annelies likes pineapple', 1);
        b.addMessage({ direction: 'in', text: 'hello' });

        expect(b.recentMessages(50).map((m) => m.text)).toEqual(['hello']);
        expect(b.getFacts()).toEqual([]);
        expect(b.getSummary()).toBeNull();
        expect(a.getFacts()[0]?.value).toBe('Annelies');
    });

    it('refuses to touch another chat’s message ids', () => {
        const aMsg = a.addMessage({ direction: 'in', text: 'x' })!;
        expect(b.getMessagesByIds([aMsg])).toEqual([]);
        expect(() => b.storeMessageEmbedding(aMsg, [1, 0, 0, 0])).toThrow();
        b.upsertFact({ key: 'k', value: 'v', sourceMsgId: aMsg });
        const row = db
            .prepare(`SELECT source_msg_id FROM facts WHERE chat_jid = ?`)
            .get(B) as { source_msg_id: number | null };
        expect(row.source_msg_id).toBeNull();
    });

    it('vector recall never returns another chat’s messages', () => {
        const aMsg = a.addMessage({ direction: 'in', text: 'pineapple' })!;
        const bMsg = b.addMessage({ direction: 'in', text: 'banana' })!;
        a.storeMessageEmbedding(aMsg, [1, 0, 0, 0]);
        b.storeMessageEmbedding(bMsg, [0, 1, 0, 0]);

        const recalled = b.recallSimilar([1, 0, 0, 0], 5);
        expect(recalled.map((m) => m.id)).toEqual([bMsg]);
    });

    it('deduplicates WhatsApp message ids per chat', () => {
        expect(
            a.addMessage({ waMsgId: 'X', direction: 'in', text: 'a' }),
        ).not.toBeNull();
        expect(
            a.addMessage({ waMsgId: 'X', direction: 'in', text: 'a' }),
        ).toBeNull();
        expect(
            b.addMessage({ waMsgId: 'X', direction: 'in', text: 'a' }),
        ).not.toBeNull();
    });
});

describe('foreignIdentifiers', () => {
    it('lists other chats’ identifying values except shared ones', () => {
        a.upsertFact({ key: 'name', value: 'Annelies' });
        a.upsertFact({ key: 'phone', value: '+31612345678' });
        a.upsertFact({ key: 'favourite_colour', value: 'green' });
        b.upsertFact({ key: 'name', value: 'annelies' });

        expect(foreignIdentifiers(db, B)).toEqual(['+31612345678']);
    });
});

describe('openDb', () => {
    it('rejects a changed embedding dimension', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-'));
        const file = path.join(dir, 'test.db');
        openDb({ path: file, embedDim: DIM }).close();
        expect(() => openDb({ path: file, embedDim: DIM + 1 })).toThrow(
            /embedding dimension/,
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
