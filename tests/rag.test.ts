import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/brain/llm.js';
import { openDb } from '../src/memory/db.js';
import { ingestKnowledge } from '../src/rag/ingest.js';
import { searchKnowledge } from '../src/rag/retrieve.js';

const DIM = 3;
const TOPICS = ['price', 'hours', 'parking'];

/** One-hot embedding per topic keyword, so search results are predictable. */
const llm: LlmClient = {
    chatJson: async () => {
        throw new Error('not used');
    },
    embed: async (texts) =>
        texts.map((t) =>
            TOPICS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0.001)),
        ),
};

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('knowledge ingest + search', () => {
    it('ingests, searches, re-ingests only changes and removes deleted files', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-kb-'));
        fs.writeFileSync(
            path.join(dir, 'a.md'),
            '# Salon\n\n## Price\n\nprice cut 45\n\n## Hours\n\nhours tue-sat',
        );
        fs.writeFileSync(path.join(dir, 'b.txt'), 'parking is on the street');
        const db = openDb({ path: ':memory:', embedDim: DIM });

        const first = await ingestKnowledge(db, llm, dir);
        expect(first.added.sort()).toEqual(['a.md', 'b.txt']);

        const [q] = await llm.embed(['what is the price?']);
        const hits = searchKnowledge(db, q!, 2, 0.5);
        expect(hits[0]).toMatchObject({
            source: 'a.md',
            heading: 'Salon › Price',
        });

        const second = await ingestKnowledge(db, llm, dir);
        expect(second.unchanged.sort()).toEqual(['a.md', 'b.txt']);

        fs.rmSync(path.join(dir, 'b.txt'));
        const third = await ingestKnowledge(db, llm, dir);
        expect(third.removed).toEqual(['b.txt']);
        const [pq] = await llm.embed(['parking']);
        expect(searchKnowledge(db, pq!, 5, 0.5)).toEqual([]);
    });
});
