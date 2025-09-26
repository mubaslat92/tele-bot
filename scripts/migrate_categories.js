#!/usr/bin/env node
// Normalize historical entry descriptions to the fixed 7 categories.
// Usage:
//   node scripts/migrate_categories.js [--dry] [--chat <chatId>]
// Notes:
// - Backs up DB before writing (ledger.sqlite.YYYYMMDD-HHMMSS.bak)
// - Skips transfers; incomes are left as-is but their descriptions are normalized too

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
require('dotenv').config();

const config = require('../src/config');
const LedgerStore = require('../src/db');
const { normalizeDescription, SHORTHANDS, CANON_CATEGORIES } = require('../src/shared/parse');

function normalizeToCanonical(desc) {
  const s = String(desc || '').trim();
  if (!s) return 'uncategorized';
  const normalized = normalizeDescription(s);
  const parts = normalized.split(/\s+/);
  const first = (parts[0] || '').toLowerCase();
  let mapped = null;
  if (CANON_CATEGORIES.includes(first)) {
    mapped = first;
  } else if (SHORTHANDS.has(first)) {
    const v = SHORTHANDS.get(first);
    if (CANON_CATEGORIES.includes(v)) mapped = v;
  } else {
    for (const [k, v] of SHORTHANDS.entries()) {
      if (first.startsWith(k) && CANON_CATEGORIES.includes(v)) { mapped = v; break; }
    }
  }
  if (mapped) {
    parts[0] = mapped;
    return parts.join(' ');
  }
  // Unknown: prefix 'uncategorized ' and keep details
  return ['uncategorized', ...parts].join(' ');
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const chatIdx = args.findIndex(a => a === '--chat');
  const onlyChat = chatIdx >= 0 ? String(args[chatIdx + 1] || '') : null;

  const dbPath = config.dbPath;
  if (!dbPath) throw new Error('No DB path configured');

  // Backup DB
  try {
    const ts = dayjs().format('YYYYMMDD-HHmmss');
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath, path.extname(dbPath));
    const bak = path.join(dir, `${base}.${ts}.bak`);
    fs.copyFileSync(dbPath, bak);
    console.log('Backup created:', bak);
  } catch (e) {
    console.warn('Backup failed (continuing):', e?.message || e);
  }

  const store = await LedgerStore.create(dbPath);
  const db = store.db;
  // Build SELECT
  let stmt;
  if (onlyChat) {
    stmt = db.prepare(`SELECT id, chat_id as chatId, code, is_transfer as isTransfer, is_income as isIncome, description FROM entries WHERE chat_id = :chat ORDER BY id ASC`);
    stmt.bind({ ':chat': onlyChat });
  } else {
    stmt = db.prepare(`SELECT id, chat_id as chatId, code, is_transfer as isTransfer, is_income as isIncome, description FROM entries ORDER BY id ASC`);
  }

  let updates = 0, scanned = 0;
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  for (const r of rows) {
    scanned++;
    // Skip transfers; keep invoices/attachments too (normalize harmlessly)
    const codeUp = String(r.code || '').toUpperCase();
    if (codeUp === 'XFER') continue;
    const current = String(r.description || '');
    const next = normalizeToCanonical(current);
    if (next !== current) {
      updates++;
      if (!dry) {
        await store.updateEntryById(r.id, { description: next });
      }
      if (updates <= 10) {
        console.log(`#${r.id} ${r.chatId} ${codeUp}: '${current}' -> '${next}'`);
      }
    }
  }

  console.log(`Scanned: ${scanned}, Updated: ${updates}${dry ? ' (dry-run)' : ''}`);
  process.exit(0);
}

main().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
