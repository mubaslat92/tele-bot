// Free-form, order-agnostic parser v2
// Goal: accept natural phrases like "spent 60 on groceries", "75 usd fuel", "rent 250 jod flat",
// and produce a normalized object: { code, amount, currency, description }

const { AliasStore } = require('./aliases');
const { normalizeDescription, SHORTHANDS, CANON_CATEGORIES } = require('./parse');

const KNOWN_CURRENCIES = new Set([
  'JOD','JD','USD','EUR','GBP','CHF','JPY','AUD','CAD',
  'SAR','AED','QAR','KWD','BHD','OMR','EGP','TRY','ILS','MAD','DZD','TND'
]);
const NORMALIZE_CURRENCY = { JD: 'JOD' };

const STOPWORDS = new Set(['on','for','at','to','the','a','an','in','of','my','our']);
const EXCLUDE_TOKENS = new Set([
  'spent','spend','pay','paid','buy','bought','get','got','gave','give',
  'receive','received','earn','earned','income','salary','wage','wages',
  'from','via','using','with','by','bill','invoice','receipt','rcpt','cash','card','credit','debit',
]);

function tokenize(text) {
  return (text || '')
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/[\u200B-\u200D\uFEFF]/g, '')) // zero-width cleanup
    .filter(Boolean);
}

function parseAmount(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].replace(/,/g, '');
    if (/^[+-]?\d+(?:[\.,]\d+)?$/.test(raw)) {
      const amt = Number(raw.replace(',', '.'));
      if (!Number.isNaN(amt)) return { amount: amt, index: i };
    }
  }
  return { amount: null, index: -1 };
}

function parseCurrency(tokens, amountIndex) {
  for (let i = 0; i < tokens.length; i++) {
    if (i === amountIndex) continue;
    const t = tokens[i];
    if (/^[A-Za-z]{2,5}$/.test(t)) {
      const up = t.toUpperCase();
      const norm = NORMALIZE_CURRENCY[up] || up;
      if (KNOWN_CURRENCIES.has(norm)) return { currency: norm, index: i };
    }
  }
  return { currency: null, index: -1 };
}

function inferCode(text) {
  const s = (text || '').toLowerCase();
  if (/\b(income|salary|bonus|cashback|revenue|inc|sal)\b/.test(s)) return 'INC';
  if (/\b(transfer|xfer)\b/.test(s)) return 'XFER';
  // Treat explicit invoice/receipt keywords as INV, but don't match generic 'bill' to avoid false positives
  if (/\b(invoice|receipt|inv|rcpt)\b/.test(s)) return 'INV';
  if (/\b(refund|returned)\b/.test(s)) return 'F'; // keep F as primary expense code, negative handled by amount
  return null; // default decided by caller (e.g., F or MISC)
}

function buildDescription(remainingTokens, aliasesPath) {
  // If trailing hashtag category exists (e.g., #g or #groceries), extract and normalize it
  let forcedCategory = null;
  if (remainingTokens.length) {
    const last = String(remainingTokens[remainingTokens.length - 1] || '').trim();
    if (last.startsWith('#') && last.length > 1) {
      const t = last.slice(1).toLowerCase();
      let mapped = null;
      if (CANON_CATEGORIES.includes(t)) mapped = t;
      else if (SHORTHANDS.has(t)) mapped = SHORTHANDS.get(t);
      if (!mapped) {
        for (const [k, v] of SHORTHANDS.entries()) {
          if (t.startsWith(k) && CANON_CATEGORIES.includes(v)) { mapped = v; break; }
        }
      }
      if (mapped) {
        forcedCategory = mapped;
        remainingTokens = remainingTokens.slice(0, -1); // drop the hashtag token
      }
    }
  }
  // drop helper words and verbs anywhere, then trim stopwords at edges; keep order
  const arr = remainingTokens
    .filter(Boolean)
    .filter(t => !EXCLUDE_TOKENS.has((t || '').toLowerCase()));
  while (arr.length && STOPWORDS.has(arr[0].toLowerCase())) arr.shift();
  while (arr.length && STOPWORDS.has(arr[arr.length - 1].toLowerCase())) arr.pop();
  if (!arr.length) return '';
  const rawFirstOriginal = (arr[0] || '').toLowerCase();
  // apply alias on first token
  try {
    const aliasStore = AliasStore.load(aliasesPath);
    const first = (arr[0] || '').toLowerCase();
    const ali = aliasStore.get(first);
    if (ali) arr[0] = ali;
  } catch (_) {}
  // final pass through existing normalizeDescription (shorthands/fuzzy)
  const joined = arr.join(' ');
  let desc = normalizeDescription(joined);
  if (!desc) return '';
  // Enforce canonical first token (category) from fixed set.
  const parts = desc.split(/\s+/);
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
  if (forcedCategory) {
    parts[0] = forcedCategory;
    return { desc: parts.join(' '), rawFirst: rawFirstOriginal };
  }
  if (mapped) {
    parts[0] = mapped;
    return { desc: parts.join(' '), rawFirst: rawFirstOriginal };
  }
  // Unknown -> prefix 'uncategorized' and keep original word as detail
  return { desc: ['uncategorized', ...parts].join(' '), rawFirst: rawFirstOriginal };
}

function parseV2(text, opts) {
  const tokens = tokenize(text);
  if (!tokens.length) return { error: 'Empty message' };

  const { amount, index: amtIdx } = parseAmount(tokens);
  let finalAmount = amount;

  // identify negativity via words
  if (/\b(refund|returned|credit)\b/i.test(text) && typeof finalAmount === 'number' && finalAmount > 0) {
    finalAmount = -finalAmount;
  }

  const { currency, index: curIdx } = parseCurrency(tokens, amtIdx);
  const code = inferCode(text) || null;

  const remaining = tokens.filter((_, idx) => idx !== amtIdx && idx !== curIdx);
  const built = buildDescription(remaining, opts?.aliasesPath);
  const description = typeof built === 'string' ? built : built.desc;
  const rawFirst = typeof built === 'string' ? null : built.rawFirst;

  return {
    code: code || null, // caller decides default code if null
    amount: finalAmount,
    currency: currency || null,
    description,
    rawFirst,
  };
}

module.exports = { parseV2 };
