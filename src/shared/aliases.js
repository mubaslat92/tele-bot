const fs = require("fs");

class AliasStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
  }

  static load(filePath) {
    const store = new AliasStore(filePath);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const json = JSON.parse(raw || "{}");
        for (const [k, v] of Object.entries(json)) {
          if (typeof k === "string" && typeof v === "string") {
            store.map.set(k.toLowerCase(), v.toLowerCase());
          }
        }
      }
    } catch (_) {
      // ignore corrupt file
    }
    return store;
  }

  save() {
    const obj = Object.fromEntries([...this.map.entries()]);
    fs.mkdirSync(require("path").dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  set(alias, canonical) {
    if (!alias || !canonical) return;
    if (this.map.size >= 1000 && !this.map.has(alias.toLowerCase())) return; // cap
    this.map.set(alias.toLowerCase(), canonical.toLowerCase());
    this.save();
  }

  get(alias) {
    if (!alias) return undefined;
    return this.map.get(alias.toLowerCase());
  }

  all() {
    return Object.fromEntries([...this.map.entries()]);
  }
}

class AICache {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
  }

  static load(filePath) {
    const store = new AICache(filePath);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const json = JSON.parse(raw || "{}");
        for (const [k, v] of Object.entries(json)) {
          if (typeof k === "string" && typeof v === "string") {
            store.map.set(k.toLowerCase(), v.toLowerCase());
          }
        }
      }
    } catch (_) {
      // ignore corrupt file
    }
    return store;
  }

  save() {
    const obj = Object.fromEntries([...this.map.entries()]);
    fs.mkdirSync(require("path").dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  get(token) {
    if (!token) return undefined;
    return this.map.get(token.toLowerCase());
  }

  set(token, canonical) {
    if (!token || !canonical) return;
    this.map.set(token.toLowerCase(), canonical.toLowerCase());
    this.save();
  }
}

module.exports = { AliasStore, AICache };
