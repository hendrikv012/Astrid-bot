import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LlmClient } from '../brain/llm.js';
import { type DB, toVec, vecRowId } from '../memory/db.js';
import { chunkText } from './chunk.js';
import { DOCUMENT_PREFIX } from './retrieve.js';

export interface IngestResult {
    added: string[];
    updated: string[];
    unchanged: string[];
    removed: string[];
}

const EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const EMBED_BATCH = 16;

/**
 * Syncs the knowledge directory into kb_* tables. Only changed files are
 * re-embedded (by content hash); files deleted from disk are removed.
 */
export async function ingestKnowledge(
    db: DB,
    llm: LlmClient,
    dir: string,
    log: (msg: string) => void = () => {},
): Promise<IngestResult> {
    const result: IngestResult = {
        added: [],
        updated: [],
        unchanged: [],
        removed: [],
    };
    const files = listFiles(dir);
    const relPaths = new Set(files.map((f) => path.relative(dir, f)));

    for (const file of files) {
        const rel = path.relative(dir, file);
        const raw = fs.readFileSync(file, 'utf8');
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const existing = db
            .prepare(`SELECT id, content_hash FROM kb_documents WHERE path = ?`)
            .get(rel) as { id: number; content_hash: string } | undefined;

        if (existing?.content_hash === hash) {
            result.unchanged.push(rel);
            continue;
        }

        const chunks = chunkText(raw);
        const embeddings: number[][] = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            const batch = chunks.slice(i, i + EMBED_BATCH);
            embeddings.push(
                ...(await llm.embed(
                    batch.map(
                        (c) =>
                            `${DOCUMENT_PREFIX}${c.heading ? `${c.heading}\n` : ''}${c.text}`,
                    ),
                    { priority: 'background' },
                )),
            );
        }

        db.transaction(() => {
            if (existing) deleteDocument(db, existing.id);
            const docId = Number(
                db
                    .prepare(
                        `INSERT INTO kb_documents (path, content_hash, ingested_at) VALUES (?, ?, ?)`,
                    )
                    .run(rel, hash, Date.now()).lastInsertRowid,
            );
            const insChunk = db.prepare(
                `INSERT INTO kb_chunks (document_id, ord, heading, text) VALUES (?, ?, ?, ?)`,
            );
            const insVec = db.prepare(
                `INSERT INTO vec_kb_chunks (rowid, embedding) VALUES (?, ?)`,
            );
            chunks.forEach((c, i) => {
                const chunkId = insChunk.run(
                    docId,
                    i,
                    c.heading,
                    c.text,
                ).lastInsertRowid;
                insVec.run(vecRowId(chunkId), toVec(embeddings[i]!));
            });
        })();

        (existing ? result.updated : result.added).push(rel);
        log(
            `${existing ? 'updated' : 'added'} ${rel} (${chunks.length} chunks)`,
        );
    }

    const stored = db.prepare(`SELECT id, path FROM kb_documents`).all() as {
        id: number;
        path: string;
    }[];
    for (const doc of stored) {
        if (!relPaths.has(doc.path)) {
            db.transaction(() => deleteDocument(db, doc.id))();
            result.removed.push(doc.path);
            log(`removed ${doc.path}`);
        }
    }
    return result;
}

function deleteDocument(db: DB, docId: number): void {
    const ids = db
        .prepare(`SELECT id FROM kb_chunks WHERE document_id = ?`)
        .all(docId) as { id: number }[];
    const delVec = db.prepare(`DELETE FROM vec_kb_chunks WHERE rowid = ?`);
    for (const { id } of ids) delVec.run(vecRowId(id));
    db.prepare(`DELETE FROM kb_chunks WHERE document_id = ?`).run(docId);
    db.prepare(`DELETE FROM kb_documents WHERE id = ?`).run(docId);
}

function listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(
            (e) =>
                e.isFile() &&
                EXTENSIONS.has(path.extname(e.name).toLowerCase()),
        )
        .map((e) => path.join(e.parentPath, e.name))
        .sort();
}

// CLI: `npm run ingest`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const { loadEnv } = await import('../config/env.js');
    const { openDb } = await import('../memory/db.js');
    const { OllamaLlm } = await import('../brain/llm.js');
    const env = loadEnv();
    const db = openDb({ path: env.DB_PATH, embedDim: env.EMBED_DIM });
    const llm = new OllamaLlm({
        host: env.OLLAMA_HOST,
        chatModel: env.CHAT_MODEL,
        embedModel: env.EMBED_MODEL,
        temperature: env.LLM_TEMPERATURE,
        seed: env.LLM_SEED,
        numCtx: env.LLM_NUM_CTX,
    });
    await llm.assertReady([env.EMBED_MODEL]);
    const r = await ingestKnowledge(db, llm, env.KNOWLEDGE_DIR, (m) =>
        console.log(m),
    );
    console.log(
        `Done: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.removed.length} removed.`,
    );
    db.close();
}
