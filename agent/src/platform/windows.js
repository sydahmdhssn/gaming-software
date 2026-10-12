import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_PATHS = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
];

/**
 * Windows controller. The lock screen is Microsoft Edge in kiosk mode (full screen,
 * no address bar) pointed at the agent's local page; a watchdog reopens it if closed.
 * Must run inside the logged-in user's desktop session (e.g. from Startup), not as a service.
 */
export function createWindowsPlatform({ log = console.log } = {}) {
  const edge = process.env.DXL_EDGE_PATH ?? EDGE_PATHS.find((p) => existsSync(p));
  if (!edge) throw new Error('Microsoft Edge was not found. Set DXL_EDGE_PATH to msedge.exe.');

  let lockProc = null;
  let sessionProc = null;
  let wantLocked = false;
  let lockUrl = null;
  let restarts = 0;

  const launch = (args, profile) => spawn(edge, [
    ...args, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    `--user-data-dir=${join(tmpdir(), profile)}`,
  ], { stdio: 'ignore', windowsHide: false });

  const kill = (proc) => {
    if (proc?.pid) execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => {});
  };

  function openLock() {
    if (lockProc) return;
    lockProc = launch(['--kiosk', lockUrl, '--edge-kiosk-type=fullscreen', '--overscroll-history-navigation=0'], 'dxl-lock');
    const started = Date.now();
    lockProc.on('exit', () => {
      lockProc = null;
      if (!wantLocked) return;
      // Someone closed the lock screen: reopen it, backing off if Edge keeps crashing.
      restarts = Date.now() - started < 5_000 ? restarts + 1 : 0;
      setTimeout(openLock, Math.min(10_000, 300 * 2 ** restarts));
    });
  }

  return {
    name: 'windows',
    showLock(url) {
      wantLocked = true;
      lockUrl = url;
      kill(sessionProc);
      sessionProc = null;
      openLock();
    },
    hideLock() {
      wantLocked = false;
      kill(lockProc);
      lockProc = null;
    },
    showSessionWindow(url) {
      if (sessionProc) return;
      sessionProc = launch([`--app=${url}`, '--window-size=340,230'], 'dxl-session');
      sessionProc.on('exit', () => { sessionProc = null; });
    },
    notify(text) {
      const safe = String(text).replace(/'/g, "''");
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `(New-Object -ComObject Wscript.Shell).Popup('${safe}', 20, 'DXL Gaming Zone', 64)`],
      { stdio: 'ignore', detached: true }).unref();
    },
    shutdown() {
      log('Shutting down');
      execFile('shutdown', ['/s', '/t', '5', '/c', 'DXL Gaming Zone: shutdown requested by staff']);
    },
    restart() {
      log('Restarting');
      execFile('shutdown', ['/r', '/t', '5', '/c', 'DXL Gaming Zone: restart requested by staff']);
    },
  };
}
