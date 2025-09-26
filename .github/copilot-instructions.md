# Copilot instructions for this repository

This repo is a Node.js service that logs expenses from Telegram/WhatsApp, serves an HTTP API + dashboard SPA, and generates monthly Excel reports. It uses a file-backed SQLite (sql.js) DB and a fixed expense category model.

## Architecture and data flow
- Entry-point: `src/index.js`
  - Loads `src/config.js` (env-driven), opens the DB via `LedgerStore.create()` (`src/db.js`). Watches the DB file and hot-reloads in-memory DB if another process updates it (worker).
  - Starts Express API (`createApiApp` in `src/api.js`) on `DASHBOARD_PORT` and optionally the Telegram bot (Telegraf) and WhatsApp webhook server.
  - Schedules monthly reports (Excel via `exceljs`) and sends to each chat.
- Database (`src/db.js`): sql.js in-memory with on-disk persistence. Key tables: `entries`, `fx_rates`, `budgets`, `recurring`, `trips`, `invoices`, `suggestions`.
  - Call `await store.persist()` after any writes. Never bind `undefined` to sql.js — use `null` (see `applySuggestion`).
- HTTP API (`src/api.js`): JSON Express app with optional Bearer auth (`DASHBOARD_AUTH_TOKEN`). Serves:
  - Metrics: `/api/summary`, `/api/by-category`, `/api/daily`, `/api/weekly`, `/api/monthly`, `/api/yearly`, `/api/daily-summary`
  - Data: `/api/entries`, `/api/export` (csv/xlsx), `/api/chats`, `/api/fx`, `/api/budgets`, `/api/recurring`, `/api/trips`, `/api/invoices`, `/api/uncategorized`
  - ML-ish: `/api/forecast`, `/api/anomalies`, `/api/correlations`, `/api/narrative`
  - Review flow: `/api/suggestions*` (created by worker), `/attachments` and `/files` static serving
  - Mobile quick add: `POST /api/mobile/entry`
- Dashboard SPA: `dashboard-app/` (Vite/React/Tailwind). Built `dist/` is auto-served at `/`; legacy static UI under `/dashboard`.
- Worker/OCR: `scripts/process_pending_jobs.js` downloads Telegram attachments, runs OCR (tesseract.js or native tesseract), writes suggestions to DB. Attachments live under `data/attachments/`.

## Category model and conventions
- Fixed categories (code → name): g→groceries, f→food, t→transport, b→bills, h→health, r→rent, m→misc, u→uncategorized.
  - Helper `rowCategory(r)` prefers one-letter `code`; otherwise first word of `description` (`getCategory`). Filters accept code or name via `catSynonyms`.
- Codes are stored uppercase; transfers use `XFER`; income detection for codes like `INC`, `SAL`, etc. `entries.is_transfer`/`is_income` are derived.
- Currency default is `JOD`. Base amounts computed with `fx_rates` and saved into `entries.base_amount_jod`/`fx_rate_jod`.
- Do not change sql.js loading pattern — it uses dynamic `import('sql.js')` to support ESM builds.

## Developer workflows (Windows PowerShell)
- Run server (API + bot + dashboard):
  - `npm install`; set `.env` (copy from `.env.example`); `npm run dev`
  - Without Telegram token the API still starts. `BOT_MODE=polling|webhook` controls Telegraf startup.
- Dashboard SPA dev: `cd dashboard-app; npm install; npm run dev` (proxies API to 8090). Build with `npm run build` to auto-serve at `/`.
- Worker (OCR): `node scripts/process_pending_jobs.js` (foreground) or spawn via `/debug/process_pending` endpoint.
- Useful endpoints: `/api/health`, `/api/routes`, `/files`, `/attachments`.

## Patterns to follow when extending
- Use `requireAuth` and reuse helpers: `parseMonthParam`, `rowCategory`, `catSynonyms`, `currentMonthRange`.
- Exclude transfers (`code==='XFER'`) and usually income (`is_income`) from expense charts. Keep category filtering consistent across endpoints.
- When updating entries, recompute and persist derived fields (see `updateEntryById`). Bind `null`, not `undefined`.
- Windows paths: always use `path.join/resolve`; for public links use `path.basename` + `encodeURIComponent` (see suggestions/attachments).

## Integration points
- Telegram via Telegraf (env `TELEGRAM_BOT_TOKEN`), webhook mode needs `WEBHOOK_URL/PORT`.
- Optional AI normalizer (Ollama/OpenAI), configured in `.env`; OCR via tesseract.js or native Tesseract CLI.
- Mobile (Android) app
  - Source: `mobile/ledger_mobile` (Flutter). In dev, the Android emulator can’t reach `localhost`; use `http://10.0.2.2:8090` for `API_BASE_URL`. Physical device: use your PC’s LAN IP.
  - Auth: send `Authorization: Bearer <DASHBOARD_AUTH_TOKEN>` for all protected endpoints.
  - Endpoints used: `GET /api/summary?month=current`, `POST /api/mobile/entry` with `{ amount, currency, description, createdAt?, chatId?, code? }`. Server defaults `chatId`→`"mobile"` and `code`→`"F"` if omitted.
  - Common errors: `401` (missing/invalid token), `400` (missing `amount` or `description`).

If any section above is unclear or you need examples for a specific endpoint or flow (e.g., adding a new export, extending suggestions), tell me what you’re building and I’ll refine this doc.