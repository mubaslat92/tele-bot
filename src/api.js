const express = require("express");
const path = require("path");
const cron = require("node-cron");
const fs = require('fs');
const child_process = require('child_process');

function currentMonthRange(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { year: y, month: m, startIso: start.toISOString(), endIso: end.toISOString() };
}

function parseMonthParam(monthStr) {
  if (!monthStr || monthStr === "current") return currentMonthRange();
  if (!/^\d{4}-\d{1,2}$/.test(monthStr)) return null;
  const [y, m] = monthStr.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || m < 1 || m > 12) return null;
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)); // last day of month
  return { year: y, month: m, startIso: start.toISOString(), endIso: end.toISOString() };
}

function getCategory(desc) {
  const s = (desc || "").trim();
  if (!s) return "uncategorized";
  return s.split(/\s+/)[0].toLowerCase();
}

// Derive category only from the description's first word (stable, independent of code)
function rowCategory(r) {
  return getCategory(r.description);
}

// Map between single-letter codes and canonical names and a helper for synonym matching
const CODE_TO_NAME = { g:'groceries', f:'food', t:'transport', b:'bills', h:'health', r:'rent', m:'misc', u:'uncategorized' };
const NAME_TO_CODE = Object.fromEntries(Object.entries(CODE_TO_NAME).map(([k,v]) => [v, k]));
function catSynonyms(c) {
  const lc = String(c || '').toLowerCase();
  const out = new Set([lc]);
  if (CODE_TO_NAME[lc]) out.add(CODE_TO_NAME[lc]); // if code provided, add name
  if (NAME_TO_CODE[lc]) out.add(NAME_TO_CODE[lc]); // if name provided, add code
  return out;
}

function isoWeekInfo(d) {
  // Copy date, set to UTC Thursday of current week to get ISO week
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday in current week decides the year
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diff = date - firstThursday;
  const week = 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
  const year = date.getUTCFullYear();
  return { year, week };
}

function authMiddleware(token) {
  // If no token configured, allow all (dev)
  if (!token) return (_req, _res, next) => next();
  return (req, res, next) => {
    const hdr = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    if (m && m[1] === token) return next();
    res.status(401).json({ error: "Unauthorized" });
  };
}

function createApiApp({ store, config }) {
  const app = express();
  try { console.log('API: createApiApp start'); } catch (_) {}
  app.use(express.json());
  // minimal CORS for dev
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const requireAuth = authMiddleware(config.dashboardAuthToken);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // DEV-ONLY: bulk seed entries for testing the dashboard
  app.post('/api/seed', requireAuth, async (req, res) => {
    try {
      if (String(process.env.NODE_ENV).toLowerCase() === 'production') {
        return res.status(403).json({ error: 'disabled in production' });
      }
      const { entries } = req.body || {};
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'entries[] required' });
      }
      let inserted = 0;
      for (const e of entries) {
        if (typeof e !== 'object' || e == null) continue;
        const amount = Number(e.amount);
        const description = typeof e.description === 'string' ? e.description : '';
        if (!Number.isFinite(amount) || !description) continue;
        const chatId = String(e.chatId || 'seed');
        const userId = String(e.userId || chatId);
        const createdAt = e.createdAt ? new Date(e.createdAt).toISOString() : new Date().toISOString();
        const currency = e.currency ? String(e.currency).toUpperCase() : 'JOD';
        const code = (e.code ? String(e.code) : 'F').toUpperCase();
        const entry = { chatId, userId, code, amount, currency, description, createdAt };
        await store.addEntry(entry);
        inserted++;
      }
      return res.json({ ok: true, inserted });
    } catch (e) {
      console.error('seed failed', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Serve report files for convenient linking
  app.use("/files", express.static(path.resolve(config.reportsDir)));

  // Dashboard UI:
  // If a new SPA build exists (dashboard-app/dist), serve it at both root (/) and /dashboard for backward compatibility.
  // Otherwise, fall back to the legacy static dashboard under public/dashboard at /dashboard.
  try {
    const spaDir = path.resolve(__dirname, "..", "dashboard-app", "dist");
    if (fs.existsSync(spaDir)) {
      // Serve SPA assets at root
      app.use(express.static(spaDir));
      app.get(["/", "/index.html"], (_req, res) => {
        res.sendFile(path.join(spaDir, "index.html"));
      });
      // Also serve SPA at /dashboard to replace the legacy UI
      app.use("/dashboard", express.static(spaDir));
    } else {
      // Legacy UI
      app.use(
        "/dashboard",
        express.static(path.resolve(__dirname, "..", "public", "dashboard")),
      );
    }
  } catch (_) {
    // On any error, fall back to legacy UI
    app.use(
      "/dashboard",
      express.static(path.resolve(__dirname, "..", "public", "dashboard")),
    );
  }

  // Debug: list registered routes
  app.get('/api/routes', (_req, res) => {
    try {
      const routes = [];
      const stack = app._router && app._router.stack ? app._router.stack : [];
      for (const layer of stack) {
        if (layer.route && layer.route.path) {
          const methods = Object.keys(layer.route.methods || {}).filter(Boolean);
          routes.push({ path: layer.route.path, methods });
        }
      }
      res.json({ routes });
    } catch (e) {
      res.json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/summary", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();

  let totalExpense = 0; // expenses: sum of amounts where is_income=0 (negatives reduce expense)
  let totalIncome = 0;  // income: sum of amounts where is_income=1
  let count = 0;
    const catTotals = new Map();
    const currencies = new Set();
    const fxBreakdown = new Map();

    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      for (const r of rows) {
        const amt = Number(r.amount) || 0;
        if (r.code && String(r.code).toUpperCase() === "XFER") continue; // don't count transfers
        // refunds: negative amounts lower total
        count += 1;
        if (r.is_income) totalIncome += amt; else totalExpense += amt;
        if (r.currency) currencies.add(r.currency);
  const cat = rowCategory(r);
        const targetMap = (r.is_income ? null : catTotals);
        if (targetMap) targetMap.set(cat, (targetMap.get(cat) || 0) + amt);
        const cur = (r.currency || "JOD").toUpperCase();
        fxBreakdown.set(cur, (fxBreakdown.get(cur) || 0) + Math.abs(amt));
      }
    }

    let topCategory = null;
    let topAmount = 0;
    for (const [k, v] of catTotals.entries()) {
      if (v > topAmount) { topAmount = v; topCategory = k; }
    }

    res.json({
      month: `${m.year}-${String(m.month).padStart(2, "0")}`,
      totalExpense,
      totalIncome,
      net: totalIncome + totalExpense,
      count,
      topCategory,
      currency: currencies.size === 1 ? Array.from(currencies)[0] : (currencies.size === 0 ? config.defaultCurrency : "mixed"),
      fx: Array.from(fxBreakdown.entries()).map(([currency, amount]) => ({ currency, amount })),
    });
  });

  // FX rates admin
  app.get("/api/fx", requireAuth, (req, res) => {
    const d = String(req.query.date || new Date().toISOString().slice(0, 10));
    const rows = store.getFxRatesForDate(d);
    res.json({ date: d, rates: rows });
  });
  app.post("/api/fx", requireAuth, express.json(), (req, res) => {
    const { date, rates } = req.body || {};
    if (!date || !Array.isArray(rates)) return res.status(400).json({ error: "Body must be { date, rates: [{ currency, toJod }] }" });
    for (const r of rates) {
      if (!r.currency || typeof r.toJod !== "number") continue;
      store.setFxRate(date, r.currency, r.toJod);
    }
    res.json({ ok: true });
  });

  // Budgets
  app.get("/api/budgets", requireAuth, (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const rows = store.getBudgets(chatId);
    res.json({ budgets: rows });
  });
  app.post("/api/budgets", requireAuth, express.json(), (req, res) => {
    const { chatId, category, capJod } = req.body || {};
    if (!category || typeof capJod !== "number") return res.status(400).json({ error: "Body must be { category, capJod, chatId? }" });
    store.setBudget(chatId || null, category, capJod);
    res.json({ ok: true });
  });

  app.get("/api/chats", requireAuth, (_req, res) => {
    const chats = store.getDistinctChatIds();
    let names = {};
    try {
      if (fs.existsSync(config.chatNamesPath)) {
        names = JSON.parse(fs.readFileSync(config.chatNamesPath, 'utf8')) || {};
      }
    } catch (_) {}
    const data = chats.map(id => ({ id, name: names[id] || id }));
    res.json({ chats: data });
  });

  app.get("/api/by-category", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    const totals = new Map();
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      for (const r of rows) {
        if (r.code && String(r.code).toUpperCase() === "XFER") continue;
        if (r.is_income) continue; // exclude income from expense categories chart
  const cat = rowCategory(r);
        totals.set(cat, (totals.get(cat) || 0) + (Number(r.amount) || 0));
      }
    }
    const data = Array.from(totals.entries()).map(([category, amount]) => ({ category, amount }));
    data.sort((a, b) => b.amount - a.amount);
    res.json({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, data });
  });

  app.get("/api/daily", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const category = req.query.category ? String(req.query.category).toLowerCase() : null;
    const catSet = category ? catSynonyms(category) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    const totals = new Map(); // date -> amount
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      for (const r of rows) {
        if (r.code && String(r.code).toUpperCase() === "XFER") continue;
        if (catSet && !catSet.has(rowCategory(r))) continue;
        const d = new Date(r.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const key = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        totals.set(key, (totals.get(key) || 0) + (Number(r.amount) || 0));
      }
    }
    const data = Array.from(totals.entries()).map(([date, amount]) => ({ date, amount }));
    data.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, data });
  });

  app.get("/api/weekly", requireAuth, (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const category = req.query.category ? String(req.query.category).toLowerCase() : null;
    const catSet = category ? catSynonyms(category) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let range;
    const mStr = req.query.month ? String(req.query.month) : "";
    const yStr = req.query.year ? String(req.query.year) : "";
    if (mStr) {
      range = parseMonthParam(mStr);
      if (!range) return res.status(400).json({ error: "month must be YYYY-MM" });
    } else {
      const y = parseInt(yStr || String(new Date().getUTCFullYear()), 10);
      if (!Number.isFinite(y)) return res.status(400).json({ error: "year must be a number" });
      const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0)).toISOString();
      const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)).toISOString();
      range = { year: y, month: null, startIso: start, endIso: end };
    }
    const totals = new Map(); // key yyyy-Www -> amount
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, range.startIso, range.endIso);
      for (const r of rows) {
        if (catSet && !catSet.has(rowCategory(r))) continue;
        const d = new Date(r.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const { year, week } = isoWeekInfo(d);
        const key = `${year}-W${String(week).padStart(2, "0")}`;
        totals.set(key, (totals.get(key) || 0) + (Number(r.amount) || 0));
      }
    }
    const data = Array.from(totals.entries()).map(([week, amount]) => ({ week, amount }));
    data.sort((a, b) => a.week.localeCompare(b.week));
    res.json({ scope: mStr ? { month: mStr } : { year: range.year }, data });
  });

  app.get("/api/yearly", requireAuth, (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    const startYear = req.query.start ? parseInt(String(req.query.start), 10) : null;
    const endYear = req.query.end ? parseInt(String(req.query.end), 10) : null;
    const fromIso = new Date(Date.UTC(startYear || 2000, 0, 1, 0, 0, 0, 0)).toISOString();
    const toIso = new Date(Date.UTC(endYear || new Date().getUTCFullYear(), 11, 31, 23, 59, 59, 999)).toISOString();
    const totals = new Map(); // year -> amount
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, fromIso, toIso);
      for (const r of rows) {
        const d = new Date(r.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const y = d.getUTCFullYear();
        totals.set(y, (totals.get(y) || 0) + (Number(r.amount) || 0));
      }
    }
    const data = Array.from(totals.entries()).map(([year, amount]) => ({ year, amount }));
    data.sort((a, b) => a.year - b.year);
    res.json({ data });
  });

  app.get("/api/monthly", requireAuth, (req, res) => {
    const year = parseInt(String(req.query.year || new Date().getUTCFullYear()), 10);
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const category = req.query.category ? String(req.query.category).toLowerCase() : null;
    const catSet = category ? catSynonyms(category) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    const out = [];
    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0, 0)).toISOString();
      const end = new Date(Date.UTC(year, m, 0, 23, 59, 59, 999)).toISOString();
      let sum = 0;
      for (const cid of chatIds) {
        const rows = store.getEntriesBetween(cid, start, end);
        for (const r of rows) {
          if (catSet && !catSet.has(rowCategory(r))) continue;
          sum += Number(r.amount) || 0;
        }
      }
      out.push({ month: `${year}-${String(m).padStart(2, "0")}`, amount: sum });
    }
    res.json({ year, data: out });
  });

  // Helper: month keys for last N months (ascending)
  function getLastNMonthsKeys(n) {
    const now = new Date();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }

  // Helper: aggregate monthly totals in base JOD per category
  function buildMonthlySeries({ months = 24, chatId = null, category = null }) {
    const monthKeys = getLastNMonthsKeys(months);
    const seriesByCat = new Map(); // cat -> Array(len=months)
    const chats = chatId ? [chatId] : store.getDistinctChatIds();
    const codeToName = { g:'groceries', f:'food', t:'transport', b:'bills', h:'health', r:'rent', m:'misc', u:'uncategorized' };
    const nameToCode = Object.fromEntries(Object.entries(codeToName).map(([k,v]) => [v,k]));
    const catSynonyms = (c) => {
      const lc = String(c||'').toLowerCase();
      const out = new Set([lc]);
      if (codeToName[lc]) out.add(codeToName[lc]);
      if (nameToCode[lc]) out.add(nameToCode[lc]);
      return out;
    };
    const filterSet = (category && category !== 'all') ? catSynonyms(category) : null;
    // prefill
    if (filterSet) seriesByCat.set(String(category).toLowerCase(), Array(months).fill(0));
    for (let idx = 0; idx < months; idx++) {
      const key = monthKeys[idx];
      const p = parseMonthParam(key);
      for (const cid of chats) {
        const rows = store.getEntriesBetween(cid, p.startIso, p.endIso);
        for (const r of rows) {
          // Exclude transfers and income for expense forecasting
          const code = String(r.code || '').toUpperCase();
          if (code === 'XFER' || r.is_income) continue;
          const cat = getCategory(r.description);
          if (filterSet && !filterSet.has(String(cat||'').toLowerCase())) continue;
          // Base JOD amount
          const base = (typeof r.base_amount_jod === 'number' && !Number.isNaN(r.base_amount_jod))
            ? r.base_amount_jod
            : ((r.currency || 'JOD').toUpperCase() === 'JOD'
                ? (Number(r.amount) || 0)
                : (Number(r.amount) || 0) * (store.getFxRateOn(r.createdAt, r.currency) || 1));
          const keyOut = filterSet ? String(category).toLowerCase() : cat;
          if (!seriesByCat.has(keyOut)) seriesByCat.set(keyOut, Array(months).fill(0));
          seriesByCat.get(keyOut)[idx] += base;
        }
      }
    }
    return { months: monthKeys, seriesByCat };
  }

  // Linear regression forecast and CI bands
  function lrForecast(series, h = 1) {
    const n = series.length;
    if (n < 6) return { ok: false, reason: 'insufficient_history' };
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = series[i];
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const denom = (n * sumXX - sumX * sumX);
    if (denom === 0) return { ok: false, reason: 'degenerate_series' };
    const b = (n * sumXY - sumX * sumY) / denom;
    const a = (sumY - b * sumX) / n;
    const yhat = series.map((_, i) => a + b * i);
    const residuals = series.map((y, i) => y - yhat[i]);
    const sse = residuals.reduce((s, e) => s + e * e, 0);
    const sigma = Math.sqrt(sse / Math.max(1, n - 2)); // std error
  const nextX = n + (h - 1);
  const forecast = a + b * nextX;
    // naive CI assuming homoskedasticity
    const ci80 = [forecast - 1.2816 * sigma, forecast + 1.2816 * sigma];
    const ci95 = [forecast - 1.96 * sigma, forecast + 1.96 * sigma];
    return { ok: true, method: 'lr', a, b, forecast, ci80, ci95, sigma, h };
  }

  // Holt-Winters additive (monthly seasonality m=12)
  function hwForecast(series, opts = {}) {
    const m = 12;
    const n = series.length;
    if (n < 2 * m) return { ok: false, reason: 'insufficient_history' };
    const alphas = opts.alphas || [0.2, 0.3, 0.4];
    const betas = opts.betas || [0.1, 0.2];
    const gammas = opts.gammas || [0.1, 0.2, 0.3];
    const h = Math.max(1, Math.min(12, opts.h || 1));

    function initSeasonals(y) {
      const seasonals = new Array(m).fill(0);
      const seasons = Math.floor(n / m);
      const avgPerSeason = [];
      for (let s = 0; s < seasons; s++) {
        const start = s * m;
        let sum = 0; for (let i = 0; i < m; i++) sum += y[start + i];
        avgPerSeason.push(sum / m);
      }
      for (let i = 0; i < m; i++) {
        let acc = 0;
        for (let s = 0; s < seasons; s++) {
          acc += y[s * m + i] - avgPerSeason[s];
        }
        seasonals[i] = acc / seasons;
      }
      const overallMean = y.reduce((s, x) => s + x, 0) / n;
      // normalize to zero-mean additive seasonals
      const meanSeason = seasonals.reduce((s, x) => s + x, 0) / m;
      for (let i = 0; i < m; i++) seasonals[i] = seasonals[i] - meanSeason;
      const L0 = y[0] - seasonals[0];
      let T0 = 0;
      // trend init by average change per season
      let cnt = 0, sum = 0;
      for (let i = 0; i < n - m; i++) { sum += (y[i + m] - y[i]) / m; cnt++; }
      T0 = cnt ? (sum / cnt) : 0;
      return { L0, T0, S0: seasonals };
    }

    function runHW(y, alpha, beta, gamma) {
      const { L0, T0, S0 } = initSeasonals(y);
      const L = new Array(n).fill(0);
      const T = new Array(n).fill(0);
      const S = new Array(n).fill(0);
      // seed
      L[0] = L0; T[0] = T0; for (let i = 0; i < m; i++) S[i] = S0[i];
      const yhat = new Array(n).fill(0);
      yhat[0] = L[0] + T[0] + S[0];
      for (let t = 1; t < n; t++) {
        const sIdx = t - m >= 0 ? t - m : (t % m);
        const Stm = t - m >= 0 ? S[t - m] : S0[sIdx];
        // level
        L[t] = alpha * (y[t] - Stm) + (1 - alpha) * (L[t - 1] + T[t - 1]);
        // trend
        T[t] = beta * (L[t] - L[t - 1]) + (1 - beta) * T[t - 1];
        // seasonal
        S[t] = gamma * (y[t] - L[t]) + (1 - gamma) * Stm;
        yhat[t] = L[t - 1] + T[t - 1] + Stm; // one-step-ahead fitted
      }
      const residuals = y.map((val, i) => val - yhat[i]);
      const sse = residuals.reduce((s, e) => s + e * e, 0);
      const sigma = Math.sqrt(sse / Math.max(1, n - 3));
      // 1-step forecast (next month)
  // seasonal component index for h-step ahead: use S[n - m + ((h - 1) % m)]
  const sIdx = (n - m + ((h - 1) % m));
  const Stm = sIdx >= 0 ? S[sIdx] : S0[((h - 1) % m)];
  const forecast = L[n - 1] + h * T[n - 1] + Stm;
      const ci80 = [forecast - 1.2816 * sigma, forecast + 1.2816 * sigma];
      const ci95 = [forecast - 1.96 * sigma, forecast + 1.96 * sigma];
      return { L, T, S, yhat, residuals, sse, sigma, forecast };
    }

    let best = null;
    for (const a of alphas) for (const b of betas) for (const g of gammas) {
      const out = runHW(series, a, b, g);
      if (!best || out.sse < best.sse) best = { ...out, alpha: a, beta: b, gamma: g };
    }
    if (!best) return { ok: false, reason: 'fit_failed' };
    return {
      ok: true,
      method: 'hw',
      alpha: best.alpha, beta: best.beta, gamma: best.gamma,
      forecast: best.forecast,
      ci80: [best.forecast - 1.2816 * best.sigma, best.forecast + 1.2816 * best.sigma],
      ci95: [best.forecast - 1.96 * best.sigma, best.forecast + 1.96 * best.sigma],
      sigma: best.sigma,
      h,
    };
  }

  // Simple ping to verify route registration path is reachable
  app.get('/api/forecast/ping', (_req, res) => {
    res.json({ ok: true });
  });

  // Forecast endpoint
  app.get('/api/forecast', requireAuth, async (req, res) => {
    try {
      if (config.forecastingEnabled === false) {
        return res.status(403).json({ error: 'forecasting disabled' });
      }
      const chatId = req.query.chatId ? String(req.query.chatId) : null;
      const category = req.query.category ? String(req.query.category).toLowerCase() : 'all';
      const months = Math.max(3, Math.min(60, parseInt(String(req.query.months || 24), 10)));
  const method = String(req.query.method || config.forecastMethod || 'auto').toLowerCase();
  const h = Math.max(1, Math.min(12, parseInt(String(req.query.h || 1), 10)));
      const { months: monthKeys, seriesByCat } = buildMonthlySeries({ months, chatId, category });
      const targets = category && category !== 'all' ? [category] : Array.from(seriesByCat.keys());
      const results = [];
      for (const cat of targets) {
        const series = seriesByCat.get(cat) || Array(months).fill(0);
        let out;
        if (method === 'lr') out = lrForecast(series, h);
        else if (method === 'hw') out = hwForecast(series, { h });
        else {
          out = series.length >= 24 ? hwForecast(series, { h }) : lrForecast(series, h);
          if (!out.ok && out.reason === 'insufficient_history') out = lrForecast(series, h);
        }
        results.push({ category: cat, months: monthKeys, history: series, ...out });
      }
      res.json({ unit: 'JOD', h, results });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  try { console.log('API: /api/forecast route registered'); } catch (_) {}

  function rollingMeanStd(arr) {
    const n = arr.length;
    if (n === 0) return { mean: 0, std: 0 };
    const mean = arr.reduce((s, x) => s + x, 0) / n;
    const varr = arr.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, n - 1);
    return { mean, std: Math.sqrt(varr) };
  }

  // Anomaly detection endpoint
  app.get('/api/anomalies', requireAuth, (req, res) => {
    try {
      if (config.anomalyDetectionEnabled === false) {
        return res.status(403).json({ error: 'anomaly detection disabled' });
      }
      const chatId = req.query.chatId ? String(req.query.chatId) : null;
      const category = req.query.category ? String(req.query.category).toLowerCase() : 'all';
      const months = Math.max(6, Math.min(60, parseInt(String(req.query.months || 24), 10)));
      const window = Math.max(3, Math.min(24, parseInt(String(req.query.window || 12), 10)));
      const zThresh = Number(req.query.z || 3.0);
      const { months: monthKeys, seriesByCat } = buildMonthlySeries({ months, chatId, category });
      const targets = category && category !== 'all' ? [category] : Array.from(seriesByCat.keys());
      const anomalies = [];
      for (const cat of targets) {
        const series = seriesByCat.get(cat) || Array(months).fill(0);
        for (let i = window; i < months; i++) {
          const hist = series.slice(i - window, i);
          const { mean, std } = rollingMeanStd(hist);
          const actual = series[i];
          const expected = mean;
          const z = std > 0 ? (actual - expected) / std : 0;
          if (std > 0 && Math.abs(z) >= zThresh) {
            anomalies.push({ category: cat, month: monthKeys[i], actual, expected, z, method: 'zscore' });
          }
          // domain rule for bills-like spikes (category 'b' or starts with 'b')
          if (cat === 'b' || cat === 'bills') {
            const median = [...hist].sort((a,b)=>a-b)[Math.floor(hist.length/2)] || 0;
            if (median > 0 && actual >= 1.8 * median) {
              anomalies.push({ category: cat, month: monthKeys[i], actual, expected: median, z: null, method: 'rule', note: 'bills>1.8x median' });
            }
          }
        }
      }
      anomalies.sort((a, b) => String(a.month).localeCompare(String(b.month)));
      res.json({ unit: 'JOD', anomalies });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  try { console.log('API: /api/anomalies route registered'); } catch (_) {}

  app.get("/api/entries", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit || 100), 10)));
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const category = req.query.category ? String(req.query.category).toLowerCase() : null;
    const catSet = category ? catSynonyms(category) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let rowsAll = [];
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      rowsAll = rowsAll.concat(rows);
    }
    if (catSet) rowsAll = rowsAll.filter((r) => catSet.has(rowCategory(r)));
    rowsAll.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, data: rowsAll.slice(0, limit) });
  });

  // Export entries for a month (CSV or XLSX)
  app.get('/api/export', requireAuth, async (req, res) => {
    const monthStr = String(req.query.month || '');
    const startStr = req.query.start ? String(req.query.start) : null;
    const endStr = req.query.end ? String(req.query.end) : null;
    let range = null;
    if (startStr && endStr) {
      const s = parseMonthParam(startStr);
      const e = parseMonthParam(endStr);
      if (!s || !e) return res.status(400).json({ error: 'start/end must be YYYY-MM' });
      range = { startIso: s.startIso, endIso: e.endIso, label: `${startStr}_to_${endStr}` };
    } else {
      const m = parseMonthParam(monthStr);
      if (!m) return res.status(400).json({ error: 'month must be YYYY-MM' });
      range = { startIso: m.startIso, endIso: m.endIso, label: `${m.year}-${String(m.month).padStart(2,'0')}` };
    }
    const format = String(req.query.format || 'csv').toLowerCase();
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const category = req.query.category ? String(req.query.category).toLowerCase() : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let rowsAll = [];
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, range.startIso, range.endIso);
      rowsAll = rowsAll.concat(rows);
    }
  const catSet = category ? catSynonyms(category) : null;
  if (catSet) rowsAll = rowsAll.filter((r) => catSet.has(rowCategory(r)));
    rowsAll.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const baseName = `ledger_${range.label}${chatId ? '_' + chatId : ''}${category ? '_' + category : ''}`;
    if (format === 'xlsx') {
      try {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Ledger');
        sheet.columns = [
          { header: 'Date', key: 'date', width: 20 },
          { header: 'Code', key: 'code', width: 10 },
          { header: 'Amount', key: 'amount', width: 12 },
          { header: 'Currency', key: 'currency', width: 10 },
          { header: 'Description', key: 'description', width: 50 },
          { header: 'ChatId', key: 'chatId', width: 18 },
        ];
        for (const e of rowsAll) {
          sheet.addRow({ date: e.createdAt, code: e.code, amount: e.amount, currency: e.currency || '', description: e.description || '', chatId: e.chat_id || e.chatId || '' });
        }
        const fname = `${baseName}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        await workbook.xlsx.write(res);
        res.end();
      } catch (e) {
        res.status(500).json({ error: e?.message || String(e) });
      }
      return;
    }
    // CSV default
    try {
      const lines = [];
      lines.push(['Date','Code','Amount','Currency','Description','ChatId'].join(','));
      for (const e of rowsAll) {
        const cols = [
          String(e.createdAt || ''),
          String(e.code || ''),
          String(e.amount || ''),
          String(e.currency || ''),
          '"' + String(e.description || '').replace(/"/g,'""') + '"',
          String(e.chat_id || e.chatId || ''),
        ];
        lines.push(cols.join(','));
      }
      const csv = lines.join('\n');
      const fname = `${baseName}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Daily summary endpoint (per chat optional)
  app.get('/api/daily-summary', requireAuth, (req, res) => {
    const date = String(req.query.date || new Date().toISOString().slice(0,10)); // YYYY-MM-DD
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const start = new Date(date + 'T00:00:00Z').toISOString();
    const end = new Date(date + 'T23:59:59.999Z').toISOString();
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let expense = 0, income = 0;
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, start, end);
      for (const r of rows) {
        if (String(r.code || '').toUpperCase() === 'XFER') continue;
        if (r.is_income) income += Number(r.amount) || 0; else expense += Number(r.amount) || 0;
      }
    }
    res.json({ date, expense, income, net: income + expense });
  });

  // End-of-month summary (extra structured for emailing/export)
  // Mobile: minimal entry creation for quick-add
  app.post('/api/mobile/entry', requireAuth, express.json(), async (req, res) => {
    try {
  const { amount, currency, description, createdAt, chatId, code } = req.body || {};
      const amt = Number(amount);
      if (!Number.isFinite(amt)) return res.status(400).json({ error: 'amount required' });
      const desc = typeof description === 'string' ? description : '';
      if (!desc) return res.status(400).json({ error: 'description required' });
      const cur = (currency || 'JOD').toString().toUpperCase();
      const at = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();
      // Default to a stable "mobile" chat when not provided
      const cid = chatId ? String(chatId) : (req.query.chatId ? String(req.query.chatId) : 'mobile');
      const uid = 'mobile';
  const entry = { chatId: cid, userId: uid, code: (code ? String(code).toUpperCase() : 'F'), amount: amt, currency: cur, description: desc, createdAt: at };
      const saved = await store.addEntry(entry);
      res.json({ ok: true, entry: saved || entry });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  app.get('/api/end-of-month', requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ''));
    if (!m) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let expense = 0, income = 0;
    const byCode = new Map();
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      for (const r of rows) {
        if (String(r.code || '').toUpperCase() === 'XFER') continue;
        const amt = Number(r.amount) || 0;
        if (r.is_income) income += amt; else expense += amt;
        const key = r.code || 'OTHER';
        byCode.set(key, (byCode.get(key) || 0) + amt);
      }
    }
    res.json({ month: `${m.year}-${String(m.month).padStart(2,'0')}`, expense, income, net: income + expense, byCode: Array.from(byCode.entries()).map(([k,v]) => ({ code:k, amount:v })) });
  });

  // Trips CRUD
  app.get('/api/trips', requireAuth, (req, res) => { const chatId = req.query.chatId ? String(req.query.chatId) : null; res.json({ data: store.getTrips(chatId) }); });
  app.post('/api/trips', requireAuth, express.json(), async (req, res) => { const { chatId, name, startedAt, endedAt } = req.body || {}; if (!chatId) return res.status(400).json({ error: 'chatId required' }); try { const t = await store.addTrip({ chatId, name, startedAt, endedAt }); res.json({ ok: true, trip: t }); } catch (e) { res.status(500).json({ error: e?.message || String(e) }); } });

  // Invoices endpoints
  app.get('/api/invoices', requireAuth, (req, res) => { const chatId = req.query.chatId ? String(req.query.chatId) : null; res.json({ data: store.getInvoices(chatId) }); });
  app.post('/api/invoices', requireAuth, express.json(), async (req, res) => { const { chatId, filePath, vendor, total, createdAt } = req.body || {}; if (!chatId || !filePath) return res.status(400).json({ error: 'chatId and filePath required' }); try { const inv = await store.addInvoice({ chatId, filePath, vendor, total, createdAt }); res.json({ ok: true, invoice: inv }); } catch (e) { res.status(500).json({ error: e?.message || String(e) }); } });

  // Receipt upload placeholder (multipart handling/actual file storage left to server config)
  app.post('/api/receipts', requireAuth, (req, res) => {
    // For now we expect JSON with { chatId, entryId?, filePath, ocrText?, vendor?, total? }
    const { chatId, entryId, filePath, ocrText, vendor, total } = req.body || {};
    if (!chatId || !filePath) return res.status(400).json({ error: 'chatId and filePath required' });
    if (entryId) {
      // attach to an existing entry
      store.updateEntryById(Number(entryId), { })
        .then(async () => {
          // update attachment and ocr fields directly in DB for now
          const stmt = store.db.prepare('UPDATE entries SET attachment_path = :f, ocr_text = :o, is_invoice = :inv WHERE id = :id');
          stmt.run({ ':f': filePath, ':o': ocrText || null, ':inv': vendor ? 1 : 0, ':id': Number(entryId) });
          stmt.free();
          await store.persist();
          return res.json({ ok: true });
        }).catch(e => res.status(500).json({ error: e?.message || String(e) }));
    } else {
      // create a new entry marked as invoice/attachment with OCR text
      const now = new Date().toISOString();
      store.addEntry({ chatId, userId: chatId, code: vendor ? 'INV' : 'RCPT', amount: total || 0, currency: 'JOD', description: vendor || 'attachment', createdAt: now, attachmentPath: filePath, ocrText: ocrText || null, isInvoice: !!vendor })
        .then(() => res.json({ ok: true }))
        .catch(e => res.status(500).json({ error: e?.message || String(e) }));
    }
  });

  // Trip report export (XLSX)
  app.get('/api/trip-report', requireAuth, async (req, res) => {
    const tripId = req.query.tripId ? String(req.query.tripId) : null;
    if (!tripId) return res.status(400).json({ error: 'tripId required' });
    const tripRows = store.getEntriesByTrip(tripId);
    if (!tripRows || !tripRows.length) return res.status(404).json({ error: 'no entries for trip' });
    try {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Trip');
      sheet.columns = [
        { header: 'Date', key: 'date', width: 20 },
        { header: 'Code', key: 'code', width: 10 },
        { header: 'Amount', key: 'amount', width: 12 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Location', key: 'loc', width: 20 },
      ];
      for (const e of tripRows) {
        sheet.addRow({ date: e.createdAt, code: e.code, amount: e.amount, currency: e.currency || '', description: e.description || '', loc: (e.locationLat ? `${e.locationLat},${e.locationLng}` : '') });
      }
      const fname = `trip_${tripId}_${new Date().toISOString().slice(0,10)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // What-if simulator
  app.post('/api/whatif', requireAuth, express.json(), (req, res) => {
    // Body: { months: number, changes: [{ category, pct }] }
    const { months = 6, changes = [] } = req.body || {};
    // Simple model: compute current average monthly spend per category, apply percentage changes, project months
    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const end = new Date(Date.UTC(year, month, 0, 23,59,59,999)).toISOString();
    const chatIds = store.getDistinctChatIds();
    const spentByCat = new Map();
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, start, end);
      for (const r of rows) {
        if (r.is_income) continue;
        const cat = getCategory(r.description);
        spentByCat.set(cat, (spentByCat.get(cat) || 0) + (Number(r.amount) || 0));
      }
    }
    const results = [];
    for (const [cat, amt] of spentByCat.entries()) {
      const avg = amt; // using current month as baseline for simplicity
      const change = changes.find(c => c.category === cat) || null;
      const pct = change ? (change.pct / 100) : 0;
      const newMonthly = avg * (1 - pct);
      const saved = (avg - newMonthly) * months;
      results.push({ category: cat, baselineMonthly: avg, newMonthly, savedOverMonths: saved });
    }
    const totalSaved = results.reduce((s,x) => s + (x.savedOverMonths || 0), 0);
    res.json({ months, results, totalSaved });
  });

  // Category correlations (simple pairwise Pearson on monthly series) - placeholder naive impl
  app.get('/api/correlations', requireAuth, (req, res) => {
    // Build monthly series for last 12 months per category
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`);
    }
    const catSeries = {};
    for (const m of months) {
      const p = parseMonthParam(m);
      const rows = [].concat(...store.getDistinctChatIds().map(cid => store.getEntriesBetween(cid, p.startIso, p.endIso)));
      for (const r of rows) {
        if (r.is_income) continue;
        const cat = getCategory(r.description);
        const key = cat;
        catSeries[key] = catSeries[key] || [];
        // accumulate by month index
        const idx = months.indexOf(m);
        while (catSeries[key].length <= idx) catSeries[key].push(0);
        catSeries[key][idx] += Number(r.amount) || 0;
      }
    }
    const cats = Object.keys(catSeries);
    const corr = [];
    const pearson = (a,b) => {
      const n = Math.min(a.length,b.length);
      if (n === 0) return 0;
      const ma = a.reduce((s,x)=>s+x,0)/n; const mb = b.reduce((s,x)=>s+x,0)/n;
      let num=0, da=0, db=0;
      for (let i=0;i<n;i++) { const da_i = a[i]-ma; const db_i = b[i]-mb; num += da_i*db_i; da += da_i*da_i; db += db_i*db_i; }
      if (da===0 || db===0) return 0; return num/Math.sqrt(da*db);
    };
    for (let i=0;i<cats.length;i++) for (let j=i+1;j<cats.length;j++) {
      corr.push({ a: cats[i], b: cats[j], r: pearson(catSeries[cats[i]], catSeries[cats[j]]) });
    }
    res.json({ months, correlations: corr });
  });

  // Narrative summary (AI placeholder): returns a simple templated summary; can be swapped for AI call
  app.get('/api/narrative', requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || 'current'));
    if (!m) return res.status(400).json({ error: 'month must be YYYY-MM' });
    // compute top movements vs previous month for top categories
    const chats = store.getDistinctChatIds();
    const cur = {};
    const prevM = (()=>{ const d = new Date(Date.UTC(m.year, m.month-1, 1)); d.setUTCMonth(d.getUTCMonth()-1); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}` })();
    const prev = parseMonthParam(prevM);
    for (const cid of chats) {
      const rowsCur = store.getEntriesBetween(cid, m.startIso, m.endIso);
      const rowsPrev = store.getEntriesBetween(cid, prev.startIso, prev.endIso);
      const sumCur = {}; const sumPrev = {};
      for (const r of rowsCur) { if (r.is_income) continue; const c = getCategory(r.description); sumCur[c] = (sumCur[c]||0) + (Number(r.amount)||0); }
      for (const r of rowsPrev) { if (r.is_income) continue; const c = getCategory(r.description); sumPrev[c] = (sumPrev[c]||0) + (Number(r.amount)||0); }
      for (const k of Object.keys(sumCur)) { cur[k] = { cur: sumCur[k], prev: sumPrev[k] || 0 }; }
    }
    const items = Object.entries(cur).map(([cat, v]) => ({ category: cat, cur: v.cur, prev: v.prev, pct: v.prev? ((v.cur - v.prev)/Math.abs(v.prev))*100 : null }));
    items.sort((a,b)=> (b.pct||0) - (a.pct||0));
    const top = items.slice(0,3);
    const narrative = `This month: top changes: ${top.map(t=>`${t.category} ${t.pct? (Math.round(t.pct)) + '%': 'N/A'}`).join(', ')}.`;
    res.json({ narrative, items, month: `${m.year}-${String(m.month).padStart(2,'0')}` });
  });

  // Email send placeholder endpoint: expects { to, subject, body }
  app.post('/api/send-email', requireAuth, express.json(), (req, res) => {
    const { to, subject, body } = req.body || {};
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body required' });
    // Integration with SMTP or SES is left to deploy-time. For now, store request to disk as a record.
    try {
      const file = path.resolve(config.reportsDir, 'outgoing_emails.json');
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      existing.push({ to, subject, body, createdAt: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(existing, null, 2));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Update/Delete single entry
  app.patch("/api/entries/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const { code, description, currency } = req.body || {};
    store.updateEntryById(id, { code, description, currency })
      .then(() => res.json({ ok: true }))
      .catch((e) => res.status(500).json({ error: e?.message || String(e) }));
  });
  app.delete("/api/entries/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    store.deleteEntryById(id)
      .then(() => res.json({ ok: true }))
      .catch((e) => res.status(500).json({ error: e?.message || String(e) }));
  });

  // Budgets progress for a month
  app.get("/api/budgets/progress", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    const budgets = store.getBudgets(chatId || null); // includes global (null) and chat-specific
    const capByCat = new Map();
    for (const b of budgets) {
      if (b.chatId && chatId && b.chatId !== chatId) continue;
      capByCat.set(b.category.toLowerCase(), b.capJod);
    }
    const spentByCat = new Map();
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      for (const r of rows) {
        const code = String(r.code || "").toUpperCase();
        if (code === "XFER") continue;
        const cat = getCategory(r.description);
        const base = (typeof r.base_amount_jod === "number" && !Number.isNaN(r.base_amount_jod))
          ? r.base_amount_jod
          : ((r.currency || "JOD").toUpperCase() === "JOD" ? (Number(r.amount) || 0) : (Number(r.amount) || 0) * (store.getFxRateOn(r.createdAt, r.currency) || 1));
        spentByCat.set(cat, (spentByCat.get(cat) || 0) + base);
      }
    }
    const data = [];
    for (const [cat, cap] of capByCat.entries()) {
      const spent = spentByCat.get(cat) || 0;
      const pct = cap > 0 ? (spent / cap) * 100 : null;
      data.push({ category: cat, capJod: cap, spentJod: spent, percent: pct });
    }
    data.sort((a, b) => a.category.localeCompare(b.category));
    res.json({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, data });
  });

  // Uncategorized helper
  app.get("/api/uncategorized", requireAuth, (req, res) => {
    const m = parseMonthParam(String(req.query.month || ""));
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const chatIds = chatId ? [chatId] : store.getDistinctChatIds();
    let rowsAll = [];
    for (const cid of chatIds) {
      const rows = store.getEntriesBetween(cid, m.startIso, m.endIso);
      rowsAll = rowsAll.concat(rows.filter((r) => getCategory(r.description) === "uncategorized"));
    }
    rowsAll.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    res.json({ data: rowsAll });
  });

  // Recurring jobs
  const scheduled = new Map(); // id -> task
  function scheduleJob(job) {
    if (scheduled.has(job.id)) {
      try { scheduled.get(job.id).stop(); } catch (_) {}
      scheduled.delete(job.id);
    }
    const task = cron.schedule(job.cron, async () => {
      try {
        const createdAt = new Date().toISOString();
        await store.addEntry({
          chatId: job.chatId,
          userId: job.userId || job.chatId,
          code: job.code,
          amount: job.amount,
          currency: job.currency,
          description: job.description,
          createdAt,
        });
      } catch (e) {
        console.error("Recurring job failed", job.id, e);
      }
    }, { timezone: config.timezone });
    scheduled.set(job.id, task);
  }
  
  function loadRecurring() {
    const jobs = store.getRecurring();
    for (const j of jobs) scheduleJob(j);
  }
  loadRecurring();

  app.get("/api/recurring", requireAuth, (_req, res) => {
    res.json({ data: store.getRecurring() });
  });
  app.post("/api/recurring", requireAuth, (req, res) => {
    const { chatId, userId, cron: cronExp, code, amount, currency, description } = req.body || {};
    if (!chatId || !cronExp || !code || typeof amount !== "number") {
      return res.status(400).json({ error: "Body must be { chatId, cron, code, amount, currency?, description? }" });
    }
    store.addRecurring({ chatId, userId, cron: cronExp, code: String(code).toUpperCase(), amount, currency, description })
      .then((job) => { scheduleJob(job); res.json({ ok: true, job }); })
      .catch((e) => res.status(500).json({ error: e?.message || String(e) }));
  });
  app.delete("/api/recurring/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    store.deleteRecurring(id)
      .then(() => { if (scheduled.has(id)) { try { scheduled.get(id).stop(); } catch (_) {}; scheduled.delete(id); } res.json({ ok: true }); })
      .catch((e) => res.status(500).json({ error: e?.message || String(e) }));
  });

  // Serve attachments (downloaded by worker) for the dashboard to preview
  app.use('/attachments', express.static(path.resolve(__dirname, '..', 'data', 'attachments')));

  // Suggestions endpoints
  app.get('/api/suggestions', requireAuth, (req, res) => {
    try {
      const entryId = req.query.entryId ? Number(req.query.entryId) : null;
      const rows = store.getSuggestions(entryId);
      // enrich with entry data where possible
      const enriched = rows.map(s => {
        const entryStmt = store.db.prepare('SELECT id, chat_id as chatId, attachment_path as attachmentPath, ocr_text as ocrText, amount, currency, description, created_at as createdAt FROM entries WHERE id = :id');
        entryStmt.bind({ ':id': s.entryId });
        const ent = entryStmt.step() ? entryStmt.getAsObject() : null;
        entryStmt.free();
        if (ent && ent.attachmentPath) {
          // Use path.basename to handle Windows backslashes and full paths
          try {
            const fname = path.basename(String(ent.attachmentPath));
            ent.attachmentUrl = fname ? ('/attachments/' + encodeURIComponent(fname)) : null;
          } catch (_) { ent.attachmentUrl = null; }
        }
        return Object.assign({}, s, { entry: ent });
      });
      res.json({ data: enriched });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/suggestions/:id', requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
      const s = store.getSuggestionById(id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const entryStmt = store.db.prepare('SELECT id, chat_id as chatId, attachment_path as attachmentPath, ocr_text as ocrText, amount, currency, description, created_at as createdAt FROM entries WHERE id = :id');
      entryStmt.bind({ ':id': s.entryId });
      const ent = entryStmt.step() ? entryStmt.getAsObject() : null;
      entryStmt.free();
      if (ent && ent.attachmentPath) {
        try {
          const fname = path.basename(String(ent.attachmentPath));
          ent.attachmentUrl = fname ? ('/attachments/' + encodeURIComponent(fname)) : null;
        } catch (_) { ent.attachmentUrl = null; }
      }
      res.json({ suggestion: s, entry: ent });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Aliases management
  app.get('/api/aliases', requireAuth, (req, res) => {
    try {
      const { AliasStore, AICache } = require('./shared/aliases');
      const path = require('path');
      const cfg = require('./config');
      const aliases = AliasStore.load(cfg.aliasesPath).all();
      res.json({ data: aliases });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post('/api/aliases', requireAuth, express.json(), (req, res) => {
    try {
      const { alias, canonical } = req.body || {};
      if (!alias || !canonical) return res.status(400).json({ error: 'alias and canonical required' });
      const { AliasStore } = require('./shared/aliases');
      const cfg = require('./config');
      const store = AliasStore.load(cfg.aliasesPath);
  store.set(alias, canonical);
  res.json({ ok: true, alias: alias.toLowerCase(), canonical: canonical.toLowerCase(), note: 'Tip: Use one of g/f/t/b/h/r/m/u for first word categories.' });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.delete('/api/aliases/:alias', requireAuth, (req, res) => {
    try {
      const alias = String(req.params.alias || '');
      if (!alias) return res.status(400).json({ error: 'alias required' });
      const { AliasStore } = require('./shared/aliases');
      const cfg = require('./config');
      const store = AliasStore.load(cfg.aliasesPath);
      store.remove(alias);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Promote AI cache mapping to persistent alias (useful when AI maps 'rol'->'salary' and user wants override)
  app.post('/api/aliases/promote', requireAuth, express.json(), (req, res) => {
    try {
      const { token, canonical } = req.body || {};
      if (!token || !canonical) return res.status(400).json({ error: 'token and canonical required' });
      const { AliasStore, AICache } = require('./shared/aliases');
      const cfg = require('./config');
      const aliases = AliasStore.load(cfg.aliasesPath);
      const ai = AICache.load(cfg.aiCachePath);
      // optionally remove from AI cache
      ai.remove(token);
      aliases.set(token, canonical);
      res.json({ ok: true, promoted: { token: token.toLowerCase(), canonical: canonical.toLowerCase() } });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post('/api/suggestions/:id/apply', requireAuth, express.json(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
      const updated = await store.applySuggestion(id);
      // Optionally notify via Telegram: use config.telegramToken and entry chatId
      try {
        const s = store.getSuggestionById(id);
        const entryStmt = store.db.prepare('SELECT chat_id as chatId FROM entries WHERE id = :id');
        entryStmt.bind({ ':id': s.entryId });
        const ent = entryStmt.step() ? entryStmt.getAsObject() : null;
        entryStmt.free();
        if (ent && ent.chatId && config.telegramToken) {
          const axios = require('axios');
          const text = `Suggestion applied for entry ${s.entryId}: total=${s.total} ${s.currency || ''}`;
          await axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: ent.chatId, text });
        }
      } catch (_) {}
      res.json({ ok: true, suggestion: updated });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post('/api/suggestions/:id/reject', requireAuth, express.json(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
      const updated = await store.rejectSuggestion(id);
      try {
        const s = store.getSuggestionById(id);
        const entryStmt = store.db.prepare('SELECT chat_id as chatId FROM entries WHERE id = :id');
        entryStmt.bind({ ':id': s.entryId });
        const ent = entryStmt.step() ? entryStmt.getAsObject() : null;
        entryStmt.free();
        if (ent && ent.chatId && config.telegramToken) {
          const axios = require('axios');
          const text = `Suggestion rejected for entry ${s.entryId}.`;
          await axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: ent.chatId, text });
        }
      } catch (_) {}
      res.json({ ok: true, suggestion: updated });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Debug endpoints (protected by dashboard auth token)
  app.get('/debug/pending', requireAuth, (req, res) => {
    try {
      const file = path.join(__dirname, '..', 'data', 'pending_jobs.json');
      const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      res.json({ pending: list });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/debug/process_pending', requireAuth, (req, res) => {
    try {
      const script = path.resolve(__dirname, '..', 'scripts', 'process_pending_jobs.js');
      // spawn detached so it doesn't block the server
      const child = child_process.spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
      child.unref();
      res.json({ ok: true, started: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return app;
}

module.exports = { createApiApp };

