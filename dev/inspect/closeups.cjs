// Parts view close-ups of every separate piece of the base group (each leg), nearest first.
// usage: node closeups.cjs model.glb H OUTDIR [max pieces]
const { chromium } = require('playwright');
const fs = require('fs');
const [GLB, H, OUTDIR, MAX] = process.argv.slice(2);
fs.rmSync(OUTDIR, { recursive: true, force: true }); fs.mkdirSync(OUTDIR, { recursive: true });
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  const base = await S(() => {
    const s = window.__studio.S, bb = s.info.bbox, Hs = bb.max[1] - bb.min[1], u = s.info.underside;
    return s.parts.filter((q) => u != null && q.min[1] < bb.min[1] + 0.03 * Hs && q.max[1] < u + 0.25 * Hs).map((q) => q.id);
  });
  await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, base);
  await p.click('[data-action="group-new"]');
  await p.click('[data-action="view"][data-view="parts"]');
  // pieces of the base group: centre and size in screen space metres, nearest the camera first
  const pieces = await S(() => {
    const { viewer: v, S: s } = window.__studio;
    v.frame();
    const m = v.model.matrixWorld.elements, ids = new Set(s.groups[0].parts), { pos, index } = s.welded, nv = pos.length / 3;
    const parent = new Int32Array(nv).fill(-1);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let f = 0; f < s.faceLabels.length; f++) {
      if (!ids.has(s.faceLabels[f])) continue;
      for (let k = 0; k < 3; k++) { const q = index[f * 3 + k]; if (parent[q] < 0) parent[q] = q; }
      for (let k = 1; k < 3; k++) { const a = find(index[f * 3]), c = find(index[f * 3 + k]); if (a !== c) parent[a] = c; }
    }
    const box = new Map();
    for (let q = 0; q < nv; q++) {
      if (parent[q] < 0) continue;
      const r = find(q), x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
      const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      let e = box.get(r); if (!e) box.set(r, (e = { lo: [X, Y, Z], hi: [X, Y, Z], n: 0 }));
      e.n++; [X, Y, Z].forEach((w, i) => { e.lo[i] = Math.min(e.lo[i], w); e.hi[i] = Math.max(e.hi[i], w); });
    }
    const c = v.camera.position;
    return [...box.values()].filter((e) => e.n > 10).map((e) => ({ c: e.lo.map((w, i) => (w + e.hi[i]) / 2), size: Math.max(...e.hi.map((w, i) => w - e.lo[i])), n: e.n, hi: e.hi[1] }))
      .sort((a, b) => Math.hypot(...a.c.map((w, i) => w - [c.x, c.y, c.z][i])) - Math.hypot(...b.c.map((w, i) => w - [c.x, c.y, c.z][i])));
  });
  log(`${pieces.length} pieces:`, pieces.map((q) => `${q.n}v top ${(q.hi * 1000).toFixed(0)}mm`).join(', '));
  for (const [i, q] of pieces.slice(0, +(MAX || 6)).entries()) {
    await S((q) => {
      const v = window.__studio.viewer; v.frame();
      const c = v.camera.position, t = v.controls.target, d = [c.x - t.x, c.y - t.y, c.z - t.z], L = Math.hypot(...d), r = Math.max(0.12, q.size * 1.6);
      t.set(q.c[0], q.c[1] + q.size * 0.3, q.c[2]);
      c.set(t.x + d[0] / L * r * 2.2, t.y + d[1] / L * r * 0.8, t.z + d[2] / L * r * 2.2);
      v.camera.near = r / 50; v.camera.updateProjectionMatrix();
      v.controls.update(); v.dirty = true;
    }, q);
    await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUTDIR}/piece${i}.png` });
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
