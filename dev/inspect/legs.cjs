// Real model in the app: group the base parts, black and white steel on them, whole view and a
// close-up of the leg nearest the camera for each colour, then export every variant.
// usage: node legs.cjs model.glb H OUTDIR [W]
const { chromium } = require('playwright');
const fs = require('fs');
const [GLB, H, OUTDIR, W] = process.argv.slice(2);
fs.rmSync(OUTDIR, { recursive: true, force: true }); fs.mkdirSync(OUTDIR, { recursive: true });
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1300, height: 860 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  if (W) { await p.fill('#sizeW', String(W)); await p.press('#sizeW', 'Enter'); }
  const info = await S(() => {
    const s = window.__studio.S, bb = s.info.bbox, Hs = bb.max[1] - bb.min[1], u = s.info.underside;
    const base = s.parts.filter((q) => u != null && q.min[1] < bb.min[1] + 0.03 * Hs && q.max[1] < u + 0.25 * Hs).map((q) => q.id);
    return { parts: s.parts.map((q) => [q.id, +q.areaPct.toFixed(2)]), underside: u == null ? null : +((u - bb.min[1]) / Hs * 100).toFixed(1), base };
  });
  log(JSON.stringify(info));
  if (!info.base.length) { log('NO BASE PART'); process.exit(1); }
  await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, info.base);
  await p.click('[data-action="group-new"]');
  await p.click('[data-action="tab"][data-tab="메탈"]');
  await p.click('.mat[data-id="metal"]');
  await p.fill('#hexInput', '#1D1C1B #E4E4E1'); await p.click('[data-action="hex-add"]');
  await p.waitForTimeout(500);
  const group = await S(() => { const g = window.__studio.S.groups[0]; return { name: g.name, choices: g.choices.map((c) => ({ id: c.id, hex: c.color?.hex })) }; });
  log('group', JSON.stringify(group));
  // close-up: the base vertex nearest the camera, seen from the same direction
  const near = () => S(() => {
    const { viewer: v, S: s } = window.__studio;
    v.frame();
    const m = v.model.matrixWorld.elements, ids = new Set(s.groups[0].parts), { pos, index } = s.welded;
    const c = v.camera.position, t = v.controls.target;
    let best = null, bd = Infinity;
    for (let f = 0; f < s.faceLabels.length; f++) {
      if (!ids.has(s.faceLabels[f])) continue;
      const i = index[f * 3] * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      const d = (X - c.x) ** 2 + (Y - c.y) ** 2 + (Z - c.z) ** 2;
      if (d < bd) { bd = d; best = [X, Y, Z]; }
    }
    const dx = c.x - t.x, dy = c.y - t.y, dz = c.z - t.z, k = 0.22;
    t.set(best[0], best[1] + 0.05, best[2]);
    c.set(t.x + dx * k, t.y + dy * k * 0.6, t.z + dz * k);
    v.controls.update(); v.dirty = true;
  });
  for (const [i, ch] of group.choices.entries()) {
    await S(async (id) => { const g = window.__studio.S.groups[0]; g.active = id; await window.__studio.updatePreview(g); window.__studio.refreshAll(); }, ch.id);
    await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
    await p.waitForTimeout(1500);
    await p.locator('#stage').screenshot({ path: `${OUTDIR}/${i}_whole.png` });
    await near(); await p.waitForTimeout(1500);
    await p.locator('#stage').screenshot({ path: `${OUTDIR}/${i}_leg.png` });
  }
  await p.click('[data-action="view"][data-view="parts"]');
  await S(() => window.__studio.viewer.frame()); await p.waitForTimeout(1000);
  await p.locator('#stage').screenshot({ path: `${OUTDIR}/parts.png` });
  await p.click('[data-action="view"][data-view="material"]');
  const saved = [];
  await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUTDIR}/${fname}`, Buffer.from(b64, 'base64')); saved.push(fname); });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  const t0 = Date.now();
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  log('saved', saved.map((f) => `${f} ${(fs.statSync(`${OUTDIR}/${f}`).size / 1e6).toFixed(2)}MB`).join(', '), `${Date.now() - t0}ms`);
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
