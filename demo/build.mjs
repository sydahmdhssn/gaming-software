// Builds demo/dist/dxl-gaming-zone-demo.html: one self-contained file, no server needed.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const shims = { sqlite: 'sqlite.js', events: 'events.js', crypto: 'crypto.js', fs: 'fs.js', path: 'path.js' };

const result = await build({
  entryPoints: [here('./main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  minify: true,
  plugins: [{
    name: 'node-shims',
    setup(b) {
      b.onResolve({ filter: /^node:(sqlite|events|crypto|fs|path)$/ }, (args) => ({ path: here(`./shims/${shims[args.path.slice(5)]}`) }));
    },
  }],
});

const safe = (js, name) => {
  if (/<\/script/i.test(js)) throw new Error(`${name} contains a closing script tag`);
  return js;
};

const html = readFileSync(here('./template.html'), 'utf8')
  .replace('/*APP_CSS*/', () => readFileSync(here('../server/public/app.css'), 'utf8'))
  .replace('/*DEMO_CSS*/', () => readFileSync(here('./demo.css'), 'utf8'))
  .replace('/*SQL_JS*/', () => safe(readFileSync(here('../node_modules/sql.js/dist/sql-wasm.js'), 'utf8'), 'sql.js'))
  .replace('/*WASM_B64*/', () => readFileSync(here('../node_modules/sql.js/dist/sql-wasm.wasm')).toString('base64'))
  .replace('/*BUNDLE*/', () => safe(result.outputFiles[0].text, 'bundle'));

mkdirSync(here('./dist'), { recursive: true });
writeFileSync(here('./dist/dxl-gaming-zone-demo.html'), html);
console.log(`demo/dist/dxl-gaming-zone-demo.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
