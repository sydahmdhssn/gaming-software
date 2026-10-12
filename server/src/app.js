import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Venue } from './venue.js';
import { createApi } from './api.js';
import { attachHub } from './hub.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({ dbFile = ':memory:', now = Date.now, tickMs = 1000 } = {}) {
  const db = openDb(dbFile);
  const venue = new Venue(db, { now });

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApi(venue));
  app.use(express.static(PUBLIC_DIR));

  const server = createServer(app);
  const hub = attachHub(server, venue);

  const ticker = tickMs > 0 ? setInterval(() => {
    try {
      venue.tick();
    } catch (err) {
      console.error('tick failed', err);
    }
  }, tickMs) : null;

  return {
    app,
    server,
    venue,
    db,
    close() {
      clearInterval(ticker);
      hub.close();
      return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
    },
  };
}
