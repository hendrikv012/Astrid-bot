# Astrid — WhatsApp bot

A WhatsApp customer-service bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) (no browser) and a local LLM via [Ollama](https://ollama.com).

- **Strict SOP** — `config/astrid.sop.yaml` is validated at startup; rules, forbidden topics, escalation and message limits are enforced in code, not just in the prompt.
- **Fixed personality** — `config/persona.md` plus few-shot examples, always at the top of the prompt, never summarized away.
- **Preloaded images** — `config/images.yaml` + `assets/images/`; the model picks an image by id, never resends it too soon.
- **Human-like pacing** — a random delay before the first reply in a new (or long-quiet) chat, read receipts after a short pause, "typing…" for as long as a person would need with random stops mid-message, a slightly different typing speed each reply, the occasional distraction, and answers split over bubbles.
- **Per-chat SQLite memory** — every message, extracted facts and rolling summaries, isolated per chat so details never leak between customers.
- **RAG** — markdown/text in `knowledge/` is chunked, embedded and searched with `sqlite-vec`.
- **Escalation & human takeover** — the owner gets alerted; the bot goes quiet in that chat when a human replies from the phone.

## Requirements

- Node.js ≥ 22.12
- [Ollama](https://ollama.com) running locally (or reachable via `OLLAMA_HOST`)
- A WhatsApp account for the bot (a separate number is strongly recommended)

```sh
ollama pull qwen2.5:14b-instruct   # chat model (any instruct model with JSON output works)
ollama pull nomic-embed-text       # embeddings
```

## Setup

```sh
npm install
cp .env.example .env               # set OWNER_JID at least
npm run dev                        # scan the QR code: WhatsApp → Linked devices
```

On every start the bot validates the config, checks that the Ollama models exist, and syncs `knowledge/` into the database (only changed files are re-embedded). Run `npm run ingest` to sync the knowledge base without starting the bot.

Tip: while testing, set `ALLOWED_JIDS` to your own number so the bot answers nobody else.

## Customizing

| What                                                                          | Where                                   |
| ----------------------------------------------------------------------------- | --------------------------------------- |
| Rules, forbidden topics, escalation keywords, procedures, fixed texts, limits | `config/astrid.sop.yaml`                |
| Personality, writing style, example conversations                             | `config/persona.md`                     |
| Images the bot may send                                                       | `config/images.yaml` + `assets/images/` |
| Business facts (prices, hours, policies…)                                     | `knowledge/*.md`                        |

The shipped content describes an example hair salon. Replace it with your own business.

## Owner commands

Send these from `OWNER_JID` to the bot's number:

- `!resume 31612345678` — let the bot answer that chat again after an escalation
- `!pause 31612345678` — silence the bot in that chat

## Scripts

```sh
npm run dev         # run with reload (tsx)
npm run build       # compile to dist/
npm start           # run dist/
npm run ingest      # sync knowledge/ into the DB
npm test            # vitest
npm run check       # typecheck + lint + format check
```

## Disclaimer

Baileys is an unofficial WhatsApp client. WhatsApp does not allow unofficial bots, and the account may be banned. Use a dedicated number. The bot is honest about being a digital assistant when someone sincerely asks.

## License

Apache-2.0
