const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const toList = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const rootDir = path.join(__dirname, "..");

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  allowedUserIds: toList(process.env.ALLOWED_USER_IDS),
  parserVersion: (process.env.PARSER_VERSION || 'v1').toLowerCase(),
  dbPath: process.env.DB_PATH
    ? path.resolve(rootDir, process.env.DB_PATH)
    : path.join(rootDir, "data", "ledger.sqlite"),
  reportsDir: process.env.REPORTS_DIR
    ? path.resolve(rootDir, process.env.REPORTS_DIR)
    : path.join(rootDir, "data", "reports"),
  aliasesPath: process.env.ALIASES_PATH
    ? path.resolve(rootDir, process.env.ALIASES_PATH)
    : path.join(rootDir, "data", "aliases.json"),
  aiCachePath: process.env.AI_CACHE_PATH
    ? path.resolve(rootDir, process.env.AI_CACHE_PATH)
    : path.join(rootDir, "data", "ai_cache.json"),
  chatNamesPath: process.env.CHAT_NAMES_PATH
    ? path.resolve(rootDir, process.env.CHAT_NAMES_PATH)
    : path.join(rootDir, "data", "chat_names.json"),
  timezone: process.env.TIMEZONE || "UTC",
  monthlyReportDay: Number.parseInt(process.env.MONTHLY_REPORT_DAY || "1", 10),
  defaultCurrency: (process.env.DEFAULT_CURRENCY || "JOD").toUpperCase(),
  defaultAmountFirstCode: (process.env.DEFAULT_AMOUNT_FIRST_CODE || "").toUpperCase() || null,
  aiNormalizerEnabled: (process.env.AI_NORMALIZER_ENABLED || "false").toLowerCase() === "true",
  aiProvider: (process.env.AI_PROVIDER || "openai").toLowerCase(),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "gpt-4o-mini",
  ollamaModel: process.env.OLLAMA_MODEL || "phi3:mini",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  // Dashboard/API
  dashboardEnabled: (process.env.DASHBOARD_ENABLED || "true").toLowerCase() === "true",
  dashboardPort: Number.parseInt(process.env.DASHBOARD_PORT || "8090", 10),
  dashboardAuthToken: process.env.DASHBOARD_AUTH_TOKEN || "",
  // Forecasting & anomalies
  forecastingEnabled: (process.env.FORECASTING_ENABLED || "true").toLowerCase() === "true",
  forecastMethod: (process.env.FORECAST_METHOD || "auto").toLowerCase(),
  anomalyDetectionEnabled: (process.env.ANOMALY_DETECTION_ENABLED || "true").toLowerCase() === "true",
  // WhatsApp Cloud API settings (optional)
  whatsappEnabled: (process.env.WHATSAPP_ENABLED || "false").toLowerCase() === "true",
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || "",
  whatsappPort: Number.parseInt(process.env.WHATSAPP_PORT || "8081", 10),
};
