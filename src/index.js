const path = require("path");
const cron = require("node-cron");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const config = require("./config");
const LedgerStore = require("./db");
const { createBot } = require("./bot");
const { generateMonthlyReport } = require("./report");
const { createApiApp } = require("./api");
const { whatsappServer, sendWhatsAppDocumentLink } = require("./whatsapp");

dayjs.extend(utc);
dayjs.extend(timezone);

async function main() {
  const store = await LedgerStore.create(config.dbPath);
  let bot = null;

  // Start Dashboard API first so it’s available even if the bot startup hangs
  if (config.dashboardEnabled) {
    const api = createApiApp({ store, config });
    api.listen(config.dashboardPort, () => {
      console.log(`Dashboard API listening on http://0.0.0.0:${config.dashboardPort}`);
      console.log(`Open Dashboard UI at http://localhost:${config.dashboardPort}/dashboard/`);
    });
  }

  if (config.telegramToken) {
    bot = createBot({ config, store });
    // Start bot asynchronously; don’t block API readiness
    startBot(bot)
      .then(() => {
        console.log("Telegram bot started");
        scheduleMonthlyReports({ bot, store });
      })
      .catch((e) => {
        console.error("Failed to start Telegram bot:", e?.message || e);
      });
  } else {
    console.warn("TELEGRAM_BOT_TOKEN is missing; Telegram bot will not start. API/WhatsApp (if enabled) will still run.");
  }

  if (config.dashboardEnabled) {
    const api = createApiApp({ store, config });
    api.listen(config.dashboardPort, () => {
      console.log(`Dashboard API listening on http://0.0.0.0:${config.dashboardPort}`);
    });
  }

  if (config.whatsappEnabled) {
    const app = whatsappServer({ store, config });
    app.listen(config.whatsappPort, () => {
      console.log(`WhatsApp webhook listening on http://0.0.0.0:${config.whatsappPort}/whatsapp/webhook`);
    });
  }

  console.log("Service is up:", {
    telegram: Boolean(bot),
    dashboardApi: Boolean(config.dashboardEnabled),
    whatsapp: Boolean(config.whatsappEnabled),
    mode: process.env.BOT_MODE || "polling",
  });

  if (bot) {
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }
}

async function startBot(bot) {
  const mode = (process.env.BOT_MODE || "polling").toLowerCase();

  if (mode === "webhook") {
    const url = process.env.WEBHOOK_URL;
    const host = process.env.WEBHOOK_HOST || "0.0.0.0";
    const port = Number(process.env.WEBHOOK_PORT || 8080);

    if (!url) {
      throw new Error("WEBHOOK_URL is required when BOT_MODE=webhook");
    }

    await bot.telegram.setWebhook(`${url}/telegram`);
    const express = require("express");
    const app = express();
    app.use(bot.webhookCallback("/telegram"));
    app.listen(port, host, () => {
      console.log(`Listening for Telegram webhooks on http://${host}:${port}`);
    });
  } else {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {
      console.warn("deleteWebhook failed (safe to ignore in polling):", e?.message || e);
    }
    await bot.launch({ dropPendingUpdates: true });
  }
}

function scheduleMonthlyReports({ bot, store }) {
  if (!bot) return; // skip if Telegram bot isn't running
  const dayOfMonth = Number.isInteger(config.monthlyReportDay) ? config.monthlyReportDay : 1;
  const cronExpression = `0 9 ${dayOfMonth} * *`;

  cron.schedule(
    cronExpression,
    async () => {
      const target = dayjs().tz(config.timezone).subtract(1, "month");
      const year = target.year();
      const month = target.month() + 1;
      const chatIds = store.getDistinctChatIds();

      for (const chatId of chatIds) {
        try {
          const report = await generateMonthlyReport({
            store,
            chatId,
            year,
            month,
            reportsDir: config.reportsDir,
            timezoneName: config.timezone,
          });

          if (report.entriesCount === 0) {
            continue;
          }

          if (String(chatId).startsWith("wa:")) {
            if (config.whatsappEnabled) {
              // Build a link to the served file
              const filename = path.basename(report.filePath);
              const link = `${process.env.WHATSAPP_PUBLIC_BASE || "http://localhost:" + config.whatsappPort}/files/${filename}`;
              const to = String(chatId).slice(3);
              await sendWhatsAppDocumentLink(config, process.env.WHATSAPP_PHONE_NUMBER_ID || "", to, link, filename);
            }
          } else {
            await bot.telegram.sendDocument(chatId, {
              source: report.filePath,
              filename: path.basename(report.filePath),
            });
            await bot.telegram.sendMessage(
              chatId,
              `Monthly report ${year}-${String(month).padStart(2, "0")} sent. Total: ${report.grandTotal.toFixed(2)}`,
            );
          }
        } catch (error) {
          console.error(`Failed to send monthly report to chat ${chatId}`, error);
        }
      }
    },
    {
      timezone: config.timezone,
    },
  );
}

main().catch((error) => {
  console.error("Bot encountered an error", error);
  // Do not exit; rely on Telegraf's bot.catch and nodemon for resilience
});
