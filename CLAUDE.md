# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Astrid: a WhatsApp customer-service bot. TypeScript (ESM, NodeNext), Node ≥ 22.12, built on Baileys v7 (WebSocket WhatsApp client), Ollama (local LLM + embeddings), and SQLite via `better-sqlite3` + `sqlite-vec`. The repo used to be a whatsapp-web.js fork; none of that code remains.

## Commands

```sh
npm run dev                        # tsx watch src/index.ts (needs Ollama running)
npm run build                      # tsc -p tsconfig.build.json → dist/
npm run typecheck                  # tsc --noEmit (includes tests/)
npm run lint                       # eslint (typescript-eslint + prettier)
npm run check                      # typecheck + lint + format:check
npm test                           # vitest run
npx vitest run tests/bot.test.ts   # one file
npx vitest run -t "isolation"      # tests matching a name
npm run ingest                     # sync knowledge/ into the DB (needs Ollama)
```

Tests need neither WhatsApp nor Ollama: they use an in-memory SQLite DB and fake `LlmClient` / `Sender` implementations (see `tests/bot.test.ts`). Relative imports must use the `.js` extension (NodeNext). Conventional commits (header ≤ 72 chars) are enforced by commitlint; husky runs lint-staged on commit.

## Architecture

**Turn pipeline** (`src/pipeline/bot.ts`, class `Bot`): `receive()` stores every inbound message immediately, then pushes it onto a per-chat `ChatQueue`, which debounces bursts and serializes turns per chat. `handleTurn()` does: pause check → `sender.markRead` → `checkInbound` (SOP escalation/forbidden keywords, **in code, before the LLM**) → `resolveFlow` → `generate` (embed query → RAG + per-chat recall → `buildPrompt` → `llm.chatJson` with the reply schema → `checkReply`; one retry with feedback if blocked, else the SOP `unknown` template) → `sender.think/send` → store outbound with the SOP hash → `scheduleExtraction` (background, chained per chat).

**Chat isolation is enforced by API shape, not by prompt.** This is the core invariant:

- All per-chat reads/writes go through `ChatMemory` (`src/memory/ChatMemory.ts`), constructed with one `chatJid`. Every query is bound to it, and foreign message ids are rejected.
- `vec_messages` uses `chat_jid` as a sqlite-vec **partition key**, so recall can't even see other chats' vectors.
- `kb_*` tables hold only ingested documents; chat content must never be written there.
- `src/memory/leakIndex.ts` is the only cross-chat read on the bot path (the dashboard's admin queries are the other exception; see below). It returns other chats' identifying fact values solely so `checkReply` can block a reply that mentions them. Never feed its output into a prompt or a retry message.
- Do not add a query over `messages`/`facts`/`summaries` that isn't scoped to one chat.

**Chat identity**: Baileys v7 can address a person by phone-number JID or by LID. `preferPn` in `src/whatsapp/inbound.ts` picks the PN when known so one person maps to one memory. `chatJid` is the memory key; `replyJid` is what WhatsApp gave us and is what we send to.

**Prompt order is fixed** (`src/brain/prompt.ts`): persona + SOP + output contract → persona few-shot examples (assistant turns rendered as reply JSON) → memory/knowledge system message → history. When trimming for `LLM_NUM_CTX`, history is dropped first, then recalled messages, then KB chunks. Persona and SOP are never trimmed. That is what keeps the personality stable. User text is wrapped in `<user_message>` tags.

**Model output contract** (`src/brain/reply.ts`): `{messages[], image_id, escalate, escalate_reason, flow_done}`, passed to Ollama as a JSON-schema `format` (via `z.toJSONSchema`) and validated with zod. The schema allows `max_messages_per_reply + 2` bubbles so the guard trims instead of the call failing.

**Config is validated at startup and a failure stops the bot**: `config/astrid.sop.yaml` (zod schema in `src/config/sop.ts`, `.strict()` so unknown keys fail; ids must be unique across sections), `config/persona.md` (parsed by `src/config/persona.ts`: text before `## Examples`, then `User:` / `<BotName>:` lines), and `config/images.yaml` (every file loaded into memory). Env vars are validated in `src/config/env.ts`; empty values count as unset.

**Humanizing**: delay math is pure in `src/humanize/typing.ts`; `src/whatsapp/sender.ts` applies it (one typing speed per reply, typing split into stretches with random mid-message pauses, occasional pre-typing distraction, composing presence refreshed every 8 s). A "cold" chat (no reply yet, or none for `COLD_START_AFTER_MIN`) gets a random log-uniform first-reply delay: `Bot.coldStartHold` passes a `holdUntil` to `ChatQueue.push`, so messages arriving during the wait join the same batch and the chat stays unread (no blue ticks) until then. `HUMANIZE=false` disables all waits.

**Dashboard** (`src/dashboard/`, UI in `dashboard/index.html`, vanilla JS with no build step): a `node:http` server started from `src/index.ts`. It binds to `DASHBOARD_HOST` (default 127.0.0.1), requires a bearer token on every `/api/*` call (images also accept `?token=` because `<img>` can't send headers), and rejects foreign `Host` headers. Live changes: `PUT /api/sop` / `/api/persona` validate with the same parsers, write atomically, and call `Bot.updateSop/updatePersona`. `PUT /api/settings` validates `RuntimeSettingsSchema` (`src/config/runtime.ts`), then `applyRuntimeSettings` mutates the live `OllamaLlm` options, sender opts object and `BotSettings`, and the settings are persisted in `meta` (they override `.env` on start). `src/dashboard/admin.ts` holds the only chat-listing queries; like `leakIndex.ts` they cross chats and must never feed a prompt. The UI renders all chat text via `textContent`, because customer messages are untrusted.

**Escalation / takeover**: an escalation records a row, notifies `OWNER_JID`, and sets `chats.paused_until` (`pause_bot_minutes`). A `fromMe` message not sent by the bot (tracked in `botSentIds` in `src/index.ts`) counts as a human takeover and pauses the bot too. The owner can send `!resume <number>` / `!pause <number>`.

**DB schema** lives in `src/memory/migrations.ts` (append-only list, tracked by `PRAGMA user_version`). Vector tables are created in `src/memory/db.ts` with the dimension from `EMBED_DIM`, stored in `meta`. A mismatch refuses to open. Pass vec0 rowids as `BigInt` (`vecRowId`).

**Honesty rule**: SOP rule `R7_honesty` and the persona examples have Astrid admit to being a digital assistant when sincerely asked. The drift guard deliberately doesn't block that. Keep it that way when editing the persona or guard.
