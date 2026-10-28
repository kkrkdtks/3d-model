// Build the program as ONE self-contained HTML file: dist/skin-studio.html
// (all code, the worker and the built-in material textures inlined), so it
// opens by double-click in Chrome or Edge and works without internet.
//
//   node app/build.mjs
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = `${pkg.version} · ${new Date().toISOString().slice(0, 10)}`;

async function bundle(entry, define = {}) {
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)], bundle: true, format: 'iife', platform: 'browser',
    target: ['chrome110', 'edge110'], minify: true, write: false, legalComments: 'none', define, logLevel: 'warning',
    external: ['node:fs', 'node:path'], // only used by gltf-transform's NodeIO, never in the browser
  });
  return r.outputFiles[0].text;
}

const [worker, main] = await Promise.all([
  bundle('app/worker.js'),
  bundle('app/main.js', { __VERSION__: JSON.stringify(version) }),
]);
const css = await fs.readFile(path.join(ROOT, 'app/style.css'), 'utf8');
const library = JSON.parse(await fs.readFile(path.join(ROOT, 'materials/library.json'), 'utf8'));
const files = {};
for (const m of library.materials)
  for (const p of Object.values(m.maps || {})) files[p] = (await fs.readFile(path.join(ROOT, 'materials', p))).toString('base64');

// inline code must not close its <script> element early
const inline = (code) => code.replace(/<\/script/gi, '<\\/script');
let html = await fs.readFile(path.join(ROOT, 'app/index.html'), 'utf8');
html = html
  .replace('/*__CSS__*/', () => css)
  .replace('/*__WORKER__*/', () => inline(worker))
  .replace('/*__LIBRARY__*/', () => JSON.stringify({ library, files }).replace(/</g, '\\u003c'))
  .replace('/*__MAIN__*/', () => inline(main));

const out = path.join(ROOT, 'dist', 'skin-studio.html');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, html);
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)}KB`;
console.log(`dist/skin-studio.html ${kb(html)} (main ${kb(main)}, worker ${kb(worker)}, textures ${Object.keys(files).length}) v${version}`);
