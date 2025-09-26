// Shared parser for ledger messages: CODE AMOUNT [CURRENCY] [description]
const KNOWN_CURRENCIES = new Set([
  "JOD", "JD",
  "USD", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD",
  "SAR", "AED", "QAR", "KWD", "BHD", "OMR",
  "EGP", "TRY", "ILS", "MAD", "DZD", "TND",
]);

const NORMALIZE_CURRENCY = { JD: "JOD" };

// Canonical categories: small fixed set
const CANON_CATEGORIES = [
  "groceries",
  "food",
  "transport",
  "bills",
  "health",
  "rent",
  "misc",
  "uncategorized",
];

// Shorthands and helpers: map many words to the canonical categories above.
// Keep this small and opinionated.
const SHORTHANDS = new Map([
  // Primary one-letter codes
  ["g", "groceries"],
  ["f", "food"],
  ["t", "transport"],
  ["b", "bills"],
  ["h", "health"],
  ["r", "rent"],
  ["m", "misc"],
  ["u", "uncategorized"],

  // Groceries
  ["gro", "groceries"], ["groc", "groceries"], ["grocery", "groceries"], ["groceries", "groceries"],
  ["market", "groceries"], ["supermarket", "groceries"], ["mart", "groceries"], ["kol", "groceries"],

  // Food & drinks
  ["food", "food"], ["rest", "food"], ["restaurant", "food"], ["dine", "food"],
  ["lunch", "food"], ["breakfast", "food"], ["dinner", "food"], ["snack", "food"], ["snacks", "food"],
  ["coffee", "food"], ["cafe", "food"], ["tea", "food"], ["starbucks", "food"], ["costa", "food"],

  // Transport (inc. car/fuel/parking/travel)
  ["transport", "transport"], ["taxi", "transport"], ["cab", "transport"], ["uber", "transport"], ["careem", "transport"],
  ["ride", "transport"], ["bus", "transport"], ["metro", "transport"], ["train", "transport"], ["parking", "transport"],
  ["fuel", "transport"], ["gas", "transport"], ["petrol", "transport"], ["diesel", "transport"],
  ["car", "transport"], ["carwash", "transport"], ["wash", "transport"], ["maint", "transport"], ["maintenance", "transport"],
  ["repair", "transport"], ["service", "transport"],
  ["travel", "transport"], ["flight", "transport"], ["ticket", "transport"], ["hotel", "transport"], ["booking", "transport"],
  ["visa", "transport"], ["passport", "transport"],

  // Bills (utilities/phone/subscriptions/hosting)
  ["bills", "bills"], ["bill", "bills"], ["utility", "bills"], ["utilities", "bills"],
  ["electric", "bills"], ["electricity", "bills"], ["power", "bills"],
  ["wat", "bills"], ["wtr", "bills"], ["water", "bills"],
  ["int", "bills"], ["net", "bills"], ["internet", "bills"], ["wifi", "bills"],
  ["hst", "bills"], ["hosting", "bills"],
  ["phone", "bills"], ["mobile", "bills"], ["airtime", "bills"], ["topup", "bills"], ["recharge", "bills"], ["data", "bills"],
  ["sub", "bills"], ["subs", "bills"], ["subscription", "bills"], ["netflix", "bills"], ["spotify", "bills"], ["icloud", "bills"], ["youtube", "bills"], ["yt", "bills"],

  // Health
  ["phar", "health"], ["pharma", "health"], ["pharmacy", "health"], ["med", "health"], ["meds", "health"], ["medicine", "health"],
  ["doctor", "health"], ["clinic", "health"], ["hospital", "health"], ["dentist", "health"],

  // Rent / housing
  ["rent", "rent"], ["lease", "rent"],

  // Misc (fallback-ish words)
  ["misc", "misc"], ["other", "misc"], ["gift", "misc"], ["gifts", "misc"], ["present", "misc"],
  ["charity", "misc"], ["donation", "misc"], ["donate", "misc"], ["zakat", "misc"], ["sadaqa", "misc"], ["sadaka", "misc"], ["sadaqah", "misc"],
  ["tax", "misc"], ["fee", "misc"], ["fine", "misc"], ["receipt", "misc"],
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
module.exports.CANON_CATEGORIES = CANON_CATEGORIES;
