const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

// If these are set (see README — Upstash free tier), state is stored there instead of
// on local disk, so it survives free-host restarts/spin-downs. Without them, falls
// back to a local file — handy for testing on your own machine first.
const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_KEY = 'fencing-checkin-data';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function defaultData() { return { roster: [], log: [], config: null, coachPin: null, sheetsWebAppUrl: null }; }

async function loadData() {
  if (KV_URL) {
    try {
      const res = await fetch(`${KV_URL}/get/${KV_KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const json = await res.json();
      return json.result ? JSON.parse(json.result) : defaultData();
    } catch (e) {
      console.error('Could not reach Upstash, starting with empty state:', e.message);
      return defaultData();
    }
  }
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return defaultData();
}
async function saveData() {
  if (KV_URL) {
    try {
      await fetch(`${KV_URL}/set/${KV_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(data)
      });
    } catch (e) { console.error('Upstash save failed (will retry on next write):', e.message); }
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = defaultData(); // replaced by loadData() before the server starts listening

// ---------- helpers ----------
function slug(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
}
function randSeed() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function tickFor(interval) { return Math.floor(Date.now() / 1000 / interval); }
function rotatingCodeFor(seed, tick) { return String(hashStr(seed + ':' + tick) % 10000).padStart(4, '0'); }

async function ensureConfig() {
  if (!data.config) {
    data.config = { mode: 'static', staticCode: String(Math.floor(1000 + Math.random() * 9000)), seed: randSeed(), interval: 8 };
    await saveData();
  }
}
function currentDisplayCode() {
  const cfg = data.config;
  return cfg.mode === 'static' ? cfg.staticCode : rotatingCodeFor(cfg.seed, tickFor(cfg.interval || 8));
}
function isValidCode(code) {
  const cfg = data.config;
  if (cfg.mode === 'static') return code === cfg.staticCode;
  const t = tickFor(cfg.interval || 8);
  return [0, -1, 1].some(dt => rotatingCodeFor(cfg.seed, t + dt) === code);
}
function currentStatusMap() {
  const map = {};
  for (const e of data.log) { if (!(e.id in map)) map[e.id] = e; }
  return map;
}
function requireCoach(req, res, next) {
  if (!data.coachPin) return res.status(403).json({ error: 'PIN not set yet' });
  if (req.headers['x-coach-pin'] !== data.coachPin) return res.status(401).json({ error: 'Invalid PIN' });
  next();
}

// ---------- public endpoints (fencer-facing) ----------
app.get('/api/state', async (req, res) => {
  await ensureConfig();
  res.json({
    roster: data.roster,
    log: data.log.slice(0, 500),
    code: currentDisplayCode(),
    mode: data.config.mode,
    interval: data.config.interval,
    hasCoachPin: !!data.coachPin
  });
});

app.get('/api/qr.svg', async (req, res) => {
  await ensureConfig();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${host}/?code=${currentDisplayCode()}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: parseInt(req.query.size) || 260 });
  res.type('image/svg+xml').send(svg);
});

app.post('/api/checkin', async (req, res) => {
  await ensureConfig();
  const { name, code } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ ok: false, msg: 'Enter your name.' });
  if (!isValidCode(String(code || '').trim())) return res.status(400).json({ ok: false, msg: 'Incorrect or expired code.' });

  let fencer = data.roster.find(f => f.name.toLowerCase() === name.trim().toLowerCase());
  if (!fencer) { fencer = { id: slug(name), name: name.trim() }; data.roster.push(fencer); }

  const statusMap = currentStatusMap();
  const isIn = statusMap[fencer.id]?.action === 'in';
  const action = isIn ? 'out' : 'in';
  const entry = { id: fencer.id, name: fencer.name, action, time: new Date().toISOString(), synced: false };
  data.log.unshift(entry);
  await saveData();
  res.json({ ok: true, msg: `Checked ${action}, ${fencer.name}.`, action });

  syncOneToSheets(entry).catch(() => {}); // fire-and-forget, never blocks check-in if offline
});

// ---------- coach endpoints (PIN-gated) ----------
app.post('/api/coach/setup-pin', async (req, res) => {
  if (data.coachPin) return res.status(400).json({ error: 'PIN already set' });
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  data.coachPin = pin; await saveData();
  res.json({ ok: true });
});
app.post('/api/coach/login', (req, res) => {
  res.json({ ok: (req.body || {}).pin === data.coachPin, hasPin: !!data.coachPin });
});
app.get('/api/coach/full-log', requireCoach, (req, res) => res.json({ log: data.log }));
app.post('/api/coach/config', requireCoach, async (req, res) => {
  await ensureConfig();
  Object.assign(data.config, req.body || {});
  await saveData();
  res.json({ ok: true, config: data.config });
});
app.post('/api/coach/regen-code', requireCoach, async (req, res) => {
  await ensureConfig();
  if (data.config.mode === 'static') data.config.staticCode = String(Math.floor(1000 + Math.random() * 9000));
  else data.config.seed = randSeed();
  await saveData();
  res.json({ ok: true, code: currentDisplayCode() });
});
app.delete('/api/coach/roster/:id', requireCoach, async (req, res) => {
  data.roster = data.roster.filter(f => f.id !== req.params.id);
  await saveData();
  res.json({ ok: true });
});
app.post('/api/coach/add-fencer', requireCoach, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!data.roster.some(f => f.name.toLowerCase() === name.trim().toLowerCase())) {
    data.roster.push({ id: slug(name), name: name.trim() });
    await saveData();
  }
  res.json({ ok: true });
});
app.get('/api/coach/sheets-url', requireCoach, (req, res) => res.json({ url: data.sheetsWebAppUrl || '' }));
app.post('/api/coach/sheets-url', requireCoach, async (req, res) => {
  data.sheetsWebAppUrl = (req.body || {}).url || null;
  await saveData();
  res.json({ ok: true });
});
app.post('/api/coach/sync-sheets', requireCoach, async (req, res) => {
  res.json(await syncAllToSheets());
});

// ---------- Google Sheets sync (via a free Apps Script Web App — see google-apps-script/Code.gs) ----------
async function syncOneToSheets(entry) {
  if (!data.sheetsWebAppUrl) return;
  try {
    const r = await fetch(data.sheetsWebAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: entry.name, action: entry.action, time: entry.time })
    });
    if (r.ok) { entry.synced = true; await saveData(); }
  } catch (e) { /* offline right now — will retry on next check-in or manual sync */ }
}
async function syncAllToSheets() {
  if (!data.sheetsWebAppUrl) return { ok: false, msg: 'No Google Sheet connected yet.' };
  const pending = data.log.filter(e => !e.synced).slice().reverse(); // oldest first
  let sent = 0;
  for (const entry of pending) {
    try {
      const r = await fetch(data.sheetsWebAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.name, action: entry.action, time: entry.time })
      });
      if (r.ok) { entry.synced = true; sent++; } else break;
    } catch (e) { break; }
  }
  await saveData();
  return { ok: true, sent, remaining: data.log.filter(e => !e.synced).length };
}

(async () => {
  data = await loadData();
  await ensureConfig();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Fencing check-in server running on port ${PORT}`);
    console.log(KV_URL ? 'Storage: Upstash (persistent across restarts)' : 'Storage: local data.json (fine for testing, not for a real free-host deploy)');
  });
})();
