# GainSight Ledger — Machine-readable Summary for Automation (Updated 2025‑09‑26)

Purpose
- Short description: GainSight Ledger is a small Node.js application that provides a Telegram bot, a dashboard API, and local worker processes to capture shorthand expense messages and produce monthly reports.
- High-level goal: let users submit quick shorthand transactions (e.g., "60 g apples" or "F 100 elc"). The app parses messages into ledger entries, normalizes the first description token to a fixed category set (Parser v2), applies manual aliases plus optional AI suggestions, persists to an on-disk SQLite database (via sql.js), and serves a dashboard and export features.

Design Goals for automation
- Be deterministic: describe data shapes, APIs, and side-effects precisely.
- Capture developer and runtime configuration for reproducible startup and debugging.
- Document message/parse rules and alias/AI flows so another automated agent can reason about feature changes.

Glossary / Key concepts
- entry: a ledger row with fields (id, chat_id, user_id, code, amount, description, currency, created_at, base_amount_jod, fx_rate_jod, ...).
- shorthand / token: the first word in the description that users often abbreviate (e.g., "elc" for electricity).
- alias: a user-provided persistent mapping from a shorthand token to canonical words (stored in `data/aliases.json`).
- AI cache: a persistent store of AI-suggested mappings (stored in `data/ai_cache.json`).
- temp/teach flow: interactive flow where AI or the bot asks the user to confirm or provide a canonical mapping.
- amount-first message: message where first token is numeric (e.g., `60 groceries`). Defaults to code MISC unless configured.

Repository layout (important files and purpose)
- `src/` — application source
  - `index.js` — bootstrap: creates LedgerStore, starts Dashboard API, Telegram bot, optional WhatsApp etc. Also schedules monthly reports.
  - `bot.js` — Telegram bot logic (Telegraf). Parses messages, applies aliases/AI, creates entries, handles attachment/voice/locations, interactive alias/teach flows.
  - `api.js` — Express-based dashboard API and endpoints (includes alias management endpoints used by frontend).
  - `db.js` — LedgerStore wrapper around sql.js (WASM SQLite). Responsible for DB create/load, schema ensure, persist, reloadFromDisk, CRUD helpers.
  - `ai_normalizer.js` — interface to AI providers (OpenAI or local Ollama). Exports `aiNormalize()` and `normalizeUnknownDescriptionFirstWord()`.
  - `shared/parse.js` — message parsing rules, canonical category list, and SHORTHANDS map.
  - `shared/aliases.js` — AliasStore and AICache (disk-backed JSON map) with methods `load`, `get`, `set`, `remove`, `all`.
  - `report.js` — XLSX/CSV generation and monthly report logic.
  - other utilities: `whatsapp.js`, `report.js`, etc.
- `data/` — runtime data (not all checked into Git)
  - `ledger.sqlite` — persistent DB binary created via sql.js export
  - `aliases.json` — persistent manual alias mappings (lowercased keys/values)
  - `ai_cache.json` — persistent AI-mapped tokens
  - `pending_jobs.json` — worker queue for OCR/transcription jobs
- `scripts/` — small helpers for CLI operations (alias_list.js, alias_set.js, alias_promote.js, e2e_upload.py)
- `frontend/` — dashboard static UI (Vite + React). Not essential for bot flows but used by operators.
- `run-dev.ps1`, `start_servers_desktop.ps1` — dev helpers that spawn server/worker windows on Windows.

Data formats
- `data/aliases.json` — JSON object mapping shorthand -> canonical word(s). Example: `{ "rol": "rolls royce", "gog": "groceries" }`.
- `data/ai_cache.json` — JSON object mapping token -> aiCanonical. Used to avoid repeated AI calls.
- DB schema key tables (created in `db.js`):
  - `entries` (id, chat_id, user_id, code, amount, description, currency, created_at, base_amount_jod, fx_rate_jod, is_transfer, is_income, trip_id, location_lat, location_lng, attachment_path, ocr_text, voice_text, is_invoice)
  - `fx_rates`, `budgets`, `recurring`, `trips`, `invoices`, `suggestions`.

Message parsing rules (from `src/shared/parse.js` and `parse_v2.js`)
- Parser v2 (recommended): first description token must map to one of 7 canonical categories: groceries, food, transport, bills, health, rent, misc (plus uncategorized). Unknown first tokens are prefixed with `uncategorized`.
- Classic (v1):
  - Code-first: `CODE AMOUNT [CURRENCY] [description]` (CODE /^[A-Z0-9]{1,6}$/)
  - Amount-first: `AMOUNT [CURRENCY] [description]` (defaults to `DEFAULT_AMOUNT_FIRST_CODE` or `MISC`)
- Currency tokens are 2–5 letters (JOD, USD, EUR, …). JD→JOD. Guard against consuming shorthand-like tokens as currency.
- Description normalization uses SHORTHANDS, manual aliases, and optional AI suggestions.

Alias & AI normalization flows (as implemented)
- Manual alias precedence: the bot loads `AliasStore` from disk per message and applies manual alias on the first description token before calling AI.
- AI normalizer (`ai_normalizer.aiNormalize`) behavior:
  - If manual alias exists for token, returns that canonical immediately.
  - Otherwise checks disk ai cache and in-memory cache.
  - If AI enabled (`AI_NORMALIZER_ENABLED=true`) and provider configured, it calls the provider (OpenAI or Ollama) with a tight prompt asking for a single lowercase canonical word chosen from a list (CANON_LABELS).
  - On a valid mapping, AI result is cached both in memory and in the disk `ai_cache.json`.
- Interactive teach/confirm flow (Telegram bot):
  - If AI suggests mapping, bot creates entry (temp) and asks user to confirm with inline buttons: `Yes — keep 'X'` or `No — I'll provide`.
  - If user clicks Yes, mapping is persisted to `aliases.json` and the entry is updated accordingly.
  - If user clicks No, bot asks user to type replacement canonical word; the next message from that user is persisted as alias and entry updated.
- Teach flow for amount-first unknown tokens (v2 behavior):
  - Unknown first tokens are stored but prefixed with `uncategorized` by the parser.
  - The bot may prompt to teach a mapping; if taught, it saves to `aliases.json` and updates the entry.

CLI helpers and scripts
- `node .\scripts\alias_list.js` — prints current aliases.
- `node .\scripts\alias_set.js <shorthand> <canonical>` — saves alias.
- `node .\scripts\alias_promote.js <token> <canonical>` — promotes AI cache entry to manual alias.

Environment variables (key ones, defaults)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (empty = bot won't start).
- `ALLOWED_USER_IDS` — comma-separated list of allowed user ids for bot interactions (optional whitelist).
- `DB_PATH` — path to db file (default: `data/ledger.sqlite`).
- `REPORTS_DIR` — default `data/reports`.
- `ALIASES_PATH` — path to alias JSON (default `data/aliases.json`).
- `AI_CACHE_PATH` — path to AI cache JSON (default `data/ai_cache.json`).
- `DEFAULT_CURRENCY` — default currency (JOD).
- `DEFAULT_AMOUNT_FIRST_CODE` — default code for amount-first messages (empty -> `MISC`).
- `AI_NORMALIZER_ENABLED` — `true` to invoke AI normalizer.
- `AI_PROVIDER` — `openai` or `ollama`.
- `OPENAI_API_KEY`, `AI_MODEL` — OpenAI settings; `OLLAMA_BASE_URL`, `OLLAMA_MODEL` — Ollama settings.
- `DASHBOARD_ENABLED` (true/false), `DASHBOARD_PORT` (8090 default), `DASHBOARD_AUTH_TOKEN`.
- `PARSER_VERSION` — `v2` (recommended) or `v1` (classic).

Dev and Run commands (Windows PowerShell)
- Install dependencies: `npm install`
- Start dev (nodemon): `npm run dev` (runs `nodemon src/index.js`)
- Start production-like: `npm start` (`node src/index.js`)
- Run CLI scripts: `node .\scripts\alias_list.js` etc.
- Dev helper (starts separate windows): `.
un-dev.ps1`

Migration
- Normalize historical entries to the 7 categories:
  - Dry-run: `node scripts/migrate_categories.js --dry`
  - Apply: `node scripts/migrate_categories.js`
  - Limit to a chat: `node scripts/migrate_categories.js --chat <chatId>`
  - Script creates a dated backup under `data/` before changes.

Testing and validation
- Unit tests location: `tests/` contains some tests for API and export in a separate project; there are no comprehensive unit tests for interactive bot flows.
- Manual verification steps:
  - Start server and send messages from allowed Telegram account.
  - Use `/alias` to teach tokens and ensure `data/aliases.json` updates.
  - Send photo/voice and verify `data/pending_jobs.json` queue and worker processing (workers run separately).

Concurrency and DB notes
- DB uses `sql.js` which is an in-memory SQLite compiled to WASM; `LedgerStore.create` dynamic-imports `sql.js` to support ESM builds.
- The app keeps an in-memory Database instance and persists to `ledger.sqlite` by exporting bytes. Workers may also write to disk. `LedgerStore.reloadFromDisk()` reloads from the on-disk file to pick up concurrent changes.
- File watchers can watch the `ledger.sqlite` file and call `reloadFromDisk()` when modified.
- Be careful: do not run multiple processes that concurrently call `persist()` aggressively without coordination. Prefer worker queue + reload pattern in this repo.

Known runtime pitfalls and debugging tips
- ESM vs CJS: `sql.js` may be an ESM package that uses top-level await in some versions. `db.js` mitigates this by using `await import('sql.js')` inside `LedgerStore.create`, with a fallback to `require('sql.js')` for older builds.
- If you see `ERR_REQUIRE_ASYNC_MODULE`, check for top-level `await` import graphs and ensure dynamic import usage like in `db.js`.
- If bot repeatedly prompts for mapping after you taught an alias, ensure: (a) alias file updated; (b) bot applies manual alias before calling AI; (c) AI normalizer reloads aliases on each call. Recent code variants implement these fixes.
- To capture detailed bot activity, check `data/bot-activity.log` which the bot writes to for queue pushes and errors.

Security considerations
- `TELEGRAM_BOT_TOKEN` and OpenAI keys are secrets: keep them off commits (use `.env` and environment variables).
- Dashboard auth: if `DASHBOARD_ENABLED` is true and `DASHBOARD_AUTH_TOKEN` is set, dashboard endpoints may require it — check `src/api.js`.
- Aliases and AI cache are plain JSON files; if multi-user, consider per-chat scoping or access controls.

Extending the system (guidance for a future agent)
- To add a new normalization rule, update `src/shared/parse.js` SHORTHANDS and/or add a new AI-aware rule in `src/ai_normalizer.js`.
- To change the teach flow to wait before creating entries, modify `src/bot.js` to delay `store.addEntry()` until after user provides canonical word; consider persisting a temporary pending record in `data/pending_jobs.json` instead of an actual DB row.
- To support multi-word canonical mappings beyond the first token, adapt alias storage to hold arrays or normalized phrases and update `normalizeDescription()` accordingly.

Quick checklist for re-entry (what to run when you return)
1. Install dependencies: `npm install`
2. Configure `.env` with `TELEGRAM_BOT_TOKEN`, allowed user id(s), and optionally `AI_NORMALIZER_ENABLED` plus provider configs.
3. Start server: `npm start` or `npm run dev`.
4. In Telegram: send `/start` and then test messages like `F 100 elc` and `60 groceries`.
5. Use `/alias <shorthand> <canonical>` to teach tokens.
6. Check files: `data/aliases.json`, `data/ai_cache.json`, `data/ledger.sqlite`.

Contact notes / provenance
- Last edits: interactive alias/teach flows, AI cache, and alias CLI scripts were recently added. The repository contains prior conversation logs (`CONVERSATION_SAVE_2025-09-24.md`) that may describe the design history. Use them for deeper context.

Appendix: Important code locations (one-line references)
- Message parsing & shorthands & categories: `src/shared/parse.js`
- Alias store + AI cache: `src/shared/aliases.js`
- AI interface (OpenAI/Ollama): `src/ai_normalizer.js`
- Telegram bot logic & teach flow: `src/bot.js`
- DB layer (sql.js wrapper): `src/db.js`
- API & dashboard: `src/api.js`
- CLI scripts: `scripts/alias_list.js`, `scripts/alias_set.js`, `scripts/alias_promote.js`

End of file
