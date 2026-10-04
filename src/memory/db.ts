import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrations } from './migrations.js';

export type DB = Database.Database;

export interface OpenDbOptions {
    /** File path, or ':memory:' for tests. */
    path: string;
    /** Embedding dimension; must stay constant for the lifetime of a DB. */
    embedDim: number;
}

export function openDb({ path: dbPath, embedDim }: OpenDbOptions): DB {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    sqliteVec.load(db);

    migrate(db);
    ensureVectorTables(db, embedDim);
    return db;
}

function migrate(db: DB): void {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let i = current; i < migrations.length; i++) {
        db.transaction(() => {
            db.exec(migrations[i]!);
            db.pragma(`user_version = ${i + 1}`);
        })();
    }
}

function ensureVectorTables(db: DB, dim: number): void {
    const row = db
        .prepare(`SELECT value FROM meta WHERE key = 'embed_dim'`)
        .get() as { value: string } | undefined;

    if (row && Number(row.value) !== dim) {
        throw new Error(
            `DB was created with embedding dimension ${row.value} but EMBED_DIM=${dim}. ` +
                `Use the original embedding model, or delete the DB and re-ingest.`,
        );
    }

    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_kb_chunks USING vec0(
            embedding float[${dim}] distance_metric=cosine
        );
        -- chat_jid is a partition key: a query constrained to one chat never
        -- even considers vectors from another chat.
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
            chat_jid TEXT PARTITION KEY,
            embedding float[${dim}] distance_metric=cosine
        );
    `);
    db.prepare(
        `INSERT OR IGNORE INTO meta (key, value) VALUES ('embed_dim', ?)`,
    ).run(String(dim));
}

/** sqlite-vec requires integer rowids; better-sqlite3 binds JS numbers as REAL. */
export function vecRowId(id: number | bigint): bigint {
    return BigInt(id);
}

export function toVec(embedding: number[] | Float32Array): Float32Array {
    return embedding instanceof Float32Array
        ? embedding
        : new Float32Array(embedding);
}
