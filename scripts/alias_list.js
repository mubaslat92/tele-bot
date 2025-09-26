const { AliasStore } = require('../src/shared/aliases');
const config = require('../src/config');

const store = AliasStore.load(config.aliasesPath);
console.log(JSON.stringify(store.all(), null, 2));
