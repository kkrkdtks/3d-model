// Green sofa: legs in black steel, white steel and wood -> one GLB + product photo each.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t25';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const [GLB] = process.argv.slice(2);
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e));
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', '690'); await p.press('#sizeH', 'Enter');
  await p.fill('#sizeW', '2400'); await p.press('#sizeW', 'Enter');
  const last = await S(() => window.__studio.S.parts.length - 1);
  await S((i) => { window.__studio.S.selection = new Set([i]); window.__studio.refreshAll(); }, last);
  await p.click('[data-action="group-new"]');
  await p.click('[data-action="tab"][data-tab="메탈"]');
  await p.click('.mat[data-id="metal"]');
  await p.fill('#hexInput', '#1D1C1B, #E4E4E1'); await p.click('[data-action="hex-add"]');
  await p.waitForTimeout(500);
  log('choices', await S(() => window.__studio.S.groups[0].choices.map((c) => `${c.materialId}${c.color ? ' ' + c.color.hex : ''}`).join(' | ')));
  await S(() => window.__studio.viewer.frame());
  // a bit lower and closer so the legs read in the photos
  await S(() => { const v = window.__studio.viewer; const t = v.controls.target, c = v.camera.position; c.set(t.x + (c.x - t.x) * 0.8, t.y + (c.y - t.y) * 0.45, t.z + (c.z - t.z) * 0.8); v.controls.update(); v.dirty = true; });
  await p.waitForTimeout(1500);
  const saved = [];
  await p.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(`${OUT}/${name}`, Buffer.from(b64, 'base64')); saved.push(name); });
  await S(() => { window.__testSave = async (name, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(name, btoa(s)); }; });
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(1000);
  log('saved', saved.join(', '));
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
