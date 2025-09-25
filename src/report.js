const fsp = require("fs/promises");
const path = require("path");
const ExcelJS = require("exceljs");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const ensureDir = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const summarizeEntries = (entries) => {
  const totalsByCode = new Map();
  let grandTotal = 0;

  for (const entry of entries) {
    const amount = Number(entry.amount) || 0;
    grandTotal += amount;
    const current = totalsByCode.get(entry.code) ?? 0;
    totalsByCode.set(entry.code, current + amount);
  }

  return {
    grandTotal,
    totalsByCode,
  };
};

const formatCurrency = (value) => {
  return Number.parseFloat((Number(value) || 0).toFixed(2));
};

async function generateMonthlyReport({
  store,
  chatId,
  year,
  month,
  reportsDir,
  timezoneName,
}) {
  await ensureDir(reportsDir);
  console.log("generateMonthlyReport params:", { chatId, year, month, timezoneName });

  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }

  // Build the month range purely in UTC to avoid timezone validity issues
  const startUtc = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endUtc = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  if (!Number.isFinite(startUtc.getTime()) || !Number.isFinite(endUtc.getTime())) {
    throw new Error("Failed to construct date range");
  }
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();
  const entries = store.getEntriesBetween(chatId, startIso, endIso);
  const summary = summarizeEntries(entries);

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Entries");
  sheet.columns = [
    { header: "Date", key: "date", width: 20 },
    { header: "Code", key: "code", width: 10 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Currency", key: "currency", width: 10 },
    { header: "Description", key: "description", width: 40 },
  ];

  for (const entry of entries) {
    const d = dayjs(entry.createdAt);
    const dateStr = d.isValid()
      ? d.tz(timezoneName).format("YYYY-MM-DD HH:mm")
      : "";
    sheet.addRow({
      date: dateStr,
      code: entry.code,
      amount: formatCurrency(entry.amount),
      currency: entry.currency ?? "",
      description: entry.description ?? "",
    });
  }

  if (entries.length === 0) {
    sheet.addRow({ date: "", code: "", amount: "", currency: "", description: "No records" });
  }

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Code", key: "code", width: 15 },
    { header: "Total", key: "total", width: 15 },
  ];

  for (const [code, total] of summary.totalsByCode.entries()) {
    summarySheet.addRow({ code, total: formatCurrency(total) });
  }

  summarySheet.addRow({});
  summarySheet.addRow({ code: "Grand Total", total: formatCurrency(summary.grandTotal) });

  const fileName = `ledger_${year}-${String(month).padStart(2, "0")}.xlsx`;
  const filePath = path.join(reportsDir, fileName);
  await workbook.xlsx.writeFile(filePath);

  return {
    filePath,
    entriesCount: entries.length,
    grandTotal: summary.grandTotal,
    totalsByCode: Object.fromEntries(summary.totalsByCode),
    period: { start: startIso, end: endIso },
  };
}

module.exports = {
  generateMonthlyReport,
};
