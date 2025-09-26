# Dashboard SPA

React + Vite + Tailwind dashboard for the Telegram Ledger Bot.

Key features
- Category suggestions dropdown (sorted by largest totals), keyboard navigation, clear button, localStorage persistence.
- Avg Out/Day metric card on the Summary.
- Recent Entries table shows Category (prefers saved one-letter code → name; falls back to the first word of description).
- FX breakdown is hidden for now.

Dev (proxies API to port 8090)
```powershell
npm install
npm run dev
```
Open http://localhost:5173. The Vite dev server proxies API requests to `http://localhost:8090`.

Build for production
```powershell
npm run build
```
When the Node server detects `dashboard-app/dist`, it will serve the built SPA automatically at `/` while keeping the legacy static UI at `/dashboard`.

Auth notes
- In production, the API requires an `Authorization: Bearer <token>` header. Set `DASHBOARD_AUTH_TOKEN` in the server `.env` and paste it into the SPA when prompted.
- In dev, if the server config leaves `dashboardAuthToken` empty, requests may pass without the header.

Categories (Parser v2)
- The system uses a fixed set of categories as the first word of the description:
	groceries (g), food (f), transport (t), bills (b), health (h), rent (r), misc (m), uncategorized (u)
- Toggle v2 in the server `.env` with `PARSER_VERSION=v2`.

## v1.1 (2025-09-27)
- Code-aware category display in Recent.
- Category filters/time series accept code or name.
