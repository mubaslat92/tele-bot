const path = require("path");
const { Telegraf } = require("telegraf");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { generateMonthlyReport } = require("./report");
const { parseLedgerMessage, normalizeDescription, isKnownDescriptionRoot, categoryFromDescription } = require("./shared/parse");
const { parseV2 } = require("./shared/parse_v2");
const { getCodeLabel } = require("./shared/codes");
const { normalizeUnknownDescriptionFirstWord, aiNormalize } = require("./ai_normalizer");
const { AliasStore, AICache } = require("./shared/aliases");

dayjs.extend(utc);
dayjs.extend(timezone);

// removed local parser; using shared/parse.js

const formatEntryLine = (entry, timezoneName) => {
  const when = dayjs(entry.createdAt).tz(timezoneName).format("YYYY-MM-DD HH:mm");
  const currency = entry.currency ? ` ${entry.currency}` : "";
  const desc = (entry.description || '').trim();
  const parts = desc.split(/\s+/);
  const category = categoryFromDescription(desc);
  const rest = parts.slice(1).join(' ');
  // Type tag for special codes (optional): Income/Transfer/Invoice/Receipt
  const codeUp = String(entry.code || '').toUpperCase();
  let tag = '';
  if (codeUp === 'INC') tag = ' [Income]';
  else if (codeUp === 'XFER') tag = ' [Transfer]';
  else if (codeUp === 'INV') tag = ' [Invoice]';
  else if (codeUp === 'RCPT') tag = ' [Receipt]';
  return `${when} | Recorded ${Number(entry.amount)}${currency} — ${category}${rest?` ${rest}`:''}${tag}`;
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

const buildHelpMessage = (config) => {
  const lines = [
    "Send transactions like:",
  ];
  if ((config?.parserVersion || 'v1') === 'v2') {
    lines.push(
      "  60 g apples  (g = groceries)",
      "  75 usd t taxi  (t = transport)",
      "  b 45 jod electricity bill  (b = bills)",
      "  h 30 pharmacy meds  (h = health)",
      "  r 250 flat  (r = rent)",
      "  m 20 gift  (m = misc)",
      "If you write words, I'll map them to these 7 categories: g/f/t/b/h/r/m and u (uncategorized).",
      "Tip: One transaction per message."
    );
  } else {
    lines.push(
      "  F 100 elc",
      "  RENT 250 JOD flat in Amman",
      "Income examples: SAL 1000 salary, INC 50 cashback",
      "Structure: CODE AMOUNT [CURRENCY] [description]",
      "Negative amounts are refunds (e.g., F -20 return)"
    );
  }
  lines.push(
    "Commands:",
    "/report - current month",
    "/report 2025-01 - specific month",
    "/undo - remove your last entry",
  );
  return lines.join("\n");
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
  // Initialize persistent stores (AI cache kept in memory, aliases will be loaded per-message to pick up edits)
  const aiCache = AICache.load(config.aiCachePath);
  // transient conversation state to capture replacement words from users { userId -> { entryId, token } }
  const pendingAliasResponses = new Map();
  // transient teach requests for amount-first unknown tokens: { userId -> { parsed, token, createdAt, chatId } }
  const pendingTeachRequests = new Map();
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

    return ctx.reply("Welcome to the ledger bot!\n\n" + buildHelpMessage(config));
  });

  bot.help((ctx) => {
    if (!ensureAuth(config.allowedUserIds, ctx)) {
      return ctx.reply("Access denied.");
    }

    return ctx.reply(buildHelpMessage(config));
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
  // persist alias to disk so it takes effect immediately for future messages
    try {
      const store = AliasStore.load(config.aliasesPath);
      store.set(shorthand, canonical);
  return ctx.reply(`Alias saved: ${shorthand} -> ${canonical}\nTip: For categories, prefer one of g/f/t/b/h/r/m/u as the first word.`);
    } catch (e) {
      console.error('Failed to save alias', e);
      return ctx.reply('Failed to save alias.');
    }
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

    // If this user was asked to provide a replacement for a token, capture it here
    try {
      if (pendingAliasResponses.has(userId)) {
        const state = pendingAliasResponses.get(userId);
        pendingAliasResponses.delete(userId);
        const replacement = (ctx.message?.text || '').trim().toLowerCase();
        if (!replacement) return ctx.reply('Replacement must be a non-empty word.');
        try {
          const storeAlias = AliasStore.load(config.aliasesPath);
          storeAlias.set(state.token, replacement);

          if (state.entryId) {
            // update the entry description to use replacement
            const entry = store.getEntryById(state.entryId);
            if (entry) {
              const parts = (entry.description || '').split(/\s+/);
              parts[0] = replacement;
              await store.updateEntryById(entry.id, { description: parts.join(' ') });
              // show recorded line to confirm save
              try {
                const updated = store.getEntryById(entry.id) || entry;
                await ctx.reply(formatEntryLine(updated, config.timezone));
              } catch (_) {}
            }
          } else if (state.parsed) {
            // state carries parsed message info (teach flow) — create the entry with replacement
            const p = state.parsed;
            const createdAt = state.createdAt || new Date().toISOString();
            const descParts = (p.description || '').split(/\s+/);
            descParts[0] = replacement;
            const description = descParts.join(' ');
            const entry = await store.addEntry({ chatId: state.chatId, userId, code: p.code, amount: p.amount, currency: p.currency || config.defaultCurrency, description, createdAt });
            // notify in chat
            try { await ctx.telegram.sendMessage(entry.chatId, formatEntryLine(entry, config.timezone)); } catch (_) {}
          }

          await ctx.reply(`Saved alias ${state.token} -> ${replacement}`);
        } catch (e) {
          console.error('Failed to save replacement alias', e);
          await ctx.reply('Failed to save alias.');
        }
        return;
      }
    } catch (e) {
      console.error('Error handling pending alias response', e);
    }

  const text = ctx.message.text || "";
    // Gentle guard: if message seems to contain multiple transactions, ask to split
    const sepHint = /(\bor\b|\band\b|;|,)/i.test(text);
    const numCount = (text.match(/(?<![A-Za-z])\d+[\d.,]*/g) || []).length;
    if (sepHint && numCount > 1) {
      return ctx.reply("Please send one transaction per message (I detected multiple amounts). Example: 'F 100 elc' then 'RENT 250 JOD flat in Amman'.");
    }

  let parsed;
    if ((config.parserVersion || 'v1') === 'v2') {
  parsed = parseV2(text, { aliasesPath: config.aliasesPath });
      if (!parsed || parsed.error) {
        return ctx.reply(parsed?.error || 'Could not parse your message. Please include an amount.');
      }
      if (parsed.amount == null || Number.isNaN(Number(parsed.amount))) {
        return ctx.reply('Please include an amount (e.g., 60, 75 usd fuel, spent 40 on lunch).');
      }
      // Defaults for code/currency under v2
      let code = parsed.code || null;
      const beginsWithAmount = /^\s*[+-]?\d/.test(text);
      if (!code) {
        if (beginsWithAmount) {
          code = config.defaultAmountFirstCode || 'MISC';
        } else if (Number(parsed.amount) < 0) {
          code = 'F';
        } else {
          code = 'F';
        }
      }
      parsed.code = code;
    } else {
      parsed = parseLedgerMessage(text, { amountFirstCode: config.defaultAmountFirstCode });
      if (parsed.error) {
        return ctx.reply(parsed.error);
      }
    }

    const createdAt = dayjs().utc().toISOString();
    const currency = parsed.currency || config.defaultCurrency;
    let description = normalizeDescription(parsed.description);
  // If this message used the amount-first pattern and the first description token is unknown,
    // prompt the user to teach the new word instead of immediately recording MISC.
  const rawFirstToken = (parsed.rawFirst || (text.trim().split(/\s+/)[0] || '').toString()).toLowerCase();
    const messageIsAmountFirst = /^\s*\d/.test(text);
    const descPartsCheck = (parsed.description || '').split(/\s+/);
    const descFirstCheck = (descPartsCheck[0] || '').toLowerCase();
    let aliasForDescFirst = null;
    try { aliasForDescFirst = AliasStore.load(config.aliasesPath).get(descFirstCheck); } catch (_) { aliasForDescFirst = null; }
  if (messageIsAmountFirst && !aliasForDescFirst && !isKnownDescriptionRoot(descFirstCheck) && descFirstCheck && descFirstCheck !== 'uncategorized') {
      // Create a temporary entry and ask the user whether they'd like to teach this new word
      try {
        const tempEntry = await store.addEntry({
          chatId,
          userId,
          code: parsed.code,
          amount: parsed.amount,
          currency,
          description: parsed.description,
          createdAt,
        });

        // Offer quick category choices as inline buttons for a one-tap classification
        const catButtons = [
          ['groceries','food','transport'],
          ['bills','health','rent'],
          ['misc','uncategorized']
        ];
        const inline_keyboard = catButtons.map(row => row.map(c => ({ text: c, callback_data: `cat:set:${tempEntry.id}:${c}` })));
        inline_keyboard.push([
          { text: `Teach '${descFirstCheck}'`, callback_data: `alias:teach:yes:${tempEntry.id}:${descFirstCheck}` },
          { text: `Save as-is ('${descFirstCheck}')`, callback_data: `alias:teach:no:${tempEntry.id}:${descFirstCheck}` },
        ]);
        await ctx.reply(`Category not recognized. Pick a category or teach this word:`, { reply_markup: { inline_keyboard } });
        return; // wait for callback to handle teach/save decisions
      } catch (e) {
        console.error('Failed to prompt teach flow', e);
      }
    }
    // Apply manual alias on first token before AI
    const descParts = (description || "").split(/\s+/);
    const firstToken = (descParts[0] || "").toLowerCase();
    // load aliases from disk each message so edits take effect without restarting
    let aliasApplied = false;
    try {
      const alias = AliasStore.load(config.aliasesPath).get(firstToken);
      if (alias) {
        descParts[0] = alias;
        description = descParts.join(" ");
        aliasApplied = true;
      }
    } catch (_) {}
    // Optionally call AI normalizer only when no manual alias was applied
    let aiMapped = null;
    if (config.aiNormalizerEnabled && !aliasApplied) {
      // call aiNormalize directly on the first token so we can prompt the user interactively
      try {
        aiMapped = await aiNormalize({ token: firstToken, config });
      } catch (e) { aiMapped = null; }
      if (aiMapped && aiMapped !== firstToken) {
        // propose the mapping to the user before finalizing
        // set the proposed description but hold off on persisting alias until user confirms
        const proposedParts = [...descParts];
        proposedParts[0] = aiMapped;
        const proposedDesc = proposedParts.join(' ');
        description = proposedDesc;
        // create the entry but mark as pending suggestion by writing a suggestion row
        const entry = await store.addEntry({
          chatId,
          userId,
          code: parsed.code,
          amount: parsed.amount,
          currency,
          description,
          createdAt,
        });
        // Ask user to confirm mapping via inline buttons
        try {
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: `Yes — keep '${aiMapped}'`, callback_data: `alias:yes:${entry.id}:${firstToken}:${aiMapped}` },
                  { text: `No — I'll provide`, callback_data: `alias:no:${entry.id}:${firstToken}:${aiMapped}` },
                ],
              ],
            },
          };
          await ctx.reply(
            `I suggested '${aiMapped}' for '${firstToken}'. Is that correct?`,
            keyboard,
          );
          return; // done — wait for callback
        } catch (e) {
          // fallback: if inline keyboard fails, just save and continue
          console.error('Failed to send alias confirmation keyboard', e);
        }
      } else {
        // no ai suggestion, proceed with original description
        description = await normalizeUnknownDescriptionFirstWord(description, config) || description;
      }
    }
    // If we didn't early-return for an AI confirmation flow above, add entry normally
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
        const category = categoryFromDescription(entry.description);
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
            if (categoryFromDescription(r.description) !== category) continue;
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

    return ctx.reply(formatEntryLine(entry, config.timezone));
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

  // Document handler: accept PDFs or image files sent as documents; queue OCR job
  bot.on('document', async (ctx) => {
    if (isOld(ctx)) return;
    if (!ensureAuth(config.allowedUserIds, ctx)) return ctx.reply('Access denied.');
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    if (!chatId || !userId) return ctx.reply('Missing chat context');
    const doc = ctx.message.document;
    if (!doc) return ctx.reply('No document found');
    const fileId = doc.file_id;
    const mime = doc.mime_type || '';
    const caption = ctx.message.caption || '';
    const isInvoice = /invoice|bill|receipt/i.test(caption) || /invoice|bill/i.test(doc.file_name || '');
    // Accept only images and PDFs here
    if (!/^image\//i.test(mime) && !/pdf$/i.test(mime) && !/\.pdf$/i.test(doc.file_name || '')) {
      return ctx.reply('Unsupported document type. Please send an image or PDF.');
    }
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
    return ctx.reply(`Saved document (entry id ${entry.id}). Queue length: ${pendingLen}. OCR will be processed shortly.`);
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

    // Handle inline button callbacks for alias confirmation
    bot.on('callback_query', async (ctx) => {
      const data = ctx.callbackQuery?.data || '';
      if (!data.startsWith('alias:') && !data.startsWith('cat:')) return ctx.answerCbQuery();
      if (data.startsWith('cat:set:')) {
        const parts = data.split(':');
        const entryId = Number(parts[2]);
        const cat = parts.slice(3).join(':');
        try {
          const entry = store.getEntryById(entryId);
          if (entry) {
            const pieces = String(entry.description || '').split(/\s+/);
            pieces[0] = cat.toLowerCase();
            await store.updateEntryById(entry.id, { description: pieces.join(' ') });
            await ctx.answerCbQuery({ text: `Category set to ${cat}` });
            await ctx.editMessageText(`Category set to ${cat}.`);
            try { await ctx.telegram.sendMessage(entry.chatId, formatEntryLine(store.getEntryById(entry.id) || entry, config.timezone)); } catch (_) {}
          } else {
            await ctx.answerCbQuery({ text: 'Entry not found' });
          }
        } catch (e) {
          await ctx.answerCbQuery({ text: 'Failed to set category' });
        }
        return;
      }
      const parts = data.split(':');
      // format: alias:yes|no:entryId:token:aiMapped
      const action = parts[1];
      const entryId = Number(parts[2]);
      const token = parts[3];
      const aiMapped = parts.slice(4).join(':');
      try {
        if (action === 'yes') {
          // Persist alias and acknowledge
          const storeAlias = AliasStore.load(config.aliasesPath);
          storeAlias.set(token, aiMapped);
          // Optionally, update entry description to use canonical token (already set earlier)
          await store.persist();
          await ctx.answerCbQuery({ text: `Saved alias ${token} -> ${aiMapped}` });
          await ctx.editMessageText(`Confirmed and saved: '${aiMapped}' for '${token}'.`);
          try {
            const updatedEntry = store.getEntryById(entryId);
            if (updatedEntry) {
              await ctx.telegram.sendMessage(updatedEntry.chatId, formatEntryLine(updatedEntry, config.timezone));
            }
          } catch (_) {}
          return;
        }
        if (action === 'no') {
          // Ask user to send replacement token as a message. Store pending state keyed by user id
          const userId = ctx.from?.id?.toString();
          if (!userId) return ctx.answerCbQuery({ text: 'Unable to capture response.' });
          pendingAliasResponses.set(userId, { entryId, token });
          await ctx.answerCbQuery({ text: 'Please type the replacement word now.' });
          await ctx.editMessageText(`Please type the replacement word for '${token}'.`);
          return;
        }
        // Teach flow callbacks: alias:teach:yes|no:entryId:token
        if (action === 'teach') {
          const teachDecision = parts[2];
          const teachEntryId = Number(parts[3]);
          const teachToken = parts.slice(4).join(':');
          const userId = ctx.from?.id?.toString();
          if (!userId) return ctx.answerCbQuery({ text: 'Unable to capture response.' });
          if (teachDecision === 'yes') {
            // Ask the user to type the canonical word; store a pending state that includes parsed snapshot
            // The pendingAliasResponses handler will accept state.parsed to create the entry after replacement
            // We can't serialize the parsed message here without the full message context; instead ask the user to re-send a single-word replacement
            pendingAliasResponses.set(userId, { entryId: teachEntryId, token: teachToken });
            await ctx.answerCbQuery({ text: `Please type the canonical word for '${teachToken}' now.` });
            await ctx.editMessageText(`Please type the canonical word for '${teachToken}' now.`);
            return;
          }
          if (teachDecision === 'no') {
            // User chose to save as-is — create an entry with code MISC (or default amount-first code)
            try {
              // We already created the entry as-is; simply acknowledge and keep the record unchanged.
              await ctx.answerCbQuery({ text: `Saved as-is. You can still use /alias to teach '${teachToken}' later.` });
              await ctx.editMessageText(`Saved as-is. You can still use /alias to teach '${teachToken}' later.`);
              // Also show the recorded line so the user sees confirmation
              try {
                const saved = store.getEntryById(teachEntryId);
                if (saved) {
                  await ctx.reply(formatEntryLine(saved, config.timezone));
                }
              } catch (_) {}
            } catch (_) {}
            return;
          }
        }
      } catch (e) {
        console.error('Failed to handle alias callback', e);
        try { await ctx.answerCbQuery({ text: 'Failed to process response' }); } catch (_) {}
      }
    });

    

  return bot;
};
module.exports = {
  createBot,
};
