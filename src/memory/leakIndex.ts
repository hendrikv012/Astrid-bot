import type { DB } from './db.js';

/**
 * The ONLY cross-chat read on the bot path, and it never feeds a prompt.
 *
 * It lists identifying fact values (full names, phone numbers, emails, …) that
 * belong to chats OTHER than the one being answered, so the guard can block a
 * reply that mentions one of them.
 *
 * Built for many chats: with thousands of customers, common first names are
 * shared, so a single word in a name field never counts, and anything the
 * current customer wrote themselves is allowed. The index is rebuilt at most
 * once per `ttlMs` instead of on every reply.
 */
const NAME_KEYS = new Set(['name', 'full_name', 'first_name', 'last_name']);
const OTHER_KEYS = [
    'phone',
    'email',
    'address',
    'company',
    'order_id',
    'birthday',
];
const ALL_KEYS = [...NAME_KEYS, ...OTHER_KEYS];
const MIN_LEN = 4;

export class LeakIndex {
    /** lowercased value → chats whose facts contain it */
    private owners = new Map<string, Set<string>>();
    private builtAt = -Infinity;
    private readonly now: () => number;

    constructor(
        private readonly db: DB,
        private readonly ttlMs = 60_000,
        now?: () => number,
    ) {
        this.now = now ?? Date.now;
    }

    /**
     * Identifiers of other customers that must not appear in a reply to
     * `chatJid`. `ownText` is this chat's own recent messages: anything the
     * customer said themselves is fine to repeat.
     */
    forChat(chatJid: string, ownText = ''): string[] {
        this.refreshIfStale();
        const own = ownText.toLowerCase();
        const out: string[] = [];
        for (const [value, chats] of this.owners) {
            if (chats.has(chatJid)) continue; // this chat has it too
            if (own.includes(value)) continue; // the customer mentioned it
            out.push(value);
        }
        return out;
    }

    /**
     * Adds one chat's current facts right away (called after extraction), so a
     * detail learned a moment ago is protected before the next full rebuild.
     */
    noteFacts(chatJid: string, facts: { key: string; value: string }[]): void {
        for (const f of facts) this.add(chatJid, f.key, f.value);
    }

    private add(chat: string, key: string, raw: string): void {
        const v = raw.trim().toLowerCase();
        if (!ALL_KEYS.includes(key) || v.length < MIN_LEN) return;
        if (NAME_KEYS.has(key) && !/\s/.test(v)) return; // lone first name
        let set = this.owners.get(v);
        if (!set) this.owners.set(v, (set = new Set()));
        set.add(chat);
    }

    private refreshIfStale(): void {
        if (this.now() - this.builtAt < this.ttlMs) return;
        const rows = this.db
            .prepare(
                `SELECT chat_jid AS chat, key, lower(trim(value)) AS v FROM facts
                 WHERE key IN (SELECT value FROM json_each(?)) AND length(trim(value)) >= ?`,
            )
            .all(JSON.stringify(ALL_KEYS), MIN_LEN) as {
            chat: string;
            key: string;
            v: string;
        }[];
        this.owners = new Map();
        for (const r of rows) this.add(r.chat, r.key, r.v);
        this.builtAt = this.now();
    }
}
