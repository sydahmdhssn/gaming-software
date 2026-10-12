import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_FILE = process.env.DB_FILE ?? 'data/dxl-gaming-zone.db';

const { server, close } = createApp({ dbFile: DB_FILE });

server.listen(PORT, HOST, () => {
  console.log('DXL Solutions · Gaming Zone server');
  console.log(`Dashboard: http://localhost:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`Agents connect to: ws://${a.address}:${PORT}/ws`);
    }
  }
});

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
