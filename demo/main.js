// Boots the self-contained demo: SQLite (WASM) + real venue logic + dashboard + PC simulator.
import { setSqlJs } from './shims/sqlite.js';
import { createBackend } from './backend.js';
import { createPcSimulator } from './pc.js';

const bytes = Uint8Array.from(atob(window.DXL_WASM_B64), (c) => c.charCodeAt(0));
setSqlJs(await window.initSqlJs({ wasmBinary: bytes }));

const backend = createBackend();
const token = backend.seed();
backend.install();
window.DXL_DEMO = { token };

const pc = createPcSimulator(document.getElementById('pc-view'), backend);

// Tabs: front desk dashboard vs gaming PC screen
const app = document.getElementById('app');
const pcView = document.getElementById('pc-view');
function show(tab) {
  app.hidden = tab !== 'desk';
  pcView.hidden = tab !== 'pc';
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  if (tab === 'pc') pc.render(true);
  window.scrollTo(0, 0);
}

document.getElementById('demo-bar').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return show(tab.dataset.tab);
  const act = e.target.closest('[data-demo]')?.dataset.demo;
  if (act === 'skip') {
    backend.skip(5);
    const t = document.getElementById('toast');
    t.textContent = 'Jumped 5 minutes ahead';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }
  if (act === 'reset') location.reload();
  if (act === 'guide') document.getElementById('demo-guide').hidden = !document.getElementById('demo-guide').hidden;
});

// Open the gaming PC view for the station the user just worked on
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-show-pc]');
  if (!link) return;
  show('pc');
});

await import('../server/public/app.js');
document.getElementById('demo-loading').remove();
show('desk');
