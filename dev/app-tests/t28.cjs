// v0.6.2: a file made with this program (kept rest + changed groups as separate pieces) opened
// again. Every piece must be parts that can be hovered and clicked, and an export must keep
// every piece that was not changed.
// usage: node t28.cjs MODEL.glb H OUT_NAME [--g1=SELECT:CHOICES] [--g2=SELECT:CHOICES] [--export]
//   SELECT: src1 (parts mostly from piece 1), src0up (piece 0, above 30 % of the height),
//           src0down (piece 0, below that), all, or part ids like 3.4.7
//   CHOICES: comma list of #hex (original texture, new colour) or materialId#hex, e.g. #53733C,leather-matte#8B4A22
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const [GLB, H, NAME = 't28'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류|warn|열기 시간/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(500);
  // parts and the pieces of the file they come from
  const parts = await S(() => {
    const s = window.__studio.S, src = s.info.sources || [{ indexCount: s.faceLabels.length * 3 }];
    const ends = []; let e = 0; for (const x of src) { e += x.indexCount / 3; ends.push(e); }
    const per = s.parts.map(() => new Array(src.length).fill(0));
    for (let f = 0, k = 0; f < s.faceLabels.length; f++) { while (f >= ends[k]) k++; per[s.faceLabels[f]][k]++; }
    const bb = s.info.bbox, Hs = bb.max[1] - bb.min[1];
    return s.parts.map((q, i) => ({ id: q.id, area: +q.areaPct.toFixed(1), src: per[i], main: per[i].indexOf(Math.max(...per[i])), y0: +((q.min[1] - bb.min[1]) / Hs).toFixed(2), y1: +((q.max[1] - bb.min[1]) / Hs).toFixed(2) }));
  });
  log('sources', JSON.stringify(await S(() => window.__studio.S.info.sources)));
  for (const q of parts) log(`part ${q.id}: ${q.area}% piece ${q.main} faces ${q.src.join('/')} y ${q.y0}-${q.y1}`);
  await S(() => { window.__studio.viewer.frame(); });
  await p.waitForTimeout(1000);
  await p.locator('#stage').screenshot({ path: `${OUT}/material.png` });
  await p.click('[data-action="view"][data-view="parts"]');
  await p.waitForTimeout(800);
  await p.locator('#stage').screenshot({ path: `${OUT}/parts.png` });
  // hovering: faces of each big part that face the camera, projected to the screen, must pick that part
  const hits = await S(() => {
    const { viewer: v, S: s } = window.__studio;
    const THREEV = v.camera.position.constructor;
    const m = v.model.matrixWorld.elements, { pos, index } = s.welded;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const res = {};
    const big = s.parts.filter((q) => q.areaPct > 2).map((q) => q.id);
    for (const id of big) {
      let tried = 0, same = 0, other = {};
      for (let f = 0; f < s.faceLabels.length && tried < 40; f += 97) {
        if (s.faceLabels[f] !== id) continue;
        const c = [0, 0, 0];
        for (let k = 0; k < 3; k++) { const i = index[f * 3 + k] * 3; c[0] += pos[i] / 3; c[1] += pos[i + 1] / 3; c[2] += pos[i + 2] / 3; }
        const w = new THREEV(m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]);
        const sp = w.clone().project(v.camera);
        if (Math.abs(sp.x) > 0.95 || Math.abs(sp.y) > 0.95) continue;
        const x = rect.left + ((sp.x + 1) / 2) * rect.width, y = rect.top + ((1 - sp.y) / 2) * rect.height;
        const got = v.pick(x, y);
        // only count faces that are in front (what the camera sees there is this part or something nearer)
        tried++;
        if (got === id) same++; else other[got] = (other[got] || 0) + 1;
      }
      res[id] = { tried, same, other };
    }
    return res;
  });
  log('picks', JSON.stringify(hits));
  await p.click('[data-action="view"][data-view="material"]');
  // groups
  const select = (sel) => parts.filter((q) => sel === 'all' || (sel === 'src1' && q.main === 1) || (sel === 'src0up' && q.main === 0 && q.y0 > 0.3)
    || (sel === 'src0down' && q.main === 0 && q.y0 <= 0.3) || (/^[\d.]+$/.test(sel) && sel.split('.').map(Number).includes(q.id))).map((q) => q.id);
  let gi = 0;
  for (const g of ['g1', 'g2']) {
    if (!opt[g]) continue;
    const [sel, list] = opt[g].split(':');
    const ids = select(sel);
    log(g, sel, '->', ids.join(','));
    await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, ids);
    await p.click('[data-action="group-new"]');
    const choices = list.split(',').map((c) => { const i = c.indexOf('#'); return { mat: i > 0 ? c.slice(0, i) : 'original', hex: c.slice(i).toUpperCase() }; });
    await S(async ({ gi, choices }) => {
      const st = window.__studio, gr = st.S.groups[gi];
      for (const c of choices) {
        const ch = { id: 'c' + Math.random().toString(36).slice(2, 8), materialId: c.mat, color: { hex: c.hex, name: c.hex } };
        gr.choices.push(ch); gr.active = ch.id;
      }
      gr.pick = choices[0].mat;
      await st.updatePreview(gr); st.refreshAll();
    }, { gi, choices });
    gi++;
  }
  await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
  await p.waitForTimeout(1500);
  await p.locator('#stage').screenshot({ path: `${OUT}/preview.png` });
  if (gi) {
    const origNote = await S(async () => { const st = window.__studio, g = st.S.groups[0]; const o = await st.call('groupColor', { parts: g.parts }); return o; });
    log('groupColor g1', JSON.stringify(origNote));
  }
  if (opt.export) {
    const saved = [];
    await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUT}/${fname}`, Buffer.from(b64, 'base64')); saved.push(fname); });
    await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
    const t1 = Date.now();
    await S(() => window.__studio.runExport(window.__studio.S.groups.length ? 'folder' : 'compress')).catch((e) => log('export error', e.message));
    await p.waitForTimeout(800);
    log('saved', saved.map((f) => `${f} ${(fs.statSync(`${OUT}/${f}`).size / 1e6).toFixed(2)}MB`).join(', '), `${Date.now() - t1}ms`);
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
