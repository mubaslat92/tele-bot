// Generate realistic test data and post to /api/seed
// Usage (PowerShell):
//   $env:DASHBOARD_AUTH_TOKEN='your-token'
//   node .\scripts\generate_test_data.js --start=2024-01-01 --end=today --perDay=3 --chat=seed

const axios = require('axios');
const dayjs = require('dayjs');

const API = process.env.API_ORIGIN || 'http://localhost:8090';
const TOKEN = process.env.DASHBOARD_AUTH_TOKEN || '';

const args = process.argv.slice(2);
function argVal(name, def) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.split('=')[1];
}

const startStr = argVal('start', '2024-01-01');
const endStrRaw = argVal('end', 'today');
const endStr = endStrRaw === 'today' ? dayjs().format('YYYY-MM-DD') : endStrRaw;
const perDay = Number(argVal('perDay', '3'));
const chatId = argVal('chat', 'seed');

const start = dayjs(startStr);
const end = dayjs(endStr);
if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
  console.error('Invalid date range.');
  process.exit(1);
}

const CATS = ['groceries','food','transport','bills','health','rent','misc'];
const DETAILS = {
  groceries: ['apples','veg','meat','milk','bread','supplies','eggs','rice','oil'],
  food: ['lunch','coffee','snack','burger','shawarma','pizza','breakfast'],
  transport: ['taxi','bus','fuel','parking','uber','careem','carwash'],
  bills: ['electricity','water','internet','mobile','subscription','hosting'],
  health: ['meds','pharmacy','clinic','dentist','checkup'],
  rent: ['rent'],
  misc: ['gift','fee','tax','stationery','tools','donation'],
};

function rand(min, max) { return Math.random() * (max - min) + min; }
function randint(min, max) { return Math.floor(rand(min, max + 1)); }
function choice(arr) { return arr[randint(0, arr.length - 1)]; }

function amountFor(cat) {
  switch (cat) {
    case 'groceries': return +(rand(5, 45)).toFixed(2);
    case 'food': return +(rand(2, 25)).toFixed(2);
    case 'transport': return +(rand(1, 15)).toFixed(2);
    case 'bills': return +(rand(10, 120)).toFixed(2);
    case 'health': return +(rand(5, 80)).toFixed(2);
    case 'rent': return +(rand(300, 800)).toFixed(2);
    case 'misc': return +(rand(1, 30)).toFixed(2);
    default: return +(rand(2, 20)).toFixed(2);
  }
}

function salaryEntry(cursor) {
  const ts = cursor.hour(10).minute(0).second(0).millisecond(0).toISOString();
  return {
    code: 'INC',
    amount: 1000,
    currency: 'JOD',
    description: 'misc salary',
    createdAt: ts,
    chatId,
  };
}

async function postChunk(list) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers['authorization'] = `Bearer ${TOKEN}`;
  const res = await axios.post(`${API}/api/seed`, { entries: list }, { headers, timeout: 30000 });
  return res.data;
}

(async () => {
  console.log(`Seeding from ${start.format('YYYY-MM-DD')} to ${end.format('YYYY-MM-DD')} avg ~${perDay}/day`);
  let cursor = start.startOf('day');
  const batch = [];
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    const day = cursor.date();
    const count = Math.max(1, Math.round(rand(perDay - 1, perDay + 1)));

    // daily expenses
    for (let i = 0; i < count; i++) {
      let cat = choice(CATS);
      if (day === 1 && Math.random() < 0.9) cat = 'rent';
      if (day >= 3 && day <= 10 && Math.random() < 0.4) cat = 'bills';
      const detail = choice(DETAILS[cat]);
      const amount = amountFor(cat);
      const hour = randint(8, 21);
      const minute = randint(0, 59);
      const ts = cursor.hour(hour).minute(minute).second(0).millisecond(0).toISOString();
      const currency = Math.random() < 0.07 ? 'USD' : 'JOD';
      batch.push({ code: 'F', amount, currency, description: `${cat} ${detail}`, createdAt: ts, chatId });
    }

    // salary on 25th
    if (day === 25) batch.push(salaryEntry(cursor));

    if (batch.length >= 500) {
      const { inserted } = await postChunk(batch.splice(0));
      console.log('Inserted chunk:', inserted);
    }

    cursor = cursor.add(1, 'day').startOf('day');
  }

  if (batch.length) {
    const { inserted } = await postChunk(batch);
    console.log('Inserted final:', inserted);
  }
  console.log('Seeding complete.');
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
