# Telegram Ledger Bot — Detailed Notes (Updated 2025‑09‑26)

## 1) Goals
- Log expenses from chat with minimal typing.
- Normalize free text into structured entries (code, amount, currency, description).
- Default currency JOD if omitted.
- Generate monthly Excel reports.
- Optionally learn new shortcuts locally for $0 cost via Ollama.

## 2) Message standard

Supported formats:
- Parser v2 (recommended): natural phrases where the first word is a category from a fixed set.
   - Categories: groceries (g), food (f), transport (t), bills (b), health (h), rent (r), misc (m), and uncategorized (u)
   - Examples: `60 g apples`, `75 usd t taxi`, `b 45 wtr bill`
- Classic: `CODE AMOUNT [CURRENCY] [description]` or amount-first using default code.

Constraints:
- One transaction per message. If multiple amounts or connectors `or/and` appear, the bot asks to split.

Examples:
- `60 g apples` → groceries 60 JOD - apples
- `75 usd t taxi` → transport 75 USD - taxi
- `b 45 wtr bill` → bills 45 JOD - water bill
- Classic: `F 100 elc`, `RENT 250 JOD flat in Amman`

## 3) Parsing and normalization pipeline
1) Detect format (code-first or amount-first).
2) Currency:
   - Whitelist; `JD`→`JOD`; default to `JOD` when missing.
3) Description normalization uses, in order:
   - Built-ins (elc→electricity, wat/wtr→water, int/net→internet, hst→hosting, foo→food, …)
   - Aliases from `data/aliases.json` (persistent, up to ~1000)
   - Optional AI fallback via Ollama; result cached to `data/ai_cache.json`
4) Amount-first assigns code from `DEFAULT_AMOUNT_FIRST_CODE` (fallback `MISC`). Under Parser v2, unknown first tokens are prefixed with `uncategorized` to keep category integrity.
5) Guard combined messages; prompt to split.

## 4) Parser versions and AI (optional)
- Switch parser via `.env`: set `PARSER_VERSION=v2` (recommended) or `v1` (classic).
- In v2, the first description token is normalized to the canonical set; unknowns become `uncategorized`.
- AI normalizer (optional, local, free):
   - Provider: Ollama; Model: `phi3:mini` (~2–4 GB disk).
   - Triggered only when the first description token isn’t known.
   - Low-temp, short output mapping to canonical labels.
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

## 9) Dashboard updates
- Express API: `/api/summary`, `/api/by-category`, `/api/daily`, `/api/monthly`, `/api/entries`.
- React + Vite + Tailwind + Recharts UI, served by the same Node process.
- SPA improvements:
   - Category suggestions (sorted by biggest totals), keyboard nav, clear, localStorage persistence.
   - Recent Entries table shows Category (derived from description’s first word) instead of Code.
   - Avg Out/Day card added.
   - FX breakdown hidden for now.
— Bearer token auth via `.env`.

## 10) Setup recap
```powershell
cd C:\Users\hamza\Projects\telegram-ledger-bot
npm install

# .env: set TELEGRAM_BOT_TOKEN and desired defaults
# Switch to Parser v2 and enable dashboard
# PARSER_VERSION=v2
# DASHBOARD_ENABLED=true
# DASHBOARD_PORT=8090
# Optional local AI:
ollama pull phi3:mini
# .env:
# AI_NORMALIZER_ENABLED=true
# AI_PROVIDER=ollama
# OLLAMA_MODEL=phi3:mini

npm run start
```

---

## Recent changes (2025-09-26)

- Fixed taxonomy: canonical categories enforced at the first description token (g/f/t/b/h/r/m and u for uncategorized).
- Parser v2 (natural phrases) enabled via `PARSER_VERSION=v2`.
- Migration script to normalize historical entries: `node scripts/migrate_categories.js [--dry] [--chat <chatId>]` (auto backup in `data/`).
- Dashboard SPA updates: category suggestions, Avg Out/Day, FX off, Recent Entries shows Category.

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

## 12) Forecasting and anomaly detection (planned)

Goal: provide simple, explainable insights that help anticipate spend and catch mistakes early.

What you’ll get:
- Forecast next month’s spending per category (and overall) with confidence bands.
- Highlight “out of pattern” spikes (e.g., electricity bill doubled) on charts and in a small inbox.

Data prep
- Aggregate entries by category and calendar month in base currency (JOD). If multi-currency is enabled, convert with end-of-month FX.
- Require a minimum history window: 6 months for linear regression; 12 months recommended for seasonal models.

Methods
- Linear regression (LR): fit y = a + b·t on monthly totals per category where t is month index; predict t_next.
   - Pros: fast, robust for monotonic trends; Cons: ignores seasonality.
   - Confidence: use residual standard deviation to produce 80%/95% bands.
- Holt–Winters (additive) triple exponential smoothing (HW): level, trend, and seasonality with period m = 12 for monthly data.
   - Pros: captures seasonality; Cons: needs ≥2 seasons of data to stabilize.
   - Parameter selection: light grid search on α, β, γ to minimize SSE; fallback to sane defaults (0.2/0.1/0.2) if data is sparse.
- Fallbacks: if <6 months, return “insufficient history” and skip forecast for that category.

Anomaly detection
- Residual z-score: compare actual monthly totals to seasonal baseline. Flag if |z| ≥ 3 (configurable) or if change ≥ 2× median for utilities-like categories.
- STL + MAD (optional): seasonally decompose and flag if |residual| > k·MAD (k default 3.5).
- Domain rules: never flag RENT unless it changes; highlight BILLS spikes > 1.8× trailing 6-month median; ignore months with known holidays if configured.

Surface in the dashboard (UI)
- Time series: draw forecast point for next month with a dashed line and shaded CI band; anomalies get a red dot + tooltip.
- Cards: “Next month forecast” by category with delta vs last month.
- Inbox: a compact “Anomalies” list with category, month, actual vs expected, and a quick note reason (z-score, rule triggered).

Planned API endpoints (subject to change)
- GET `/api/forecast?period=monthly&h=1&category=g` → { method: "hw"|"lr", forecast, ci80, ci95, history }
- GET `/api/anomalies?period=monthly&window=12&category=all` → [{ category, month, actual, expected, z, method }]

Configuration
- Feature flags: `FORECASTING_ENABLED=true`, `ANOMALY_DETECTION_ENABLED=true`.
- Tuning: `FORECAST_METHOD=hw|lr|auto`, `FORECAST_MIN_MONTHS=6`, `ANOMALY_Z=3.0`, `ANOMALY_WINDOW=12`.

Notes
- Keep models simple and transparent. Prefer explainability over black-box accuracy.
- Start with monthly granularity; extend to weekly later if needed (seasonal period m=52).
- If history is sparse or highly volatile, suppress forecasts rather than showing misleading numbers.
