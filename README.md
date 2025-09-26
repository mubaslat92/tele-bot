# Telegram Ledger Bot

Log expenses from chat and get monthly Excel reports. Now with a fixed 7-category model and an easier Parser v2 for natural phrases.

Quick examples:
- Parser v2 (recommended):
  - `60 g apples` (g = groceries)
  - `75 usd t taxi` (t = transport)
  - `b 45 jod electricity bill` (b = bills)
- Classic (code-first):
  - `F 100 elc`
  - `RENT 250 JOD flat in Amman`

Optionally uses a free local AI (Ollama) to learn new shortcuts like `elektr → electricity`.

## Features
- Two parsing modes:
  - Parser v2 (simple natural phrases, recommended): category as first word/letter from a fixed set.
  - Classic parser (code-first or amount-first): `CODE AMOUNT [CURRENCY] [description]`.
- Fixed categories (first word of description):
  - groceries (g), food (f), transport (t), bills (b), health (h), rent (r), misc (m), and uncategorized (u)
- Default currency JOD if omitted; `JD` is normalized to `JOD`.
- Currency whitelist to avoid mistaking words like `elc` as currency.
- Description normalization:
  - Built-ins (elc→electricity, wat/wtr→water, int/net→internet, hst→hosting, foo→food, …).
  - Your aliases via `/alias` (persisted to disk).
  - Optional AI fallback (Ollama `phi3:mini`) with disk cache.
- `/report` and `/report YYYY-MM` generate Excel files with raw entries + category totals.
- One message = one transaction (bot asks to split if multiple are detected).
- SQLite-backed storage; reports saved under `data/reports`.
- Dashboard API (Express) with bearer auth + SPA dashboard (Vite/React):
  - Time scales: daily, weekly (ISO), monthly, yearly endpoints.
  - Category filter with suggestions (sorted by biggest totals), CSV export, drill-down, light/dark theme.
  - Avg Out/Day card; FX breakdown hidden by default.

## Message standard
- One transaction per message.

Parser v2 (recommended):
- Natural phrases, category word or letter first, then details. Examples:
  - `60 g apples` → groceries 60 JOD - apples
  - `75 usd t taxi` → transport 75 USD - taxi
  - `b 45 wtr bill` → bills 45 JOD - water bill
- Accepted category letters: g, f, t, b, h, r, m, u (for uncategorized)
- If you use a new word as first token, it will be prefixed with `uncategorized` unless there’s a known mapping.

Classic parser:
- Code-first: `CODE AMOUNT [CURRENCY] [description]` (e.g., `F 100 elc`)
- Amount-first: `AMOUNT [CURRENCY] [description]` (e.g., `60 groceries`) → uses `DEFAULT_AMOUNT_FIRST_CODE` (or `MISC`).

## Quick start (Windows)
1) Install
```powershell
cd C:\Users\hamza\Projects\telegram-ledger-bot
npm install
```

2) Configure `.env` (copy from `.env.example`)
- Required: `TELEGRAM_BOT_TOKEN=...`
- Useful defaults:
```
DEFAULT_CURRENCY=JOD
DEFAULT_AMOUNT_FIRST_CODE=MISC
DB_PATH=./data/ledger.sqlite
ALIASES_PATH=./data/aliases.json
AI_CACHE_PATH=./data/ai_cache.json
TIMEZONE=Asia/Amman
# Switch to the new parser (recommended):
PARSER_VERSION=v2
# Enable dashboard + auth token
DASHBOARD_ENABLED=true
DASHBOARD_PORT=8090
DASHBOARD_AUTH_TOKEN=your-strong-token
```

3) Optional: free local AI (Ollama)
- Install: https://ollama.com/download
- Pull a small model:
```powershell
ollama pull phi3:mini
```
- Enable in `.env`:
```
AI_NORMALIZER_ENABLED=true
AI_PROVIDER=ollama
OLLAMA_MODEL=phi3:mini
# OLLAMA_BASE_URL=http://localhost:11434
```

4) Run
```powershell
npm run start
```

### Dashboard API + SPA
- When enabled, an HTTP API is available at `http://localhost:8090`.
- Endpoints:
  - `GET /api/health` (no auth)
  - `GET /api/summary?month=YYYY-MM|current` (Bearer token)
  - `GET /api/by-category?month=YYYY-MM|current` (Bearer token)
  - `GET /api/daily?month=YYYY-MM|current` (Bearer token)
  - `GET /api/weekly?month=YYYY-MM` or `?year=YYYY` (Bearer token)
  - `GET /api/monthly?year=YYYY` (Bearer token)
  - `GET /api/yearly?start=YYYY&end=YYYY` (Bearer token)
  - `GET /api/entries?month=YYYY-MM|current&limit=100&category=foo` (Bearer token)
  - `GET /api/chats` (Bearer token)
  - FX: `GET/POST /api/fx`
  - Budgets: `GET/POST /api/budgets`, `GET /api/budgets/progress?month=YYYY-MM`
  - Recurring: `GET/POST /api/recurring`, `DELETE /api/recurring/:id`
  - Static reports under `/files`.
- SPA dashboard (Vite/React):
  - Dev: `cd dashboard-app; npm install; npm run dev` → http://localhost:5173 (proxies API to 8090)
  - Build: `npm run build` then the server will auto-serve from `dashboard-app/dist`.
  - Recent UI changes: category suggestions (sorted by totals), Avg Out/Day card, FX breakdown hidden, Recent Entries shows Category.

## Commands
- `/report` → report for current month
- `/report YYYY-MM` → report for that month (e.g., `/report 2025-09`)
- `/alias <shorthand> <canonical>` → teach a persistent mapping (e.g., `/alias grcs groceries`)
- `/undo` → remove your last entry (if enabled)

## Files and storage
- Database: `data/ledger.sqlite`
- Reports: `data/reports/ledger_YYYY-MM.xlsx`
- Aliases (manual): `data/aliases.json`
- AI cache (learned): `data/ai_cache.json`

## Troubleshooting
- First AI call can take a few seconds (model warm-up); later calls are cached.
- Disable AI anytime: set `AI_NORMALIZER_ENABLED=false` and restart.
- Foreground logs:
```powershell
cd C:\Users\hamza\Projects\telegram-ledger-bot
node src/index.js
```

## OCR / Receipts (recommended setup)

The worker (`scripts/process_pending_jobs.js`) will try OCR in this order:

1. tesseract.js (pure-JS OCR library)
2. native Tesseract CLI (recommended for reliability/performance)

If you want reliable, free, local OCR, install the native Tesseract engine on your machine. On Windows you can install via Chocolatey or winget.

Install with Chocolatey (if you have choco):

```powershell
choco install -y tesseract
```

Or with winget (Windows 10/11):

```powershell
winget install --id UB.Mannheim.Tesseract -e
```

After installing, confirm tesseract is on your PATH:

```powershell
tesseract --version
```

Notes:
- Tesseract ships with `eng` by default. If you need other languages (Arabic, etc.) install the appropriate language data.
- Preprocessing images (deskew, increase DPI, convert to grayscale) dramatically improves OCR accuracy. ImageMagick or sharp/Jimp can help.
- If you prefer a hosted OCR API, OCR.Space offers a free tier (api.ocr.space). Cloud vision APIs (Google/Microsoft/AWS) are paid beyond small free quotas.

Parsing OCR output into structured fields (vendor, total) is best done with a small AI/LLM prompt over the OCR text. Ollama (local) or OpenAI can be used for this:

Example flow (recommended):

1. Worker extracts raw OCR text from a receipt image.
2. Send that text to a local LLM (Ollama) or remote LLM (OpenAI) with a prompt that asks for vendor name, total amount, date, and currency in JSON.
3. Save the parsed fields back to the `entries` row (vendor → description, total → amount, currency → currency).

Sample prompt (pseudo):

"Extract vendor, total amount, date, and currency from the following receipt OCR text. Respond with a single JSON object with keys `vendor`, `total`, `date`, `currency`. If a field is missing, return null. OCR text: \"...OCR TEXT...\""

I can add an optional post-processing step that calls Ollama/OpenAI and writes the parsed vendor/total into the DB automatically. Tell me if you'd like me to:

- Wire an Ollama-based parser (local, free if you run Ollama and a small model)
- Or wire OpenAI parsing (requires an API key)

## Recent changes (2025-09-26)

Category model revamp + Parser v2 + Dashboard UX

- Fixed taxonomy: all entries are now categorized using one of 7 categories (plus uncategorized) based on the first word of `description`:
  - groceries (g), food (f), transport (t), bills (b), health (h), rent (r), misc (m), uncategorized (u)
- Parser v2 (natural phrases):
  - Example inputs: `60 g apples`, `75 usd t taxi`, `b 45 wtr bill`
  - Toggle via `.env`: `PARSER_VERSION=v2`
  - Unknown first tokens are prefixed with `uncategorized` to preserve category integrity.
- Migration script to normalize historical data:
  - Dry-run: `node scripts/migrate_categories.js --dry`
  - Apply: `node scripts/migrate_categories.js`
  - Filter to a single chat: `node scripts/migrate_categories.js --chat <chatId>`
  - The script creates an automatic timestamped backup in `data/` before writing.
- Dashboard SPA updates:
  - Category suggestions dropdown (sorted by biggest totals), keyboard nav, clear button, and localStorage persistence.
  - Avg Out/Day metric added.
  - FX breakdown hidden for now.
  - Recent Entries table shows Category instead of Code.

—

## Recent changes (2025-09-25)

Summary of new features added recently in this workspace:

- Worker-based receipt pipeline
  - `scripts/process_pending_jobs.js` watches/consumes `data/pending_jobs.json`, downloads Telegram attachments, runs OCR (tesseract.js or native tesseract CLI), calls the local LLM (Ollama) for structured parsing, and falls back to a regex total-extractor.
  - Attachments are saved under `data/attachments/`.
  - Worker writes suggestion rows to the `suggestions` table instead of applying parsed totals directly.

- Suggestions + audit workflow
  - New DB table `suggestions` and helpers in `src/db.js` (add/get/apply/reject).
  - API endpoints to review and act on suggestions:
    - `GET /api/suggestions` — list suggestions (Bearer token required)
    - `GET /api/suggestions/:id` — view a single suggestion + entry
    - `POST /api/suggestions/:id/apply` — apply a suggestion (updates entry and marks suggestion applied)
    - `POST /api/suggestions/:id/reject` — reject a suggestion
  - Dashboard UI (`/dashboard`) includes a Suggestions modal where you can view OCR text, open the attachment, and Apply/Reject suggestions.

- Notifications and logs
  - When a suggestion is created the worker appends events to `data/bot-activity.log` and will attempt to notify the originating Telegram chat via Bot API (requires `TELEGRAM_BOT_TOKEN`).
  - API will attempt to notify the chat when a suggestion is applied or rejected.

- Small but important fixes
  - `applySuggestion` binding bug fixed: DB bindings now use `null` (not `undefined`) to avoid sql.js errors.
  - Attachment URL generation now uses `path.basename()` and URL-encodes filenames so the dashboard "View" link works on Windows.

How to run/test locally (PowerShell)

- Start server (API + dashboard + bot):
```powershell
cd 'C:\Users\hamza\Projects\telegram-ledger-bot'
$env:TELEGRAM_BOT_TOKEN = 'your_bot_token_here'  # if needed
node src/index.js
```

- Run the worker once (foreground):
```powershell
cd 'C:\Users\hamza\Projects\telegram-ledger-bot'
#$env:TELEGRAM_BOT_TOKEN = 'your_bot_token_here'  # ensure token is set if downloading files
node .\scripts\process_pending_jobs.js
```

- Start the worker detached (background):
```powershell
cd 'C:\Users\hamza\Projects\telegram-ledger-bot'
Start-Process -FilePath node -ArgumentList 'scripts/process_pending_jobs.js' -WindowStyle Hidden
```

Where to look
- `data/pending_jobs.json` — pending jobs queue (written by bot handlers)
- `data/attachments/` — downloaded receipt images
- `data/bot-activity.log` — worker and bot activity (AUTO_EXTRACT, SUGGESTION, PUSH entries)
- `data/ledger.sqlite` — main DB (entries, suggestions, trips, invoices)
- Dashboard: http://localhost:8090/dashboard/ (enter Bearer token in UI)

If something fails
- Check `data/bot-activity.log` for worker messages.
- If suggestions fail to apply with HTTP 500 previously: ensure you have latest code (applySuggestion now handles null bindings).
- If attachments don't open: ensure the worker downloaded files to `data/attachments` and restart the server so static route serves them.


## Roadmap (dashboard)
- Express API (`/api/summary`, `/api/by-category`, `/api/daily`, `/api/monthly`, `/api/entries`).
- React + Vite dashboard (Tailwind + Recharts) served by the same Node app.

## Release v1.1 (2025-09-27)

This release brings a working mobile quick-add flow, consistent category handling across API/UI, and small dashboard fixes.

What’s new
- Mobile app (Flutter)
  - Home screen: Summary cards, Top categories, Recent entries.
  - Month-year picker dialog with editable year (tap the year to type), no day selection.
  - Quick add bottom sheet with fields: Amount, Category dropdown (Groceries/Food/Transport/Bills/Health/Rent/Misc/Uncategorized), Description, Currency.
  - Sends code separately (uppercase). Description is preserved exactly as typed.
  - Improved error surfacing for failed saves.
- Backend API
  - New/updated endpoint: `POST /api/mobile/entry` accepts `{ chatId?, code?, amount, currency, description, createdAt? }`.
    - Defaults `chatId` to `"mobile"` if not provided.
    - Persists `code` as provided (uppercase). Transfers (`XFER`) and income codes are detected.
  - Category derivation helper `rowCategory(r)`: prefers a known one-letter `code` (g/f/t/b/h/r/m/u); falls back to the first word of `description`.
  - Category filtering now supports synonyms (code or name) across endpoints: `/api/entries`, `/api/daily`, `/api/weekly`, `/api/monthly`, `/api/export`.
  - Dashboard continues to serve from `dashboard-app/dist` when present.
- Dashboard (Vite/React)
  - Recent entries now display category from saved `code` when available (fallback to first word of description).
  - Category filters/time series match by code or name.

How to run (Windows, dev)
- Backend API + bot
  - PowerShell:
    - `cd C:\Users\hamza\Projects\telegram-ledger-bot`
    - `npm install`
    - `npm run dev`
- Dashboard SPA
  - Dev: `cd dashboard-app; npm install; npm run dev` → http://localhost:5173 (proxies to 8090)
  - Build: `npm run build` and the server will auto-serve `dashboard-app/dist`.
- Mobile app (Android emulator)
  - Emulator can’t reach `localhost`. Use `10.0.2.2` to talk to your PC.
  - PowerShell:
    - `cd C:\Users\hamza\Projects\telegram-ledger-bot\mobile\ledger_mobile`
    - `flutter devices` (confirm `emulator-5554`)
    - `flutter run -d emulator-5554 --dart-define=API_BASE_URL=http://10.0.2.2:8090`
  - Hot reload: press `r` in the Flutter terminal; hot restart: `R`.

Notes
- Existing older entries without a known letter `code` will still show category from description’s first word. You can edit entries or migrate if needed.
- If you enable API auth via `DASHBOARD_AUTH_TOKEN`, pass the token from the mobile app as needed (Dio headers) and from the dashboard via the prompt.
