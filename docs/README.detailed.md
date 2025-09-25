# Telegram Ledger Bot — Detailed Notes (Updated 2025‑09‑25)

## 1) Goals
- Log expenses from chat with minimal typing.
- Normalize free text into structured entries (code, amount, currency, description).
- Default currency JOD if omitted.
- Generate monthly Excel reports.
- Optionally learn new shortcuts locally for $0 cost via Ollama.

## 2) Message standard

Supported formats:
- Code-first: `CODE AMOUNT [CURRENCY] [description]`
- Amount-first: `AMOUNT [CURRENCY] [description]` → code is `DEFAULT_AMOUNT_FIRST_CODE` (or `MISC`)

Constraints:
- One transaction per message. If multiple amounts or connectors `or/and` appear, the bot asks to split.

Examples:
- `F 100 elc` → `F 100 JOD - electricity`
- `RENT 250 JOD flat in Amman`
- `60 grcs` → default code + `groceries`
- `75 elektr` → default code + `electricity` (AI if not known)

## 3) Parsing and normalization pipeline
1) Detect format (code-first or amount-first).
2) Currency:
   - Whitelist; `JD`→`JOD`; default to `JOD` when missing.
3) Description normalization uses, in order:
   - Built-ins (elc→electricity, wat/wtr→water, int/net→internet, hst→hosting, foo→food, …)
   - Aliases from `data/aliases.json` (persistent, up to ~1000)
   - Optional AI fallback via Ollama; result cached to `data/ai_cache.json`
4) Amount-first assigns code from `DEFAULT_AMOUNT_FIRST_CODE` (fallback `MISC`).
5) Guard combined messages; prompt to split.

## 4) AI normalizer (optional, local, free)
- Provider: Ollama; Model: `phi3:mini` (~2–4 GB disk).
- Triggered only when the first description token isn’t known.
- Low-temp, short output mapping to canonical labels:
  - `electricity, water, rent, tax, fuel, groceries, internet, hosting, insurance, salary, fees, supplies, maintenance`
- Writes learned mappings to `data/ai_cache.json`.

Install notes:
```powershell
ollama pull phi3:mini
ollama serve   # or run the Windows service
Invoke-RestMethod -UseBasicParsing -Uri http://localhost:11434/api/tags
```

## 5) Persistence
- SQLite DB: `data/ledger.sqlite` (code, amount, currency, normalized description, timestamps, chat/user).
- Excel reports: `data/reports/ledger_YYYY-MM.xlsx`.
- Aliases (manual): `data/aliases.json`.
- AI cache (learned): `data/ai_cache.json`.

## 6) Commands
- `/report` or `/report YYYY-MM` (UTC-safe date math).
- `/alias <shorthand> <canonical>`.
- `/undo` (if enabled).

## 7) Reliability/UX
- Currency whitelist + default JOD.
- One-transaction rule prevents accidental multiple entries.
- Global error handling; friendly usage prompts.

## 8) Storage/SSD guidance
- App + node_modules: ~80–150 MB.
- SQLite growth: ~1–5 KB per entry (10k ≈ 10–50 MB).
- Reports: 20–200 KB each.
- Ollama model: ~2–4 GB.
- Plan ~3–5 GB total with one local model.

## 9) Dashboard roadmap
- Express API: `/api/summary`, `/api/by-category`, `/api/daily`, `/api/monthly`, `/api/entries`.
- React + Vite + Tailwind + Recharts UI, served by the same Node process.
- Bearer token auth via `.env`.

## 10) Setup recap
```powershell
cd C:\Users\hamza\Projects\telegram-ledger-bot
npm install

# .env: set TELEGRAM_BOT_TOKEN and desired defaults
# Optional local AI:
ollama pull phi3:mini
# .env:
# AI_NORMALIZER_ENABLED=true
# AI_PROVIDER=ollama
# OLLAMA_MODEL=phi3:mini

npm run start
```

---

## Recent changes (2025-09-25)

Added a robust receipt ingestion and suggestions/audit workflow:

- Worker (`scripts/process_pending_jobs.js`)
   - Reads `data/pending_jobs.json`, downloads Telegram attachments, performs OCR (tesseract.js or native tesseract CLI), tries to parse fields with Ollama, and falls back to regex extraction for totals.
   - Saves attachments to `data/attachments/` and writes activity to `data/bot-activity.log`.

- Suggestions mechanism
   - New `suggestions` table added via `src/db.js` with helpers to add/get/apply/reject suggestions.
   - API endpoints added to review and manage suggestions (`/api/suggestions`, `/api/suggestions/:id`, `/api/suggestions/:id/apply`, `/api/suggestions/:id/reject`).
   - Dashboard (`/dashboard`) UI includes a Suggestions modal for quick review, previewing the attachment and OCR snippet, and applying/rejecting suggestions.

- Notifications
   - Worker attempts to notify the originating Telegram chat when a suggestion is created. The API will attempt to notify the chat when a suggestion is applied/rejected (requires `TELEGRAM_BOT_TOKEN`).

- Fixes and improvements
   - Fixed `applySuggestion` binding issue (sql.js does not accept undefined bindings).
   - Attachment serving fixed for Windows paths (uses `path.basename()` and `encodeURIComponent()`).

Testing & quick commands (PowerShell)

Start server + dashboard:
```powershell
cd 'C:\Users\hamza\Projects\telegram-ledger-bot'
$env:TELEGRAM_BOT_TOKEN = 'your_bot_token_here'
node src/index.js
```

Process pending jobs once:
```powershell
cd 'C:\Users\hamza\Projects\telegram-ledger-bot'
node .\scripts\process_pending_jobs.js
```

Run worker detached:
```powershell
Start-Process -FilePath node -ArgumentList 'scripts/process_pending_jobs.js' -WindowStyle Hidden
```

Where to check:
- `data/pending_jobs.json` — jobs queued by the bot
- `data/attachments/` — downloaded images
- `data/bot-activity.log` — workflow events (SUGGESTION, AUTO_EXTRACT, PUSH)
- `data/ledger.sqlite` — DB with `entries` and `suggestions`

If you want, I can add example screenshots or an exportable test job file you can drop into `data/pending_jobs.json` for local testing.

## 11) Known limits
- Natural-language `/report this month` is not accepted; use `/report` or `/report YYYY-MM`.
- First AI call after a reboot can be slower (model warm-up).
- Amount-first uses a single default code; use code-first when you need a specific code.
