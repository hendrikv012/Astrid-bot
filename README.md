# Astrid — WhatsApp bot

A WhatsApp customer-service bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) (no browser) and a local LLM via [Ollama](https://ollama.com).

- **Strict SOP** — `config/astrid.sop.yaml` is validated at startup; rules, forbidden topics and message limits are enforced in code, not just in the prompt.
- **Purchase alerts only** — you get a WhatsApp message (at `OWNER_JID`) when a customer wants to buy, and again when they agree to buy, with a one-line summary. Nothing else alerts you. The bot never promises to "check and get back" (a guard rewrites such replies); when it doesn't know, it says so and points to the contact details in `knowledge/`.
- **Fixed personality** — `config/persona.md` plus few-shot examples, always at the top of the prompt, never summarized away.
- **Preloaded images** — `config/images.yaml` + `assets/images/`; the model picks an image by id, never resends it too soon. An image with `request_keywords` (e.g. the `photo` entry) is always sent when a customer asks for it, and `view_once: true` sends it as a WhatsApp view-once photo (opens one time, can't be forwarded or saved; WhatsApp blocks screenshots on most phones). Replace `assets/images/photo.png` with your own picture.
- **Human-like pacing** — a random delay before the first reply in a new (or long-quiet) chat, read receipts after a short pause, "typing…" for as long as a person would need with random stops mid-message, a slightly different typing speed each reply, the occasional distraction, and answers split over bubbles.
- **Per-chat SQLite memory** — every message, extracted facts and rolling summaries, isolated per chat so details never leak between customers.
- **RAG** — markdown/text in `knowledge/` is chunked, embedded and searched with `sqlite-vec`.
- **Human takeover** — when you reply yourself (from the phone or the dashboard), the bot stops, even mid-reply, and stays quiet in that chat for `human_takeover.pause_bot_minutes` (default 60).

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

| What                                                                                        | Where                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------- |
| Rules, forbidden topics, purchase keywords, procedures, fixed texts and alert texts, limits | `config/astrid.sop.yaml`                |
| Personality, writing style, example conversations                                           | `config/persona.md`                     |
| Images the bot may send                                                                     | `config/images.yaml` + `assets/images/` |
| Business facts (prices, hours, policies…)                                                   | `knowledge/*.md`                        |

The shipped content describes an example hair salon. Replace it with your own business.

## Dashboard

While the bot runs, a local dashboard is served at `http://127.0.0.1:3210`. The startup log prints a link that includes the access token (`Dashboard: http://127.0.0.1:3210/#token=…`).

- **Chats**: every conversation with its messages, the facts the bot remembers and the running summary. You can pause or resume the bot per chat, forget a fact, or reply yourself (this pauses the bot in that chat).
- **SOP** and **Persona**: edit `config/astrid.sop.yaml` and `config/persona.md`. Changes are validated before saving and apply from the next reply, with no restart.
- **Settings**: model, temperature, human-like timing (first-reply wait, typing speed, pauses), memory and knowledge settings. Saved in the database and kept across restarts. They override `.env`.
- **Knowledge**: edit, add or delete files in `knowledge/`, then re-ingest.
- **Images** and **Status**: the configured images, connection state (including the QR code when linking), and today's numbers.

The dashboard only listens on localhost. Every API call needs the token. Set `DASHBOARD_ENABLED=false` to turn it off.

## Owner commands

Send these from `OWNER_JID` to the bot's number:

- `!resume 31612345678` — let the bot answer that chat again after you took over
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
