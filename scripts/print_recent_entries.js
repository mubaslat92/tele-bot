const path = require('path');
const LedgerStore = require('../src/db');

(async function main() {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.sqlite');
    const store = await LedgerStore.create(dbPath);

    const stmt = store.db.prepare(`
      SELECT id, chat_id as chatId, user_id as userId, code, amount, description, currency, created_at as createdAt
      FROM entries
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();

    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('Failed to read entries:', err);
    process.exit(1);
  }
})();
