// In-browser stand-in for the DXL server: the real Venue logic on SQLite (WASM),
// answering the dashboard's fetch('/api/...') and WebSocket calls.
import { openDb } from '../server/src/db.js';
import { Venue } from '../server/src/venue.js';
import { AppError, MINUTE } from '../server/src/util.js';

export function createBackend() {
  let shift = 0; // "skip ahead" offset
  let temp = 0; // used while seeding history
  const now = () => Date.now() + shift + temp;
  const venue = new Venue(openDb(':memory:'), { now });

  // ---------- REST routes (mirrors server/src/api.js) ----------
  const routes = [];
  const route = (method, path, fn, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, fn, open });
  };

  route('GET', '/status', () => ({ needsSetup: venue.needsSetup(), venueName: venue.getSettings().venueName }), { open: true });
  route('POST', '/login', ({ body }) => venue.login(body), { open: true });
  route('POST', '/logout', ({ token }) => venue.logout(token));
  route('GET', '/me', ({ admin }) => admin);
  route('POST', '/admins', ({ body }) => venue.createAdmin(body));
  route('GET', '/snapshot', () => venue.snapshot());
  route('GET', '/settings', () => venue.getSettings());
  route('PUT', '/settings', ({ body }) => venue.updateSettings(body));
  route('GET', '/zones', () => venue.listZones());
  route('POST', '/zones', ({ body }) => venue.createZone(body));
  route('PUT', '/zones/:id', ({ p, body }) => venue.updateZone(p.id, body));
  route('DELETE', '/zones/:id', ({ p }) => venue.deleteZone(p.id));
  route('GET', '/stations', () => venue.listStations());
  route('POST', '/stations', ({ body }) => {
    const station = venue.createStation(body);
    if (station.kind === 'pc') goOnline(station);
    return station;
  });
  route('PUT', '/stations/:id', ({ p, body }) => venue.updateStation(p.id, body));
  route('DELETE', '/stations/:id', ({ p }) => venue.deleteStation(p.id));
  route('POST', '/stations/:id/token', ({ p }) => venue.regenerateToken(p.id));
  route('POST', '/stations/:id/session', ({ p, body, admin }) => venue.startSession(p.id, body, admin.id));
  route('GET', '/stations/:id/quote', ({ p }) => venue.quote(p.id));
  route('POST', '/stations/:id/add-time', ({ p, body, admin }) => venue.addTime(p.id, body, admin.id));
  route('POST', '/stations/:id/pause', ({ p }) => venue.pause(p.id));
  route('POST', '/stations/:id/resume', ({ p }) => venue.resume(p.id));
  route('POST', '/stations/:id/end', ({ p, body, admin }) => venue.endSession(p.id, { reason: 'staff', method: body.method ?? 'cash' }, admin.id));
  route('POST', '/stations/:id/command', ({ p, body }) => venue.command(p.id, body));
  route('GET', '/customers', () => venue.listCustomers());
  route('POST', '/customers', ({ body }) => venue.createCustomer(body));
  route('PUT', '/customers/:id', ({ p, body }) => venue.updateCustomer(p.id, body));
  route('POST', '/customers/:id/topup', ({ p, body, admin }) => venue.topUp(p.id, body, admin.id));
  route('GET', '/reports/summary', ({ query }) => venue.report(query));
  route('GET', '/transactions', ({ query }) => venue.transactions(query));

  function handle(method, url, headers, rawBody) {
    const path = url.pathname.replace(/^\/api/, '');
    const r = routes.find((x) => x.method === method && x.re.test(path));
    if (!r) return [404, { error: 'Not found' }];
    try {
      const token = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const admin = venue.authenticate(token);
      if (!r.open && !admin) return [401, { error: 'Please sign in' }];
      const m = path.match(r.re);
      const p = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = rawBody ? JSON.parse(rawBody) : {};
      const query = Object.fromEntries(url.searchParams);
      return [200, r.fn({ p, body, query, admin, token }) ?? { ok: true }];
    } catch (err) {
      if (err instanceof AppError) return [err.status, { error: err.message }];
      console.error(err);
      return [500, { error: 'Something went wrong' }];
    }
  }

  // ---------- live socket for dashboards ----------
  const sockets = new Set();
  let pending = null;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const msg = JSON.stringify({ type: 'snapshot', data: venue.snapshot() });
      for (const s of sockets) if (s.authed) s.onmessage?.({ data: msg });
    }, 30);
  };
  venue.on('change', broadcast);

  class DemoSocket {
    constructor() {
      this.readyState = 0;
      sockets.add(this);
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.type !== 'auth') return;
      if (!venue.authenticate(msg.token)) return this.shut(4001);
      this.authed = true;
      broadcast();
    }
    close() { this.shut(1000); }
    shut(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  }
  DemoSocket.OPEN = 1;

  function install() {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
      const headers = {};
      for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
      const [status, body] = handle((init.method ?? 'GET').toUpperCase(), url, headers, init.body);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    window.WebSocket = DemoSocket;
    setInterval(() => venue.tick(), 1000);
  }

  // ---------- simulated PCs ----------
  function goOnline(station) {
    venue.online.set(station.id, {
      hostname: `DXL-${station.name.replace(/\s+/g, '')}`,
      version: '0.1.0',
      connectedAt: now(),
    });
    venue.emit('change', station.id);
  }

  function goOffline(stationId) {
    venue.online.delete(stationId);
    venue.emit('change', stationId);
  }

  function skip(minutes) {
    shift += minutes * MINUTE;
    venue.tick();
    venue.emit('change', null);
  }

  // ---------- sample venue ----------
  function seed() {
    const at = (minutesAgo, fn) => {
      temp = -minutesAgo * MINUTE;
      try { fn(); } finally { temp = 0; }
    };

    const owner = venue.createAdmin({ username: 'demo', password: 'demo1234' });
    venue.createAdmin({ username: 'front.desk', password: 'frontdesk1' });
    venue.updateSettings({ venueName: 'DXL Gaming Zone · Demo venue', currency: 'PKR' });

    const standard = venue.createZone({ name: 'Standard', hourlyRate: 250 });
    const vip = venue.createZone({ name: 'VIP', hourlyRate: 500 });
    const consoles = venue.createZone({ name: 'Console', hourlyRate: 400 });

    const st = {};
    for (let i = 1; i <= 8; i++) st[`PC 0${i}`] = venue.createStation({ name: `PC 0${i}`, zoneId: standard.id });
    for (let i = 1; i <= 4; i++) st[`VIP 0${i}`] = venue.createStation({ name: `VIP 0${i}`, zoneId: vip.id });
    for (let i = 1; i <= 2; i++) st[`PS5 0${i}`] = venue.createStation({ name: `PS5 0${i}`, zoneId: consoles.id, kind: 'console' });
    for (const s of Object.values(st)) if (s.kind === 'pc' && s.name !== 'PC 08') goOnline(s);

    const m = {};
    for (const [name, username, pin, phone] of [
      ['Ali Raza', 'ali', '1234', '0300 1234567'],
      ['Sara Khan', 'sara', '5678', '0321 7654321'],
      ['Hamza Sheikh', 'hamza', '2468', '0333 2468101'],
      ['Zainab Ahmed', 'zainab', '1357', '0345 1357913'],
      ['Usman Tariq', 'usman', '9999', ''],
    ]) m[username] = venue.createCustomer({ name, username, pin, phone });

    const id = (name) => st[name].id;
    const admin = owner.id;

    // Earlier today
    at(240, () => {
      venue.topUp(m.ali.id, { amount: 1500, method: 'card' }, admin);
      venue.topUp(m.sara.id, { amount: 800, method: 'cash' }, admin);
      venue.topUp(m.hamza.id, { amount: 300, method: 'cash' }, admin);
      venue.topUp(m.zainab.id, { amount: 2500, method: 'cash' }, admin);
    });
    at(200, () => venue.startSession(id('PC 05'), { mode: 'prepaid', minutes: 60, method: 'cash' }, admin));
    at(180, () => venue.startSession(id('VIP 03'), { mode: 'open' }, admin));
    at(170, () => venue.startSession(id('VIP 04'), { mode: 'member', customerId: m.zainab.id }, admin));
    at(150, () => venue.startSession(id('PS5 02'), { mode: 'prepaid', minutes: 120, method: 'cash' }, admin));
    at(140, () => venue.tick());
    at(95, () => venue.endSession(id('VIP 03'), { method: 'card' }, admin));
    at(60, () => venue.memberLogout(id('VIP 04')));
    at(30, () => venue.tick());

    // Playing right now
    at(70, () => venue.startSession(id('PS5 01'), { mode: 'prepaid', minutes: 120, method: 'cash' }, admin));
    at(57, () => venue.startSession(id('PC 02'), { mode: 'prepaid', minutes: 60, method: 'cash' }, admin));
    at(52, () => venue.startSession(id('PC 01'), { mode: 'prepaid', minutes: 60, method: 'card' }, admin));
    at(40, () => venue.startSession(id('VIP 01'), { mode: 'member', customerId: m.sara.id }, admin));
    at(25, () => venue.startSession(id('PC 03'), { mode: 'open' }, admin));
    at(15, () => venue.startSession(id('VIP 02'), { mode: 'open' }, admin));
    at(5, () => venue.pause(id('VIP 02')));
    at(10, () => venue.startSession(id('PC 06'), { mode: 'maintenance' }, admin));

    return venue.login({ username: 'demo', password: 'demo1234' }).token;
  }

  return { venue, now, install, seed, skip, goOnline, goOffline };
}
