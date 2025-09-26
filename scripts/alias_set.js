const { AliasStore } = require('../src/shared/aliases');
const config = require('../src/config');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/alias_set.js <alias> <canonical>');
  process.exit(2);
}
const [alias, ...rest] = args;
const canonical = rest.join(' ');
const store = AliasStore.load(config.aliasesPath);
store.set(alias, canonical);
console.log(`Saved alias: ${alias} -> ${canonical}`);
