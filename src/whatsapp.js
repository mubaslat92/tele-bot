const express = require("express");
const crypto = require("crypto");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);
const { parseLedgerMessage } = require("./shared/parse");
const { generateMonthlyReport } = require("./report");

function verifySignature(req, appSecret) {
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", appSecret);
  const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

function whatsappServer({ store, config }) {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));
  // Serve reports statically so we can send document links
  if (config.reportsDir) {
    app.use("/files", express.static(config.reportsDir));
  }

  // Verify webhook
  app.get("/whatsapp/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config.whatsappVerifyToken) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Receive messages
  app.post("/whatsapp/webhook", async (req, res) => {
    if (config.whatsappAppSecret && !verifySignature(req, config.whatsappAppSecret)) {
      return res.sendStatus(403);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;
    const phoneNumberId = change?.value?.metadata?.phone_number_id;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.sendStatus(200);
    }

    for (const msg of messages) {
      if (msg.type !== "text") continue;
      const from = msg.from; // wa id
      const text = msg.text?.body || "";

      // Support on-demand report: "report" or "/report" or with YYYY-MM
      const command = text.trim();
      const m = command.match(/^\/?report(?:\s+(\d{4})-(\d{1,2}))?$/i);
      if (m) {
        const now = dayjs().tz(config.timezone);
        const year = m[1] ? parseInt(m[1], 10) : now.year();
        const month = m[2] ? parseInt(m[2], 10) : now.month() + 1;
        try {
          const report = await generateMonthlyReport({
            store,
            chatId: `wa:${from}`,
            year,
            month,
            reportsDir: config.reportsDir,
            timezoneName: config.timezone,
          });
          const filename = require("path").basename(report.filePath);
          const base = process.env.WHATSAPP_PUBLIC_BASE || `http://localhost:${config.whatsappPort}`;
          const link = `${base}/files/${encodeURIComponent(filename)}`;
          await sendWhatsAppText(config, phoneNumberId, from, `Preparing report for ${year}-${String(month).padStart(2, "0")}...`);
          await module.exports.sendWhatsAppDocumentLink(config, phoneNumberId, from, link, filename);
          await sendWhatsAppText(
            config,
            phoneNumberId,
            from,
            `Entries: ${report.entriesCount}\nTotal: ${report.grandTotal.toFixed(2)}`,
          );
        } catch (e) {
          await sendWhatsAppText(config, phoneNumberId, from, `Couldn't generate report: ${e?.message || e}`);
        }
        continue;
      }
  const parsed = parseLedgerMessage(text);

      if (parsed.error) {
        await sendWhatsAppText(config, phoneNumberId, from, parsed.error);
        continue;
      }

      const createdAt = dayjs().toISOString();
      await store.addEntry({
        chatId: `wa:${from}`,
        userId: `wa:${from}`,
        code: parsed.code,
        amount: parsed.amount,
        currency: parsed.currency,
        description: parsed.description,
        createdAt,
      });

      await sendWhatsAppText(
        config,
        phoneNumberId,
        from,
        `Recorded ${parsed.code} ${parsed.amount}` + (parsed.currency ? ` ${parsed.currency}` : "") + (parsed.description ? ` - ${parsed.description}` : ""),
      );
    }

    return res.sendStatus(200);
  });

  return app;
}

async function sendWhatsAppText(config, phoneNumberId, to, text) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const axios = require("axios");
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
    },
  );
}

module.exports = { whatsappServer };
module.exports.sendWhatsAppText = sendWhatsAppText;
module.exports.sendWhatsAppDocumentLink = async function sendWhatsAppDocumentLink(config, phoneNumberId, to, link, filename) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const axios = require("axios");
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { link, filename },
    },
    {
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
    },
  );
};
