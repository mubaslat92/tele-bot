const path = require("path");
const { Telegraf } = require("telegraf");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { generateMonthlyReport } = require("./report");
const { parseLedgerMessage, normalizeDescription } = require("./shared/parse");
const { getCodeLabel } = require("./shared/codes");
const { normalizeUnknownDescriptionFirstWord } = require("./ai_normalizer");
const { AliasStore, AICache } = require("./shared/aliases");

dayjs.extend(utc);
dayjs.extend(timezone);

// removed local parser; using shared/parse.js

const formatEntryLine = (entry, timezoneName) => {
  const when = dayjs(entry.createdAt).tz(timezoneName).format("YYYY-MM-DD HH:mm");
  const desc = entry.description ? ` - ${entry.description}` : "";
  const currency = entry.currency ? ` ${entry.currency}` : "";
  return `${when} | ${entry.code} ${entry.amount}${currency}${desc}`;
};

const parseReportArgs = (text) => {
  const tokens = text.trim().split(/\s+/).slice(1); // ignore the command itself
  // find the first YYYY-MM token anywhere in the message
  const ym = tokens.find((t) => /^\d{4}-\d{1,2}$/.test(t));
  if (!ym) return null;
  const [y, m] = ym.split("-");
  const year = Number.parseInt(y, 10);
  const month = Number.parseInt(m, 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
};

const ensureAuth = (allowedUserIds, ctx) => {
  if (!allowedUserIds.length) {
    return true;
  }

  const userId = ctx.from?.id?.toString();
  return allowedUserIds.includes(userId);
};

const registerCommands = async (bot) => {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Show help" },
    { command: "help", description: "Show help" },
    { command: "report", description: "Generate report (optional YYYY-MM)" },
    { command: "undo", description: "Remove last entry" },
    { command: "alias", description: "Teach a shorthand (e.g., /alias grcs groceries)" },
  ]);
};

const buildHelpMessage = () => {
  return [
    "Send transactions like:",
    "  F 100 elc",
    "  RENT 250 JOD flat in Amman",
    "Income examples: SAL 1000 salary, INC 50 cashback",
    "Structure: CODE AMOUNT [CURRENCY] [description]",
    "Negative amounts are refunds (e.g., F -20 return)",
    "Commands:",
    "/report - current month",
    "/report 2025-01 - specific month",
    "/undo - remove your last entry",
  ].join("\n");
};

const createBot = ({ config, store }) => {
  const bot = new Telegraf(config.telegramToken);
  const fs = require('fs');
  const path = require('path');
  const pendingFile = path.join(__dirname, '..', 'data', 'pending_jobs.json');
  const pushPendingJob = (job) => {
    try {
      const list = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : [];
      list.push(job);
      fs.writeFileSync(pendingFile, JSON.stringify(list, null, 2));
      // log activity for debugging
      try { fs.appendFileSync(path.join(__dirname, '..', 'data', 'bot-activity.log'), `${new Date().toISOString()} PUSH ${JSON.stringify(job)}\n`); } catch (_) {}
      return list.length;
    } catch (e) {
      console.error('Failed to push pending job', e);
      try { fs.appendFileSync(path.join(__dirname, '..', 'data', 'bot-activity.log'), `${new Date().toISOString()} PUSH_FAILED ${String(e)}\n`); } catch (_) {}
      return 0;
    }
  };
  // Initialize persistent stores
  const aliasStore = AliasStore.load(config.aliasesPath);
  const aiCache = AICache.load(config.aiCachePath);
  const START_TS = Math.floor(Date.now() / 1000);
  const isOld = (ctx) => {
    const ts = ctx.message?.date ?? ctx.update?.message?.date;
    return typeof ts === "number" && ts < START_TS - 1; // ignore updates older than process start
  };

  // Guardrail: intercept ambiguous natural-language report requests to avoid mis-parsing
  bot.use((ctx, next) => {
    const text = ctx.message?.text;
    if (typeof text === "string" && /\/report\s+.+/i.test(text) && !/^\/report\s+\d{4}-\d{1,2}$/i.test(text)) {
      // Allow bare /report (no args), but reject anything after /report unless it is YYYY-MM
      return ctx.reply("Use /report or /report YYYY-MM (e.g., /report 2025-09)");
    }
    return next();
  });

  // Global error handler to avoid crashes on unexpected input
  bot.catch((err, ctx) => {
    console.error("Unhandled bot error for update", ctx?.update?.update_id, err);
    try {
      ctx?.reply?.("Something went wrong processing your request.");
    } catch (_) {
      // ignore secondary failures
    }
  });

  registerCommands(bot).catch((error) => {
    console.error("Failed to register commands", error);
  });

  bot.start((ctx) => {
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    return ctx.reply("Welcome to the ledger bot!\n\n" + buildHelpMessage());
  });

  bot.help((ctx) => {
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    return ctx.reply(buildHelpMessage());
  });

  bot.command("report", async (ctx) => {
    if (isOld(ctx)) return; // drop stale
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - START_TS < 10) {
      return ctx.reply("Please resend: /report or /report YYYY-MM (bot is starting)");
    }
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    const chatId = ctx.chat?.id?.toString();
    if (!chatId) {
      return ctx.reply("Missing chat context");
    }

    const messageText = ctx.message.text.trim();
    if (!/^\/report(?:\s+\d{4}-\d{1,2})?$/.test(messageText)) {
      return ctx.reply("Use /report or /report YYYY-MM (e.g., /report 2025-09)");
    }
    const parsedArgs = parseReportArgs(messageText);
    const target = parsedArgs
      ? parsedArgs
      : (() => {
          // If no YYYY-MM in the message (or natural phrase like 'current month'), default to current month in configured timezone
          const now = dayjs().tz(config.timezone);
          if (!now.isValid()) {
            // fallback to UTC if timezone name is invalid
            const nowUtc = dayjs.utc();
            return { year: nowUtc.year(), month: nowUtc.month() + 1 };
          }
          return { year: now.year(), month: now.month() + 1 };
        })();

    await ctx.reply(
      `Preparing report for ${target.year}-${String(target.month).padStart(2, "0")}...`,
    );

    try {
      console.log("About to generate report with target:", target);
      const report = await generateMonthlyReport({
        store,
        chatId,
        year: target.year,
        month: target.month,
        reportsDir: config.reportsDir,
        timezoneName: config.timezone,
      });

      await ctx.replyWithDocument({
        source: report.filePath,
        filename: path.basename(report.filePath),
      });

      return ctx.reply(
        `Entries: ${report.entriesCount}\nTotal: ${report.grandTotal.toFixed(2)}`,
      );
    } catch (err) {
      console.error("Report generation failed:", err);
      return ctx.reply(`Couldn't generate report: ${err?.message || err}`);
    }
  });

  bot.command("undo", async (ctx) => {
    if (isOld(ctx)) return; // drop stale
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) {
      return ctx.reply("Missing chat context");
    }

    const lastEntry = store.getLastEntry(chatId, userId);
    if (!lastEntry) {
      return ctx.reply("No entries found to undo.");
    }

    await store.deleteEntryById(lastEntry.id);

    return ctx.reply(`Removed: ${formatEntryLine(lastEntry, config.timezone)}`);
  });

  // /alias <shorthand> <canonical>
  bot.command("alias", async (ctx) => {
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
      return ctx.reply("Usage: /alias <shorthand> <canonical>\nExample: /alias elct electricity");
    }
    const shorthand = parts[1].toLowerCase();
    const canonical = parts.slice(2).join(" ").toLowerCase();
    if (!/^[a-z]{1,20}$/.test(shorthand)) {
      return ctx.reply("Shorthand must be letters only (1-20 chars).");
    }
    if (!/^[a-z ]{3,40}$/.test(canonical)) {
      return ctx.reply("Canonical must be words only (3-40 chars).");
    }
    aliasStore.set(shorthand, canonical);
    return ctx.reply(`Alias saved: ${shorthand} -> ${canonical}`);
  });

  bot.on("text", async (ctx) => {
    if (isOld(ctx)) return; // drop stale
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) {
      return ctx.reply("Missing chat context");
    }

    const text = ctx.message.text || "";
    // Gentle guard: if message seems to contain multiple transactions, ask to split
    const sepHint = /(\bor\b|\band\b|;|,)/i.test(text);
    const numCount = (text.match(/(?<![A-Za-z])\d+[\d.,]*/g) || []).length;
    if (sepHint && numCount > 1) {
      return ctx.reply("Please send one transaction per message (I detected multiple amounts). Example: 'F 100 elc' then 'RENT 250 JOD flat in Amman'.");
    }

  const parsed = parseLedgerMessage(text, { amountFirstCode: config.defaultAmountFirstCode });
    if (parsed.error) {
      return ctx.reply(parsed.error);
    }

    const createdAt = dayjs().utc().toISOString();
    const currency = parsed.currency || config.defaultCurrency;
    let description = normalizeDescription(parsed.description);
    // Apply manual alias on first token before AI
    const descParts = (description || "").split(/\s+/);
    const firstToken = (descParts[0] || "").toLowerCase();
    const alias = aliasStore.get(firstToken);
    if (alias) {
      descParts[0] = alias;
      description = descParts.join(" ");
    }
    // Optionally call AI normalizer if still unknown shorthand
    if (config.aiNormalizerEnabled) {
      description = await normalizeUnknownDescriptionFirstWord(description, config) || description;
    }

    const entry = await store.addEntry({
      chatId,
      userId,
      code: parsed.code,
      amount: parsed.amount, // can be negative for refunds
      currency,
      description,
      createdAt,
    });

    // Budget alerts: notify when crossing 80% or 100% of cap for this category (chat-specific first, then global)
    try {
      const codeUp = String(entry.code || "").toUpperCase();
      if (codeUp !== "XFER") {
        // Determine category from description
        const getCategory = (desc) => {
          const s = (desc || "").trim();
          if (!s) return "uncategorized";
          return s.split(/\s+/)[0].toLowerCase();
        };
        const category = getCategory(entry.description);
        // Locate budget cap (chat-specific overrides global)
        const budgets = store.getBudgets(chatId) || [];
        let capJod = null;
        // prefer exact chat budget
        for (const b of budgets) {
          if (b.chatId && b.chatId === chatId && b.category === category) { capJod = b.capJod; break; }
        }
        if (capJod == null) {
          for (const b of budgets) {
            if ((b.chatId == null || b.chatId === undefined) && b.category === category) { capJod = b.capJod; break; }
          }
        }
        if (typeof capJod === "number" && capJod > 0) {
          // Compute month range in UTC
          const now = dayjs.utc();
          const start = now.startOf("month").toISOString();
          const end = now.endOf("month").toISOString();
          // Sum spent in JOD for this category this month (excluding transfers)
          const rows = store.getEntriesBetween(chatId, start, end) || [];
          let spentJod = 0;
          for (const r of rows) {
            const rCode = String(r.code || "").toUpperCase();
            if (rCode === "XFER") continue;
            if (getCategory(r.description) !== category) continue;
            const amt = Number(r.amount) || 0;
            const cur = (r.currency || "JOD").toUpperCase();
            const rate = cur === "JOD" ? 1 : (store.getFxRateOn(r.createdAt, cur) || 1);
            spentJod += amt * rate;
          }
          // Determine how much the just-added entry contributed (approx, in JOD)
          const addedRate = (entry.currency || "JOD").toUpperCase() === "JOD" ? 1 : (store.getFxRateOn(entry.createdAt, entry.currency) || 1);
          const addedJod = (Number(entry.amount) || 0) * addedRate;
          const prevJod = spentJod - addedJod;
          const thresholds = [0.8, 1.0];
          for (const thr of thresholds) {
            if (prevJod < capJod * thr && spentJod >= capJod * thr) {
              const pct = Math.min(100, Math.round((spentJod / capJod) * 100));
              const remaining = capJod - spentJod;
              const badge = thr === 1 ? "reached" : "80%";
              await ctx.reply(
                `Budget ${badge}: ${category} — spent ${spentJod.toFixed(2)} JOD of ${capJod.toFixed(2)} JOD (${pct}%).` +
                (remaining >= 0 ? ` Remaining: ${remaining.toFixed(2)} JOD.` : ` Over by ${Math.abs(remaining).toFixed(2)} JOD.`)
              );
              break; // alert at most one threshold per entry
            }
          }
        }
      }
    } catch (e) {
      // Non-fatal; log and continue
      console.error("Budget alert check failed:", e);
    }

    const label = getCodeLabel(entry.code);
    const labelSuffix = label ? ` (${label})` : "";
    return ctx.reply(
      `Recorded ${entry.code}${labelSuffix} ${entry.amount}` +
        (currency ? ` ${currency}` : "") +
        (description ? ` - ${description}` : ""),
    );
  });

  // Photo handler: accept receipts/invoices; save attachment file_id and queue OCR job
  bot.on('photo', async (ctx) => {
    if (isOld(ctx)) return;
    if (!ensureAuth(config.allowedUserIds, ctx)) return ctx.reply('Access denied.');
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) return ctx.reply('Missing chat context');
    const photos = ctx.message.photo || [];
    if (!photos.length) return ctx.reply('No photo found');
    const best = photos[photos.length - 1];
    const fileId = best.file_id;
    const caption = ctx.message.caption || '';
    const isInvoice = /invoice|bill|receipt/i.test(caption);
    const now = new Date().toISOString();
    const entry = await store.addEntry({
      chatId,
      userId,
      code: isInvoice ? 'INV' : 'RCPT',
      amount: 0,
      currency: config.defaultCurrency,
      description: caption || (isInvoice ? 'invoice' : 'receipt'),
      createdAt: now,
      attachmentPath: fileId,
      ocrText: null,
      isInvoice: isInvoice,
    });
  const pendingLen = pushPendingJob({ type: isInvoice ? 'invoice_ocr' : 'receipt_ocr', chatId, fileId, entryId: entry.id, createdAt: now });
  return ctx.reply(`Saved attachment (entry id ${entry.id}). Queue length: ${pendingLen}. OCR will be processed shortly.`);
  });

  // Voice handler: store voice message and queue transcription
  bot.on('voice', async (ctx) => {
    if (isOld(ctx)) return;
    if (!ensureAuth(config.allowedUserIds, ctx)) return ctx.reply('Access denied.');
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) return ctx.reply('Missing chat context');
    const voice = ctx.message.voice;
    if (!voice) return ctx.reply('No voice message found');
    const fileId = voice.file_id;
    const now = new Date().toISOString();
    const entry = await store.addEntry({ chatId, userId, code: 'VOICE', amount: 0, currency: config.defaultCurrency, description: 'voice note', createdAt: now, attachmentPath: fileId, voiceText: null });
    pushPendingJob({ type: 'transcribe', chatId, fileId, entryId: entry.id, createdAt: now });
    return ctx.reply(`Saved voice note (entry id ${entry.id}). Transcription queued.`);
  });

  // Location handler: attach GPS coordinates to a lightweight entry
  bot.on('location', async (ctx) => {
    if (isOld(ctx)) return;
    if (!ensureAuth(config.allowedUserIds, ctx)) return ctx.reply('Access denied.');
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) return ctx.reply('Missing chat context');
    const loc = ctx.message.location;
    if (!loc) return ctx.reply('No location found');
    const now = new Date().toISOString();
    const entry = await store.addEntry({ chatId, userId, code: 'LOC', amount: 0, currency: config.defaultCurrency, description: 'location tag', createdAt: now, locationLat: loc.latitude, locationLng: loc.longitude });
    return ctx.reply(`Location saved (entry id ${entry.id}). Use /report to include location metadata in exports.`);
  });

  bot.on("message", (ctx) => {
    if (isOld(ctx)) return; // drop stale
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    if (!ctx.message?.text) {
      return ctx.reply("Please send text messages only.");
    }

    return undefined;
  });

  return bot;
};

module.exports = {
  createBot,
};
