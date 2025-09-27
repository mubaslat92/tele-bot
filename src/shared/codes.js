const CODE_LABELS = {
  F: "Expense",
  RENT: "Rent",
  WAT: "Water",
  ELC: "Electricity",
  MISC: "Miscellaneous",
};

function getCodeLabel(code) {
  if (!code) return null;
  const key = String(code).toUpperCase();
  return CODE_LABELS[key] || null;
}

module.exports = { CODE_LABELS, getCodeLabel };
