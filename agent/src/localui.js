import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const UI_DIR = fileURLToPath(new URL('../ui', import.meta.url));
const FILES = {
  '/': ['lock.html', 'text/html; charset=utf-8'],
  '/session': ['session.html', 'text/html; charset=utf-8'],
  '/ui.css': ['ui.css', 'text/css; charset=utf-8'],
};

/**
 * Serves the lock screen and session window on 127.0.0.1 only.
 * POSTs require the X-DXL header so other web pages cannot trigger them.
 */
export function startLocalUi(core, { port }) {
  const server = createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        return res.end(await readFile(join(UI_DIR, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, core.publicState());

      if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/logout')) {
        if (req.headers['x-dxl'] !== '1') return json(403, { error: 'Forbidden' });
        const body = await readJson(req);
        try {
          if (url.pathname === '/api/login') await core.login(String(body.username ?? ''), String(body.pin ?? ''));
          else await core.logout();
          return json(200, { ok: true });
        } catch (err) {
          return json(400, { error: err.message });
        }
      }
      json(404, { error: 'Not found' });
    } catch {
      json(500, { error: 'Something went wrong' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_192) throw new Error('Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}
