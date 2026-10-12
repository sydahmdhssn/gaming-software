// DXL Solutions · Gaming Zone dashboard (no build step, plain ES modules)

const $app = document.getElementById('app');
const $dlg = document.getElementById('dlg');
const $toast = document.getElementById('toast');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  token: store.get('dxl.token'),
  admin: null,
  needsSetup: false,
  snap: null,
  offset: 0, // serverNow - Date.now()
  wsOk: false,
  ws: null,
  view: 'floor',
  customers: [],
  memberQuery: '',
  reportRange: 'today',
  dialog: null, // { type: 'station', id, key, form }
};

const MODE_LABEL = { prepaid: 'Prepaid', open: 'Open', member: 'Member', maintenance: 'Staff' };
const STATUS_LABEL = { available: 'Available', in_use: 'In use', paused: 'Paused', maintenance: 'Staff use', offline: 'Offline' };
const MINUTE_PRESETS = [30, 60, 90, 120, 180];

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serverNow = () => Date.now() + state.offset;
const currency = () => state.snap?.settings.currency ?? 'PKR';
const money = (n) => `${currency()} ${Number(n ?? 0).toLocaleString()}`;
const cost = (minutes, rate) => Math.ceil((minutes * rate) / 60);

function duration(ms, { seconds = true } = {}) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  if (!seconds) return h ? `${h}h ${mm}m` : `${m}m`;
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (t) => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && path !== '/login') {
    signOut(false);
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Wrap an async action: disables nothing, just reports errors.
async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

// Remaining or elapsed time for a station at "now" (server clock).
function timing(st) {
  const s = st.session;
  if (!s) return null;
  const now = serverNow();
  const at = s.pausedAt ?? now;
  const elapsed = s.usedMs + (s.pausedAt ? 0 : now - state.snap.serverNow);
  if (s.endsAt == null) return { elapsed, remaining: null, progress: null };
  const remaining = Math.max(0, s.endsAt - at);
  const total = elapsed + remaining;
  return { elapsed, remaining, progress: total ? elapsed / total : 1 };
}

// ---------- auth ----------

async function boot() {
  const status = await api('/status').catch(() => ({ needsSetup: false }));
  state.needsSetup = status.needsSetup;
  if (state.token) {
    try {
      state.admin = await api('/me');
    } catch {
      state.token = null;
    }
  }
  if (state.token) startApp();
  else renderAuth();
}

function renderAuth(error = '') {
  const setup = state.needsSetup;
  $app.innerHTML = `
    <div class="auth">
      <form class="auth-card stack" id="auth-form">
        <div>
          <div class="wordmark">DXL<small>SOLUTIONS</small></div>
          <div class="kicker">Gaming Zone Manager</div>
          <p>${setup ? 'Create the owner account to set up this venue.' : 'Staff sign in.'}</p>
        </div>
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}"></label>
        <button class="primary" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
        <div class="muted" id="auth-error">${esc(error)}</div>
      </form>
    </div>`;
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api(setup ? '/setup' : '/login', { method: 'POST', body });
      state.token = r.token;
      state.admin = r.admin;
      state.needsSetup = false;
      store.set('dxl.token', r.token);
      startApp();
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  });
}

function signOut(callApi = true) {
  if (callApi) api('/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  state.admin = null;
  state.snap = null;
  store.set('dxl.token', null);
  state.ws?.close();
  state.ws = null;
  if ($dlg.open) $dlg.close();
  renderAuth();
}

// ---------- live connection ----------

function connect() {
  if (!state.token) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') applySnapshot(msg.data);
  };
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    state.wsOk = false;
    renderLive();
    if (e.code === 4001) return signOut(false);
    setTimeout(connect, 2000);
  };
}

function applySnapshot(snap) {
  state.snap = snap;
  state.offset = snap.serverNow - Date.now();
  state.wsOk = true;
  if (state.view === 'floor' || state.view === 'setup') renderView();
  renderLive();
  refreshStationDialog();
}

// ---------- shell ----------

const VIEWS = [
  ['floor', 'Floor'],
  ['members', 'Members'],
  ['reports', 'Reports'],
  ['setup', 'Stations & zones'],
  ['settings', 'Settings'],
];

function startApp() {
  state.view = VIEWS.some(([v]) => v === location.hash.slice(1)) ? location.hash.slice(1) : 'floor';
  $app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <div class="wordmark">DXL<small>SOLUTIONS</small></div>
        <nav class="nav">${VIEWS.map(([v, l]) => `<a href="#${v}" data-view="${v}">${l}</a>`).join('')}</nav>
        <div class="who"><span>Signed in as <b>${esc(state.admin?.username)}</b></span><button class="small" data-act="signout">Sign out</button></div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div>
            <div class="kicker" id="venue-name">Gaming Zone</div>
            <h1 id="view-title"></h1>
          </div>
          <div class="spacer"></div>
          <span class="live" id="live"><i></i><span>Live</span></span>
          <div class="clock" id="clock"></div>
        </div>
        <div id="view"></div>
      </main>
    </div>`;
  connect();
  renderView();
}

function renderLive() {
  const el = document.getElementById('live');
  if (!el) return;
  el.classList.toggle('off', !state.wsOk);
  el.lastElementChild.textContent = state.wsOk ? 'Live' : 'Reconnecting';
  const venue = document.getElementById('venue-name');
  if (venue && state.snap) venue.textContent = state.snap.settings.venueName;
}

function renderView() {
  const view = document.getElementById('view');
  if (!view) return;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === state.view));
  document.getElementById('view-title').textContent = VIEWS.find(([v]) => v === state.view)[1];
  if (state.view === 'floor') view.innerHTML = floorView();
  else if (state.view === 'setup') view.innerHTML = setupView();
  else if (state.view === 'members') loadMembers();
  else if (state.view === 'reports') loadReports();
  else if (state.view === 'settings') view.innerHTML = settingsView();
}

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEWS.some(([k]) => k === v) && state.token) {
    state.view = v;
    renderView();
  }
});

// ---------- floor ----------

function floorView() {
  const snap = state.snap;
  if (!snap) return '<div class="empty">Connecting to the server</div>';
  if (!snap.stations.length) {
    return `<div class="empty">No stations yet. Go to <a href="#setup">Stations & zones</a> to add your zones and PCs.</div>`;
  }
  const count = (status) => snap.stations.filter((s) => s.status === status).length;
  const busy = snap.stations.filter((s) => s.session).length;
  const zones = snap.zones
    .map((z) => ({ ...z, stations: snap.stations.filter((s) => s.zoneId === z.id) }))
    .filter((z) => z.stations.length);

  return `
    <div class="stats">
      <div class="stat"><span class="kicker">Available</span><b>${count('available')}</b></div>
      <div class="stat"><span class="kicker">Playing</span><b>${busy}</b></div>
      <div class="stat"><span class="kicker">Paused</span><b>${count('paused')}</b></div>
      <div class="stat"><span class="kicker">Offline</span><b>${count('offline')}</b></div>
      <div class="stat"><span class="kicker">Occupancy</span><b>${Math.round((busy / snap.stations.length) * 100)}%</b></div>
    </div>
    ${zones.map((z) => `
      <section class="zone">
        <div class="zone-head"><h2>${esc(z.name)}</h2><span class="muted">${money(z.hourly_rate)} per hour</span></div>
        <div class="grid">${z.stations.map(stationCard).join('')}</div>
      </section>`).join('')}`;
}

function stationCard(st) {
  const t = timing(st);
  const s = st.session;
  const ending = t?.remaining != null && t.remaining <= 5 * 60_000 && !s.pausedAt;
  let time = '';
  let sub = st.kind === 'pc' && st.online ? esc(st.agent?.hostname ?? '') : '';
  if (s) {
    time = t.remaining != null ? duration(t.remaining) : duration(t.elapsed);
    const who = s.customerName ? esc(s.customerName) : MODE_LABEL[s.mode];
    sub = `${who} · ${t.remaining != null ? 'left' : 'played'}`;
  }
  return `
    <button class="station ${st.status}${ending ? ' ending' : ''}" data-act="station" data-id="${st.id}">
      <div class="top"><span class="name">${esc(st.name)}</span><span class="tag">${st.kind === 'pc' ? 'PC' : 'Console'}</span></div>
      <span class="state"><i></i>${ending ? 'Ending soon' : STATUS_LABEL[st.status]}</span>
      ${s ? `<div class="time" data-timer="${st.id}">${time}</div>` : ''}
      <div class="sub">${sub}</div>
      ${t?.progress != null ? `<div class="bar"><span style="width:${Math.min(100, t.progress * 100).toFixed(1)}%"></span></div>` : ''}
    </button>`;
}

// ---------- station dialog ----------

const stationKey = (st) => `${st?.status}|${st?.session?.id}|${st?.session?.pausedAt}|${st?.session?.endsAt}|${st?.online}|${st?.session?.customerBalance}`;

async function openStation(id) {
  state.customers = await api('/customers').catch(() => state.customers);
  state.dialog = { type: 'station', id, key: null, form: { mode: 'prepaid', minutes: 60, method: 'cash', customerId: '' } };
  renderStationDialog();
  if (!$dlg.open) $dlg.showModal();
}

function refreshStationDialog() {
  const d = state.dialog;
  if (d?.type !== 'station' || !$dlg.open) return;
  const st = state.snap.stations.find((s) => s.id === d.id);
  if (!st) return $dlg.close();
  if (stationKey(st) !== d.key) renderStationDialog();
}

function renderStationDialog() {
  const d = state.dialog;
  const st = state.snap.stations.find((s) => s.id === d.id);
  if (!st) return;
  d.key = stationKey(st);
  const s = st.session;

  const remote = st.kind === 'pc' ? `
    <div class="divider"></div>
    <div class="stack">
      <div class="kicker">Remote control${st.online ? '' : ' · PC offline'}</div>
      <form class="inline" data-form="message">
        <input name="text" placeholder="Send a message to this PC" maxlength="300" ${st.online ? '' : 'disabled'} style="flex:1;min-width:180px">
        <button type="submit" ${st.online ? '' : 'disabled'}>Send</button>
      </form>
      <div class="inline">
        <button class="small" data-act="cmd" data-cmd="restart" ${st.online && !s ? '' : 'disabled'}>Restart PC</button>
        <button class="small" data-act="cmd" data-cmd="shutdown" ${st.online && !s ? '' : 'disabled'}>Shut down PC</button>
      </div>
    </div>` : '';

  $dlg.innerHTML = `
    <div class="dlg-head">
      <div><div class="kicker">${esc(st.zoneName)} · ${money(st.hourlyRate)}/hr · ${st.kind === 'pc' ? 'PC' : 'Console'}</div><h2>${esc(st.name)}</h2></div>
      <div class="spacer"></div>
      <span class="pill ${s ? 'on' : ''}">${STATUS_LABEL[st.status]}</span>
      <button class="small" data-act="close">Close</button>
    </div>
    <div class="dlg-body">${s ? activeSessionBody(st) : startSessionBody(st)}${remote}</div>`;
}

function activeSessionBody(st) {
  const s = st.session;
  const t = timing(st);
  return `
    <div class="facts">
      <div class="fact"><span class="kicker">${t.remaining != null ? 'Time left' : 'Time played'}</span><b data-timer="${st.id}">${t.remaining != null ? duration(t.remaining) : duration(t.elapsed)}</b></div>
      <div class="fact"><span class="kicker">Type</span><b>${MODE_LABEL[s.mode]}</b></div>
      <div class="fact"><span class="kicker">Started</span><b>${fmtTime(s.startedAt)}</b></div>
      <div class="fact"><span class="kicker">${s.mode === 'member' ? 'Member balance' : 'Paid so far'}</span><b>${s.mode === 'member' ? money(s.customerBalance) : money(s.charged)}</b></div>
    </div>
    ${s.customerName ? `<div class="muted">Member: <b style="color:var(--white)">${esc(s.customerName)}</b></div>` : ''}
    ${s.mode === 'prepaid' ? `
      <form class="stack" data-form="addtime">
        <div class="kicker">Add time</div>
        <div class="inline">
          <div class="chips">${[15, 30, 60, 120].map((m) => `<button type="button" class="small" data-act="pick-add" data-min="${m}">+${m}m</button>`).join('')}</div>
          <input name="minutes" type="number" min="1" max="1440" value="30" style="width:90px">
          <select name="method" style="width:100px"><option value="cash">Cash</option><option value="card">Card</option></select>
          <button class="primary" type="submit">Add</button>
        </div>
      </form>` : ''}
    <div class="inline">
      ${s.pausedAt ? '<button class="primary" data-act="resume">Resume</button>' : '<button data-act="pause">Pause</button>'}
      <div class="spacer"></div>
      <button class="solid" data-act="end">End session</button>
    </div>`;
}

function startSessionBody(st) {
  const f = state.dialog.form;
  const member = state.customers.find((c) => String(c.id) === String(f.customerId));
  let summary = '';
  if (f.mode === 'prepaid') summary = `Collect <span class="price">${money(cost(f.minutes, st.hourlyRate))}</span> now for ${f.minutes} minutes.`;
  if (f.mode === 'open') summary = 'No time limit. The bill is calculated per minute when the session ends.';
  if (f.mode === 'maintenance') summary = 'Unlocks the station for staff. Nothing is charged.';
  if (f.mode === 'member') {
    summary = member
      ? `${esc(member.name)} has ${money(member.balance)}, enough for about <b>${st.hourlyRate ? duration(Math.floor((member.balance * 60) / st.hourlyRate) * 60_000, { seconds: false }) : 'unlimited time'}</b> here.`
      : 'Pick a member. Their balance is charged per minute. Members can also sign in at the PC themselves.';
  }

  return `
    <form class="stack" data-form="start">
      <div class="seg">${Object.entries(MODE_LABEL).map(([m, l]) => `<button type="button" class="${f.mode === m ? 'on' : ''}" data-act="mode" data-mode="${m}">${l}</button>`).join('')}</div>
      ${f.mode === 'prepaid' ? `
        <div class="stack">
          <div class="chips">${MINUTE_PRESETS.map((m) => `<button type="button" class="small ${f.minutes === m ? 'on' : ''}" data-act="minutes" data-min="${m}">${m < 60 ? `${m}m` : `${m / 60}h`}</button>`).join('')}</div>
          <div class="field-row">
            <label>Minutes<input name="minutes" type="number" min="1" max="1440" value="${f.minutes}"></label>
            <label>Payment<select name="method"><option value="cash" ${f.method === 'cash' ? 'selected' : ''}>Cash</option><option value="card" ${f.method === 'card' ? 'selected' : ''}>Card</option></select></label>
          </div>
        </div>` : ''}
      ${f.mode === 'member' ? `
        <label>Member
          <select name="customerId">
            <option value="">Choose a member</option>
            ${state.customers.map((c) => `<option value="${c.id}" ${String(c.id) === String(f.customerId) ? 'selected' : ''} ${c.playing_on ? 'disabled' : ''}>${esc(c.name)} (@${esc(c.username)}) · ${money(c.balance)}${c.playing_on ? ` · on ${esc(c.playing_on)}` : ''}</option>`).join('')}
          </select>
        </label>` : ''}
      <div class="help">${summary}</div>
      <button class="primary" type="submit" ${st.status === 'offline' ? 'title="The PC is offline. The session starts and the PC unlocks when it reconnects."' : ''}>Start session</button>
    </form>`;
}

async function endSession(st) {
  const s = st.session;
  let method = 'cash';
  if (s.mode === 'prepaid' || s.mode === 'maintenance') {
    if (!confirm(`End the session on ${st.name}?${s.mode === 'prepaid' ? ' Unused prepaid time is not refunded.' : ''}`)) return;
  } else {
    const q = await run(() => api(`/stations/${st.id}/quote`));
    if (!q) return;
    if (s.mode === 'open') {
      const answer = prompt(`${st.name}: ${q.minutes} min played.\nCollect ${money(q.due)}.\n\nType "card" for card payment, or press OK for cash.`, 'cash');
      if (answer == null) return;
      method = answer.trim().toLowerCase() === 'card' ? 'card' : 'cash';
    } else if (!confirm(`${st.name}: ${q.minutes} min played. ${money(Math.min(q.due, s.customerBalance))} will be deducted from ${s.customerName}'s balance. End now?`)) {
      return;
    }
  }
  const ended = await run(() => api(`/stations/${st.id}/end`, { method: 'POST', body: { method } }));
  if (ended) toast(`${st.name} ended · ${money(ended.charged)} total`);
}

// ---------- members ----------

async function loadMembers() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <input id="member-search" placeholder="Search name, username or phone" value="${esc(state.memberQuery)}" style="max-width:320px">
        <div class="spacer"></div>
        <button class="primary" data-act="new-member">Add member</button>
      </div>
      <div id="member-table" class="table-wrap"><div class="muted">Loading</div></div>
    </div>`;
  document.getElementById('member-search').addEventListener('input', (e) => {
    state.memberQuery = e.target.value;
    renderMemberTable();
  });
  state.customers = await api('/customers').catch((e) => { toast(e.message); return []; });
  renderMemberTable();
}

function renderMemberTable() {
  const el = document.getElementById('member-table');
  if (!el) return;
  const q = state.memberQuery.trim().toLowerCase();
  const rows = state.customers.filter((c) => !q || [c.name, c.username, c.phone].some((v) => String(v ?? '').toLowerCase().includes(q)));
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${state.customers.length ? 'No members match your search.' : 'No members yet. Members get a username and PIN to sign in at any PC and play from their balance.'}</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th class="num">Balance</th><th>Now</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `
        <tr>
          <td><b>${esc(c.name)}</b></td>
          <td class="mono">@${esc(c.username)}</td>
          <td>${esc(c.phone ?? '')}</td>
          <td class="num">${money(c.balance)}</td>
          <td>${c.playing_on ? `<span class="pill on">${esc(c.playing_on)}</span>` : ''}</td>
          <td class="num"><div class="inline" style="justify-content:flex-end">
            <button class="small primary" data-act="topup" data-id="${c.id}">Top up</button>
            <button class="small" data-act="edit-member" data-id="${c.id}">Edit</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function formDialog({ title, kicker = '', fields, submit, onSubmit }) {
  state.dialog = { type: 'form' };
  $dlg.innerHTML = `
    <form data-form="generic">
      <div class="dlg-head"><div><div class="kicker">${esc(kicker)}</div><h2>${esc(title)}</h2></div><div class="spacer"></div><button type="button" class="small" data-act="close">Close</button></div>
      <div class="dlg-body">${fields}</div>
      <div class="dlg-foot"><button type="button" data-act="close">Cancel</button><button class="primary" type="submit">${esc(submit)}</button></div>
    </form>`;
  $dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    const ok = await run(() => onSubmit(Object.fromEntries(new FormData(e.target))));
    if (btn) btn.disabled = false;
    if (ok !== undefined) $dlg.close();
  });
  if (!$dlg.open) $dlg.showModal();
  $dlg.querySelector('input:not([type=hidden]), select')?.focus();
}

function memberDialog(c = null) {
  formDialog({
    title: c ? `Edit ${c.name}` : 'Add member',
    kicker: 'Members',
    submit: c ? 'Save' : 'Add member',
    fields: `
      <label>Full name<input name="name" required maxlength="80" value="${esc(c?.name ?? '')}"></label>
      <div class="field-row">
        <label>Username<input name="username" required maxlength="30" pattern="[A-Za-z0-9_.]+" value="${esc(c?.username ?? '')}" ${c ? 'disabled' : ''}></label>
        <label>Phone<input name="phone" maxlength="20" value="${esc(c?.phone ?? '')}"></label>
      </div>
      <label>${c ? 'New PIN (leave empty to keep)' : 'PIN (4 to 8 digits)'}<input name="pin" inputmode="numeric" pattern="\\d{4,8}" ${c ? '' : 'required'} autocomplete="off"></label>`,
    onSubmit: async (body) => {
      const r = c ? await api(`/customers/${c.id}`, { method: 'PUT', body }) : await api('/customers', { method: 'POST', body });
      toast(c ? 'Member saved' : `Member @${r.username} added`);
      if (state.view === 'members') loadMembers();
      return r;
    },
  });
}

function topupDialog(c) {
  formDialog({
    title: `Top up ${c.name}`,
    kicker: `Balance ${money(c.balance)}`,
    submit: 'Add balance',
    fields: `
      <div class="chips">${[200, 500, 1000, 2000].map((a) => `<button type="button" class="small" data-act="pick-amount" data-amount="${a}">${money(a)}</button>`).join('')}</div>
      <div class="field-row">
        <label>Amount (${esc(currency())})<input name="amount" type="number" min="1" required></label>
        <label>Payment<select name="method"><option value="cash">Cash</option><option value="card">Card</option></select></label>
      </div>`,
    onSubmit: async (body) => {
      const r = await api(`/customers/${c.id}/topup`, { method: 'POST', body: { amount: Number(body.amount), method: body.method } });
      toast(`${c.name} now has ${money(r.balance)}`);
      if (state.view === 'members') loadMembers();
      return r;
    },
  });
}

// ---------- setup: zones and stations ----------

function setupView() {
  const snap = state.snap;
  if (!snap) return '<div class="empty">Connecting to the server</div>';
  const wsUrl = `ws://${location.host}/ws`;
  return `
    <div class="panel">
      <div class="panel-head"><h2>Zones</h2><span class="muted">Each zone has its own hourly rate.</span><div class="spacer"></div><button class="primary" data-act="new-zone">Add zone</button></div>
      ${snap.zones.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Zone</th><th class="num">Rate per hour</th><th class="num">Stations</th><th></th></tr></thead>
        <tbody>${snap.zones.map((z) => `
          <tr>
            <td><b>${esc(z.name)}</b></td>
            <td class="num">${money(z.hourly_rate)}</td>
            <td class="num">${snap.stations.filter((s) => s.zoneId === z.id).length}</td>
            <td class="num"><div class="inline" style="justify-content:flex-end">
              <button class="small" data-act="edit-zone" data-id="${z.id}">Edit</button>
              <button class="small" data-act="delete-zone" data-id="${z.id}">Delete</button>
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Add your first zone, for example Standard, VIP or Console.</div>'}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Stations</h2><span class="muted">PCs and consoles on the floor.</span><div class="spacer"></div><button class="primary" data-act="new-station" ${snap.zones.length ? '' : 'disabled'}>Add station</button></div>
      ${snap.stations.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Station</th><th>Zone</th><th>Type</th><th>Agent</th><th>Pairing token</th><th></th></tr></thead>
        <tbody>${snap.stations.map((s) => `
          <tr>
            <td><b>${esc(s.name)}</b></td>
            <td>${esc(s.zoneName)}</td>
            <td>${s.kind === 'pc' ? 'PC' : 'Console'}</td>
            <td>${s.kind === 'pc' ? (s.online ? `<span class="pill on">Online</span> <span class="muted">${esc(s.agent?.hostname ?? '')} v${esc(s.agent?.version ?? '')}</span>` : '<span class="pill">Offline</span>') : '<span class="muted">Timer only</span>'}</td>
            <td>${s.kind === 'pc' ? `<button class="small" data-act="show-token" data-id="${s.id}">Show</button>` : ''}</td>
            <td class="num"><div class="inline" style="justify-content:flex-end">
              <button class="small" data-act="edit-station" data-id="${s.id}">Edit</button>
              <button class="small" data-act="delete-station" data-id="${s.id}">Delete</button>
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No stations yet.</div>'}
    </div>

    <div class="panel">
      <h2 style="margin-bottom:10px">Connect a gaming PC</h2>
      <div class="help">
        1. Install Node.js 22 on the PC and copy the <code>agent</code> folder to it.<br>
        2. Create <code>agent/config.json</code> with the server address <code>${esc(wsUrl)}</code> (use this server's LAN IP if you are on it now) and the station's pairing token.<br>
        3. Start it with <code>npm run agent</code>. The PC locks until a session starts. See <code>docs/agent-setup.md</code> for auto start on login.
      </div>
    </div>`;
}

function zoneDialog(z = null) {
  formDialog({
    title: z ? `Edit ${z.name}` : 'Add zone',
    kicker: 'Zones',
    submit: z ? 'Save' : 'Add zone',
    fields: `
      <label>Zone name<input name="name" required maxlength="80" value="${esc(z?.name ?? '')}" placeholder="Standard, VIP, Console"></label>
      <label>Rate per hour (${esc(currency())})<input name="hourlyRate" type="number" min="0" required value="${z?.hourly_rate ?? ''}"></label>`,
    onSubmit: (body) => api(z ? `/zones/${z.id}` : '/zones', { method: z ? 'PUT' : 'POST', body: { name: body.name, hourlyRate: Number(body.hourlyRate) } }),
  });
}

function stationDialog(s = null) {
  formDialog({
    title: s ? `Edit ${s.name}` : 'Add station',
    kicker: 'Stations',
    submit: s ? 'Save' : 'Add station',
    fields: `
      <label>Station name<input name="name" required maxlength="40" value="${esc(s?.name ?? '')}" placeholder="PC 01"></label>
      <div class="field-row">
        <label>Zone<select name="zoneId">${state.snap.zones.map((z) => `<option value="${z.id}" ${s?.zoneId === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>
        <label>Type<select name="kind"><option value="pc" ${s?.kind !== 'console' ? 'selected' : ''}>PC (with agent)</option><option value="console" ${s?.kind === 'console' ? 'selected' : ''}>Console (timer only)</option></select></label>
      </div>`,
    onSubmit: (body) => api(s ? `/stations/${s.id}` : '/stations', { method: s ? 'PUT' : 'POST', body: { ...body, zoneId: Number(body.zoneId) } }),
  });
}

async function showToken(id) {
  const stations = await run(() => api('/stations'));
  const st = stations?.find((s) => s.id === id);
  if (!st) return;
  state.dialog = { type: 'token' };
  const config = JSON.stringify({ serverUrl: `ws://${location.host}/ws`, token: st.agent_token }, null, 2);
  $dlg.innerHTML = `
    <div class="dlg-head"><div><div class="kicker">Pairing</div><h2>${esc(st.name)}</h2></div><div class="spacer"></div><button class="small" data-act="close">Close</button></div>
    <div class="dlg-body">
      <div class="muted">Save this as <code>agent/config.json</code> on the PC. Change the host to this server's LAN IP if needed.</div>
      <textarea readonly rows="5" class="mono" id="cfg">${esc(config)}</textarea>
      <div class="inline">
        <button class="primary" data-act="copy-cfg">Copy</button>
        <div class="spacer"></div>
        <button data-act="regen-token" data-id="${st.id}">Generate new token</button>
      </div>
      <div class="muted">A new token disconnects the PC until its config is updated.</div>
    </div>`;
  if (!$dlg.open) $dlg.showModal();
}

// ---------- reports ----------

function rangeFor(key) {
  const end = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (key === '7d') start.setDate(start.getDate() - 6);
  if (key === '30d') start.setDate(start.getDate() - 29);
  return { from: start.getTime(), to: end.getTime() + 1 };
}

async function loadReports() {
  const view = document.getElementById('view');
  const { from, to } = rangeFor(state.reportRange);
  view.innerHTML = '<div class="muted">Loading</div>';
  const [r, txs] = await Promise.all([
    api(`/reports/summary?from=${from}&to=${to}`),
    api('/transactions?limit=50'),
  ]).catch((e) => { toast(e.message); return [null, []]; });
  if (!r || state.view !== 'reports') return;
  view.innerHTML = `
    <div class="inline" style="margin-bottom:18px">
      <div class="seg">${[['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']].map(([k, l]) => `<button class="${state.reportRange === k ? 'on' : ''}" data-act="range" data-range="${k}">${l}</button>`).join('')}</div>
      <div class="spacer"></div>
      <button data-act="export">Export CSV</button>
    </div>
    <div class="stats">
      <div class="stat"><span class="kicker">Cash in</span><b>${money(r.cashIn)}</b></div>
      <div class="stat"><span class="kicker">Cash</span><b>${money(r.byMethod.cash)}</b></div>
      <div class="stat"><span class="kicker">Card</span><b>${money(r.byMethod.card)}</b></div>
      <div class="stat"><span class="kicker">Member top ups</span><b>${money(r.topups)}</b></div>
      <div class="stat"><span class="kicker">Session revenue</span><b>${money(r.sessionRevenue)}</b></div>
      <div class="stat"><span class="kicker">Sessions</span><b>${r.sessionsCount}</b></div>
      <div class="stat"><span class="kicker">Hours played</span><b>${(r.minutesPlayed / 60).toFixed(1)}</b></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>By zone</h2></div>
      ${r.byZone.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Zone</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Revenue</th></tr></thead>
        <tbody>${r.byZone.map((z) => `<tr><td><b>${esc(z.zone)}</b></td><td class="num">${z.sessions}</td><td class="num">${(z.minutes / 60).toFixed(1)}</td><td class="num">${money(z.revenue)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No finished sessions in this period.</div>'}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Latest transactions</h2></div>
      ${txs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Type</th><th>Station / member</th><th>Method</th><th>Note</th><th>Staff</th><th class="num">Amount</th></tr></thead>
        <tbody>${txs.map((t) => `<tr>
          <td>${fmtDateTime(t.created_at)}</td>
          <td>${t.kind === 'topup' ? 'Top up' : 'Session'}</td>
          <td>${esc([t.station_name, t.customer_name].filter(Boolean).join(' · '))}</td>
          <td>${esc(t.method)}</td>
          <td class="muted">${esc(t.note ?? '')}</td>
          <td class="muted">${esc(t.admin_name ?? 'self')}</td>
          <td class="num">${money(t.amount)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No transactions yet.</div>'}
    </div>`;
  state.lastTxs = txs;
}

async function exportCsv() {
  const txs = await run(() => api('/transactions?limit=1000'));
  if (!txs) return;
  const head = ['time', 'type', 'amount', 'method', 'station', 'member', 'staff', 'note'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(','), ...txs.map((t) => [new Date(t.created_at).toISOString(), t.kind, t.amount, t.method, t.station_name, t.customer_name, t.admin_name, t.note].map(cell).join(','))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `dxl-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- settings ----------

function settingsView() {
  const s = state.snap?.settings ?? { venueName: '', currency: 'PKR' };
  return `
    <form class="panel stack" data-form="settings" style="max-width:560px">
      <h2>Venue</h2>
      <div class="field-row">
        <label>Venue name<input name="venueName" required maxlength="80" value="${esc(s.venueName)}"></label>
        <label>Currency<input name="currency" required maxlength="8" value="${esc(s.currency)}"></label>
      </div>
      <div><button class="primary" type="submit">Save</button></div>
    </form>
    <form class="panel stack" data-form="admin" style="max-width:560px">
      <h2>Add a staff account</h2>
      <div class="field-row">
        <label>Username<input name="username" required maxlength="40" autocomplete="off"></label>
        <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      </div>
      <div><button class="primary" type="submit">Add staff</button></div>
    </form>
    <div class="panel" style="max-width:560px">
      <div class="kicker">About</div>
      <p style="margin:6px 0 0">DXL Gaming Zone Manager v0.1 by DXL Solutions.</p>
    </div>`;
}

// ---------- events ----------

const stationById = (id) => state.snap?.stations.find((s) => s.id === Number(id));

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const d = state.dialog;
  const st = d?.type === 'station' ? stationById(d.id) : null;

  switch (act) {
    case 'signout': return signOut();
    case 'close': return $dlg.close();
    case 'station': return openStation(Number(id));

    case 'mode':
      d.form.mode = el.dataset.mode;
      return renderStationDialog();
    case 'minutes':
      d.form.minutes = Number(el.dataset.min);
      return renderStationDialog();
    case 'pick-add':
      $dlg.querySelector('[data-form=addtime] [name=minutes]').value = el.dataset.min;
      return undefined;
    case 'pick-amount':
      $dlg.querySelector('[name=amount]').value = el.dataset.amount;
      return undefined;
    case 'pause': return run(() => api(`/stations/${st.id}/pause`, { method: 'POST' }), `${st.name} paused`);
    case 'resume': return run(() => api(`/stations/${st.id}/resume`, { method: 'POST' }), `${st.name} resumed`);
    case 'end': return endSession(st);
    case 'cmd':
      if (!confirm(`${el.dataset.cmd === 'restart' ? 'Restart' : 'Shut down'} ${st.name}?`)) return undefined;
      return run(() => api(`/stations/${st.id}/command`, { method: 'POST', body: { action: el.dataset.cmd } }), 'Command sent');

    case 'new-member': return memberDialog();
    case 'edit-member': return memberDialog(state.customers.find((c) => c.id === Number(id)));
    case 'topup': return topupDialog(state.customers.find((c) => c.id === Number(id)));

    case 'new-zone': return zoneDialog();
    case 'edit-zone': return zoneDialog(state.snap.zones.find((z) => z.id === Number(id)));
    case 'delete-zone':
      if (!confirm('Delete this zone?')) return undefined;
      return run(() => api(`/zones/${id}`, { method: 'DELETE' }), 'Zone deleted');
    case 'new-station': return stationDialog();
    case 'edit-station': return stationDialog(stationById(id));
    case 'delete-station':
      if (!confirm(`Delete ${stationById(id)?.name}?`)) return undefined;
      return run(() => api(`/stations/${id}`, { method: 'DELETE' }), 'Station deleted');
    case 'show-token': return showToken(Number(id));
    case 'copy-cfg':
      await navigator.clipboard?.writeText(document.getElementById('cfg').value).catch(() => {});
      return toast('Copied');
    case 'regen-token':
      if (!confirm('Generate a new token? The PC disconnects until you update its config.')) return undefined;
      await run(() => api(`/stations/${id}/token`, { method: 'POST' }), 'New token generated');
      return showToken(Number(id));

    case 'range':
      state.reportRange = el.dataset.range;
      return loadReports();
    case 'export': return exportCsv();
    default: return undefined;
  }
});

document.addEventListener('change', (e) => {
  const form = e.target.closest('[data-form=start]');
  if (!form) return;
  const f = state.dialog.form;
  if (e.target.name === 'minutes') f.minutes = Math.max(1, Number(e.target.value) || 1);
  if (e.target.name === 'method') f.method = e.target.value;
  if (e.target.name === 'customerId') f.customerId = e.target.value;
  renderStationDialog();
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form || form.dataset.form === 'generic') return;
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  const st = state.dialog?.type === 'station' ? stationById(state.dialog.id) : null;

  switch (form.dataset.form) {
    case 'start': {
      const f = state.dialog.form;
      if (f.mode === 'member' && !f.customerId) return toast('Choose a member first');
      const payload = { mode: f.mode, minutes: f.minutes, method: f.method, customerId: Number(f.customerId) || undefined };
      return run(() => api(`/stations/${st.id}/session`, { method: 'POST', body: payload }), `${st.name} started`);
    }
    case 'addtime':
      return run(() => api(`/stations/${st.id}/add-time`, { method: 'POST', body: { minutes: Number(body.minutes), method: body.method } }), `Time added to ${st.name}`);
    case 'message': {
      const ok = await run(() => api(`/stations/${st.id}/command`, { method: 'POST', body: { action: 'message', text: body.text } }), 'Message sent');
      if (ok) form.reset();
      return undefined;
    }
    case 'settings':
      return run(() => api('/settings', { method: 'PUT', body }), 'Settings saved');
    case 'admin': {
      const ok = await run(() => api('/admins', { method: 'POST', body }), `Staff account ${body.username} added`);
      if (ok) form.reset();
      return undefined;
    }
    default: return undefined;
  }
});

$dlg.addEventListener('close', () => { state.dialog = null; });

// Live clock and timers
setInterval(() => {
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (!state.snap) return;
  if (state.view === 'floor') {
    const view = document.getElementById('view');
    if (view) view.innerHTML = floorView();
  }
  for (const el of $dlg.querySelectorAll('[data-timer]')) {
    const st = stationById(el.dataset.timer);
    const t = st && timing(st);
    if (t) el.textContent = t.remaining != null ? duration(t.remaining) : duration(t.elapsed);
  }
}, 1000);

boot();
