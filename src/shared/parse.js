// Shared parser for ledger messages: CODE AMOUNT [CURRENCY] [description]
const KNOWN_CURRENCIES = new Set([
  "JOD", "JD",
  "USD", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD",
  "SAR", "AED", "QAR", "KWD", "BHD", "OMR",
  "EGP", "TRY", "ILS", "MAD", "DZD", "TND",
]);

const NORMALIZE_CURRENCY = { JD: "JOD" };

// Shorthands and helpers are defined before parse so we can avoid
// misclassifying shorthand tokens as currencies.
const SHORTHANDS = new Map([
  ["elc", "electricity"],
  ["elec", "electricity"],
  ["electric", "electricity"],
  ["wat", "water"],
  ["wtr", "water"],
  ["hst", "hosting"],
  ["int", "internet"],
  ["net", "internet"],
  ["rent", "rent"],
  ["tax", "tax"],
  ["foo", "food"],
]);

function isShorthandLike(word) {
  if (!word) return false;
  const w = word.toLowerCase();
  if (SHORTHANDS.has(w)) return true;
  for (const key of SHORTHANDS.keys()) {
    if (w.startsWith(key)) return true;
  }
  return false;
}

function parseLedgerMessage(text, opts = {}) {
  const amountFirstCode = (opts && typeof opts.amountFirstCode === "string" && opts.amountFirstCode) || null;
  const trimmed = (text || "").trim();
  if (!trimmed) return { error: "Empty message" };

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return { error: "Use format CODE AMOUNT [CURRENCY] [description] or AMOUNT [CURRENCY] [description]" };

  const first = parts[0];
  const firstAsNumber = Number.parseFloat(first.replace(/,/g, ""));
  // Pattern B: AMOUNT-first
  if (!Number.isNaN(firstAsNumber)) {
    let cursor = 1;
    let currency = null;
    if (parts[cursor] && /^[A-Za-z]{2,5}$/.test(parts[cursor])) {
      const candidateRaw = parts[cursor];
      const candidate = candidateRaw.toUpperCase();
      const candidateLower = candidateRaw.toLowerCase();
      const normalized = NORMALIZE_CURRENCY[candidate] || candidate;
      // Guard: if token looks like a known description shorthand, do NOT treat as currency.
      if (!isShorthandLike(candidateLower) && KNOWN_CURRENCIES.has(normalized)) {
        currency = normalized;
        cursor += 1;
      }
    }
    const description = parts.slice(cursor).join(" ");
    // Amount-first defaults to configured code or MISC for predictability
    const code = amountFirstCode || "MISC";
    return { code, amount: firstAsNumber, currency, description };
  }

  // Pattern A: CODE-first (original)
  const code = first.toUpperCase();
  const amount = Number.parseFloat(parts[1].replace(/,/g, ""));
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return { error: "Code should be letters/numbers (e.g., F, RENT)" };
  if (Number.isNaN(amount)) return { error: "Amount should be a number" };

  let cursor = 2;
  let currency = null;
  if (parts[cursor] && /^[A-Za-z]{2,5}$/.test(parts[cursor])) {
    const candidateRaw = parts[cursor];
    const candidate = candidateRaw.toUpperCase();
    const candidateLower = candidateRaw.toLowerCase();
    const normalized = NORMALIZE_CURRENCY[candidate] || candidate;
    // Guard: do not consume shorthand-like tokens as currencies
    if (!isShorthandLike(candidateLower) && KNOWN_CURRENCIES.has(normalized)) {
      currency = normalized;
      cursor += 1;
    }
  }

  const description = parts.slice(cursor).join(" ");
  return { code, amount, currency, description };
}

module.exports = { parseLedgerMessage, KNOWN_CURRENCIES, NORMALIZE_CURRENCY };
// Add description normalization utilities

function normalizeDescription(desc) {
  const s = (desc || "").trim();
  if (!s) return s;
  const parts = s.split(/\s+/);
  const first = parts[0].toLowerCase();
  if (SHORTHANDS.has(first)) {
    parts[0] = SHORTHANDS.get(first);
    return parts.join(" ");
  }
  // Fuzzy: startsWith match (e.g., "ele" -> electricity, "wat" -> water)
  for (const [key, value] of SHORTHANDS.entries()) {
    if (first.startsWith(key)) {
      parts[0] = value;
      return parts.join(" ");
    }
  }
  return s;
}

function isKnownDescriptionRoot(word) {
  if (!word) return false;
  const w = word.toLowerCase();
  if (SHORTHANDS.has(w)) return true;
  for (const key of SHORTHANDS.keys()) {
    if (w.startsWith(key)) return true;
  }
  return false;
}

module.exports.normalizeDescription = normalizeDescription;
module.exports.isKnownDescriptionRoot = isKnownDescriptionRoot;
module.exports.SHORTHANDS = SHORTHANDS;
