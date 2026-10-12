import { EventEmitter } from 'node:events';
import { transaction } from './db.js';
import {
  AppError, MINUTE, hashSecret, verifySecret, randomToken,
  billableMinutes, costFor, affordableMinutes, usedMs,
  requireText, requireInt, requireOneOf,
} from './util.js';

const TOKEN_TTL = 12 * 60 * MINUTE;
const MODES = ['prepaid', 'open', 'member', 'maintenance'];
const METHODS = ['cash', 'card'];
const KINDS = ['pc', 'console'];
const DEFAULT_SETTINGS = { venueName: 'DXL Gaming Zone', currency: 'PKR' };

// Members get 5 wrong PINs, then a 2 minute cool-down per username.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT = 2 * MINUTE;

/**
 * The venue owns all business rules. It emits:
 *   'change'  (stationId | null)  something a dashboard or agent should see changed
 *   'command' (stationId, cmd)    a remote command for a station agent
 */
export class Venue extends EventEmitter {
  constructor(db, { now = Date.now } = {}) {
    super();
    this.db = db;
    this.now = now;
    this.online = new Map(); // stationId -> { hostname, version, connectedAt }
    this.loginFails = new Map();
  }

  // ---------- settings ----------

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const settings = { ...DEFAULT_SETTINGS };
    for (const { key, value } of rows) settings[key] = value;
    return settings;
  }

  updateSettings(input) {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (input.venueName !== undefined) upsert.run('venueName', requireText(input.venueName, 'Venue name'));
    if (input.currency !== undefined) upsert.run('currency', requireText(input.currency, 'Currency', { max: 8 }));
    this.emit('change', null);
    return this.getSettings();
  }

  // ---------- admin auth ----------

  needsSetup() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n === 0;
  }

  createAdmin({ username, password }) {
    const name = requireText(username, 'Username', { max: 40 });
    if (typeof password !== 'string' || password.length < 8) {
      throw new AppError(400, 'Password must be at least 8 characters');
    }
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(name, hashSecret(password), this.now());
      return { id: Number(lastInsertRowid), username: name };
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new AppError(409, 'Username already exists');
      throw err;
    }
  }

  login({ username, password }) {
    const admin = this.db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username ?? ''));
    if (!admin || !verifySecret(password ?? '', admin.password_hash)) {
      throw new AppError(401, 'Wrong username or password');
    }
    const token = randomToken(32);
    this.db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(this.now());
    this.db.prepare('INSERT INTO auth_tokens (token, admin_id, expires_at) VALUES (?, ?, ?)')
      .run(token, admin.id, this.now() + TOKEN_TTL);
    return { token, admin: { id: admin.id, username: admin.username } };
  }

  authenticate(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT a.id, a.username, t.expires_at FROM auth_tokens t
      JOIN admins a ON a.id = t.admin_id WHERE t.token = ?`).get(token);
    if (!row || row.expires_at < this.now()) return null;
    return { id: row.id, username: row.username };
  }

  logout(token) {
    this.db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  }

  // ---------- zones ----------

  listZones() {
    return this.db.prepare('SELECT * FROM zones ORDER BY name').all();
  }

  getZone(id) {
    const zone = this.db.prepare('SELECT * FROM zones WHERE id = ?').get(Number(id));
    if (!zone) throw new AppError(404, 'Zone not found');
    return zone;
  }

  createZone({ name, hourlyRate }) {
    const zoneName = requireText(name, 'Zone name');
    const rate = requireInt(hourlyRate, 'Hourly rate', { max: 1_000_000 });
    const { lastInsertRowid } = this.unique(() => this.db
      .prepare('INSERT INTO zones (name, hourly_rate, created_at) VALUES (?, ?, ?)')
      .run(zoneName, rate, this.now()), 'A zone with this name already exists');
    this.emit('change', null);
    return this.getZone(lastInsertRowid);
  }

  updateZone(id, { name, hourlyRate }) {
    const zone = this.getZone(id);
    const zoneName = name === undefined ? zone.name : requireText(name, 'Zone name');
    const rate = hourlyRate === undefined ? zone.hourly_rate : requireInt(hourlyRate, 'Hourly rate', { max: 1_000_000 });
    this.unique(() => this.db.prepare('UPDATE zones SET name = ?, hourly_rate = ? WHERE id = ?')
      .run(zoneName, rate, zone.id), 'A zone with this name already exists');
    this.emit('change', null);
    return this.getZone(zone.id);
  }

  deleteZone(id) {
    const zone = this.getZone(id);
    const used = this.db.prepare('SELECT COUNT(*) AS n FROM stations WHERE zone_id = ?').get(zone.id).n;
    if (used) throw new AppError(409, 'Move or delete the stations in this zone first');
    this.db.prepare('DELETE FROM zones WHERE id = ?').run(zone.id);
    this.emit('change', null);
  }

  // ---------- stations ----------

  listStations() {
    return this.db.prepare(`
      SELECT s.*, z.name AS zone_name, z.hourly_rate FROM stations s
      JOIN zones z ON z.id = s.zone_id ORDER BY z.name, s.name`).all();
  }

  getStation(id) {
    const station = this.db.prepare(`
      SELECT s.*, z.name AS zone_name, z.hourly_rate FROM stations s
      JOIN zones z ON z.id = s.zone_id WHERE s.id = ?`).get(Number(id));
    if (!station) throw new AppError(404, 'Station not found');
    return station;
  }

  stationByToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT * FROM stations WHERE agent_token = ?').get(String(token)) ?? null;
  }

  createStation({ name, zoneId, kind = 'pc' }) {
    const stationName = requireText(name, 'Station name', { max: 40 });
    const zone = this.getZone(zoneId);
    requireOneOf(kind, 'Kind', KINDS);
    const { lastInsertRowid } = this.unique(() => this.db
      .prepare('INSERT INTO stations (name, zone_id, kind, agent_token, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(stationName, zone.id, kind, randomToken(18), this.now()), 'A station with this name already exists');
    this.emit('change', Number(lastInsertRowid));
    return this.getStation(lastInsertRowid);
  }

  updateStation(id, { name, zoneId, kind }) {
    const station = this.getStation(id);
    const stationName = name === undefined ? station.name : requireText(name, 'Station name', { max: 40 });
    const zone = zoneId === undefined ? { id: station.zone_id } : this.getZone(zoneId);
    const stationKind = kind === undefined ? station.kind : requireOneOf(kind, 'Kind', KINDS);
    this.unique(() => this.db.prepare('UPDATE stations SET name = ?, zone_id = ?, kind = ? WHERE id = ?')
      .run(stationName, zone.id, stationKind, station.id), 'A station with this name already exists');
    this.emit('change', station.id);
    return this.getStation(station.id);
  }

  regenerateToken(id) {
    const station = this.getStation(id);
    this.db.prepare('UPDATE stations SET agent_token = ? WHERE id = ?').run(randomToken(18), station.id);
    this.emit('revoke', station.id);
    return this.getStation(station.id);
  }

  deleteStation(id) {
    const station = this.getStation(id);
    if (this.activeSession(station.id)) throw new AppError(409, 'End the active session first');
    const history = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE station_id = ?').get(station.id).n;
    if (history) throw new AppError(409, 'This station has session history and cannot be deleted. Rename it instead.');
    this.emit('revoke', station.id);
    this.db.prepare('DELETE FROM stations WHERE id = ?').run(station.id);
    this.emit('change', null);
  }

  // ---------- customers (members) ----------

  listCustomers() {
    return this.db.prepare(`
      SELECT c.id, c.name, c.username, c.phone, c.balance, c.created_at,
        (SELECT st.name FROM sessions s JOIN stations st ON st.id = s.station_id
          WHERE s.customer_id = c.id AND s.ended_at IS NULL) AS playing_on
      FROM customers c ORDER BY c.name`).all();
  }

  getCustomer(id) {
    const customer = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
    if (!customer) throw new AppError(404, 'Member not found');
    return customer;
  }

  createCustomer({ name, username, phone, pin }) {
    const memberName = requireText(name, 'Name');
    const login = requireText(username, 'Username', { max: 30 }).toLowerCase();
    if (!/^[a-z0-9_.]+$/.test(login)) throw new AppError(400, 'Username may only use letters, numbers, dot and underscore');
    const memberPin = String(pin ?? '');
    if (!/^\d{4,8}$/.test(memberPin)) throw new AppError(400, 'PIN must be 4 to 8 digits');
    const { lastInsertRowid } = this.unique(() => this.db.prepare(`
      INSERT INTO customers (name, username, phone, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(memberName, login, phone ? String(phone).trim() : null, hashSecret(memberPin), this.now()),
      'This username is taken');
    return this.publicCustomer(this.getCustomer(lastInsertRowid));
  }

  updateCustomer(id, { name, phone, pin }) {
    const customer = this.getCustomer(id);
    const memberName = name === undefined ? customer.name : requireText(name, 'Name');
    const memberPhone = phone === undefined ? customer.phone : (phone ? String(phone).trim() : null);
    let pinHash = customer.pin_hash;
    if (pin !== undefined && pin !== '') {
      if (!/^\d{4,8}$/.test(String(pin))) throw new AppError(400, 'PIN must be 4 to 8 digits');
      pinHash = hashSecret(String(pin));
    }
    this.db.prepare('UPDATE customers SET name = ?, phone = ?, pin_hash = ? WHERE id = ?')
      .run(memberName, memberPhone, pinHash, customer.id);
    this.emit('change', null);
    return this.publicCustomer(this.getCustomer(customer.id));
  }

  topUp(customerId, { amount, method = 'cash' }, adminId = null) {
    const value = requireInt(amount, 'Amount', { min: 1, max: 10_000_000 });
    requireOneOf(method, 'Payment method', METHODS);
    const customer = this.getCustomer(customerId);
    const stationId = transaction(this.db, () => {
      this.db.prepare('UPDATE customers SET balance = balance + ? WHERE id = ?').run(value, customer.id);
      this.record({ kind: 'topup', amount: value, method, customerId: customer.id, adminId });
      // A member who is playing gets the extra time straight away.
      const session = this.db.prepare(
        "SELECT * FROM sessions WHERE customer_id = ? AND ended_at IS NULL AND mode = 'member'").get(customer.id);
      if (session) {
        this.setMemberEnd(session, customer.balance + value);
        return session.station_id;
      }
      return null;
    });
    this.emit('change', stationId);
    return this.publicCustomer(this.getCustomer(customer.id));
  }

  publicCustomer({ pin_hash, ...rest }) {
    return rest;
  }

  // ---------- sessions ----------

  activeSession(stationId) {
    return this.db.prepare('SELECT * FROM sessions WHERE station_id = ? AND ended_at IS NULL').get(Number(stationId)) ?? null;
  }

  startSession(stationId, { mode, minutes, customerId, method = 'cash' }, adminId = null) {
    const station = this.getStation(stationId);
    requireOneOf(mode, 'Session type', MODES);
    if (this.activeSession(station.id)) throw new AppError(409, `${station.name} already has an active session`);
    const now = this.now();
    const rate = station.hourly_rate;

    const sessionId = transaction(this.db, () => {
      let endsAt = null;
      let charged = 0;
      let customer = null;

      if (mode === 'prepaid') {
        const mins = requireInt(minutes, 'Minutes', { min: 1, max: 24 * 60 });
        requireOneOf(method, 'Payment method', METHODS);
        endsAt = now + mins * MINUTE;
        charged = costFor(mins, rate);
      } else if (mode === 'member') {
        customer = this.getCustomer(customerId);
        const playing = this.db.prepare('SELECT 1 FROM sessions WHERE customer_id = ? AND ended_at IS NULL').get(customer.id);
        if (playing) throw new AppError(409, `${customer.name} is already playing on another station`);
        if (affordableMinutes(customer.balance, rate) < 1) {
          throw new AppError(402, `${customer.name} needs at least ${costFor(1, rate)} balance to play in ${station.zone_name}`);
        }
      }

      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO sessions (station_id, customer_id, mode, rate, started_at, ends_at, charged)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(station.id, customer?.id ?? null, mode, rate, now, endsAt, charged);
      const id = Number(lastInsertRowid);

      if (mode === 'member') this.setMemberEnd(this.getSession(id), customer.balance);
      if (charged > 0) {
        this.record({ kind: 'session', amount: charged, method, sessionId: id, stationId: station.id, adminId,
          note: `${minutes} min prepaid` });
      }
      return id;
    });

    this.emit('change', station.id);
    return this.getSession(sessionId);
  }

  addTime(stationId, { minutes, method = 'cash' }, adminId = null) {
    const session = this.requireActive(stationId);
    if (session.mode !== 'prepaid') {
      throw new AppError(400, session.mode === 'member'
        ? 'Member sessions run on balance. Top up the member instead.'
        : 'This session has no time limit');
    }
    const mins = requireInt(minutes, 'Minutes', { min: 1, max: 24 * 60 });
    requireOneOf(method, 'Payment method', METHODS);
    const amount = costFor(mins, session.rate);
    transaction(this.db, () => {
      this.db.prepare('UPDATE sessions SET ends_at = ends_at + ?, charged = charged + ? WHERE id = ?')
        .run(mins * MINUTE, amount, session.id);
      this.record({ kind: 'session', amount, method, sessionId: session.id, stationId: session.station_id, adminId,
        note: `${mins} min added` });
    });
    this.emit('change', session.station_id);
    return this.getSession(session.id);
  }

  pause(stationId) {
    const session = this.requireActive(stationId);
    if (session.paused_at == null) {
      this.db.prepare('UPDATE sessions SET paused_at = ? WHERE id = ?').run(this.now(), session.id);
      this.emit('change', session.station_id);
    }
    return this.getSession(session.id);
  }

  resume(stationId) {
    const session = this.requireActive(stationId);
    if (session.paused_at != null) {
      const paused = this.now() - session.paused_at;
      this.db.prepare(`
        UPDATE sessions SET paused_at = NULL, paused_total = paused_total + ?,
          ends_at = CASE WHEN ends_at IS NULL THEN NULL ELSE ends_at + ? END
        WHERE id = ?`).run(paused, paused, session.id);
      this.emit('change', session.station_id);
    }
    return this.getSession(session.id);
  }

  /** Ends the session and settles open and member billing. Returns the closed session. */
  endSession(stationId, { reason = 'staff', method = 'cash' } = {}, adminId = null) {
    const session = this.requireActive(stationId);
    const now = this.now();
    transaction(this.db, () => {
      const used = usedMs(session, now);
      let charge = 0;
      if (session.mode === 'open') {
        requireOneOf(method, 'Payment method', METHODS);
        charge = costFor(billableMinutes(used), session.rate);
        if (charge > 0) {
          this.record({ kind: 'session', amount: charge, method, sessionId: session.id,
            stationId: session.station_id, adminId, note: `${billableMinutes(used)} min open` });
        }
      } else if (session.mode === 'member') {
        const customer = this.getCustomer(session.customer_id);
        charge = Math.min(customer.balance, costFor(billableMinutes(used), session.rate));
        this.db.prepare('UPDATE customers SET balance = balance - ? WHERE id = ?').run(charge, customer.id);
        if (charge > 0) {
          this.record({ kind: 'session', amount: charge, method: 'balance', sessionId: session.id,
            customerId: customer.id, stationId: session.station_id, adminId, note: `${billableMinutes(used)} min member` });
        }
      }
      // Fold an open pause into the total so usage reports stay exact.
      const pausedTotal = session.paused_total + (session.paused_at != null ? now - session.paused_at : 0);
      this.db.prepare(`
        UPDATE sessions SET ended_at = ?, paused_at = NULL, paused_total = ?, charged = charged + ?, end_reason = ?
        WHERE id = ?`).run(now, pausedTotal, charge, reason, session.id);
    });
    this.emit('change', session.station_id);
    return this.getSession(session.id);
  }

  /** Price an open or member session as if it ended now (for the end-session dialog). */
  quote(stationId) {
    const session = this.requireActive(stationId);
    const used = usedMs(session, this.now());
    const due = session.mode === 'open' || session.mode === 'member'
      ? costFor(billableMinutes(used), session.rate) : 0;
    return { sessionId: session.id, mode: session.mode, minutes: Math.ceil(used / MINUTE), due };
  }

  /** Called every second: ends sessions whose time ran out. Returns ended sessions. */
  tick() {
    const expired = this.db.prepare(`
      SELECT station_id FROM sessions
      WHERE ended_at IS NULL AND paused_at IS NULL AND ends_at IS NOT NULL AND ends_at <= ?`).all(this.now());
    return expired.map(({ station_id }) => this.endSession(station_id, { reason: 'expired' }));
  }

  // ---------- member login at the PC ----------

  memberLogin(stationId, { username, pin }) {
    const login = String(username ?? '').trim().toLowerCase();
    const fails = this.loginFails.get(login);
    if (fails && fails.count >= LOGIN_MAX_FAILS && this.now() - fails.at < LOGIN_LOCKOUT) {
      throw new AppError(429, 'Too many wrong PINs. Try again in 2 minutes or ask the front desk.');
    }
    const customer = this.db.prepare('SELECT * FROM customers WHERE username = ?').get(login);
    if (!customer || !verifySecret(String(pin ?? ''), customer.pin_hash)) {
      const count = fails && this.now() - fails.at < LOGIN_LOCKOUT ? fails.count + 1 : 1;
      this.loginFails.set(login, { count, at: this.now() });
      throw new AppError(401, 'Wrong username or PIN');
    }
    this.loginFails.delete(login);
    return this.startSession(stationId, { mode: 'member', customerId: customer.id });
  }

  memberLogout(stationId) {
    const session = this.activeSession(stationId);
    if (!session || session.mode !== 'member') throw new AppError(400, 'No member is logged in on this station');
    return this.endSession(stationId, { reason: 'logout' });
  }

  // ---------- remote commands ----------

  command(stationId, { action, text }) {
    const station = this.getStation(stationId);
    requireOneOf(action, 'Action', ['message', 'restart', 'shutdown']);
    if (!this.online.has(station.id)) throw new AppError(409, `${station.name} is offline`);
    const cmd = { action };
    if (action === 'message') cmd.text = requireText(text, 'Message', { max: 300 });
    if ((action === 'restart' || action === 'shutdown') && this.activeSession(station.id)) {
      throw new AppError(409, 'End the active session before restarting or shutting down');
    }
    this.emit('command', station.id, cmd);
    return { ok: true };
  }

  // ---------- views ----------

  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));
  }

  /** What a station agent needs to know: lock or unlock, and when time runs out. */
  agentState(stationId) {
    const station = this.getStation(stationId);
    const session = this.activeSession(station.id);
    const settings = this.getSettings();
    const base = { station: station.name, zone: station.zone_name, venueName: settings.venueName, serverNow: this.now() };
    if (!session) return { ...base, locked: true, session: null };
    const customer = session.customer_id ? this.getCustomer(session.customer_id) : null;
    return {
      ...base,
      locked: session.paused_at != null,
      session: {
        id: session.id,
        mode: session.mode,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        paused: session.paused_at != null,
        member: customer ? customer.name : null,
      },
    };
  }

  snapshot() {
    const now = this.now();
    const sessions = new Map(this.db.prepare(`
      SELECT s.*, c.name AS customer_name, c.balance AS customer_balance FROM sessions s
      LEFT JOIN customers c ON c.id = s.customer_id WHERE s.ended_at IS NULL`).all()
      .map((s) => [s.station_id, s]));

    const stations = this.listStations().map((st) => {
      const s = sessions.get(st.id);
      const online = this.online.has(st.id);
      let status = 'available';
      if (s) status = s.paused_at != null ? 'paused' : s.mode === 'maintenance' ? 'maintenance' : 'in_use';
      else if (st.kind === 'pc' && !online) status = 'offline';
      return {
        id: st.id,
        name: st.name,
        kind: st.kind,
        zoneId: st.zone_id,
        zoneName: st.zone_name,
        hourlyRate: st.hourly_rate,
        online,
        agent: this.online.get(st.id) ?? null,
        status,
        session: s ? {
          id: s.id,
          mode: s.mode,
          customerId: s.customer_id,
          customerName: s.customer_name,
          customerBalance: s.customer_balance,
          rate: s.rate,
          startedAt: s.started_at,
          endsAt: s.ends_at,
          pausedAt: s.paused_at,
          usedMs: usedMs(s, now),
          charged: s.charged,
        } : null,
      };
    });

    return { serverNow: now, settings: this.getSettings(), zones: this.listZones(), stations };
  }

  report({ from, to }) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new AppError(400, 'Invalid date range');

    const txs = this.db.prepare('SELECT * FROM transactions WHERE created_at >= ? AND created_at < ?').all(start, end);
    const byMethod = { cash: 0, card: 0, balance: 0 };
    let topups = 0;
    let sessionRevenue = 0;
    for (const t of txs) {
      byMethod[t.method] = (byMethod[t.method] ?? 0) + t.amount;
      if (t.kind === 'topup') topups += t.amount;
      if (t.kind === 'session') sessionRevenue += t.amount;
    }

    const sessions = this.db.prepare(`
      SELECT s.*, z.name AS zone_name FROM sessions s
      JOIN stations st ON st.id = s.station_id JOIN zones z ON z.id = st.zone_id
      WHERE s.ended_at >= ? AND s.ended_at < ? AND s.mode != 'maintenance'`).all(start, end);
    const zones = new Map();
    let minutesPlayed = 0;
    for (const s of sessions) {
      const minutes = Math.round(usedMs(s, s.ended_at) / MINUTE);
      minutesPlayed += minutes;
      const z = zones.get(s.zone_name) ?? { zone: s.zone_name, sessions: 0, minutes: 0, revenue: 0 };
      z.sessions += 1;
      z.minutes += minutes;
      z.revenue += s.charged;
      zones.set(s.zone_name, z);
    }

    return {
      from: start,
      to: end,
      cashIn: byMethod.cash + byMethod.card,
      byMethod,
      topups,
      sessionRevenue,
      sessionsCount: sessions.length,
      minutesPlayed,
      byZone: [...zones.values()].sort((a, b) => b.revenue - a.revenue),
    };
  }

  transactions({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT t.*, st.name AS station_name, c.name AS customer_name, a.username AS admin_name
      FROM transactions t
      LEFT JOIN stations st ON st.id = t.station_id
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN admins a ON a.id = t.admin_id
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 1000));
  }

  // ---------- internals ----------

  requireActive(stationId) {
    const station = this.getStation(stationId);
    const session = this.activeSession(station.id);
    if (!session) throw new AppError(409, `${station.name} has no active session`);
    return session;
  }

  // Member sessions end when the balance would run out (paused time is free).
  setMemberEnd(session, balance) {
    const minutes = affordableMinutes(balance, session.rate);
    const endsAt = minutes === Infinity ? null : session.started_at + session.paused_total + minutes * MINUTE;
    this.db.prepare('UPDATE sessions SET ends_at = ? WHERE id = ?').run(endsAt, session.id);
  }

  record({ kind, amount, method, sessionId = null, customerId = null, stationId = null, adminId = null, note = null }) {
    this.db.prepare(`
      INSERT INTO transactions (kind, amount, method, session_id, customer_id, station_id, admin_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, amount, method, sessionId, customerId, stationId, adminId, note, this.now());
  }

  unique(fn, message) {
    try {
      return fn();
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new AppError(409, message);
      throw err;
    }
  }
}
