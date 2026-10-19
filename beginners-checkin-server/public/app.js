let mode = 'checkin';
let hasCoachPin = false;
let coachPin = localStorage.getItem('beginnersCoachPin') || null;
let coach = null;            // last /api/coach/state response
let coachSelectedDate = null; // defaults to the server's "today"
let qrTimer = null;

const app = document.getElementById('app');
let prefillCode = new URLSearchParams(location.search).get('code') || '';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = {};
  try { body = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, body };
}
function coachHeaders() { return { 'Content-Type': 'application/json', 'X-Coach-Pin': coachPin || '' }; }
function setCoachPin(pin) { coachPin = pin; localStorage.setItem('beginnersCoachPin', pin); }

// The QR endpoint is coach-only, so it can't be loaded with a plain <img src>.
async function loadQr(el, size) {
  const res = await fetch(`/api/coach/qr.svg?size=${size}`, { headers: coachHeaders() });
  if (res.ok && el.isConnected) el.innerHTML = await res.text();
}

// ---------------- CHECK-IN VIEW ----------------
function renderCheckin() {
  clearInterval(qrTimer);
  app.innerHTML = `
    <div class="top">
      <div class="club">On <b>The Strip</b> · Beginners Class Check-In</div>
      <div class="mode-link" id="coachLink">Coach view</div>
    </div>
    <div class="checkin-card">
      <div class="hint">Scan the QR code in the room, or enter the code posted by your coach. Then start typing your name and tap it when it appears.</div>
      <div class="field-row">
        <div class="field"><label for="fName">Name</label><input id="fName" placeholder="Start typing your name" autocomplete="off"><div class="suggestions" id="sugg"></div></div>
        <div class="field code"><label for="fCode">Code</label><input id="fCode" placeholder="0000" inputmode="numeric" maxlength="4" value="${esc(prefillCode)}"></div>
      </div>
      <div class="submit-row"><button class="submit-btn" id="submitBtn">Check in</button><div class="msg" id="msg"></div></div>
    </div>
  `;
  document.getElementById('coachLink').onclick = () => { mode = hasCoachPin ? 'coach-gate' : 'coach-setup'; render(); };

  const fName = document.getElementById('fName');
  const suggBox = document.getElementById('sugg');
  const msgEl = document.getElementById('msg');
  let lookup = 0;

  fName.addEventListener('input', async () => {
    fName.classList.remove('picked');
    msgEl.textContent = '';
    const q = fName.value.trim();
    const mine = ++lookup;
    if (q.length < 2) { suggBox.innerHTML = ''; return; }
    const { body } = await api('/api/names?q=' + encodeURIComponent(q));
    if (mine !== lookup) return; // a newer keystroke already asked
    const names = body.names || [];
    suggBox.innerHTML = names.length
      ? names.map(n => `<div class="sugg" data-n="${esc(n)}">${esc(n)}</div>`).join('')
      : `<div class="sugg-none">No one on the class list matches that. Check the spelling, or ask a coach to add you.</div>`;
    suggBox.querySelectorAll('.sugg').forEach(el => el.onclick = () => {
      fName.value = el.dataset.n;
      fName.classList.add('picked');
      suggBox.innerHTML = '';
      lookup++;
    });
  });
  fName.focus();

  document.getElementById('submitBtn').onclick = async () => {
    const { body } = await api('/api/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fName.value, code: document.getElementById('fCode').value })
    });
    msgEl.textContent = body.msg || 'Something went wrong.';
    msgEl.className = 'msg ' + (body.ok ? 'ok' : 'err');
    if (body.ok) { fName.value = ''; fName.classList.remove('picked'); suggBox.innerHTML = ''; }
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
  document.getElementById('backLink').onclick = () => { mode = 'checkin'; render(); };
  document.getElementById('setPinBtn').onclick = async () => {
    const v = document.getElementById('pinInput').value.trim();
    if (!v) return;
    const { ok } = await api('/api/coach/setup-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: v }) });
    if (ok) { setCoachPin(v); hasCoachPin = true; mode = 'coach'; render(); }
  };
}
function renderCoachGate() {
  app.innerHTML = `<div class="gate">
    <h2>Coach access</h2>
    <p>Enter the coach PIN to see attendance and manage the class list.</p>
    <input id="pinInput" maxlength="6" inputmode="numeric" placeholder="••••">
    <button id="enterBtn">Enter</button>
    <div class="msg err" id="gateMsg" style="margin-top:10px"></div>
    <div class="mode-link" style="margin-top:14px;display:inline-block" id="backLink">← Back to check-in</div>
  </div>`;
  document.getElementById('backLink').onclick = () => { mode = 'checkin'; render(); };
  document.getElementById('enterBtn').onclick = async () => {
    const v = document.getElementById('pinInput').value.trim();
    const { body } = await api('/api/coach/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: v }) });
    if (body.ok) { setCoachPin(v); mode = 'coach'; render(); }
    else document.getElementById('gateMsg').textContent = 'Incorrect PIN.';
  };
}

// ---------------- COACH DASHBOARD ----------------
async function refreshCoach() {
  const { ok, body } = await api('/api/coach/state', { headers: coachHeaders() });
  if (ok) coach = body;
  return ok;
}

async function renderCoach() {
  clearInterval(qrTimer);
  if (!(await refreshCoach())) { mode = 'coach-gate'; render(); return; }
  if (!coachSelectedDate) coachSelectedDate = coach.today;
  const day = coachSelectedDate;

  const presentIds = new Set(coach.log.filter(e => e.day === day).map(e => e.id));
  const totals = {};
  for (const e of coach.log) totals[e.id] = (totals[e.id] || 0) + 1;
  const rows = coach.roster.slice().sort((a, b) => a.name.localeCompare(b.name));
  const presentCount = rows.filter(f => presentIds.has(f.id)).length;

  app.innerHTML = `
    <div class="top">
      <div class="club">On <b>The Strip</b> · Beginners Coach Dashboard</div>
      <div class="mode-link" id="backLink">Exit to check-in</div>
    </div>
    <div class="scoreboard"><div class="num">${presentCount}</div><div class="label">of ${rows.length} present<br>${day === coach.today ? 'today' : esc(day)}</div></div>

    <div class="verify-panel">
      <div class="verify-tabs">
        <button data-m="static" class="${coach.mode === 'static' ? 'active' : ''}">Static code / QR</button>
        <button data-m="rotating" class="${coach.mode === 'rotating' ? 'active' : ''}">Rotating QR</button>
      </div>
      <div class="verify-body">
        <div class="verify-qr" id="qrBox"></div>
        <div class="verify-info">
          <div class="code-num" id="codeNum">${esc(coach.code)}</div>
          <div class="note" id="verifyNote"></div>
          <div class="verify-row" id="verifyControls"></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="section-label"><span class="dot"></span>Class list</div>
      <div class="note">Only names on this list can check in. Paste one name per line; names already on the list are skipped.</div>
      <div class="row">
        <textarea id="namesInput" placeholder="Jordan Lee&#10;Sam Patel&#10;Alex Chen"></textarea>
        <button class="primary" id="addNamesBtn">Add to list</button>
      </div>
      <div class="sync-status" id="rosterStatus"></div>
    </div>

    <div class="coach-toolbar">
      <input type="date" id="dateInput" value="${esc(day)}" aria-label="Class date">
      <input type="text" id="filterInput" placeholder="Filter by name…">
      <button id="csvBtn">Export CSV</button>
    </div>
    <div class="table-scroll">
      <table class="roster-table"><thead><tr><th>Name</th><th>${day === coach.today ? 'Today' : esc(day)}</th><th>Classes attended</th><th></th></tr></thead>
        <tbody id="rosterBody"></tbody></table>
    </div>

    <div class="panel">
      <div class="section-label"><span class="dot"></span>Google Sheet sync</div>
      <div class="note">Paste the Apps Script Web App URL (see google-apps-script/Code.gs in this app's folder) so every check-in and the class list mirror to your sheet. ${coach.pending} check-in(s) waiting to sync.</div>
      <div class="row">
        <input type="text" id="sheetsUrlInput" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(coach.sheetsUrl)}">
        <button id="saveSheetsBtn">Save</button>
        <button id="syncNowBtn">Sync now</button>
      </div>
      <div class="sync-status" id="syncStatus"></div>
    </div>

    <div class="panel">
      <div class="section-label"><span class="dot"></span>Coach PIN</div>
      <div class="note">Changing it signs out anyone using the old PIN on another device.</div>
      <div class="row">
        <input type="text" id="newPinInput" maxlength="6" inputmode="numeric" placeholder="New PIN">
        <button id="changePinBtn">Change PIN</button>
      </div>
      <div class="sync-status" id="pinStatus"></div>
    </div>
  `;

  document.getElementById('backLink').onclick = () => { mode = 'checkin'; render(); };
  loadQr(document.getElementById('qrBox'), 140);

  // ----- verification code / QR -----
  const note = document.getElementById('verifyNote');
  const controls = document.getElementById('verifyControls');
  if (coach.mode === 'static') {
    note.textContent = 'Post this code or QR where the class can see it. Make a new one whenever you want to invalidate the old one.';
    controls.innerHTML = `<button id="newCodeBtn">New code</button><button id="presentBtn">Present fullscreen</button>`;
    document.getElementById('newCodeBtn').onclick = async () => {
      await api('/api/coach/regen-code', { method: 'POST', headers: coachHeaders() });
      renderCoach();
    };
  } else {
    note.textContent = `Refreshes every ${coach.interval}s automatically. Put a phone or tablet on a stand and use Present fullscreen.`;
    controls.innerHTML = `
      <select id="intervalSelect" aria-label="Refresh interval">
        ${[5, 8, 15].map(s => `<option value="${s}" ${coach.interval == s ? 'selected' : ''}>Every ${s}s</option>`).join('')}
      </select>
      <button id="presentBtn">Present fullscreen</button>
      <button id="reseedBtn">Regenerate secret</button>`;
    document.getElementById('intervalSelect').onchange = async (e) => {
      await api('/api/coach/config', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ interval: parseInt(e.target.value, 10) }) });
      renderCoach();
    };
    document.getElementById('reseedBtn').onclick = async () => {
      await api('/api/coach/regen-code', { method: 'POST', headers: coachHeaders() });
      renderCoach();
    };
    let shown = coach.code;
    qrTimer = setInterval(async () => {
      if (!(await refreshCoach()) || coach.code === shown) return;
      shown = coach.code;
      const codeEl = document.getElementById('codeNum'), qrBox = document.getElementById('qrBox');
      if (!codeEl || !qrBox) { clearInterval(qrTimer); return; }
      codeEl.textContent = shown;
      loadQr(qrBox, 140);
    }, 1000);
  }
  document.getElementById('presentBtn').onclick = () => { mode = 'coach-present'; render(); };
  app.querySelectorAll('.verify-tabs button').forEach(btn => {
    btn.onclick = async () => {
      await api('/api/coach/config', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ mode: btn.dataset.m }) });
      renderCoach();
    };
  });

  // ----- class list -----
  document.getElementById('addNamesBtn').onclick = async () => {
    const names = document.getElementById('namesInput').value;
    const { ok, body } = await api('/api/coach/roster', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ names }) });
    if (!ok) { document.getElementById('rosterStatus').textContent = body.error || 'Could not add names.'; return; }
    await renderCoach();
    document.getElementById('rosterStatus').textContent = `Added ${body.added}.` + (body.skipped ? ` ${body.skipped} already on the list.` : '');
  };

  function renderRows(filter) {
    const f = (filter || '').toLowerCase();
    const list = rows.filter(r => r.name.toLowerCase().includes(f));
    const tbody = document.getElementById('rosterBody');
    tbody.innerHTML = list.map(r => {
      const here = presentIds.has(r.id);
      return `<tr>
        <td>${esc(r.name)}</td>
        <td><span class="status-pill ${here ? 'in' : 'out'}"><span class="light"></span>${here ? 'Present' : 'Absent'}</span></td>
        <td class="mono">${totals[r.id] || 0}</td>
        <td><span class="remove-x" data-id="${esc(r.id)}" title="Remove from class list" role="button" aria-label="Remove ${esc(r.name)}">×</span></td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" class="empty">${rows.length ? 'No names match.' : 'The class list is empty. Paste names above to get started.'}</td></tr>`;
    tbody.querySelectorAll('.remove-x').forEach(el => el.onclick = () => askRemove(el.dataset.id));
  }
  renderRows('');
  document.getElementById('filterInput').addEventListener('input', (e) => renderRows(e.target.value));
  document.getElementById('dateInput').onchange = (e) => { coachSelectedDate = e.target.value || coach.today; renderCoach(); };

  document.getElementById('csvBtn').onclick = () => {
    const sorted = coach.log.slice().sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
    const lines = [['Name', 'Date']].concat(sorted.map(e => [e.name, e.day]));
    const csv = lines.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'beginners-attendance.csv';
    a.click();
  };

  // ----- sheets + PIN -----
  document.getElementById('saveSheetsBtn').onclick = async () => {
    const url = document.getElementById('sheetsUrlInput').value.trim();
    await api('/api/coach/sheets-url', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ url }) });
    document.getElementById('syncStatus').textContent = 'Saved.';
  };
  document.getElementById('syncNowBtn').onclick = async () => {
    const status = document.getElementById('syncStatus');
    status.textContent = 'Syncing…';
    const { body } = await api('/api/coach/sync-sheets', { method: 'POST', headers: coachHeaders() });
    status.textContent = body.ok ? `Class list synced. Sent ${body.sent} check-in(s), ${body.remaining} still pending.` : (body.msg || 'Sync failed.');
  };
  document.getElementById('changePinBtn').onclick = async () => {
    const status = document.getElementById('pinStatus');
    const newPin = document.getElementById('newPinInput').value.trim();
    if (!newPin) { status.textContent = 'Enter a new PIN first.'; return; }
    const { ok, body } = await api('/api/coach/change-pin', { method: 'POST', headers: coachHeaders(), body: JSON.stringify({ newPin }) });
    if (ok) { setCoachPin(newPin); document.getElementById('newPinInput').value = ''; status.textContent = 'PIN changed.'; }
    else status.textContent = body.error || 'Could not change PIN.';
  };
}

function askRemove(id) {
  const f = coach.roster.find(x => x.id === id);
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal">
    <p>Remove <b>${esc(f ? f.name : 'this person')}</b> from the class list? They won't be able to check in, but their past attendance stays on record.</p>
    <div class="row"><button id="cancelRm">Cancel</button><button class="danger" id="confirmRm">Remove</button></div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#cancelRm').onclick = () => el.remove();
  el.querySelector('#confirmRm').onclick = async () => {
    await api(`/api/coach/roster/${encodeURIComponent(id)}`, { method: 'DELETE', headers: coachHeaders() });
    el.remove();
    renderCoach();
  };
}

// ---------------- PRESENT (FULLSCREEN QR) ----------------
function renderPresent() {
  clearInterval(qrTimer);
  const sub = () => coach.mode === 'rotating' ? `refreshes every ${coach.interval}s` : 'code ' + coach.code;
  app.innerHTML = `<div class="present-screen">
    <button class="exit-btn" id="exitPresent">Exit</button>
    <div class="club-label">Beginners Class · Scan to check in</div>
    <div class="qr-box" id="qrBoxP"></div>
    <div class="sub" id="codeSubP">${esc(sub())}</div>
  </div>`;
  document.getElementById('exitPresent').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); mode = 'coach'; render(); };
  try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
  loadQr(document.getElementById('qrBoxP'), 260);

  let shown = coach.code;
  qrTimer = setInterval(async () => {
    const box = document.getElementById('qrBoxP');
    if (!box) { clearInterval(qrTimer); return; }
    if (!(await refreshCoach()) || coach.code === shown) return;
    shown = coach.code;
    loadQr(box, 260);
    document.getElementById('codeSubP').textContent = sub();
  }, 1000);
}

function render() {
  if (mode === 'checkin') renderCheckin();
  else if (mode === 'coach-setup') renderCoachSetup();
  else if (mode === 'coach-gate') renderCoachGate();
  else if (mode === 'coach') renderCoach();
  else if (mode === 'coach-present') renderPresent();
}

(async () => {
  const { body } = await api('/api/state');
  hasCoachPin = !!body.hasCoachPin;
  render();
})();
