import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentCore } from './core.js';
import { startLocalUi } from './localui.js';
import { createSimPlatform } from './platform/sim.js';
import { createWindowsPlatform } from './platform/windows.js';

const VERSION = '0.1.0';
const CONFIG_FILE = fileURLToPath(new URL('../config.json', import.meta.url));

// Config: agent/config.json, overridable by environment variables.
const fileConfig = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
const config = {
  serverUrl: process.env.DXL_SERVER_URL ?? fileConfig.serverUrl,
  token: process.env.DXL_STATION_TOKEN ?? fileConfig.token,
  localPort: Number(process.env.DXL_LOCAL_PORT ?? fileConfig.localPort ?? 47800),
  platform: process.env.DXL_PLATFORM ?? fileConfig.platform ?? (process.platform === 'win32' ? 'windows' : 'sim'),
};

if (!config.serverUrl || !config.token) {
  console.error('Missing serverUrl or token. Copy agent/config.example.json to agent/config.json and fill it in.');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const platform = config.platform === 'windows' ? createWindowsPlatform({ log }) : createSimPlatform({ log });
const core = new AgentCore({ serverUrl: config.serverUrl, token: config.token, hostname: hostname(), version: VERSION });

const lockUrl = `http://127.0.0.1:${config.localPort}/`;
const sessionUrl = `http://127.0.0.1:${config.localPort}/session`;

await startLocalUi(core, { port: config.localPort });

core.on('lock', () => platform.showLock(lockUrl));
core.on('unlock', () => {
  platform.hideLock();
  platform.showSessionWindow(sessionUrl);
});
core.on('warn', (minutes) => platform.notify(`${minutes} minute${minutes > 1 ? 's' : ''} left on this session.`));
core.on('command', (cmd) => {
  log('command', cmd.action);
  if (cmd.action === 'message') platform.notify(cmd.text);
  else if (cmd.action === 'restart') platform.restart();
  else if (cmd.action === 'shutdown') platform.shutdown();
});
core.on('update', () => {
  const s = core.state;
  log(`${s.connected ? 'online' : 'offline'} · ${s.locked ? 'locked' : 'unlocked'}${s.station ? ` · ${s.station}` : ''}`);
});

// Fail safe: locked from the first second until the server says otherwise.
platform.showLock(lockUrl);
core.start();
log(`DXL Gaming Zone agent ${VERSION} (${platform.name}) -> ${config.serverUrl}`);

const stop = () => {
  core.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
