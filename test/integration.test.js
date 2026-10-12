import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../server/src/app.js';
import { AgentCore } from '../agent/src/core.js';

let ctx;
let base;
let token;
let station;

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const until = async (fn, ms = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  ctx = createApp({ tickMs: 50 });
  ctx.server.listen(0, '127.0.0.1');
  await once(ctx.server, 'listening');
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(() => ctx.close());

test('setup, auth and validation over HTTP', async () => {
  assert.deepEqual((await api('/status')).body.needsSetup, true);
  assert.equal((await api('/snapshot')).status, 401);
  const setup = await api('/setup', { method: 'POST', body: { username: 'owner', password: 'password1' } });
  assert.equal(setup.status, 200);
  token = setup.body.token;
  assert.equal((await api('/setup', { method: 'POST', body: { username: 'x', password: 'password1' } })).status, 409);

  const zone = await api('/zones', { method: 'POST', body: { name: 'VIP', hourlyRate: 600 } });
  assert.equal(zone.status, 200);
  assert.equal((await api('/zones', { method: 'POST', body: { name: 'Bad', hourlyRate: -1 } })).status, 400);
  station = (await api('/stations', { method: 'POST', body: { name: 'VIP 01', zoneId: zone.body.id } })).body;
  assert.ok(station.agent_token);
});

test('agent pairs, unlocks on session start, member logs in at the PC, locks on end', async () => {
  const agent = new AgentCore({ serverUrl: `${base.replace('http', 'ws')}/ws`, token: station.agent_token, hostname: 'test-pc', version: 'test' });
  const events = [];
  agent.on('lock', () => events.push('lock'));
  agent.on('unlock', () => events.push('unlock'));
  const commands = [];
  agent.on('command', (c) => commands.push(c));
  agent.start();

  await until(() => agent.state.connected);
  assert.equal(agent.state.locked, true);
  assert.equal(agent.state.station, 'VIP 01');
  let snap = (await api('/snapshot')).body;
  assert.equal(snap.stations[0].status, 'available');
  assert.equal(snap.stations[0].agent.hostname, 'test-pc');

  // Staff starts a prepaid session -> PC unlocks
  const start = await api(`/stations/${station.id}/session`, { method: 'POST', body: { mode: 'prepaid', minutes: 30, method: 'cash' } });
  assert.equal(start.body.charged, 300);
  await until(() => !agent.state.locked);
  assert.ok(agent.remainingMs() > 29 * 60_000);

  // Remote message
  await api(`/stations/${station.id}/command`, { method: 'POST', body: { action: 'message', text: 'Hello' } });
  await until(() => commands.length === 1);
  assert.deepEqual(commands[0], { action: 'message', text: 'Hello' });

  // Pause locks, resume unlocks
  await api(`/stations/${station.id}/pause`, { method: 'POST' });
  await until(() => agent.state.locked);
  await api(`/stations/${station.id}/resume`, { method: 'POST' });
  await until(() => !agent.state.locked);

  await api(`/stations/${station.id}/end`, { method: 'POST', body: {} });
  await until(() => agent.state.locked);

  // Member signs in from the lock screen
  const member = (await api('/customers', { method: 'POST', body: { name: 'Ali', username: 'ali', pin: '1234' } })).body;
  await assert.rejects(agent.login('ali', '1234'), /needs at least/);
  await api(`/customers/${member.id}/topup`, { method: 'POST', body: { amount: 600, method: 'cash' } });
  await assert.rejects(agent.login('ali', '0000'), /Wrong username or PIN/);
  await agent.login('ali', '1234');
  await until(() => !agent.state.locked);
  assert.equal(agent.state.session.member, 'Ali');
  await agent.logout();
  await until(() => agent.state.locked);

  snap = (await api('/snapshot')).body;
  assert.equal(snap.stations[0].status, 'available');
  assert.deepEqual(events, ['unlock', 'lock', 'unlock', 'lock', 'unlock', 'lock']);
  agent.stop();
  await until(() => !ctx.venue.online.size);
});

test('agent locks locally when time runs out, even if the server is gone', async () => {
  let clock = Date.now();
  const agent = new AgentCore({ serverUrl: 'ws://127.0.0.1:1/ws', token: 'x', now: () => clock });
  const events = [];
  agent.on('lock', () => events.push('lock'));
  agent.applyState({ serverNow: clock, locked: false, session: { id: 9, mode: 'prepaid', endsAt: clock + 80, paused: false } });
  assert.equal(agent.state.locked, false);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(agent.state.locked, true);
  assert.deepEqual(events, ['lock']);
  agent.stop();
});

test('dashboard socket requires a valid token and receives snapshots', async () => {
  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
  const [code] = await once(bad, 'close');
  assert.equal(code, 4001);

  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token }));
  const [raw] = await once(ws, 'message');
  const msg = JSON.parse(raw);
  assert.equal(msg.type, 'snapshot');
  assert.equal(msg.data.stations.length, 1);
  ws.close();
});

test('rejected station token is closed with 4001', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', token: 'not-a-token' }));
  const [code] = await once(ws, 'close');
  assert.equal(code, 4001);
});
