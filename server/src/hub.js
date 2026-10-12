import { WebSocketServer } from 'ws';
import { AppError } from './util.js';

const AUTH_TIMEOUT = 5_000;
const PING_INTERVAL = 15_000;

/**
 * One WebSocket endpoint (/ws) for two kinds of clients. The first message decides which:
 *   { type: 'hello', token, hostname, version }  a station agent (token = station pairing token)
 *   { type: 'auth', token }                      a staff dashboard (token = login token)
 */
export function attachHub(httpServer, venue) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });
  const agents = new Map(); // stationId -> ws
  const dashboards = new Set();

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  let snapshotTimer = null;
  const broadcastSnapshot = () => {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!dashboards.size) return;
      const snapshot = { type: 'snapshot', data: venue.snapshot() };
      for (const ws of dashboards) send(ws, snapshot);
    }, 50);
  };

  const pushAgentState = (stationId) => {
    const ws = agents.get(stationId);
    if (ws) send(ws, { type: 'state', data: venue.agentState(stationId) });
  };

  const onChange = (stationId) => {
    if (stationId == null) for (const id of agents.keys()) pushAgentState(id);
    else pushAgentState(stationId);
    broadcastSnapshot();
  };
  const onCommand = (stationId, cmd) => {
    const ws = agents.get(stationId);
    if (ws) send(ws, { type: 'command', data: cmd });
  };
  const onRevoke = (stationId) => agents.get(stationId)?.close(4001, 'Pairing token changed');

  venue.on('change', onChange);
  venue.on('command', onCommand);
  venue.on('revoke', onRevoke);

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let role = null;
    let stationId = null;
    const authTimer = setTimeout(() => { if (!role) ws.close(4000, 'Authentication timeout'); }, AUTH_TIMEOUT);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return ws.close(4000, 'Invalid message');
      }

      if (!role) {
        if (msg.type === 'hello') {
          const station = venue.stationByToken(msg.token);
          if (!station) return ws.close(4001, 'Unknown station token');
          role = 'agent';
          stationId = station.id;
          agents.get(stationId)?.close(4002, 'Replaced by a newer connection');
          agents.set(stationId, ws);
          venue.online.set(stationId, {
            hostname: String(msg.hostname ?? '').slice(0, 64),
            version: String(msg.version ?? '').slice(0, 16),
            connectedAt: venue.now(),
          });
          clearTimeout(authTimer);
          pushAgentState(stationId);
          broadcastSnapshot();
        } else if (msg.type === 'auth') {
          if (!venue.authenticate(msg.token)) return ws.close(4001, 'Please sign in');
          role = 'dashboard';
          dashboards.add(ws);
          clearTimeout(authTimer);
          send(ws, { type: 'snapshot', data: venue.snapshot() });
        } else {
          ws.close(4000, 'Expected hello or auth');
        }
        return;
      }

      if (role === 'agent') handleAgentMessage(stationId, msg, ws);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (role === 'dashboard') dashboards.delete(ws);
      if (role === 'agent' && agents.get(stationId) === ws) {
        agents.delete(stationId);
        venue.online.delete(stationId);
        broadcastSnapshot();
      }
    });
  });

  function handleAgentMessage(stationId, msg, ws) {
    const reply = (ok, extra = {}) => send(ws, { type: 'result', id: msg.id, ok, ...extra });
    try {
      if (msg.type === 'login') {
        venue.memberLogin(stationId, msg);
        reply(true);
      } else if (msg.type === 'logout') {
        venue.memberLogout(stationId);
        reply(true);
      } else if (msg.type === 'refresh') {
        pushAgentState(stationId);
      }
    } catch (err) {
      reply(false, { error: err instanceof AppError ? err.message : 'Something went wrong' });
      if (!(err instanceof AppError)) console.error(err);
    }
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL);

  return {
    close() {
      clearInterval(pinger);
      clearTimeout(snapshotTimer);
      venue.off('change', onChange);
      venue.off('command', onCommand);
      venue.off('revoke', onRevoke);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
