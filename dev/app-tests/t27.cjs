// v0.6.1 "original texture, new colour": pick the 원래 질감 card, add hex colours through the
// panel, preview each (whole + close-up + the panel), export them, and check each file.
// usage: node t27.cjs MODEL.glb H "#hex,#hex" [OUT_NAME] [--parts=all|top|notop|base|nobase] [--size=WxD]
//        [--second=base:materialId:#hex]  a second group (here the floor parts) with a built-in material,
//        so the export mixes "original texture, new colour" with an ordinary material in one file
//        [--reopen]  at the end, open the same model again: the saved work must come back in the new colours
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [GLB, H, HEXES, NAME = 't27'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류|warn/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(300);
  const pick = (which) => S((which) => {
    const s = window.__studio.S, all = s.parts.map((q) => q.id), bb = s.info.bbox, Hs = bb.max[1] - bb.min[1];
    const top = s.parts.reduce((a, q) => (q.min[1] > a.min[1] ? q : a)).id;
    const base = s.parts.filter((q) => q.min[1] < bb.min[1] + 0.03 * Hs && q.max[1] < bb.min[1] + 0.6 * Hs).map((q) => q.id);
    if (which === 'top') return [top];
    if (which === 'notop') return all.filter((id) => id !== top);
    if (which === 'base') return base;
    if (which === 'nobase') return all.filter((id) => !base.includes(id));
    return all;
  }, which);
  const parts = await pick(opt.parts || 'all');
  log('parts', parts.join(','));
  await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, parts);
  await p.click('[data-action="group-new"]');
  if (opt.second) {
    const [which, mid, hex] = opt.second.split(':');
    const ids = await pick(which);
    log('second group', which, ids.join(','), mid, hex);
    await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, ids);
    await p.click('[data-action="group-new"]');
    await S(async ({ mid, hex }) => {
      const st = window.__studio, g = st.S.groups[st.S.groups.length - 1];
      const ch = { id: 'c' + Math.random().toString(36).slice(2, 8), materialId: mid, color: hex ? { hex: hex.toUpperCase(), name: hex.toUpperCase() } : null };
      g.choices.push(ch); g.active = ch.id;
      await st.updatePreview(g); st.refreshAll();
    }, { mid, hex });
    // back to the first group for the colour panel
    await S(() => { const st = window.__studio; st.S.active = st.S.groups[0].key; st.refreshAll(); });
  }
  await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
  await p.waitForTimeout(800);
  await p.locator('#stage').screenshot({ path: `${OUT}/0_original_whole.png` });
  // the card, then colours through the panel
  await p.click('.mat.orig');
  await p.waitForSelector('#hexInput');
  await p.waitForFunction(() => document.querySelector('[data-orig-color]')?.textContent.includes('#'), null, { timeout: 30000 }).catch(() => log('no original colour shown'));
  log('original colour note:', await p.textContent('[data-orig-color]').catch(() => '?'));
  await p.fill('#hexInput', HEXES); await p.click('[data-action="hex-add"]');
  await p.waitForTimeout(600);
  if (opt.size) { await p.fill('#sizeInput', opt.size); await p.click('[data-action="size-add"]'); await p.waitForTimeout(600); }
  await p.locator('#secMaterial').screenshot({ path: `${OUT}/panel.png` });
  const choices = await S(() => window.__studio.S.groups[0].choices.map((c) => ({ id: c.id, m: c.materialId, hex: c.color?.hex })));
  log('choices', JSON.stringify(choices));
  const close = (k) => S((k) => {
    const { viewer: v } = window.__studio;
    v.frame();
    const c = v.camera.position, t = v.controls.target;
    c.set(t.x + (c.x - t.x) * k, t.y + (c.y - t.y) * k, t.z + (c.z - t.z) * k);
    v.controls.update(); v.dirty = true;
  }, k);
  for (const ch of choices) {
    await S(async (id) => { const g = window.__studio.S.groups[0]; g.active = id; await window.__studio.updatePreview(g); window.__studio.refreshAll(); }, ch.id);
    await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
    await p.waitForTimeout(1200);
    const tag = ch.hex.slice(1);
    await p.locator('#stage').screenshot({ path: `${OUT}/${tag}_whole.png` });
    await close(0.42); await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUT}/${tag}_close.png` });
  }
  // original look, same close-up, for comparison
  await S(async () => { const g = window.__studio.S.groups[0]; g.active = null; await window.__studio.updatePreview(g); window.__studio.refreshAll(); });
  await close(0.42); await p.waitForTimeout(1200);
  await p.locator('#stage').screenshot({ path: `${OUT}/0_original_close.png` });
  await S(async () => { const g = window.__studio.S.groups[0]; g.active = g.choices[0].id; await window.__studio.updatePreview(g); window.__studio.refreshAll(); });
  const saved = [];
  await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUT}/${fname}`, Buffer.from(b64, 'base64')); saved.push(fname); });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  const t1 = Date.now();
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  log('saved', saved.map((f) => `${f} ${(fs.statSync(`${OUT}/${f}`).size / 1e6).toFixed(2)}MB`).join(', '), `${Date.now() - t1}ms`);
  if ('reopen' in opt) {
    // the work is kept in the browser: open the same model again in a fresh page
    await S(() => window.__studio.saveWorkNow?.());
    await p.waitForTimeout(1500);
    await p.reload();
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
    await p.waitForTimeout(2500);
    const back = await S(() => {
      const st = window.__studio, g = st.S.groups[0];
      if (!g) return null;
      const mesh = st.viewer.skins.get(g.key);
      return { groups: st.S.groups.length, choices: g.choices.map((c) => `${c.materialId}${c.color ? ' ' + c.color.hex : ''}`), active: g.choices.find((c) => c.id === g.active)?.color?.hex, shown: g.skinShown, recolor: mesh?.userData.recolor || '' };
    });
    log('reopen', JSON.stringify(back));
    await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
    await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUT}/reopen_whole.png` });
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
