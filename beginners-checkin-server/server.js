const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3001;

// Same storage scheme as the main team app (Upstash if configured, local file otherwise),
// under a different key so both apps can share one Upstash database without colliding.
const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_KEY = 'beginners-checkin-data';

// Attendance is recorded per calendar day, so the server needs to know the club's local
// day. Hosts run in UTC, where an evening class in the Americas is already "tomorrow".
const TIME_ZONE = process.env.CLUB_TIMEZONE || 'America/Toronto';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function dayKey(date) { return dayFormat.format(date); } // 'yyyy-MM-dd'

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
function cleanName(name) { return String(name).trim().replace(/\s+/g, ' '); }
function findOnRoster(name) {
  const wanted = cleanName(name).toLowerCase();
  return data.roster.find(f => f.name.toLowerCase() === wanted);
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
function requireCoach(req, res, next) {
  if (!data.coachPin) return res.status(403).json({ error: 'PIN not set yet' });
  if (req.headers['x-coach-pin'] !== data.coachPin) return res.status(401).json({ error: 'Invalid PIN' });
  next();
}

// ---------- public endpoints (beginner-facing) ----------
// Deliberately minimal: the room code, the roster and who attended are coach-only.
app.get('/api/state', (req, res) => res.json({ hasCoachPin: !!data.coachPin }));

// Name lookup for the type-and-pick box. Needs 2+ characters and returns a few matches,
// so the page never downloads the whole class list.
app.get('/api/names', (req, res) => {
  const q = cleanName(req.query.q || '').toLowerCase();
  if (q.length < 2) return res.json({ names: [] });
  const matches = data.roster.map(f => f.name).filter(n => n.toLowerCase().includes(q));
  matches.sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.localeCompare(b));
  res.json({ names: matches.slice(0, 8) });
});

app.post('/api/checkin', async (req, res) => {
  await ensureConfig();
  const { name, code } = req.body || {};
  if (!name || !cleanName(name)) return res.status(400).json({ ok: false, msg: 'Type your name and pick it from the list.' });
  if (!isValidCode(String(code || '').trim())) return res.status(400).json({ ok: false, msg: 'Incorrect or expired code.' });

  const fencer = findOnRoster(name);
  if (!fencer) {
    return res.status(400).json({ ok: false, msg: "That name isn't on the class list. Pick your name from the suggestions, or ask a coach to add you." });
  }

  const today = dayKey(new Date());
  if (data.log.some(e => e.id === fencer.id && e.day === today)) {
    return res.json({ ok: true, msg: `Already checked in today, ${fencer.name}.` });
  }
  const entry = { id: fencer.id, name: fencer.name, day: today, time: new Date().toISOString(), synced: false };
  data.log.unshift(entry);
  await saveData();
  res.json({ ok: true, msg: `You're checked in, ${fencer.name}.` });

  syncOneToSheets(entry).catch(() => {}); // fire-and-forget, never blocks check-in if offline
});

// ---------- coach endpoints (PIN-gated) ----------
app.post('/api/coach/setup-pin', async (req, res) => {
  if (data.coachPin) return res.status(400).json({ error: 'PIN already set' });
  const { pin } = req.body || {};
  if (!pin || !String(pin).trim()) return res.status(400).json({ error: 'PIN required' });
  data.coachPin = String(pin).trim(); await saveData();
  res.json({ ok: true });
});
app.post('/api/coach/login', (req, res) => {
  res.json({ ok: !!data.coachPin && (req.body || {}).pin === data.coachPin, hasPin: !!data.coachPin });
});
app.post('/api/coach/change-pin', requireCoach, async (req, res) => {
  const { newPin } = req.body || {};
  if (!newPin || !String(newPin).trim()) return res.status(400).json({ error: 'New PIN required' });
  data.coachPin = String(newPin).trim();
  await saveData();
  res.json({ ok: true });
});
app.get('/api/coach/state', requireCoach, async (req, res) => {
  await ensureConfig();
  res.json({
    roster: data.roster,
    log: data.log,
    today: dayKey(new Date()),
    code: currentDisplayCode(),
    mode: data.config.mode,
    interval: data.config.interval,
    sheetsUrl: data.sheetsWebAppUrl || '',
    pending: data.log.filter(e => !e.synced).length
  });
});
app.get('/api/coach/qr.svg', requireCoach, async (req, res) => {
  await ensureConfig();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${host}/?code=${currentDisplayCode()}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: parseInt(req.query.size) || 260 });
  res.type('image/svg+xml').send(svg);
});
app.post('/api/coach/config', requireCoach, async (req, res) => {
  await ensureConfig();
  const { mode, interval } = req.body || {};
  if (mode === 'static' || mode === 'rotating') data.config.mode = mode;
  if ([5, 8, 15].includes(interval)) data.config.interval = interval;
  await saveData();
  res.json({ ok: true });
});
app.post('/api/coach/regen-code', requireCoach, async (req, res) => {
  await ensureConfig();
  if (data.config.mode === 'static') data.config.staticCode = String(Math.floor(1000 + Math.random() * 9000));
  else data.config.seed = randSeed();
  await saveData();
  res.json({ ok: true });
});
// Accepts one name or a pasted list (one per line).
app.post('/api/coach/roster', requireCoach, async (req, res) => {
  const lines = String((req.body || {}).names || '').split(/\r?\n/).map(cleanName).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Enter at least one name.' });
  let added = 0, skipped = 0;
  for (const name of lines) {
    if (findOnRoster(name)) { skipped++; continue; }
    data.roster.push({ id: slug(name), name });
    added++;
  }
  if (added) { await saveData(); syncRosterToSheets().catch(() => {}); }
  res.json({ ok: true, added, skipped });
});
app.delete('/api/coach/roster/:id', requireCoach, async (req, res) => {
  data.roster = data.roster.filter(f => f.id !== req.params.id);
  await saveData();
  res.json({ ok: true });
  syncRosterToSheets().catch(() => {});
});
app.post('/api/coach/sheets-url', requireCoach, async (req, res) => {
  data.sheetsWebAppUrl = cleanName((req.body || {}).url || '') || null;
  await saveData();
  res.json({ ok: true });
  syncRosterToSheets().catch(() => {}); // a newly connected sheet has no class list yet
});
app.post('/api/coach/sync-sheets', requireCoach, async (req, res) => {
  res.json(await syncAllToSheets());
});

// ---------- Google Sheets sync (see google-apps-script/Code.gs) ----------
async function postToSheets(payload) {
  const r = await fetch(data.sheetsWebAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.ok;
}
// The sheet gets the full class list so it can show people who have never attended.
async function syncRosterToSheets() {
  if (!data.sheetsWebAppUrl) return false;
  try {
    return await postToSheets({ type: 'roster', names: data.roster.map(f => f.name) });
  } catch (e) { return false; }
}
async function syncOneToSheets(entry) {
  if (!data.sheetsWebAppUrl) return;
  try {
    if (await postToSheets({ type: 'checkin', name: entry.name, day: entry.day, time: entry.time })) {
      entry.synced = true;
      await saveData();
    }
  } catch (e) { /* offline right now — retried on the next manual sync */ }
}
async function syncAllToSheets() {
  if (!data.sheetsWebAppUrl) return { ok: false, msg: 'No Google Sheet connected yet.' };
  const rosterOk = await syncRosterToSheets();
  const pending = data.log.filter(e => !e.synced).slice().reverse(); // oldest first
  let sent = 0;
  if (rosterOk) {
    for (const entry of pending) {
      try {
        if (await postToSheets({ type: 'checkin', name: entry.name, day: entry.day, time: entry.time })) { entry.synced = true; sent++; } else break;
      } catch (e) { break; }
    }
    await saveData();
  }
  return { ok: rosterOk, msg: rosterOk ? undefined : 'Could not reach the Google Sheet. Check the Web App URL.', sent, remaining: data.log.filter(e => !e.synced).length };
}

(async () => {
  data = await loadData();
  await ensureConfig();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Beginners check-in server running on port ${PORT} (days counted in ${TIME_ZONE})`);
    console.log(KV_URL ? 'Storage: Upstash (persistent across restarts)' : 'Storage: local data.json (fine for testing, not for a real free-host deploy)');
  });
})();
