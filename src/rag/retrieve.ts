import { type DB, toVec } from '../memory/db.js';

export interface KbHit {
    chunkId: number;
    source: string;
    heading: string | null;
    text: string;
    distance: number;
}

/** nomic-embed-text expects task prefixes; harmless for other models. */
export const QUERY_PREFIX = 'search_query: ';
export const DOCUMENT_PREFIX = 'search_document: ';

/**
 * Top-k knowledge-base chunks for a query embedding. Reads only kb_* tables,
 * which contain ingested documents and never chat content.
 */
export function searchKnowledge(
    db: DB,
    queryEmbedding: number[],
    k: number,
    maxDistance: number,
): KbHit[] {
    const rows = db
        .prepare(
            `SELECT v.rowid AS chunkId, v.distance, c.heading, c.text, d.path AS source
             FROM vec_kb_chunks v
             JOIN kb_chunks c ON c.id = v.rowid
             JOIN kb_documents d ON d.id = c.document_id
             WHERE v.embedding MATCH ? AND k = ?
             ORDER BY v.distance`,
        )
        .all(toVec(queryEmbedding), k) as KbHit[];
    return rows.filter((r) => r.distance <= maxDistance);
}
