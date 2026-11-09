// Batch maker: drives the real app (dist/skin-studio.html) headless, exactly as clicking it by hand,
// to make every variant of one product from a job file. Used for the 라움sr catalogue (2026-11-09).
//
// usage: node dev/batch/run.cjs job.json [--dry]   (--dry: set up and save preview shots, no export)
//
// job.json:
// {
//   "glb": "path/model.glb", "h": 750,             // real height in mm (W/D follow the model's proportions)
//   "w": 1600,                                      // optional instead of h: real width drives the scale
//   "prefix": "dio_ceramic_table",                  // file name start
//   "liftMm": 40, "naming": "ko" | "en", "photos": true,
//   "groups": [                                     // in order; every part goes to the first group that takes it
//     { "name": "상판", "select": "top", "sizes": [[1400, 800], [1600, 900]],
//       "choices": [{ "material": "stone-ceramic", "hex": "#C6C6BD", "name": "샌드그레이" }] },
//     { "name": "프레임", "select": "rest", "choices": [{ "material": "wood-walnut", "hex": "#5C3C2B", "name": "월넛" }] }
//   ],
//   "out": "dev/batch/out/dio"
// }
// select: "top" (highest part with the largest area; the parts that make its slab follow its size),
//   "rest" (every part not yet taken), "all", [ids], { "below": 0.5 } / { "above": 0.5 } (fraction of
//   the height the part's top / bottom must stay under / over), { "ids": [..] },
//   { "taller": f } (parts taller than f of the height: a sofa's body without its feet),
//   "slab" (the top and the thin layers under it that make one slab), "under-top" (those layers only).
// A material may be "original" (keep the model's own texture, change only the colour).
// Variants = every combination of the groups' choices and sizes, as in the app.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const ROOT = path.resolve(__dirname, '../..');
const [JOB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = process.argv.includes('--dry');
const job = JSON.parse(fs.readFileSync(JOB, 'utf8'));
const rel = (p) => path.resolve(path.dirname(path.resolve(JOB)), p);
const OUT = rel(job.out || `out/${path.basename(JOB, '.json')}`);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

(async () => {
  // Playwright hands the page an empty file for a non-ASCII path: open a copy with a plain name
  const src = rel(job.glb);
  const tmp = path.join(OUT, '_input.glb');
  fs.copyFileSync(src, tmp);

  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + path.join(ROOT, 'dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  let t = Date.now();
  await p.setInputFiles('#fileInput', tmp);
  await p.waitForFunction(() => window.__studio?.S.workKey && window.__studio.S.parts.length > 0, null, { timeout: 600000 });
  log(`opened ${path.basename(src)} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (job.w) { await p.fill('#sizeW', String(job.w)); await p.press('#sizeW', 'Enter'); }
  else { await p.fill('#sizeH', String(job.h)); await p.press('#sizeH', 'Enter'); }
  await p.waitForTimeout(400);

  const listParts = () => S(() => window.__studio.S.parts.map((q) => ({ id: q.id, min: q.min, max: q.max, area: q.area, faces: q.faces })));
  let parts = await listParts();
  const minY = Math.min(...parts.map((q) => q.min[1])), maxY = Math.max(...parts.map((q) => q.max[1])), Hm = maxY - minY;
  // height cuts, as the app's "높이로 나누기": a stray piece of a leg that came with the top, cut off below
  // `at` (fraction of the height); the lower piece becomes a part of its own (the "rest" group takes it)
  for (const c of job.cuts || []) {
    const id = c.part === 'top' ? parts.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6).sort((a, b) => b.area - a.area)[0]?.id : c.part;
    const y = minY + c.at * Hm;
    const ok = await S(async ({ id, y }) => {
      const st = window.__studio, s = st.S;
      const res = await st.call('cut', { part: id, y });
      Object.assign(s, { parts: res.parts, faceLabels: res.faceLabels, segKey: s.segKey + 1, cuts: [...s.cuts, { part: id, y }] });
      st.viewer.setParts(s.welded.pos, s.welded.index, res.faceLabels, res.parts.length);
      st.refreshAll();
      return true;
    }, { id, y }).catch((e) => { log(`cut part ${id} at ${c.at}: nothing to cut there (${e.message.split('\n')[0]})`); return false; });
    if (!ok) continue;
    parts = await listParts();
    log(`cut part ${id} at ${c.at} of the height: ${parts.length} parts`);
  }
  log(`parts ${parts.length}:`, parts.map((q) => `${q.id}[${((q.min[1] - minY) / Hm).toFixed(2)}-${((q.max[1] - minY) / Hm).toFixed(2)} ${q.faces}f]`).join(' '));

  const taken = new Set();
  for (const g of job.groups) {
    let ids;
    const sel = g.select;
    if (sel === 'top') {
      const top = parts.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6 && !taken.has(q.id)).sort((a, c) => c.area - a.area)[0];
      ids = top ? [top.id] : [];
    } else if (sel === 'slab' || sel === 'under-top') {
      // the top and the thin layers that make one slab with it (its underside, a second layer), as the
      // app's slab followers (core/size.js slabFollowers): thin, about as wide and deep, touching it
      const top = parts.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6 && (sel === 'under-top' || !taken.has(q.id))).sort((a, c) => c.area - a.area)[0];
      ids = top ? [top.id] : [];
      if (top) {
        const tol = 0.01 * Hm, thin = Math.max(2.5 * (top.max[1] - top.min[1]), 0.08 * Hm);
        let lo = top.min[1];
        for (let grew = true; grew;) {
          grew = false;
          for (const q of parts) {
            if (ids.includes(q.id) || taken.has(q.id) || q.max[1] - q.min[1] > thin || q.max[1] < lo - tol) continue;
            if (![0, 2].every((k) => { const e = top.max[k] - top.min[k]; return q.max[k] - q.min[k] >= 0.7 * e && q.min[k] >= top.min[k] - 0.1 * e && q.max[k] <= top.max[k] + 0.1 * e; })) continue;
            ids.push(q.id); lo = Math.min(lo, q.min[1]); grew = true;
          }
        }
        // under-top: only the layers under the top (a two-sided top's lower face), not the top itself
        if (sel === 'under-top') ids = ids.filter((id) => id !== top.id);
      }
    } else if (sel === 'rest' || sel === 'all') ids = parts.map((q) => q.id).filter((id) => sel === 'all' || !taken.has(id));
    else if (Array.isArray(sel)) ids = sel;
    else if (sel?.ids) ids = sel.ids;
    else if (sel?.below != null) ids = parts.filter((q) => !taken.has(q.id) && (q.max[1] - minY) / Hm <= sel.below).map((q) => q.id);
    else if (sel?.taller != null) ids = parts.filter((q) => !taken.has(q.id) && (q.max[1] - q.min[1]) / Hm > sel.taller).map((q) => q.id);
    else if (sel?.above != null) ids = parts.filter((q) => !taken.has(q.id) && (q.min[1] - minY) / Hm >= sel.above).map((q) => q.id);
    ids = ids.filter((id) => !taken.has(id) && parts.some((q) => q.id === id));
    if (!ids.length) { log(`group ${g.name}: no parts, skipped`); continue; }
    await S(({ ids, g }) => {
      const st = window.__studio;
      st.newGroup(ids); const grp = st.S.groups.at(-1); grp.name = g.name;
      for (const c of g.choices) st.addChoice(grp, c.material, { hex: c.hex, name: c.name || '' });
      grp.pick = g.choices[0].material;
      if (g.rotate) st.setPatternAngle(grp, g.rotate);
      st.setActive(grp.key);
      st.refreshAll();
    }, { ids, g });
    ids.forEach((id) => taken.add(id));
    if (g.sizes?.length) {
      for (const [w, d] of g.sizes) { await p.fill('#sizeInput', d ? `${w}×${d}` : `${w}`); await p.click('[data-action="size-add"]'); await p.waitForTimeout(300); }
      // the parts that make the top's slab follow its size and belong to no other group
      const fol = await S(() => { const st = window.__studio; return st.followersOf(st.S.groups.at(-1)) || []; });
      fol.forEach((id) => taken.add(id));
      // the slab's underside gets the top's material too (as clicking both into one group), unless "followersKeep"
      if (fol.length && !g.followersKeep) {
        await S((fol) => { const st = window.__studio, grp = st.S.groups.at(-1); grp.parts = [...new Set([...grp.parts, ...fol])].sort((a, c) => a - c); st.updatePreview(grp); st.refreshAll(); }, fol);
        await p.waitForTimeout(500);
      }
      log(`group ${g.name}: parts ${ids.join(',')} + followers ${fol.join(',') || '-'}; sizes ${g.sizes.map((z) => z.join('×')).join(', ')}`);
    } else log(`group ${g.name}: parts ${ids.join(',')}`);
  }
  const left = parts.filter((q) => !taken.has(q.id)).map((q) => q.id);
  if (left.length) log(`parts kept as modelled: ${left.join(',')}`);
  await p.waitForFunction(() => window.__studio.S.groups.every((g) => g.skinShown), null, { timeout: 600000 });

  // preview shots of the first variant: front quarter and a close-up angle
  await p.waitForTimeout(1200);
  await p.locator('#stage').screenshot({ path: `${OUT}/_preview.png` });

  if (DRY) { await b.close(); return; }

  // export settings as in the export panel
  await S((job) => {
    const st = window.__studio;
    st.S.liftMm = job.liftMm ?? 40;
    st.S.naming = job.naming || 'ko';
    if (job.prefix) st.S.prefix = job.prefix;
    st.S.photos = job.photos !== false;
    if (st.S.photo && job.photos !== false) { st.S.photo.angles = job.angles || ['front', 'quarter']; st.S.photo.bg = job.bg || 'white'; st.S.photo.thumb = true; }
    st.S.catalog = true;
    st.renderExport();
  }, job);
  const saved = [];
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.mkdirSync(path.dirname(`${OUT}/${n}`), { recursive: true }); fs.writeFileSync(`${OUT}/${n}`, data); saved.push(n); }
    else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved.push(fname); }
  });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  t = Date.now();
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(1000);
  const qc = await S(() => window.__studio.S.results.map((r) => ({ name: r.name, bytes: r.bytes ?? r.size, level: r.qc?.level, errors: r.qc?.check?.errors ?? null, notes: r.qc?.notes })));
  log(`exported ${qc.length} variants in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  for (const r of qc) log(`  ${r.name}  errors ${r.errors}  ${r.level || ''}`);
  fs.writeFileSync(`${OUT}/_qc.json`, JSON.stringify(qc, null, 2));
  fs.rmSync(tmp, { force: true });
  log('files:', saved.length);
  await b.close();
  process.exit(qc.length && qc.every((r) => r.errors === 0) ? 0 : 1);
})();
