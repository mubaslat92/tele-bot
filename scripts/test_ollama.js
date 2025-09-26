const axios = require('axios');
const config = require('../src/config');

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

(async function main(){
  const token = process.argv[2] || 'rol';
  const base = (config.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const url = `${base}/api/chat`;
  try {
    console.log('Posting to', url, 'model=', config.ollamaModel);
    const { data } = await axios.post(url, {
      model: config.ollamaModel || 'phi3:mini',
      messages: [
        { role: 'system', content: 'You output only one lowercase word.' },
        { role: 'user', content: buildPrompt(token.toLowerCase()) }
      ],
      options: { temperature: 0, num_predict: 5 },
      stream: false,
    }, { headers: { 'Content-Type': 'application/json' } });

    console.log('Raw response:', JSON.stringify(data, null, 2));
    const text = data.message?.content || data.choices?.[0]?.message?.content || null;
    console.log('Extracted text:', text && String(text).trim());
  } catch (e) {
    console.error('Request failed:', e.message || e);
    if (e.response) console.error('Status:', e.response.status, 'Body:', JSON.stringify(e.response.data));
    process.exit(1);
  }
})();
