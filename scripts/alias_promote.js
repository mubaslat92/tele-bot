const { AliasStore, AICache } = require('../src/shared/aliases');
const config = require('../src/config');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/alias_promote.js <token> <canonical>');
  process.exit(2);
}
const [token, ...rest] = args;
const canonical = rest.join(' ');
const aliases = AliasStore.load(config.aliasesPath);
const ai = AICache.load(config.aiCachePath);
ai.remove(token);
aliases.set(token, canonical);
console.log(`Promoted AI mapping: ${token} -> ${canonical}`);
