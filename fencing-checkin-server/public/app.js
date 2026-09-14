let state = { roster: [], log: [], code: '----', mode: 'static', interval: 8, hasCoachPin: false };
let mode = 'fencer';
let coachPin = localStorage.getItem('coachPin') || null;
let coachSelectedDate = new Date().toISOString().slice(0, 10);
let fullLog = [];
let pendingModal = null;
let pollTimer = null, qrTimer = null;

const app = document.getElementById('app');
const urlParams = new URLSearchParams(location.search);
let prefillCode = urlParams.get('code') || '';

function todayStr(d) { return new Date(d).toISOString().slice(0, 10); }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDateTime(iso) { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = {};
  try { body = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, body };
}
function coachHeaders() { return { 'Content-Type': 'application/json', 'X-Coach-Pin': coachPin || '' }; }

async function refreshState() {
  const { ok, body } = await api('/api/state');
  if (ok) { state = body; }
}

function currentStatusMap() {
  const map = {};
  for (const e of state.log) { if (!(e.id in map)) map[e.id] = e; }
  return map;
}

// ---------------- FENCER VIEW ----------------
function renderFencer() {
  const statusMap = currentStatusMap();
  const inList = state.roster.filter(f => statusMap[f.id]?.action === 'in')
    .sort((a, b) => new Date(statusMap[b.id].time) - new Date(statusMap[a.id].time));
  const outList = state.roster.filter(f => statusMap[f.id]?.action !== 'in')
    .sort((a, b) => a.name.localeCompare(b.name));

  const tile = f => {
    const s = statusMap[f.id];
    const st = s?.action === 'in' ? 'in' : 'out';
    const t = s?.time;
    let timeLabel = 'not checked in yet';
    if (st === 'in') timeLabel = 'in since ' + fmtTime(t);
    else if (s?.action === 'dnc') timeLabel = 'D.N.C. · ' + new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
    else if (t) timeLabel = 'out · ' + fmtTime(t);
    return `<div class="tile ${st}" data-name="${f.name.replace(/"/g, '&quot;')}">
      <div class="light"></div>
      <div class="tile-info">
        <div class="tile-name">${f.name}</div>
        <div class="tile-time">${timeLabel}</div>
      </div>
    </div>`;
  };

  app.innerHTML = `
    <div class="top">
      <div class="club">On <b>The Strip</b> · Fencing Practice Check-In</div>
      <div class="mode-link" id="coachLink">Coach view</div>
    </div>
    <div class="scoreboard"><div class="num">${inList.length}</div><div class="label">checked<br>in</div></div>
    <div class="checkin-card">
      <div class="hint">Scan the QR code in the room, or enter your name and the code posted by your coach. This confirms you're actually here — your record can't be edited afterward.</div>
      <div class="field-row">
        <div class="field"><label>Name</label><input id="fName" placeholder="Your full name" autocomplete="off"></div>
        <div class="field code"><label>Code</label><input id="fCode" placeholder="0000" inputmode="numeric" maxlength="4" value="${prefillCode}"></div>
      </div>
      <div class="suggestions" id="sugg"></div>
      <div class="submit-row"><button class="submit-btn" id="submitBtn">Check in / out</button><div class="msg" id="msg"></div></div>
    </div>
    <div class="section-label on"><span class="dot"></span>On the strip (${inList.length})</div>
    <div class="grid">${inList.length ? inList.map(tile).join('') : '<div class="empty">No one checked in yet.</div>'}</div>
    <div class="section-label off"><span class="dot"></span>Off strip (${outList.length})</div>
    <div class="grid">${outList.length ? outList.map(tile).join('') : '<div class="empty">Everyone is checked in.</div>'}</div>
  `;

  document.getElementById('coachLink').onclick = () => { mode = state.hasCoachPin ? 'coach-gate' : 'coach-setup'; render(); };

  const fName = document.getElementById('fName');
  const suggBox = document.getElementById('sugg');
  fName.addEventListener('input', () => {
    const q = fName.value.trim().toLowerCase();
    const matches = q ? state.roster.filter(f => f.name.toLowerCase().includes(q)).slice(0, 6) : [];
    suggBox.innerHTML = matches.map(f => `<div class="sugg" data-n="${f.name.replace(/"/g, '&quot;')}">${f.name}</div>`).join('');
    suggBox.querySelectorAll('.sugg').forEach(el => el.onclick = () => { fName.value = el.dataset.n; suggBox.innerHTML = ''; });
  });
  fName.focus();
  app.querySelectorAll('.tile').forEach(el => el.onclick = () => { fName.value = el.dataset.name; fName.focus(); });

  document.getElementById('submitBtn').onclick = async () => {
    const msgEl = document.getElementById('msg');
    const { body } = await api('/api/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fName.value, code: document.getElementById('fCode').value })
    });
    msgEl.textContent = body.msg || 'Something went wrong.';
    msgEl.className = 'msg ' + (body.ok ? 'ok' : 'err');
    if (body.ok) { prefillCode = ''; await refreshState(); renderFencer(); }
  };
}

// ---------------- COACH GATE / SETUP ----------------
function renderCoachSetup() {
  app.innerHTML = `<div class="gate">
    <h2>Set a coach PIN</h2>
    <p>This gates the coach dashboard. Pick something the coaching staff will remember.</p>
    <input id="pinInput" maxlength="6" inputmode="numeric" placeholder="••••">
    <button id="setPinBtn">Save PIN</button>
    <div class="mode-link" style="margin-top:14px;display:inline-block" id="backLink">← Back to check-in</div>
  </div>`;
  document.getElementById('backLink').onclick = () => { mode = 'fencer'; render(); };
  document.getElementById('setPinBtn').onclick = async () => {
    const v = document.getElementById('pinInput').value.trim();
    if (!v) return;
    const { ok } = await api('/api/coach/setup-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: v }) });
    if (ok) { coachPin = v; localStorage.setItem('coachPin', v); mode = 'coach'; await refreshState(); render(); }
  };
}
function renderCoachGate() {
  app.innerHTML = `<div class="gate">
    <h2>Coach access</h2>
    <p>Enter the coach PIN to see check-in times and manage verification.</p>
    <input id="pinInput" maxlength="6" inputmode="numeric" placeholder="••••">
    <button id="enterBtn">Enter</button>
    <div class="msg err" id="gateMsg" style="margin-top:10px"></div>
    <div class="mode-link" style="margin-top:14px;display:inline-block" id="backLink">← Back to check-in</div>
  </div>`;
  document.getElementById('backLink').onclick = () => { mode = 'fencer'; render(); };
  document.getElementById('enterBtn').onclick = async () => {
    const v = document.getElementById('pinInput').value.trim();
    const { body } = await api('/api/coach/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: v }) });
    if (body.ok) { coachPin = v; localStorage.setItem('coachPin', v); mode = 'coach'; render(); }
    else document.getElementById('gateMsg').textContent = 'Incorrect PIN.';
  };
}

// ---------------- COACH DASHBOARD ----------------
function dayEvents(dateStr) {
  return fullLog.filter(e => todayStr(e.time) === dateStr).sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function renderCoach() {
  clearInterval(qrTimer);
  const { ok, body } = await api('/api/coach/full-log', { headers: coachHeaders() });
  if (!ok) { mode = 'coach-gate'; render(); return; }
  fullLog = body.log;
  const { body: sheetsBody } = await api('/api/coach/sheets-url', { headers: coachHeaders() });
  const sheetsUrl = sheetsBody.url || '';

  const events = dayEvents(coachSelectedDate);
  const statusMap = currentStatusMap();
  const inNow = state.roster.filter(f => statusMap[f.id]?.action === 'in').length;

  const byFencer = {};
  for (const e of events) { byFencer[e.id] = byFencer[e.id] || { name: e.name, events: [] }; byFencer[e.id].events.push(e); }
  const rows = Object.entries(byFencer).map(([id, d]) => {
    let totalMs = 0, lastIn = null, lastOutTime = null, lastOutType = null, openIn = null;
    for (const e of d.events) {
      if (e.action === 'in') { openIn = e.time; lastIn = e.time; }
      else if (e.action === 'out') { lastOutTime = e.time; lastOutType = 'out'; if (openIn) { totalMs += new Date(e.time) - new Date(openIn); openIn = null; } }
      else if (e.action === 'dnc') { lastOutTime = e.time; lastOutType = 'dnc'; openIn = null; }
    }
    return { id, name: d.name, stillIn: statusMap[id]?.action === 'in', lastIn, lastOutTime, lastOutType, mins: Math.round(totalMs / 60000) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const pendingCount = fullLog.filter(e => !e.synced).length;

  app.innerHTML = `
    <div class="top">
      <div class="club">On <b>The Strip</b> · Coach Dashboard</div>
      <div class="mode-link" id="backLink">Exit to check-in</div>
    </div>
    <div class="scoreboard"><div class="num">${inNow}</div><div class="label">on the<br>strip now</div></div>

    <div class="verify-panel">
      <div class="verify-tabs">
        <button data-m="static" class="${state.mode === 'static' ? 'active' : ''}">Static code / QR</button>
        <button data-m="rotating" class="${state.mode === 'rotating' ? 'active' : ''}">Rotating QR</button>
      </div>
      <div class="verify-body">
        <div class="verify-qr"><img id="qrImg" src="/api/qr.svg?size=140&t=${Date.now()}" width="140" height="140"></div>
        <div class="verify-info">
          <div class="code-num" id="codeNum">${state.code}</div>
          <div class="note" id="verifyNote"></div>
          <div class="verify-row" id="verifyControls"></div>
        </div>
      </div>
    </div>

    <div class="sheets-panel">
      <div class="section-label" style="margin:0 0 4px"><span class="dot" style="background:var(--gold)"></span>Google Sheet sync</div>
      <div class="note" style="font-size:12px;color:var(--text-faint)">Paste the Apps Script Web App URL (see google-apps-script/Code.gs in the project) so every check-in mirrors to your sheet. ${pendingCount} event(s) waiting to sync.</div>
      <div class="row">
        <input type="text" id="sheetsUrlInput" placeholder="https://script.google.com/macros/s/.../exec" value="${sheetsUrl}">
        <button id="saveSheetsBtn">Save</button>
        <button id="syncNowBtn">Sync now</button>
      </div>
      <div class="sync-status" id="syncStatus"></div>
    </div>

    <div class="add-fencer-row">
      <input id="newFencerName" placeholder="Add a fencer to the roster…">
      <button id="addFencerBtn">Add</button>
    </div>

    <div class="coach-toolbar">
      <input type="date" id="dateInput" value="${coachSelectedDate}">
      <input type="text" id="filterInput" placeholder="Filter by name…">
      <button id="csvBtn">Export CSV</button>
    </div>

    <table class="roster-table"><thead><tr><th>Fencer</th><th>Status</th><th>Last in</th><th>Last out</th><th>Time on strip</th><th></th></tr></thead>
      <tbody id="rosterBody"></tbody></table>

    <div class="log-feed">
      <div class="section-label"><span class="dot" style="background:var(--gold)"></span>Immutable event log — ${coachSelectedDate}</div>
      <div id="logList"></div>
    </div>
  `;

  document.getElementById('backLink').onclick = () => { mode = 'fencer'; render(); };

  function renderVerifyControls() {
    document.getElementById('codeNum').textContent = state.code;
    const note = document.getElementById('verifyNote');
    const controls = document.getElementById('verifyControls');
    if (state.mode === 'static') {
      note.textContent = 'Post this code or QR where fencers can see it. Regenerate whenever you want to invalidate the old one.';
      controls.innerHTML = `<button id="newCodeBtn">New code</button>`;
      document.getElementById('newCodeBtn').onclick = async () => {
        await api('/api/coach/regen-code', { method: 'POST', headers: coachHeaders() });
        await refreshState(); document.getElementById('codeNum').textContent = state.code;
        document.getElementById('qrImg').src = `/api/qr.svg?size=140&t=${Date.now()}`;
      };
    } else {
      note.textContent = `Refreshes every ${state.interval}s automatically. Put a phone or tablet on the tripod and use Present mode.`;
      controls.innerHTML = `
        <select id="intervalSelect">
          <option value="5" ${state.interval == 5 ? 'selected' : ''}>Every 5s</option>
          <option value="8" ${state.interval == 8 ? 'selected' : ''}>Every 8s</option>
          <option value="15" ${state.interval == 15 ? 'selected' : ''}>Every 15s</option>
        </select>
        <button id="presentBtn">Present fullscreen</button>
        <button id="reseedBtn">Regenerate secret</button>`;
      document.getElementById('intervalSelect').onchange = async (e) => {
        await api('/api/coach/config', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ interval: parseInt(e.target.value, 10) }) });
        await refreshState();
      };
      document.getElementById('presentBtn').onclick = () => { mode = 'coach-present'; render(); };
      document.getElementById('reseedBtn').onclick = async () => {
        await api('/api/coach/regen-code', { method: 'POST', headers: coachHeaders() });
        await refreshState();
      };
    }
  }
  app.querySelectorAll('.verify-tabs button').forEach(btn => {
    btn.onclick = async () => {
      await api('/api/coach/config', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ mode: btn.dataset.m }) });
      await refreshState(); renderCoach();
    };
  });
  renderVerifyControls();
  if (state.mode === 'rotating') {
    qrTimer = setInterval(async () => {
      await refreshState();
      document.getElementById('codeNum').textContent = state.code;
      const img = document.getElementById('qrImg'); if (img) img.src = `/api/qr.svg?size=140&t=${Date.now()}`;
    }, 1000);
  }

  document.getElementById('saveSheetsBtn').onclick = async () => {
    const url = document.getElementById('sheetsUrlInput').value.trim();
    await api('/api/coach/sheets-url', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ url }) });
    document.getElementById('syncStatus').textContent = 'Saved.';
  };
  document.getElementById('syncNowBtn').onclick = async () => {
    document.getElementById('syncStatus').textContent = 'Syncing…';
    const { body } = await api('/api/coach/sync-sheets', { method: 'POST', headers: coachHeaders() });
    document.getElementById('syncStatus').textContent = body.ok ? `Synced ${body.sent} event(s). ${body.remaining} still pending.` : (body.msg || 'Sync failed.');
  };

  document.getElementById('addFencerBtn').onclick = async () => {
    const v = document.getElementById('newFencerName').value.trim();
    if (!v) return;
    await api('/api/coach/add-fencer', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ name: v }) });
    await refreshState(); renderCoach();
  };
  document.getElementById('dateInput').onchange = (e) => { coachSelectedDate = e.target.value; renderCoach(); };
  document.getElementById('csvBtn').onclick = () => {
    const rows2 = [['Name', 'Action', 'Time']].concat(events.map(e => [e.name, e.action === 'dnc' ? 'D.N.C.' : e.action, e.time]));
    const csv = rows2.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fencing-checkin-${coachSelectedDate}.csv`;
    a.click();
  };

  function renderRows(filter) {
    const f = (filter || '').toLowerCase();
    const body = document.getElementById('rosterBody');
    const list = rows.filter(r => r.name.toLowerCase().includes(f));
    body.innerHTML = list.map(r => `<tr>
        <td>${r.name}</td>
        <td><span class="status-pill ${r.stillIn ? 'in' : 'out'}"><span class="light"></span>${r.stillIn ? 'On strip' : 'Off strip'}</span></td>
        <td class="mono">${r.lastIn ? fmtTime(r.lastIn) : '—'}</td>
        <td class="mono">${r.lastOutType === 'dnc' ? 'D.N.C.' : (r.lastOutTime ? fmtTime(r.lastOutTime) : '—')}</td>
        <td class="mono">${r.mins ? r.mins + ' min' : (r.stillIn ? 'in progress' : '—')}</td>
        <td><span class="remove-x" data-id="${r.id}" title="Remove from roster">×</span></td>
      </tr>`).join('') || `<tr><td colspan="6" class="empty">No events for this day yet.</td></tr>`;
    body.querySelectorAll('.remove-x').forEach(el => el.onclick = () => askRemove(el.dataset.id));
  }
  renderRows('');
  document.getElementById('filterInput').addEventListener('input', (e) => renderRows(e.target.value));

  document.getElementById('logList').innerHTML = events.slice().reverse().slice(0, 80).map(e =>
    `<div class="log-entry"><span class="t">${fmtDateTime(e.time)}</span><span class="${e.action === 'in' ? 'a-in' : (e.action === 'dnc' ? 'a-dnc' : 'a-out')}">${e.name} checked ${e.action === 'dnc' ? 'D.N.C.' : e.action}</span></div>`
  ).join('') || '<div class="empty">Nothing logged for this day.</div>';
}

// ---------------- PRESENT (TRIPOD) SCREEN ----------------
function renderPresent() {
  clearInterval(qrTimer);
  app.innerHTML = `<div class="present-screen">
    <button class="exit-btn" id="exitPresent">Exit</button>
    <div class="club-label">On The Strip · Scan to check in / out</div>
    <div class="qr-box"><img id="qrImgP" src="/api/qr.svg?size=260&t=${Date.now()}" width="260" height="260"></div>
    <div class="sub" id="codeSubP">${state.mode === 'rotating' ? `refreshes every ${state.interval}s` : 'code ' + state.code}</div>
  </div>`;
  document.getElementById('exitPresent').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); mode = 'coach'; render(); };
  try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}

  qrTimer = setInterval(async () => {
    await refreshState();
    const img = document.getElementById('qrImgP'); if (!img) { clearInterval(qrTimer); return; }
    img.src = `/api/qr.svg?size=260&t=${Date.now()}`;
    const sub = document.getElementById('codeSubP');
    if (sub) sub.textContent = state.mode === 'rotating' ? `refreshes every ${state.interval}s` : 'code ' + state.code;
  }, 1000);
}

function askRemove(id) {
  const f = state.roster.find(x => x.id === id);
  pendingModal = { id, name: f ? f.name : 'this fencer' };
  renderModal();
}
function renderModal() {
  if (!pendingModal) return;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal">
    <p>Remove <b>${pendingModal.name}</b> from the roster? Their past log entries stay on record.</p>
    <div class="row"><button id="cancelRm">Cancel</button><button class="danger" id="confirmRm">Remove</button></div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#cancelRm').onclick = () => { pendingModal = null; el.remove(); };
  el.querySelector('#confirmRm').onclick = async () => {
    await api(`/api/coach/roster/${pendingModal.id}`, { method: 'DELETE', headers: coachHeaders() });
    pendingModal = null; el.remove(); await refreshState(); renderCoach();
  };
}

function render() {
  if (mode === 'fencer') renderFencer();
  else if (mode === 'coach-setup') renderCoachSetup();
  else if (mode === 'coach-gate') renderCoachGate();
  else if (mode === 'coach') renderCoach();
  else if (mode === 'coach-present') renderPresent();
}

async function init() {
  await refreshState();
  render();
  pollTimer = setInterval(async () => {
    if (mode === 'fencer') { await refreshState(); renderFencer(); }
  }, 4000);
}
init();
