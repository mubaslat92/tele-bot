#!/usr/bin/env node
// Worker: process pending OCR/transcription jobs written by the bot to data/pending_jobs.json
// Usage: node scripts/process_pending_jobs.js

const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');
const config = require('../src/config');
const LedgerStore = require('../src/db');
const child_process = require('child_process');
const axios = require('axios');

async function loadStore() {
  const dbPath = config.dbPath;
  return LedgerStore.create(dbPath);
}

function loadPending(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch (e) {
    console.error('Failed to read pending file', e);
    return [];
  }
}

function savePending(file, list) {
  try {
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('Failed to write pending file', e);
  }
}

async function downloadTelegramFile(token, fileId, destPath) {
  // Get file info
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) throw new Error('Failed to getFile info: ' + infoRes.status);
  const info = await infoRes.json();
  if (!info || !info.result || !info.result.file_path) throw new Error('Invalid file info');
  const filePath = info.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const r = await fetch(fileUrl);
  if (!r.ok) throw new Error('Failed to download file: ' + r.status);
  const buffer = await r.arrayBuffer();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(buffer));
  return destPath;
}

async function preprocessForOcr(imagePath) {
  try {
    const sharp = require('sharp');
    const outPath = imagePath.replace(/\.[^.]+$/i, '.ocr.png');
    await sharp(imagePath)
      .rotate() // auto-orient
      .grayscale()
      .normalise()
      .sharpen()
      .toFile(outPath);
    return outPath;
  } catch (e) {
    // If sharp not available or fails, fallback to original path
    return imagePath;
  }
}

async function tryOcr(imagePath) {
  try {
    // try to use tesseract.js simple API (recognize) which is robust across versions
    const Tesseract = require('tesseract.js');
    const pre = await preprocessForOcr(imagePath);
    const res = await Tesseract.recognize(pre, 'eng+ara', { tessedit_char_whitelist: '0123456789.,-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ج د ر.$€' });
    const text = res?.data?.text || null;
    if (text) return text;
  } catch (e) {
    console.warn('tesseract.js not available or OCR failed:', e.message || e);
  }
  // try native tesseract CLI as a fallback (recommended on desktop/server)
  try {
    const pre = await preprocessForOcr(imagePath);
    const txt = tryNativeTesseract(pre);
    if (txt) return txt;
  } catch (er) {
    console.warn('Native tesseract CLI not available or failed:', er.message || er);
  }
  return null;
}

function tryNativeTesseract(imagePath) {
  // Run `tesseract <image> stdout -l eng` and return the stdout
  try {
    const out = child_process.execFileSync('tesseract', [imagePath, 'stdout', '-l', 'eng'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return (out || '').toString();
  } catch (e) {
    // execFileSync will throw if tesseract is not installed or returns non-zero
    throw e;
  }
}

async function processJob(store, job, pendingFile) {
  const token = config.telegramToken;
  try {
    const attachmentsDir = path.join(__dirname, '..', 'data', 'attachments');
    if (job.type === 'receipt_ocr' || job.type === 'invoice_ocr' || job.type === 'receipt' || job.type === 'invoice') {
      const fileId = job.fileId;
      // First, download the file to a temporary path to infer extension
      // Telegram file path includes extension; we'll re-use it for storage
      const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
      if (!infoRes.ok) throw new Error('Failed to getFile info: ' + infoRes.status);
      const info = await infoRes.json();
      const tgPath = info?.result?.file_path || `${fileId}`;
      const ext = path.extname(tgPath) || '.dat';
      const dest = path.join(attachmentsDir, `${fileId}${ext}`);
      console.log('Downloading', fileId, 'to', dest);
      await downloadTelegramFile(token, fileId, dest);
      let ocrText = null;
      if (/\.pdf$/i.test(dest)) {
        try {
          const pdfParse = require('pdf-parse');
          const dataBuffer = fs.readFileSync(dest);
          const pdfData = await pdfParse(dataBuffer);
          ocrText = (pdfData && pdfData.text) ? String(pdfData.text) : null;
        } catch (e) {
          console.warn('pdf-parse failed; OCR via tesseract fallback', e?.message || e);
          // As a fallback, attempt image-OCR (will yield nothing for native PDFs but safe to try)
          try { ocrText = await tryOcr(dest); } catch (_) { ocrText = null; }
        }
        // If no embedded text, try rasterizing first page with pdftoppm (Poppler) and OCR the image
        if (!ocrText) {
          try {
            const outPrefix = dest.replace(/\.pdf$/i, '') + '_page';
            child_process.execFileSync('pdftoppm', ['-png', '-r', '300', dest, outPrefix], { stdio: 'ignore' });
            const first = fs.existsSync(outPrefix + '-1.png') ? (outPrefix + '-1.png') : null;
            if (first) {
              const txt = await tryOcr(first);
              if (txt) ocrText = txt;
            }
          } catch (e) {
            console.warn('pdftoppm not available or rasterization failed:', e?.message || e);
          }
        }
      } else {
        ocrText = await tryOcr(dest);
      }
      // Optionally parse OCR text with Ollama into structured fields (vendor, total, date, currency)
      let parsed = null;
      try {
        if (ocrText && config.aiProvider === 'ollama') {
          parsed = await parseReceiptWithOllama(ocrText);
        }
      } catch (e) {
        console.warn('Ollama parsing error:', e.message || e);
        parsed = null;
      }

      // Always persist attachment_path and ocr_text to the entry
  const stmtBase = store.db.prepare('UPDATE entries SET attachment_path = :f, ocr_text = :o, is_invoice = :inv WHERE id = :id');
      stmtBase.run({ ':f': dest, ':o': ocrText || null, ':inv': job.type.includes('invoice') ? 1 : 0, ':id': job.entryId });
      stmtBase.free();

      // If Ollama found a total, write a suggestion instead of directly applying
      if (parsed && parsed.total && !isNaN(Number(parsed.total))) {
        try {
          await store.addSuggestion({ entryId: job.entryId, createdAt: new Date().toISOString(), vendor: parsed.vendor || null, total: Number(parsed.total), currency: parsed.currency || null, date: parsed.date || null, method: 'ollama', note: 'auto by ollama' });
          try { fs.appendFileSync(path.join(__dirname, '..', 'data', 'bot-activity.log'), `${new Date().toISOString()} SUGGESTION entry=${job.entryId} source=ollama total=${parsed.total}\n`); } catch (_) {}
          // Notify upload chat via Telegram that a suggestion is available
          try {
            const sStmt = store.db.prepare('SELECT chat_id as chatId FROM entries WHERE id = :id');
            sStmt.bind({ ':id': job.entryId });
            const sEnt = sStmt.step() ? sStmt.getAsObject() : null;
            sStmt.free();
            if (sEnt && sEnt.chatId && config.telegramToken) {
              await axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: sEnt.chatId, text: `Receipt parsed for entry ${job.entryId}. Please review suggestions in the dashboard.` });
            }
          } catch (_) {}
        } catch (e) {
          console.warn('Failed to save suggestion', e?.message || e);
        }
      } else {
        // Fallback regex extractor
        const fallback = extractTotalFromOcr(ocrText || '');
        if (fallback && typeof fallback.total === 'number') {
          try {
            await store.addSuggestion({ entryId: job.entryId, createdAt: new Date().toISOString(), vendor: null, total: fallback.total, currency: null, date: null, method: 'regex', note: `auto-extract reason=${fallback.reason}` });
            try { fs.appendFileSync(path.join(__dirname, '..', 'data', 'bot-activity.log'), `${new Date().toISOString()} SUGGESTION entry=${job.entryId} source=regex total=${fallback.total}\n`); } catch (_) {}
            try {
              const sStmt = store.db.prepare('SELECT chat_id as chatId FROM entries WHERE id = :id');
              sStmt.bind({ ':id': job.entryId });
              const sEnt = sStmt.step() ? sStmt.getAsObject() : null;
              sStmt.free();
              if (sEnt && sEnt.chatId && config.telegramToken) {
                await axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { chat_id: sEnt.chatId, text: `Receipt parsed (fallback) for entry ${job.entryId}. Please review suggestions in the dashboard.` });
              }
            } catch (_) {}
          } catch (e) {
            console.warn('Failed to save regex suggestion', e?.message || e);
          }
        }
      }
      await store.persist();
      console.log('Processed OCR for entry', job.entryId, parsed ? 'with parsed fields' : 'without parsed fields');
    } else if (job.type === 'transcribe' || job.type === 'voice') {
      const fileId = job.fileId;
      const ext = 'oga';
      const dest = path.join(__dirname, '..', 'data', 'attachments', `${fileId}.${ext}`);
      console.log('Downloading voice', fileId, 'to', dest);
      await downloadTelegramFile(token, fileId, dest);
      // Try OpenAI Whisper (if available)
      let transcript = null;
      if (process.env.OPENAI_API_KEY) {
        try {
          console.log('Attempting OpenAI transcription...');
          const FormData = require('form-data');
          const fs = require('fs');
          const form = new FormData();
          form.append('file', fs.createReadStream(dest));
          form.append('model', 'whisper-1');
          const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body: form, headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
          if (r.ok) {
            const j = await r.json();
            transcript = j.text;
          } else {
            console.warn('OpenAI transcription failed', r.status);
          }
        } catch (e) {
          console.warn('OpenAI transcription error', e?.message || e);
        }
      }
      const stmt = store.db.prepare('UPDATE entries SET attachment_path = :f, voice_text = :v WHERE id = :id');
      stmt.run({ ':f': dest, ':v': transcript, ':id': job.entryId });
      stmt.free();
      await store.persist();
      console.log('Saved voice attachment for entry', job.entryId, transcript ? 'with transcript' : 'without transcript');
    } else {
      console.warn('Unknown job type', job.type);
    }
    return { ok: true };
  } catch (e) {
    console.error('Job failed', job, e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function main() {
  const pendingFile = path.join(__dirname, '..', 'data', 'pending_jobs.json');
  const store = await loadStore();
  const list = loadPending(pendingFile);
  if (!list.length) {
    console.log('No pending jobs');
    return;
  }
  const remaining = [];
  for (const job of list) {
    console.log('Processing job', job);
    const res = await processJob(store, job, pendingFile);
    if (!res.ok) {
      job.error = res.error;
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts < 5) remaining.push(job); else console.warn('Dropping job after attempts', job);
    }
  }
  savePending(pendingFile, remaining);
}

main().catch(e => { console.error(e); process.exit(1); });

// Use Ollama (local) to parse OCR text into JSON fields
async function parseReceiptWithOllama(ocrText) {
  const base = (config.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const url = `${base}/api/chat`;
  // Try first a simple JSON-only prompt, then retry with examples if the first attempt fails
  const makeRequest = async (promptBody) => {
    return axios.post(url, {
      model: config.ollamaModel || 'phi3:mini',
      messages: [
        { role: 'system', content: 'You must output ONLY valid JSON.' },
        { role: 'user', content: promptBody }
      ],
      options: { temperature: 0, num_predict: 3 },
      stream: false
    }, { headers: { 'Content-Type': 'application/json' } });
  };

  const simplePrompt = `You are a strict JSON extractor. Given the OCR text of a receipt, extract {"vendor","total","date","currency"}. Respond ONLY with valid JSON and nothing else. If a field is missing, use null. OCR:\n\n${ocrText}`;
  let resp = await makeRequest(simplePrompt);
  let content = resp.data?.message?.content || resp.data?.choices?.[0]?.message?.content || resp.data?.output;
  if (!content || !content.match(/\{[\s\S]*\}/)) {
    // Retry with an example-driven prompt to encourage well-formed JSON
    const examplePrompt = `Extract vendor, total, date, currency as JSON only. Examples:\n\nOCR: "Some Cafe\nItem A 10.00\nItem B 5.00\nTotal 15.00"\nJSON: {"vendor":"Some Cafe","total":15.00,"date":null,"currency":null}\n\nOCR: "RESTAURANT X\nFUSE TEA 12,50\nTutar 1490,00"\nJSON: {"vendor":"RESTAURANT X","total":1490.00,"date":null,"currency":null}\n\nNow parse this OCR and return ONLY the JSON object (no commentary):\n\nOCR:\n${ocrText}`;
    resp = await makeRequest(examplePrompt);
    content = resp.data?.message?.content || resp.data?.choices?.[0]?.message?.content || resp.data?.output;
  }
  if (!content) throw new Error('No content from Ollama');
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON found in Ollama response');
  const jsonText = m[0];
  const parsed = JSON.parse(jsonText);
  return {
    vendor: parsed.vendor || parsed.merchant || null,
    total: parsed.total || parsed.amount || null,
    date: parsed.date || null,
    currency: parsed.currency || null
  };
}

// Simple regex-based fallback to extract the most plausible total from OCR text
function extractTotalFromOcr(ocrText) {
  if (!ocrText) return null;
  // Normalize Arabic-Indic digits to ASCII 0-9
  const mapDigits = (s) => s.replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
  const normalizedText = mapDigits(ocrText);
  const lines = normalizedText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const candidates = [];
  const normalizeNum = (s) => {
    // Remove non-numeric except ., and , and digits
    const cleaned = s.replace(/[^0-9.,]/g, '');
    if (!cleaned) return null;
    // If both dot and comma exist, assume dot is thousand separator and comma is decimal
    if (cleaned.indexOf('.') !== -1 && cleaned.indexOf(',') !== -1) {
      return parseFloat(cleaned.replace(/\./g, '').replace(/,/g, '.'));
    }
    // If only comma present, treat comma as decimal
    if (cleaned.indexOf(',') !== -1 && cleaned.indexOf('.') === -1) {
      return parseFloat(cleaned.replace(/,/g, '.'));
    }
    // otherwise parse normally
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  // Look for lines with keywords first
  const keyword = /(tutar|total|toplam|subtotal|amount(?:\s+due)?|grand\s+total|total\s+due|balance\s+due|total\s+amount|المجموع|إجمالي|الاجمالي|الإجمالي|المبلغ|المبلغ\s+الإجمالي)/i;
  for (const line of lines) {
    if (keyword.test(line)) {
      const nums = (line.match(/[0-9]+(?:[.,][0-9]{1,3})?/g) || []).map(normalizeNum).filter(n => Number.isFinite(n));
      for (const n of nums) candidates.push({ n, reason: 'keyword', line });
    }
  }

  // If no keyword hits, collect all numeric tokens and pick the largest reasonable one
  if (!candidates.length) {
    for (const line of lines) {
      // Skip lines that look like dates or timestamps heavily
      if (/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(line)) continue;
      const nums = (line.match(/[0-9]+(?:[.,][0-9]{1,3})?/g) || []).map(normalizeNum).filter(n => Number.isFinite(n));
      for (const n of nums) candidates.push({ n, reason: 'number', line });
    }
  }

  if (!candidates.length) return null;
  // pick the largest numeric candidate (most receipts have total as the largest value)
  candidates.sort((a,b) => b.n - a.n);
  // Filter out absurdly large values that are unlikely to be totals (e.g., years or IDs)
  const filtered = candidates.filter(c => c.n > 0 && c.n < 1e7);
  const pool = filtered.length ? filtered : candidates;
  const top = pool[0];
  return { total: top.n, reason: top.reason, line: top.line };
}
