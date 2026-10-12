import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  hourly_rate INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id          INTEGER PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  zone_id     INTEGER NOT NULL REFERENCES zones(id),
  kind        TEXT NOT NULL DEFAULT 'pc',
  agent_token TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  username   TEXT UNIQUE NOT NULL,
  phone      TEXT,
  pin_hash   TEXT NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- mode: prepaid (paid upfront for fixed minutes), open (pay at end),
--       member (billed from customer balance), maintenance (staff, free)
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  station_id   INTEGER NOT NULL REFERENCES stations(id),
  customer_id  INTEGER REFERENCES customers(id),
  mode         TEXT NOT NULL,
  rate         INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  ends_at      INTEGER,
  paused_at    INTEGER,
  paused_total INTEGER NOT NULL DEFAULT 0,
  ended_at     INTEGER,
  charged      INTEGER NOT NULL DEFAULT 0,
  end_reason   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_active ON sessions(station_id) WHERE ended_at IS NULL;

-- kind: session | topup ; method: cash | card | balance
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  method      TEXT NOT NULL,
  session_id  INTEGER REFERENCES sessions(id),
  customer_id INTEGER REFERENCES customers(id),
  station_id  INTEGER REFERENCES stations(id),
  admin_id    INTEGER REFERENCES admins(id),
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_created ON transactions(created_at);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
