// v0.6 materials: open time, the material cards of every tab, each built-in material on a real
// model (whole view + close-up), and an export of a few variants for the validator.
// usage: node t26.cjs MODEL.glb H "id:#hex,id:#hex,..." [OUT_NAME] [--parts=top|base|all] [--cut=MM] [--export=N]
// --parts: which parts get the materials (top: the highest part, notop: all but that one, base: the floor parts, all)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [GLB, H, LIST, NAME = 't26'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const picks = LIST.split(',').filter(Boolean).map((s) => { const [id, hex] = s.split(':'); return { id, hex }; });
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류|warn/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  const t0 = Date.now();
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  log('open page', Date.now() - t0, 'ms');
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(300);
  if (opt.cut) {
    await S(() => { window.__studio.S.selection = new Set([0]); window.__studio.refreshAll(); });
    await p.click('[data-action="cut-start"]');
    await p.waitForSelector('#cutRange');
    await p.fill('#cutMm', opt.cut); await p.dispatchEvent('#cutMm', 'change');
    await p.waitForTimeout(800);
    await p.click('[data-action="cut-apply"]');
    await p.waitForFunction(() => window.__studio.S.cuts.length === 1, null, { timeout: 120000 });
  }
  const parts = await S((which) => {
    const s = window.__studio.S, bb = s.info.bbox, Hs = bb.max[1] - bb.min[1];
    const all = s.parts.map((q) => q.id);
    const top = s.parts.reduce((a, q) => (q.min[1] > a.min[1] ? q : a)).id;
    if (which === 'top') return [top];
    if (which === 'notop') return all.filter((id) => id !== top);
    if (which === 'base') return s.parts.filter((q) => q.min[1] < bb.min[1] + 0.03 * Hs && q.max[1] < bb.min[1] + 0.6 * Hs).map((q) => q.id);
    return all;
  }, opt.parts || 'all');
  log('parts', await S(() => window.__studio.S.parts.map((q) => `${q.id}:${q.areaPct.toFixed(1)}%`).join(' ')), '->', parts.join(','));
  await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, parts);
  await p.click('[data-action="group-new"]');
  // the cards of every tab
  for (const tab of ['가죽', '패브릭', '대리석', '나무', '도장', '메탈', '기타']) {
    await p.click(`[data-action="tab"][data-tab="${tab}"]`);
    await p.waitForFunction(() => [...document.querySelectorAll('#secMaterial img[data-swatch]')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 }).catch(() => log('swatches slow', tab));
    await p.waitForTimeout(300);
    await p.locator('#secMaterial .mats').screenshot({ path: `${OUT}/cards_${tab}.png` });
  }
  // close-up: the group's world box, seen from the current direction
  const close = (k) => S((k) => {
    const { viewer: v, S: s } = window.__studio;
    v.frame();
    const m = v.model.matrixWorld.elements, ids = new Set(s.groups[0].parts), { pos, index } = s.welded;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let f = 0; f < s.faceLabels.length; f += 7) {
      if (!ids.has(s.faceLabels[f])) continue;
      const i = index[f * 3] * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], w[a]); hi[a] = Math.max(hi[a], w[a]); }
    }
    const c = v.camera.position, t = v.controls.target;
    const d = [c.x - t.x, c.y - t.y, c.z - t.z], L = Math.hypot(...d);
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    t.set((lo[0] + hi[0]) / 2, hi[1] - (hi[1] - lo[1]) * 0.25, (lo[2] + hi[2]) / 2);
    c.set(t.x + d[0] / L * diag * k, t.y + d[1] / L * diag * k + diag * k * 0.15, t.z + d[2] / L * diag * k);
    v.controls.update(); v.dirty = true;
  }, k);
  for (const pk of picks) {
    await S(({ id, hex }) => {
      const g = window.__studio.S.groups[0];
      const ch = { id: 'c' + Math.random().toString(36).slice(2, 8), materialId: id, color: hex ? { hex: hex.toUpperCase(), name: hex.toUpperCase() } : null };
      g.choices.push(ch); g.active = ch.id;
    }, pk);
    await S(async () => { const g = window.__studio.S.groups[0]; await window.__studio.updatePreview(g); window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
    await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUT}/${pk.id}_whole.png` });
    await close(0.45); await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUT}/${pk.id}_close.png` });
  }
  log('choices', await S(() => window.__studio.S.groups[0].choices.map((c) => `${c.materialId}${c.color ? ' ' + c.color.hex : ''}`).join(' | ')));
  const nExport = +(opt.export || 0);
  if (nExport) {
    await S((n) => { const g = window.__studio.S.groups[0]; g.choices = g.choices.slice(0, n); g.active = g.choices[0]?.id; window.__studio.refreshAll(); }, nExport);
    const saved = [];
    await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUT}/${fname}`, Buffer.from(b64, 'base64')); saved.push(fname); });
    await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
    const t1 = Date.now();
    await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
    await p.waitForTimeout(800);
    log('saved', saved.map((f) => `${f} ${(fs.statSync(`${OUT}/${f}`).size / 1e6).toFixed(2)}MB`).join(', '), `${Date.now() - t1}ms`);
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
