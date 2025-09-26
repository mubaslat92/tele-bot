// Optional AI-backed description normalizer
// Tries to map an unknown first word to a canonical expense label.

const axios = require("axios");

const { isKnownDescriptionRoot, SHORTHANDS } = require("./shared/parse");
const { AICache, AliasStore } = require("./shared/aliases");

// Simple in-memory cache plus disk cache
const CACHE = new Map();
let DISK_CACHE = null;
let ALIASES = null;

const CANON_LABELS = [
  "electricity",
  "water",
  "rent",
  "tax",
  "fuel",
  "groceries",
  "internet",
  "hosting",
  "insurance",
  "salary",
  "fees",
  "supplies",
  "maintenance",
];

function buildPrompt(token) {
  return `You act as a strict mapper for shorthand expense category tokens.\n` +
    `Map the token to the closest label from this list (lowercase only): ${CANON_LABELS.join(", ")}.\n` +
    `Rules:\n- If already a full word in the list, return it unchanged.\n- If it is a prefix or common shorthand, expand to the best match.\n- If you cannot map confidently, respond with the literal token.\n- Output ONLY the single word (no punctuation, no explanations).\nToken: ${token}`;
}

async function aiNormalize({ token, config }) {
  const lower = token.toLowerCase();
  if (!lower || isKnownDescriptionRoot(lower)) return null; // already known or empty
  // Load disk structures lazily and always reload aliases to pick up recent /alias commands
  if (!DISK_CACHE && config.aiCachePath) DISK_CACHE = AICache.load(config.aiCachePath);
  if (config.aliasesPath) ALIASES = AliasStore.load(config.aliasesPath);

  // Manual alias wins first (reloaded above)
  const aliasHit = ALIASES?.get(lower);
  if (aliasHit) return aliasHit;

  // Disk/in-memory cache hit
  const diskHit = DISK_CACHE?.get(lower);
  if (diskHit) return diskHit;
  if (CACHE.has(lower)) return CACHE.get(lower);
  if (!config.aiNormalizerEnabled) return null;
  try {
    if (config.aiProvider === "openai") {
      if (!config.openaiApiKey) return null;
      const { data } = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: config.aiModel,
          messages: [
            { role: "system", content: "You output only one lowercase word." },
            { role: "user", content: buildPrompt(lower) },
          ],
          temperature: 0,
          max_tokens: 5,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.openaiApiKey}`,
          },
        }
      );
      const text = data.choices?.[0]?.message?.content?.trim().toLowerCase();
      if (!text) return null;
      const word = text.split(/\s+/)[0];
      if (!word) return null;
      if (CANON_LABELS.includes(word) || word === lower) {
        CACHE.set(lower, word);
        DISK_CACHE?.set(lower, word);
        return word;
      }
      return null;
    }

    if (config.aiProvider === "ollama") {
      const base = (config.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
      const url = `${base}/api/chat`;
      const { data } = await axios.post(
        url,
        {
          model: config.ollamaModel || "phi3:mini",
          messages: [
            { role: "system", content: "You output only one lowercase word." },
            { role: "user", content: buildPrompt(lower) },
          ],
          options: { temperature: 0, num_predict: 5 },
          stream: false,
        },
        { headers: { "Content-Type": "application/json" } }
      );
      const text = data.message?.content?.trim().toLowerCase();
      if (!text) return null;
      const word = text.split(/\s+/)[0];
      if (!word) return null;
      if (CANON_LABELS.includes(word) || word === lower) {
        CACHE.set(lower, word);
        DISK_CACHE?.set(lower, word);
        return word;
      }
      return null;
    }

    // Unknown provider
    return null;
  } catch (e) {
    console.warn("AI normalizer failed", e.message || e);
    return null;
  }
}

async function normalizeUnknownDescriptionFirstWord(description, config) {
  if (!description) return description;
  const parts = description.split(/\s+/);
  if (parts.length === 0) return description;
  const first = parts[0];
  const mapped = await aiNormalize({ token: first, config });
  if (mapped && mapped !== first.toLowerCase()) {
    parts[0] = mapped;
    return parts.join(" ");
  }
  return description;
}

module.exports = { normalizeUnknownDescriptionFirstWord, aiNormalize };
