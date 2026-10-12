// Simulated gaming PC: shows what the player sees, driven by the same state the real agent gets.
import { usedMs } from '../server/src/util.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function createPcSimulator(root, backend) {
  const { venue, now } = backend;
  const messages = new Map(); // stationId -> [text]
  const power = new Map(); // stationId -> 'restarting' | 'off'
  let current = null;
  let screenKey = '';
  let loginMsg = '';

  venue.on('command', (stationId, cmd) => {
    if (cmd.action === 'message') {
      messages.set(stationId, [...(messages.get(stationId) ?? []), cmd.text]);
    } else if (cmd.action === 'restart') {
      power.set(stationId, 'restarting');
      backend.goOffline(stationId);
      setTimeout(() => {
        power.delete(stationId);
        backend.goOnline(venue.getStation(stationId));
      }, 4000);
    } else if (cmd.action === 'shutdown') {
      power.set(stationId, 'off');
      backend.goOffline(stationId);
    }
    render(true);
  });

  const pcs = () => venue.listStations().filter((s) => s.kind === 'pc');

  function select(id) {
    current = id;
    loginMsg = '';
    render(true);
  }

  function screenState(st) {
    const pw = power.get(st.id);
    if (pw) return { kind: pw };
    if (!venue.online.has(st.id)) return { kind: 'offline' };
    const agent = venue.agentState(st.id);
    if (!agent.session) return { kind: 'locked', agent };
    if (agent.session.paused) return { kind: 'paused', agent };
    return { kind: 'playing', agent };
  }

  function lockScreen(st, agent, paused) {
    return `
      <div class="pc-lock">
        <div class="pc-top"><span class="wordmark">DXL<small>SOLUTIONS</small></span><span class="pc-clock" data-pc-clock></span></div>
        <div class="pc-lock-body">
          <div>
            <div class="kicker">${esc(agent.venueName)}</div>
            <div class="pc-station">${esc(st.name)}</div>
            <div class="pc-zone">${esc(st.zone_name)} zone</div>
          </div>
          <div class="pc-card">
            ${paused ? `<h3>Session paused</h3><p>Your time is on hold. The front desk will resume it.</p>` : `
            <h3>Sign in to play</h3>
            <p>Members sign in with their username and PIN. Walk in players, please see the front desk.</p>
            <form id="pc-login" autocomplete="off">
              <input id="pc-user" placeholder="Username" autocapitalize="none" spellcheck="false" required>
              <input id="pc-pin" placeholder="PIN" type="password" inputmode="numeric" maxlength="8" required>
              <button class="primary" type="submit">Start playing</button>
              <div class="pc-msg" id="pc-msg">${esc(loginMsg)}</div>
            </form>`}
          </div>
        </div>
        <div class="pc-foot"><span><i class="pc-dot"></i>Connected to front desk</span><span>Powered by DXL Solutions</span></div>
      </div>`;
  }

  function desktop(st, agent) {
    const s = agent.session;
    return `
      <div class="pc-desktop">
        <div class="pc-game">
          <div class="kicker">Player desktop</div>
          <div class="pc-game-title">Unlocked and ready to play</div>
          <div class="pc-apps">${['Game library', 'Browser', 'Voice chat', 'Settings'].map((a) => `<span>${a}</span>`).join('')}</div>
        </div>
        <div class="pc-widget">
          <div class="pc-widget-row"><span class="kicker">${esc(st.name)}</span><span class="wordmark">DXL</span></div>
          <div class="kicker" data-pc-label>${s.endsAt ? 'Time left' : 'Time played'}</div>
          <div class="pc-time" data-pc-time></div>
          <div class="pc-who">${s.member ? `Signed in as ${esc(s.member)}` : s.mode === 'open' ? 'Pay at the front desk when you finish' : s.mode === 'maintenance' ? 'Staff use' : 'Prepaid session'}</div>
          ${s.mode === 'member' ? '<button type="button" data-pc="logout">End my session</button>' : ''}
        </div>
        <div class="pc-warn" data-pc-warn hidden></div>
      </div>`;
  }

  function render(force = false) {
    const list = pcs();
    if (!list.length) {
      root.innerHTML = '<div class="empty">Add a PC station on the Front desk to see its screen here.</div>';
      return;
    }
    if (!list.some((s) => s.id === current)) current = list[0].id;
    const st = venue.getStation(current);
    const state = screenState(st);
    const msgs = messages.get(st.id) ?? [];
    const key = `${current}|${state.kind}|${state.agent?.session?.id}|${msgs.length}|${list.length}|${venue.online.size}`;

    if (force || key !== screenKey) {
      screenKey = key;
      let screen = '';
      if (state.kind === 'locked') screen = lockScreen(st, state.agent, false);
      else if (state.kind === 'paused') screen = lockScreen(st, state.agent, true);
      else if (state.kind === 'playing') screen = desktop(st, state.agent);
      else if (state.kind === 'restarting') screen = '<div class="pc-blank"><div class="kicker">Restarting</div><p>The PC is restarting and will lock when it comes back.</p></div>';
      else if (state.kind === 'off') screen = `<div class="pc-blank"><div class="kicker">Powered off</div><p>Staff shut this PC down.</p><button class="primary" type="button" data-pc="power">Power on</button></div>`;
      else screen = '<div class="pc-blank"><div class="kicker">Offline</div><p>This PC has no agent connected. In the demo, PC 08 stays offline to show how that looks.</p></div>';

      const focused = document.activeElement?.id;
      const typed = { user: root.querySelector('#pc-user')?.value ?? '', pin: root.querySelector('#pc-pin')?.value ?? '' };

      root.innerHTML = `
        <div class="pc-head">
          <div>
            <div class="kicker">Gaming PC view</div>
            <h2>What the player sees</h2>
            <p class="muted">Each PC runs the DXL agent. It stays locked until the front desk starts a session or a member signs in, then locks again when time is up.</p>
          </div>
          <label class="pc-pick">Show PC
            <select id="pc-select">${list.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.name)} · ${venue.online.has(s.id) ? (venue.activeSession(s.id) ? 'in use' : 'locked') : 'offline'}</option>`).join('')}</select>
          </label>
        </div>
        <div class="pc-monitor"><div class="pc-screen">${screen}
          ${msgs.length ? `<div class="pc-popup"><div class="kicker">Message from the front desk</div><p>${esc(msgs[0])}</p><button class="primary" type="button" data-pc="ack">OK</button></div>` : ''}
        </div></div>
        <div class="pc-stand"></div>
        <div class="pc-hints">
          <div><b>Try a member sign in:</b> pick a locked PC and use <code>ali</code> with PIN <code>1234</code>, or <code>hamza</code> / <code>2468</code> (low balance).</div>
          <div><b>Try the front desk:</b> start, pause or end a session, or send a message, then come back here to see the PC react.</div>
        </div>`;

      const u = root.querySelector('#pc-user');
      if (u) {
        u.value = typed.user;
        root.querySelector('#pc-pin').value = typed.pin;
        if (focused === 'pc-user' || focused === 'pc-pin') root.querySelector(`#${focused}`).focus();
      }
    }
    tick();
  }

  function tick() {
    const clock = root.querySelector('[data-pc-clock]');
    if (clock) clock.textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeEl = root.querySelector('[data-pc-time]');
    if (!timeEl || current == null) return;
    const s = venue.activeSession(current);
    if (!s) return;
    const t = now();
    const left = s.ends_at != null ? s.ends_at - t : null;
    timeEl.textContent = left != null ? clockText(left) : clockText(usedMs(s, t));
    const warn = root.querySelector('[data-pc-warn]');
    if (warn) {
      warn.hidden = !(left != null && left <= 5 * 60_000);
      if (!warn.hidden) warn.textContent = left <= 60_000 ? 'Less than 1 minute left. Your PC will lock soon.' : `${Math.ceil(left / 60_000)} minutes left on this session.`;
    }
  }

  root.addEventListener('change', (e) => {
    if (e.target.id === 'pc-select') select(Number(e.target.value));
  });

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-pc]');
    if (!el) return;
    const action = el.dataset.pc;
    if (action === 'ack') messages.set(current, (messages.get(current) ?? []).slice(1));
    if (action === 'power') {
      power.set(current, 'restarting');
      setTimeout(() => { power.delete(current); backend.goOnline(venue.getStation(current)); }, 2500);
    }
    if (action === 'logout') {
      try { venue.memberLogout(current); } catch (err) { loginMsg = err.message; }
    }
    render(true);
  });

  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'pc-login') return;
    e.preventDefault();
    const username = root.querySelector('#pc-user').value;
    const pin = root.querySelector('#pc-pin').value;
    // A successful sign in re-renders the screen synchronously, so the form may be gone.
    try {
      venue.memberLogin(current, { username, pin });
      loginMsg = '';
    } catch (err) {
      loginMsg = err.message;
    }
    const pinInput = root.querySelector('#pc-pin');
    if (pinInput) pinInput.value = '';
    render(true);
  });

  venue.on('change', () => render());
  setInterval(() => render(), 1000);

  return { select, render };
}
