/**
 * Ordered schema migrations. Each entry runs once, inside a transaction, and
 * bumps `PRAGMA user_version`. Never edit an applied migration — append a new one.
 *
 * Vector tables are not here because their dimension comes from config; see
 * `ensureVectorTables` in db.ts.
 */
export const migrations: string[] = [
    /* 1: core chat memory + knowledge base */ `
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE chats (
        jid         TEXT PRIMARY KEY,
        name        TEXT,
        is_group    INTEGER NOT NULL DEFAULT 0,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        flow_state  TEXT
    );

    CREATE TABLE messages (
        id          INTEGER PRIMARY KEY,
        chat_jid    TEXT NOT NULL REFERENCES chats(jid),
        wa_msg_id   TEXT,
        sender_jid  TEXT,
        direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text        TEXT NOT NULL DEFAULT '',
        image_id    TEXT,
        ts          INTEGER NOT NULL,
        sop_hash    TEXT,
        embedded    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (chat_jid, wa_msg_id)
    );
    CREATE INDEX idx_messages_chat_id ON messages(chat_jid, id);

    -- subject is 'chat' for facts about the (private) chat partner, or the
    -- sender JID for facts about a specific member of a group chat.
    CREATE TABLE facts (
        id             INTEGER PRIMARY KEY,
        chat_jid       TEXT NOT NULL REFERENCES chats(jid),
        subject        TEXT NOT NULL DEFAULT 'chat',
        key            TEXT NOT NULL,
        value          TEXT NOT NULL,
        confidence     REAL NOT NULL DEFAULT 1.0,
        source_msg_id  INTEGER REFERENCES messages(id),
        updated_at     INTEGER NOT NULL,
        UNIQUE (chat_jid, subject, key)
    );

    CREATE TABLE summaries (
        chat_jid     TEXT PRIMARY KEY REFERENCES chats(jid),
        summary      TEXT NOT NULL,
        upto_msg_id  INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );

    CREATE TABLE images_sent (
        id        INTEGER PRIMARY KEY,
        chat_jid  TEXT NOT NULL REFERENCES chats(jid),
        image_id  TEXT NOT NULL,
        sent_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_images_sent_chat ON images_sent(chat_jid, image_id, sent_at);

    -- Unused since migration 3 (owner alerts are purchase-only, see sales_events).
    CREATE TABLE escalations (
        id          INTEGER PRIMARY KEY,
        chat_jid    TEXT NOT NULL REFERENCES chats(jid),
        msg_id      INTEGER REFERENCES messages(id),
        reason      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );

    -- Knowledge base: ONLY ingested documents. Chat content never goes here.
    CREATE TABLE kb_documents (
        id            INTEGER PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        content_hash  TEXT NOT NULL,
        ingested_at   INTEGER NOT NULL
    );

    CREATE TABLE kb_chunks (
        id           INTEGER PRIMARY KEY,
        document_id  INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        ord          INTEGER NOT NULL,
        heading      TEXT,
        text         TEXT NOT NULL
    );
    CREATE INDEX idx_kb_chunks_doc ON kb_chunks(document_id);
    `,
    /* 2: extraction cursor + human-takeover pause per chat */ `
    ALTER TABLE chats ADD COLUMN extracted_upto INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE chats ADD COLUMN paused_until INTEGER NOT NULL DEFAULT 0;
    `,
    /* 3: reply address per chat, purchase alerts, indexes for dashboard stats */ `
    -- The JID WhatsApp last used for this chat (may be a LID); used for replies
    -- sent from the dashboard. chats.jid stays the stable memory key.
    ALTER TABLE chats ADD COLUMN reply_jid TEXT;

    -- One row per purchase signal the owner was alerted about.
    CREATE TABLE sales_events (
        id          INTEGER PRIMARY KEY,
        chat_jid    TEXT NOT NULL REFERENCES chats(jid),
        stage       TEXT NOT NULL CHECK (stage IN ('interested', 'agreed')),
        summary     TEXT,
        msg_id      INTEGER REFERENCES messages(id),
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_sales_events_chat ON sales_events(chat_jid, stage, created_at);
    CREATE INDEX idx_sales_events_created ON sales_events(created_at);

    CREATE INDEX idx_messages_ts ON messages(ts);
    CREATE INDEX idx_chats_last_seen ON chats(last_seen);
    CREATE INDEX idx_chats_paused ON chats(paused_until);
    `,
    /* 4: daily counters for dashboard stats (no full-table counts at 10k+ chats) */ `
    CREATE TABLE stats_daily (
        day   TEXT NOT NULL,
        kind  TEXT NOT NULL,
        n     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kind)
    ) WITHOUT ROWID;

    INSERT INTO stats_daily (day, kind, n)
        SELECT date(ts / 1000, 'unixepoch', 'localtime'), 'msg_' || direction, COUNT(*)
        FROM messages GROUP BY 1, 2;
    INSERT INTO stats_daily (day, kind, n)
        SELECT date(created_at / 1000, 'unixepoch', 'localtime'), 'sale_' || stage, COUNT(*)
        FROM sales_events GROUP BY 1, 2;

    CREATE TRIGGER trg_stats_messages AFTER INSERT ON messages BEGIN
        INSERT INTO stats_daily (day, kind, n)
        VALUES (date(NEW.ts / 1000, 'unixepoch', 'localtime'), 'msg_' || NEW.direction, 1)
        ON CONFLICT (day, kind) DO UPDATE SET n = n + 1;
    END;

    CREATE TRIGGER trg_stats_sales AFTER INSERT ON sales_events BEGIN
        INSERT INTO stats_daily (day, kind, n)
        VALUES (date(NEW.created_at / 1000, 'unixepoch', 'localtime'), 'sale_' || NEW.stage, 1)
        ON CONFLICT (day, kind) DO UPDATE SET n = n + 1;
    END;
    `,
];
