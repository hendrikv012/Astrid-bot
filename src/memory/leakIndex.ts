import type { DB } from './db.js';

/**
 * The ONLY cross-chat read in the codebase, and it never feeds a prompt.
 *
 * It returns identifying fact values (names, phone numbers, emails, …) that
 * belong to chats OTHER than `chatJid`, so the guard can block a reply that
 * mentions one of them. Values that also appear in this chat's own facts are
 * excluded (two customers can share a first name).
 */
const IDENTIFYING_KEYS = [
    'name',
    'full_name',
    'first_name',
    'last_name',
    'phone',
    'email',
    'address',
    'company',
    'order_id',
    'birthday',
];

const MIN_LEN = 4;

export function foreignIdentifiers(db: DB, chatJid: string): string[] {
    const keys = JSON.stringify(IDENTIFYING_KEYS);
    const rows = db
        .prepare(
            `SELECT DISTINCT lower(value) AS v FROM facts
             WHERE chat_jid != ?
               AND key IN (SELECT value FROM json_each(?))
               AND length(value) >= ?
             EXCEPT
             SELECT lower(value) FROM facts WHERE chat_jid = ?`,
        )
        .all(chatJid, keys, MIN_LEN, chatJid) as { v: string }[];
    return rows.map((r) => r.v);
}
