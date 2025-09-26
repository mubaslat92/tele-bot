const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
// sql.js can be an ESM package that uses top-level await in some versions.
// Import it dynamically inside create() to avoid require() failing when the
// environment contains ESM with top-level await.

const ensureDir = async (targetPath) => {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
};

class LedgerStore {
  static async create(filePath) {
    // Dynamic import to support sql.js ESM builds
    let initSqlJs;
    try {
      const mod = await import('sql.js');
      initSqlJs = mod.default || mod;
    } catch (e) {
      // fallback to require for older environments
      initSqlJs = require('sql.js');
    }
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, "../node_modules/sql.js/dist", file),
    });
    await ensureDir(filePath);

    let db;
    if (fs.existsSync(filePath)) {
      const fileBuffer = await fsp.readFile(filePath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    const store = new LedgerStore(SQL, db, filePath);
    store.#ensureSchema();
    await store.persist();
    return store;
  }

  constructor(SQL, db, filePath) {
    this.SQL = SQL;
    this.db = db;
    this.filePath = filePath;
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        code TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT,
        currency TEXT,
        created_at TEXT NOT NULL,
        base_amount_jod REAL,
        fx_rate_jod REAL,
        is_transfer INTEGER DEFAULT 0,
        is_income INTEGER DEFAULT 0,
        trip_id TEXT,
        location_lat REAL,
        location_lng REAL,
        attachment_path TEXT,
        ocr_text TEXT,
        voice_text TEXT,
        is_invoice INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_entries_chat_created
        ON entries (chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS fx_rates (
        date TEXT NOT NULL,
        currency TEXT NOT NULL,
        to_jod REAL NOT NULL,
        PRIMARY KEY (date, currency)
      );

      CREATE TABLE IF NOT EXISTS budgets (
        chat_id TEXT,
        category TEXT NOT NULL,
        cap_jod REAL NOT NULL,
        PRIMARY KEY (chat_id, category)
      );

      CREATE TABLE IF NOT EXISTS recurring (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        cron TEXT NOT NULL,
        code TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT,
        description TEXT
      );
    `);
    // Defensive ALTERs for older databases missing new columns
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN base_amount_jod REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN fx_rate_jod REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN is_transfer INTEGER DEFAULT 0;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN is_income INTEGER DEFAULT 0;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN trip_id TEXT;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN location_lat REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN location_lng REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN attachment_path TEXT;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN ocr_text TEXT;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN voice_text TEXT;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN is_invoice INTEGER DEFAULT 0;`); } catch (_) {}

    // New tables for trips and invoices
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        name TEXT,
        started_at TEXT,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        file_path TEXT,
        vendor TEXT,
        total REAL,
        created_at TEXT
      );
      
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        vendor TEXT,
        total REAL,
        currency TEXT,
        date TEXT,
        method TEXT,
        note TEXT,
        accepted INTEGER DEFAULT 0,
        applied INTEGER DEFAULT 0,
        rejected INTEGER DEFAULT 0
      );
    `);
  }

  async addSuggestion({ entryId, createdAt, vendor, total, currency, date, method, note }) {
    const stmt = this.db.prepare(`
      INSERT INTO suggestions (entry_id, created_at, vendor, total, currency, date, method, note, accepted, applied, rejected)
      VALUES (:entry, :created, :vendor, :total, :currency, :date, :method, :note, 0, 0, 0)
    `);
    stmt.run({ ':entry': entryId, ':created': createdAt || new Date().toISOString(), ':vendor': vendor || null, ':total': (typeof total === 'number') ? total : (total ? Number(total) : null), ':currency': currency || null, ':date': date || null, ':method': method || null, ':note': note || null });
    stmt.free();
    const id = this.db.exec("SELECT last_insert_rowid() as id")?.[0]?.values?.[0]?.[0] ?? null;
    await this.persist();
    return { id, entryId, createdAt, vendor, total, currency, date, method, note };
  }

  getSuggestions(entryId) {
    let stmt;
    if (entryId) {
      stmt = this.db.prepare(`SELECT id, entry_id as entryId, created_at as createdAt, vendor, total, currency, date, method, note, accepted, applied, rejected FROM suggestions WHERE entry_id = :entry ORDER BY created_at DESC`);
      stmt.bind({ ':entry': entryId });
    } else {
      stmt = this.db.prepare(`SELECT id, entry_id as entryId, created_at as createdAt, vendor, total, currency, date, method, note, accepted, applied, rejected FROM suggestions ORDER BY created_at DESC`);
    }
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  getSuggestionById(id) {
    const stmt = this.db.prepare(`SELECT id, entry_id as entryId, created_at as createdAt, vendor, total, currency, date, method, note, accepted, applied, rejected FROM suggestions WHERE id = :id`);
    stmt.bind({ ':id': id });
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  async applySuggestion(id) {
    const s = this.getSuggestionById(id);
    if (!s) throw new Error('Suggestion not found');
    const entryId = s.entryId;
    // Update the entries row with suggested fields
    const upd = this.db.prepare(`UPDATE entries SET amount = :amt, currency = :cur, description = :desc WHERE id = :id`);
    // sql.js bindings must not be undefined; use null for missing values
    const bindCur = (s.currency === null || s.currency === undefined) ? null : s.currency;
    const bindDesc = (s.vendor === null || s.vendor === undefined) ? null : s.vendor;
    const bindAmt = (s.total === null || s.total === undefined) ? null : s.total;
    upd.run({ ':amt': bindAmt, ':cur': bindCur, ':desc': bindDesc, ':id': entryId });
    upd.free();
    // Mark suggestion as accepted/applied
    const stmt = this.db.prepare(`UPDATE suggestions SET accepted = 1, applied = 1 WHERE id = :id`);
    stmt.run({ ':id': id });
    stmt.free();
    await this.persist();
    return this.getSuggestionById(id);
  }

  async rejectSuggestion(id) {
    const s = this.getSuggestionById(id);
    if (!s) throw new Error('Suggestion not found');
    const stmt = this.db.prepare(`UPDATE suggestions SET rejected = 1 WHERE id = :id`);
    stmt.run({ ':id': id });
    stmt.free();
    await this.persist();
    return this.getSuggestionById(id);
  }

  async persist() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    await fsp.writeFile(this.filePath, buffer);
  }

  // Reload the in-memory sql.js database from the on-disk file.
  // Call this when another process (worker) may have updated the file.
  async reloadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) return false;
      const fileBuffer = await fsp.readFile(this.filePath);
      // Create a fresh Database instance from the file buffer
      this.db = new this.SQL.Database(fileBuffer);
      // Ensure schema in case of older DBs
      this.#ensureSchema();
      return true;
    } catch (e) {
      console.error('Failed to reload DB from disk:', e?.message || e);
      return false;
    }
  }

  getFxRateOn(dateIso, currency) {
    if (!currency || currency.toUpperCase() === "JOD") return 1;
    const d = new Date(dateIso);
    if (Number.isNaN(d.getTime())) return null;
    const keyDate = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const stmt = this.db.prepare(`
      SELECT to_jod FROM fx_rates
      WHERE currency = :c AND date <= :d
      ORDER BY date DESC
      LIMIT 1
    `);
    stmt.bind({ ":c": currency.toUpperCase(), ":d": keyDate });
    const rate = stmt.step() ? stmt.getAsObject().to_jod : null;
    stmt.free();
    return typeof rate === "number" ? rate : null;
  }

  setFxRate(dateStr, currency, toJod) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO fx_rates (date, currency, to_jod)
      VALUES (:d, :c, :r)
    `);
    stmt.run({ ":d": dateStr, ":c": currency.toUpperCase(), ":r": toJod });
    stmt.free();
  }

  getFxRatesForDate(dateStr) {
    const stmt = this.db.prepare(`SELECT currency, to_jod as toJod FROM fx_rates WHERE date = :d ORDER BY currency ASC`);
    stmt.bind({ ":d": dateStr });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  setBudget(chatId, category, capJod) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO budgets (chat_id, category, cap_jod)
      VALUES (:chat, :cat, :cap)
    `);
    stmt.run({ ":chat": chatId || null, ":cat": category.toLowerCase(), ":cap": capJod });
    stmt.free();
  }

  getBudgets(chatId) {
    const rows = [];
    let stmt;
    if (chatId) {
      stmt = this.db.prepare(`SELECT chat_id as chatId, category, cap_jod as capJod FROM budgets WHERE chat_id = :chat OR chat_id IS NULL`);
      stmt.bind({ ":chat": chatId });
    } else {
      stmt = this.db.prepare(`SELECT chat_id as chatId, category, cap_jod as capJod FROM budgets`);
    }
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async addEntry(entry) {
    const stmt = this.db.prepare(`
      INSERT INTO entries (chat_id, user_id, code, amount, description, currency, created_at, base_amount_jod, fx_rate_jod, is_transfer, is_income, trip_id, location_lat, location_lng, attachment_path, ocr_text, voice_text, is_invoice)
      VALUES (:chat_id, :user_id, :code, :amount, :description, :currency, :created_at, :base_amount_jod, :fx_rate_jod, :is_transfer, :is_income, :trip_id, :location_lat, :location_lng, :attachment_path, :ocr_text, :voice_text, :is_invoice)
    `);

  const upCode = (entry.code || "").toUpperCase();
  const isTransfer = upCode === "XFER" ? 1 : 0;
  const incomeCodes = new Set(["INC","INCOME","SAL","SALARY","REV","REVENUE","PAY","BONUS"]);
  const isIncome = incomeCodes.has(upCode) ? 1 : 0;
    let rate = null;
    let baseJod = null;
    try {
      rate = this.getFxRateOn(entry.createdAt, entry.currency);
      if (typeof rate === "number") baseJod = (Number(entry.amount) || 0) * rate;
    } catch (_) {}

    stmt.run({
      ":chat_id": entry.chatId,
      ":user_id": entry.userId,
      ":code": entry.code,
      ":amount": entry.amount,
      ":description": entry.description || null,
      ":currency": entry.currency || null,
      ":created_at": entry.createdAt,
      ":base_amount_jod": baseJod,
      ":fx_rate_jod": rate,
      ":is_transfer": isTransfer,
      ":is_income": isIncome,
      ":trip_id": entry.tripId || null,
      ":location_lat": (typeof entry.locationLat === 'number') ? entry.locationLat : null,
      ":location_lng": (typeof entry.locationLng === 'number') ? entry.locationLng : null,
      ":attachment_path": entry.attachmentPath || null,
      ":ocr_text": entry.ocrText || null,
      ":voice_text": entry.voiceText || null,
      ":is_invoice": entry.isInvoice ? 1 : 0,
    });
    stmt.free();

    const idResult = this.db.exec("SELECT last_insert_rowid() as id");
    const id = idResult?.[0]?.values?.[0]?.[0] ?? null;

    await this.persist();

    return { id, ...entry };
  }

  getEntriesBetween(chatId, fromIso, toIso) {
    const stmt = this.db.prepare(`
      SELECT id, chat_id as chatId, user_id as userId, code, amount, description, currency, created_at as createdAt, is_transfer as is_transfer, is_income as is_income, trip_id as tripId, location_lat as locationLat, location_lng as locationLng, attachment_path as attachmentPath, ocr_text as ocrText, voice_text as voiceText, is_invoice as isInvoice
      FROM entries
      WHERE chat_id = :chat_id AND created_at BETWEEN :from AND :to
      ORDER BY created_at ASC
    `);

    const result = [];
    stmt.bind({
      ":chat_id": chatId,
      ":from": fromIso,
      ":to": toIso,
    });

    while (stmt.step()) {
      result.push(stmt.getAsObject());
    }

    stmt.free();
    return result;
  }

  getEntriesByTrip(tripId) {
    const stmt = this.db.prepare(`
      SELECT id, chat_id as chatId, user_id as userId, code, amount, description, currency, created_at as createdAt, is_transfer as is_transfer, is_income as is_income, trip_id as tripId, location_lat as locationLat, location_lng as locationLng, attachment_path as attachmentPath, ocr_text as ocrText, voice_text as voiceText, is_invoice as isInvoice
      FROM entries
      WHERE trip_id = :trip
      ORDER BY created_at ASC
    `);
    stmt.bind({ ':trip': tripId });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // helper: last entry timestamp per chat
  getLastEntryTimestamp(chatId) {
    const stmt = this.db.prepare(`SELECT created_at as createdAt FROM entries WHERE chat_id = :chat ORDER BY created_at DESC LIMIT 1`);
    stmt.bind({ ':chat': chatId });
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? String(row.createdAt) : null;
  }

  // Trips
  async addTrip({ chatId, name, startedAt, endedAt }) {
    const stmt = this.db.prepare(`
      INSERT INTO trips (chat_id, name, started_at, ended_at)
      VALUES (:chat, :name, :start, :end)
    `);
    stmt.run({ ':chat': chatId, ':name': name || null, ':start': startedAt || null, ':end': endedAt || null });
    stmt.free();
    const id = this.db.exec("SELECT last_insert_rowid() as id")?.[0]?.values?.[0]?.[0] ?? null;
    await this.persist();
    return { id, chatId, name, startedAt, endedAt };
  }

  getTrips(chatId) {
    const stmt = this.db.prepare(`SELECT id, chat_id as chatId, name, started_at as startedAt, ended_at as endedAt FROM trips WHERE chat_id = :chat OR :chat = '' ORDER BY id DESC`);
    stmt.bind({ ':chat': chatId || '' });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // Invoices
  async addInvoice({ chatId, filePath, vendor, total, createdAt }) {
    const stmt = this.db.prepare(`
      INSERT INTO invoices (chat_id, file_path, vendor, total, created_at)
      VALUES (:chat, :file, :vendor, :total, :created)
    `);
    stmt.run({ ':chat': chatId, ':file': filePath || null, ':vendor': vendor || null, ':total': total || null, ':created': createdAt || null });
    stmt.free();
    const id = this.db.exec("SELECT last_insert_rowid() as id")?.[0]?.values?.[0]?.[0] ?? null;
    await this.persist();
    return { id, chatId, filePath, vendor, total, createdAt };
  }

  getInvoices(chatId) {
    const stmt = this.db.prepare(`SELECT id, chat_id as chatId, file_path as filePath, vendor, total, created_at as createdAt FROM invoices WHERE chat_id = :chat OR :chat = '' ORDER BY id DESC`);
    stmt.bind({ ':chat': chatId || '' });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  getDistinctChatIds() {
    const stmt = this.db.prepare("SELECT DISTINCT chat_id as chatId FROM entries");
    const chats = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      chats.push(row.chatId);
    }

    stmt.free();
    return chats;
  }

  getLastEntry(chatId, userId) {
    const stmt = this.db.prepare(`
      SELECT id, chat_id as chatId, user_id as userId, code, amount, description, currency, created_at as createdAt
      FROM entries
      WHERE chat_id = :chat_id AND user_id = :user_id
      ORDER BY created_at DESC
      LIMIT 1
    `);

    stmt.bind({
      ":chat_id": chatId,
      ":user_id": userId,
    });

    const entry = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return entry;
  }

  getEntryById(id) {
    const stmt = this.db.prepare(`SELECT id, chat_id as chatId, user_id as userId, code, amount, description, currency, created_at as createdAt, attachment_path as attachmentPath, ocr_text as ocrText FROM entries WHERE id = :id`);
    stmt.bind({ ':id': id });
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  async deleteEntryById(id) {
    const stmt = this.db.prepare("DELETE FROM entries WHERE id = :id");
    stmt.run({ ":id": id });
    stmt.free();
    await this.persist();
  }

  async updateEntryById(id, { code, description, currency }) {
    // Fetch current row to allow recomputation
    const sel = this.db.prepare(`SELECT code, amount, currency, created_at FROM entries WHERE id = :id`);
    sel.bind({ ":id": id });
    const row = sel.step() ? sel.getAsObject() : null;
    sel.free();
    if (!row) return;

    const nextCode = (typeof code === "string" && code) ? code.toUpperCase() : String(row.code || "");
    const nextCurrency = (typeof currency === "string") ? currency.toUpperCase() : String(row.currency || "");
    const amount = Number(row.amount) || 0;
    const createdAt = String(row.created_at);

    const isTransfer = nextCode.toUpperCase() === "XFER" ? 1 : 0;
    const incomeCodes = new Set(["INC","INCOME","SAL","SALARY","REV","REVENUE","PAY","BONUS"]);
    const isIncome = incomeCodes.has(nextCode.toUpperCase()) ? 1 : 0;
    let rate = this.getFxRateOn(createdAt, nextCurrency);
    if (typeof rate !== "number") rate = 1;
    const baseJod = amount * rate;

    const fields = [];
    const params = { ":id": id, ":code": nextCode, ":desc": description, ":cur": nextCurrency, ":is_transfer": isTransfer, ":is_income": isIncome, ":fx": rate, ":base": baseJod };
    if (typeof code === "string" && code) fields.push("code = :code");
    if (typeof description === "string") fields.push("description = :desc");
    if (typeof currency === "string") fields.push("currency = :cur");
    // Always update derived flags and fx/base
    fields.push("is_transfer = :is_transfer");
    fields.push("is_income = :is_income");
    fields.push("fx_rate_jod = :fx");
    fields.push("base_amount_jod = :base");
    const sql = `UPDATE entries SET ${fields.join(", ")} WHERE id = :id`;
    const upd = this.db.prepare(sql);
    upd.run(params);
    upd.free();
    await this.persist();
  }

  // Recurring jobs
  async addRecurring(job) {
    const stmt = this.db.prepare(`
      INSERT INTO recurring (chat_id, user_id, cron, code, amount, currency, description)
      VALUES (:chat, :user, :cron, :code, :amount, :currency, :description)
    `);
    stmt.run({
      ":chat": job.chatId,
      ":user": job.userId || null,
      ":cron": job.cron,
      ":code": job.code,
      ":amount": job.amount,
      ":currency": job.currency || null,
      ":description": job.description || null,
    });
    stmt.free();
    const id = this.db.exec("SELECT last_insert_rowid() as id")?.[0]?.values?.[0]?.[0] ?? null;
    await this.persist();
    return { id, ...job };
  }

  getRecurring() {
    const stmt = this.db.prepare(`SELECT id, chat_id as chatId, user_id as userId, cron, code, amount, currency, description FROM recurring ORDER BY id ASC`);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async deleteRecurring(id) {
    const stmt = this.db.prepare("DELETE FROM recurring WHERE id = :id");
    stmt.run({ ":id": id });
    stmt.free();
    await this.persist();
  }
}

module.exports = LedgerStore;
