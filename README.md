# Astrid — WhatsApp bot

A WhatsApp customer-service bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) (no browser) and a local LLM via [Ollama](https://ollama.com).

- **Strict SOP** — `config/astrid.sop.yaml` is validated at startup; rules, forbidden topics and message limits are enforced in code, not just in the prompt.
- **Purchase alerts only** — you get a WhatsApp message (at `OWNER_JID`) when a customer wants to buy, and again when they agree to buy, with a one-line summary. Nothing else alerts you. The bot never promises to "check and get back" (a guard rewrites such replies); when it doesn't know, it says so and points to the contact details in `knowledge/`.
- **Fixed personality** — `config/persona.md` plus few-shot examples, always at the top of the prompt, never summarized away.
- **Preloaded images** — `config/images.yaml` + `assets/images/`; the model picks an image by id, never resends it too soon. An image with `request_keywords` (e.g. the `photo` entry) is always sent when a customer asks for it, and `view_once: true` sends it as a WhatsApp view-once photo (opens one time, can't be forwarded or saved; WhatsApp blocks screenshots on most phones). Replace `assets/images/photo.png` with your own picture.
- **Human-like pacing** — a random delay before the first reply in a new (or long-quiet) chat, read receipts after a short pause, "typing…" for as long as a person would need with random stops mid-message, a slightly different typing speed each reply, the occasional distraction, and answers split over bubbles.
- **Per-chat SQLite memory** — every message, extracted facts and rolling summaries, isolated per chat so details never leak between customers.
- **RAG** — markdown/text in `knowledge/` is chunked, embedded and searched with `sqlite-vec`.
- **Welcome picture** — every new customer first gets a view-once picture (`first_contact: true` in `config/images.yaml`; replace `assets/images/welcome.png`).
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

Numbers in `.env` (`OWNER_JID`, `ALLOWED_JIDS`) are written with country code and no leading 0, e.g. `31612345678`; a full JID (`31612345678@s.whatsapp.net`) works too.

Testing:

- A new chat waits 20–150 s (random) before the first reply, like a person noticing a notification. Set `FIRST_REPLY_MIN_MS=0` and `FIRST_REPLY_MAX_MS=0` for instant replies while testing.
- Every incoming message is logged (`message received`, `replying`, `reply sent`), or with the reason it was ignored.
- Right after linking, Baileys may log `failed to decrypt` once per contact; WhatsApp resends those messages automatically.
- Optional: set `ALLOWED_JIDS` to your own number so the bot answers nobody else.
- `npm run chat` chats with the bot in the terminal, without WhatsApp and without any waiting. It uses the real pipeline and model, shows each step and the model's raw output as it is written, and uses a throwaway database.
- `HUMANIZE=false` turns off every human-like wait (first-reply delay, reading, thinking, typing); add `DEBOUNCE_MS=0` to also skip the short wait for follow-up messages.

## Customizing

| What                                                                                        | Where                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------- |
| Rules, forbidden topics, purchase keywords, procedures, fixed texts and alert texts, limits | `config/astrid.sop.yaml`                |
| Personality, writing style, example conversations                                           | `config/persona.md`                     |
| Images the bot may send                                                                     | `config/images.yaml` + `assets/images/` |
| Business facts (prices, hours, policies…)                                                   | `knowledge/*.md`                        |

The shipped content describes an example hair salon. Replace it with your own business.

## Handling high volume (100–200 messages/minute)

- **Model queue** — all model calls share one queue (`LLM_CONCURRENCY` at a time; start Ollama with the same `OLLAMA_NUM_PARALLEL`). Customer replies always go first; memory updates (facts, summaries) wait, at most `BACKGROUND_MAX_WAIT_SEC`.
- **Send cap** — at most `OUTBOUND_MAX_PER_MIN` messages leave the number per minute (lower = lower ban risk). Replies are delayed, never dropped, and when busy the bot merges its bubbles into one message. The cap must be higher than the number of customers you expect to answer per minute (the welcome picture counts as an extra send for new customers).
- **Behind warning** — when replies wait more than 2 minutes for the model, the dashboard pill turns orange and the log warns. The Status tab shows the model queue, memory backlog and sends per minute.
- **Load test** — measure your machine before going live:

```sh
npm run loadtest -- --rate 200 --chats 5000 --minutes 3          # real Ollama from .env
npm run loadtest -- --fake-llm --fake-latency 3000 --rate 200    # without a model
```

It prints wait times per minute and a verdict ("keeps up" / "falls behind"). Nothing is sent to WhatsApp.

## Running in the background (pm2)

[pm2](https://pm2.keymetrics.io/) keeps the bot running as the process **`astrid`**: it restarts it after a crash (with backoff, so a missing Ollama doesn't cause a restart loop) and, once set up, after a reboot. Settings are in `ecosystem.config.cjs`.

First link WhatsApp once in a normal terminal with `npm run dev` (scan the QR code, then stop it with Ctrl+C). After that:

```sh
npm install -g pm2       # once per machine
npm run start:pm2        # build and start "astrid"
pm2 startup              # once: prints a command, run it so pm2 starts on boot
npm run pm2:save         # remember "astrid" for reboots

npm run status           # is it running?
npm run logs             # live log (dashboard link, errors)
npm run restart:pm2      # rebuild and restart after code or .env changes
npm run stop:pm2         # stop the bot
```

Only ever run one `astrid` process: two would fight over the same WhatsApp login.

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
