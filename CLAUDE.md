# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fork of [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js): a CommonJS Node.js (>=18) library that drives WhatsApp Web in a Puppeteer-controlled browser and exposes it as an event-emitting `Client` API. There is no build step; `index.js` re-exports everything and `index.d.ts` holds the hand-maintained TypeScript typings.

## Commands

```sh
npm install
npm run lint            # eslint . (the only check CI runs)
npm run lint:fix
npm run format:check    # prettier; `npm run format` to write
npm run check           # lint + format:check — run before committing
npm test                # mocha tests --recursive --timeout 5000
npx mocha tests/structures/message.js --timeout 5000   # single file (or `npm run test-single -- <file>`)
npx mocha tests --recursive -g "pattern"               # single test by name
npm run shell           # REPL with an initialized `client` (shell.js)
npm run generate-docs   # jsdoc -> docs/ (generated HTML, committed)
```

Tests are integration tests against a real WhatsApp account: they need a `.env` (see `.env.example`) with `WWEBJS_TEST_CLIENT_ID` (a `LocalAuth` clientId with a saved, authenticated session) and `WWEBJS_TEST_REMOTE_ID` (another WhatsApp ID to message). `tests/helper.js` throws at load time if `WWEBJS_TEST_REMOTE_ID` is unset, so tests cannot run in a fresh environment — rely on lint/format for verification there.

Formatting: Prettier with 4-space indent, single quotes, trailing commas, 80-col width. Husky runs lint-staged on pre-commit and commitlint on commit-msg.

## Commit / PR conventions

Conventional commits, header ≤72 chars, enforced by commitlint (`commitlint.config.js`). Allowed types: `feat fix docs style refactor perf test build ci chore types revert infra`. Use a scope matching the area, e.g. `fix(client): ...`, `feat(message): ...`. PR titles follow the same format; PRs fill in `.github/pull_request_template.md`.

## Architecture

**Two execution contexts.** Most logic runs in two places, and keeping them straight is the main thing to understand:

- **Node side** — `src/Client.js` (the `Client` EventEmitter, by far the largest file), `src/structures/*`, auth strategies, web cache.
- **Browser side** — code passed to `page.evaluate(...)`. It runs inside WhatsApp Web, cannot reference Node variables or closures (pass everything as serializable arguments), and returns only serializable data.

**Injection flow (`Client.initialize` → `Client.inject`).** Puppeteer launches, navigates to WhatsApp Web, waits for `window.Debug.VERSION`, then checks `WAWebSocketModel` socket state to decide whether authentication (QR or pairing code) is needed. Once logged in, `LoadUtils` from `src/util/Injected/Utils.js` is evaluated in the page, installing `window.WWebJS` — a library of helpers built on WhatsApp's internal modules accessed via `window.require('WAWeb...')` (e.g. `WAWebCollections`). Node code calls into the page as `this.client.pupPage.evaluate(() => window.WWebJS.someHelper(...))`. Re-injection can happen on SPA navigation (`framenavigated`), so inject is abortable and guards against duplicate listeners/`ready` events.

**Events flow back** via `exposeFunctionIfAbsent` (`src/util/Puppeteer.js`), which registers Node callbacks on `window` (e.g. `onAddMessageEvent`); the page wires WhatsApp model listeners to those callbacks, and `Client` converts the payloads to structures and emits events named in `Events` (`src/util/Constants.js`).

**WhatsApp internals change without notice.** Most bug fixes here are adapting to renamed modules/fields in WhatsApp Web (see git log). Patterns to follow:

- Prefer feature-detecting fallbacks over replacing the old path outright.
- WhatsApp IDs: `_serialized` was renamed to `$1`; use `Base._normalizeId` so downstream code can keep using `_serialized`.
- The supported WhatsApp Web version is tracked in `tools/version-checker/.version`; `webVersionCache` (`src/webCache/`: local/remote/none) controls which WA Web build is loaded.

**Structures (`src/structures/`).** All extend `Base`: constructed with `(client, data)`, populated through `_patch(data)` from the serialized model returned by `window.WWebJS.get*Model`, and methods call back into the page via `this.client.pupPage.evaluate`. `ChatFactory`/`ContactFactory` (`src/factories/`) pick the subclass (`PrivateChat`/`GroupChat`/`Channel`, `PrivateContact`/`BusinessContact`). New public structures must be exported from both `src/structures/index.js` and `index.js`, and typed in `index.d.ts`.

**Auth strategies (`src/authStrategies/`).** `BaseAuthStrategy` defines lifecycle hooks (`beforeBrowserInitialized`, `onAuthenticationNeeded`, `afterAuthReady`, `logout`, …) the Client calls; `LocalAuth` persists the browser `userDataDir` on disk, `RemoteAuth` zips it to a user-supplied store (uses the optional deps `archiver`/`unzipper`/`fs-extra`), `NoAuth` persists nothing.

**`InterfaceController`** (`src/util/InterfaceController.js`, exposed as `client.interface`) manipulates the WhatsApp Web UI itself (open chat drawers, etc.) rather than data.

When adding or changing a public method/option/event, update its JSDoc (docs are generated from it) and `index.d.ts`.
