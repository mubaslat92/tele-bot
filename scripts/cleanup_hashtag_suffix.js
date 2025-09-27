#!/usr/bin/env node
const path = require('path');
const cfg = require('../src/config');
const LedgerStore = require('../src/db');

(async () => {
  const store = await LedgerStore.create(cfg.dbPath);
  const chats = store.getDistinctChatIds();
  let updated = 0;
  for (const chatId of chats) {
    const rows = store.getEntriesBetween(chatId, '1970-01-01T00:00:00.000Z', new Date().toISOString());
    for (const r of rows) {
      const desc = String(r.description || '');
      const cleaned = desc.replace(/\s+#\S+$/i, '').trim();
      if (cleaned !== desc) {
        await store.updateEntryById(r.id, { description: cleaned });
        updated++;
      }
    }
  }
  console.log(`cleanup: updated ${updated} rows`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
