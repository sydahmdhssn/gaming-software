/**
 * Simulator for development and testing on any OS: prints what a real PC would do.
 * Open the lock screen URL in a browser to see and use it.
 */
export function createSimPlatform({ log = console.log } = {}) {
  return {
    name: 'sim',
    showLock(url) { log(`[sim] LOCK screen  -> ${url}`); },
    hideLock() { log('[sim] UNLOCK screen'); },
    showSessionWindow(url) { log(`[sim] session timer window -> ${url}`); },
    notify(text) { log(`[sim] MESSAGE: ${text}`); },
    shutdown() { log('[sim] SHUTDOWN requested'); },
    restart() { log('[sim] RESTART requested'); },
  };
}
