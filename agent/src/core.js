import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const WARN_AT_MINUTES = [5, 1];
const REQUEST_TIMEOUT = 10_000;

/**
 * Keeps one station in sync with the server.
 *
 * Emits:
 *   'lock' / 'unlock'   the screen must be locked or released
 *   'warn' (minutes)    time is running out
 *   'command' (cmd)     message / restart / shutdown from staff
 *   'update'            anything on the local screens may have changed
 *
 * Fail safe: the PC starts locked, and a timed session locks on its own
 * when time runs out even if the server is unreachable.
 */
export class AgentCore extends EventEmitter {
  constructor({ serverUrl, token, hostname, version, now = Date.now, WebSocketImpl = WebSocket }) {
    super();
    Object.assign(this, { serverUrl, token, hostname, version, now, WebSocketImpl });
    this.ws = null;
    this.offset = 0; // serverNow - localNow
    this.retry = 0;
    this.stopped = false;
    this.pending = new Map();
    this.nextId = 1;
    this.timers = [];
    this.warned = new Set();
    this.state = { connected: false, locked: true, session: null, station: null, zone: null, venueName: null, error: null };
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.close();
  }

  connect() {
    const ws = new this.WebSocketImpl(this.serverUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', token: this.token, hostname: this.hostname, version: this.version }));
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'state') this.applyState(msg.data);
      else if (msg.type === 'command') this.emit('command', msg.data);
      else if (msg.type === 'result') this.settle(msg);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.state.connected = false;
      this.state.error = code === 4001 ? `Server rejected this PC: ${reason}` : null;
      for (const { reject } of this.pending.values()) reject(new Error('Disconnected from server'));
      this.pending.clear();
      this.emit('update');
      if (!this.stopped) {
        // Back off up to 30s; a rejected token retries slowly in case staff re-pair it.
        const delay = code === 4001 ? 30_000 : Math.min(30_000, 1000 * 2 ** this.retry++);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });

    ws.on('error', () => {}); // 'close' follows and handles reconnecting
  }

  applyState(data) {
    this.offset = data.serverNow - this.now();
    const wasLocked = this.state.locked;
    const prevSession = this.state.session?.id;
    this.state = {
      connected: true,
      locked: data.locked,
      session: data.session,
      station: data.station,
      zone: data.zone,
      venueName: data.venueName,
      error: null,
    };
    if (data.session?.id !== prevSession) this.warned.clear();
    this.schedule();
    if (data.locked !== wasLocked) this.emit(data.locked ? 'lock' : 'unlock');
    this.emit('update');
  }

  /** Milliseconds left in a timed session, or null when there is no limit. */
  remainingMs() {
    const s = this.state.session;
    if (!s?.endsAt) return null;
    return Math.max(0, s.endsAt - (this.now() + this.offset));
  }

  schedule() {
    this.clearTimers();
    const s = this.state.session;
    if (!s?.endsAt || s.paused) return;
    const left = this.remainingMs();
    for (const minutes of WARN_AT_MINUTES) {
      const at = left - minutes * 60_000;
      if (at > 0) this.timers.push(setTimeout(() => this.warn(minutes), at));
    }
    this.timers.push(setTimeout(() => this.expireLocally(s.id), left));
  }

  warn(minutes) {
    const key = `${this.state.session?.id}:${minutes}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.emit('warn', minutes);
  }

  expireLocally(sessionId) {
    if (this.state.session?.id !== sessionId || this.state.locked) return;
    this.state.locked = true;
    this.state.session = null;
    this.emit('lock');
    this.emit('update');
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  request(type, payload = {}) {
    if (!this.state.connected || this.ws?.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new Error('Not connected to the server. Please ask the front desk.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The server did not answer. Please try again.'));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ type, id, ...payload }));
    });
  }

  settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error ?? 'Request failed'));
  }

  login(username, pin) {
    return this.request('login', { username, pin });
  }

  logout() {
    return this.request('logout');
  }

  publicState() {
    return { ...this.state, remainingMs: this.remainingMs() };
  }
}
