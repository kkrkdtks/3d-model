// v1.4: a table top made longer or narrower takes its underside along. AI models often have the top as
// two parts (a light upper layer, a dark lower layer, or the underside of the top in another part): when
// only the clicked top was stretched, a 2000 mm top hung open past its 1980 mm underside (see-through
// from below, gaps at the rim) and the underside stuck out at the sides of an 850 mm top.
// - the top part gets a material and sizes; the parts under it that make the slab must follow
//   (the panel says so), legs and frame must not;
// - in every saved size, looking up from below anywhere under the top shows a surface facing down
//   (none of it open), no more holes than at the current size;
// - the underside stays inside the top as it was (it does not stick out of a narrower top);
// - the frame and legs keep their size.
// usage: node t35.cjs MODEL.glb H [OUT_NAME] [--cut] [--followers]
//   --cut: split the top into an upper and a lower layer first; --followers: parts must go along with the top
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [GLB, H, NAME = 't35'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const SIZES = [{ w: 2000, d: 850 }, { w: 2200, d: 850 }, { w: 1800, d: 800 }];

/** World-space triangles of a GLB, per primitive: { group, material, tri: Float64Array (9 per triangle) }. */
function triangles(doc) {
  const out = [];
  for (const nd of doc.getRoot().listNodes()) {
    if (!nd.getMesh()) continue;
    const M = nd.getWorldMatrix();
    for (const p of nd.getMesh().listPrimitives()) {
      const P = p.getAttribute('POSITION'), I = p.getIndices(), n = I.getCount(), q = [0, 0, 0];
      const W = new Float64Array(P.getCount() * 3);
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, q);
        for (let r = 0; r < 3; r++) W[i * 3 + r] = M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r];
      }
      const tri = new Float64Array(n * 3);
      for (let t = 0; t < n; t++) { const v = I.getScalar(t); tri.set(W.subarray(v * 3, v * 3 + 3), t * 3); }
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tri[i + k]); hi[k] = Math.max(hi[k], tri[i + k]); }
      out.push({ group: p.getExtras()?.group || '?', material: p.getMaterial()?.getName() || '', tri, lo, hi });
    }
  }
  return out;
}

/**
 * Look up from below at a grid of points under the top (cell mm): the lowest surface of the slab
 * there must face down (a viewer draws only the front of each triangle; a surface facing up is not
 * drawn from below, so the top is see-through there). Returns { cells, open }.
 */
function openFromBelow(prims, top, cell = 0.004) {
  const x0 = top.lo[0] + 0.004, x1 = top.hi[0] - 0.004, z0 = top.lo[2] + 0.004, z1 = top.hi[2] - 0.004;
  const nx = Math.floor((x1 - x0) / cell), nz = Math.floor((z1 - z0) / cell);
  const best = new Float64Array(nx * nz).fill(Infinity), up = new Uint8Array(nx * nz);
  const band = top.lo[1] - 0.06; // the slab and what is right under it
  for (const p of prims)
    for (let t = 0; t < p.tri.length; t += 9) {
      const a = p.tri.subarray(t, t + 3), b = p.tri.subarray(t + 3, t + 6), c = p.tri.subarray(t + 6, t + 9);
      if (a[1] < band || b[1] < band || c[1] < band) continue;
      const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
      const den = ux * vz - uz * vx; // twice the signed area seen from above
      if (Math.abs(den) < 1e-12) continue;
      const ny = uz * vx - ux * vz; // y of (b-a)×(c-a)
      const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - x0) / cell - 0.5));
      const j0 = Math.max(0, Math.ceil((Math.min(a[2], b[2], c[2]) - z0) / cell - 0.5)), j1 = Math.min(nz - 1, Math.floor((Math.max(a[2], b[2], c[2]) - z0) / cell - 0.5));
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const px = x0 + (i + 0.5) * cell - a[0], pz = z0 + (j + 0.5) * cell - a[2];
          const s = (px * vz - pz * vx) / den, r = (ux * pz - uz * px) / den;
          if (s < 0 || r < 0 || s + r > 1) continue;
          const y = a[1] + s * (b[1] - a[1]) + r * (c[1] - a[1]), k = i * nz + j;
          if (y < best[k]) { best[k] = y; up[k] = ny > 0 ? 1 : 0; }
        }
    }
  let open = 0;
  const mask = new Uint8Array(nx * nz); // 255: open, 0: closed (rows along z, for a picture)
  for (let k = 0; k < best.length; k++) if (best[k] === Infinity || up[k]) { open++; mask[(k % nz) * nx + Math.floor(k / nz)] = 255; }
  return { cells: best.length, open, mask, nx, nz };
}

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(400);
  // the top: the part reaching highest with the largest area there
  const topPart = () => S(() => {
    const ps = window.__studio.S.parts, maxY = Math.max(...ps.map((q) => q.max[1]));
    return ps.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6).sort((a, c) => c.area - a.area)[0].id;
  });
  let top = await topPart();
  if ('cut' in opt) {
    // two layers, as a model split by colour into a light top and a dark underside
    await S((top) => { const st = window.__studio; st.S.selection = new Set([top]); st.refreshAll(); }, top);
    await p.click('[data-action="cut-start"]');
    await S((top) => { const st = window.__studio, q = st.S.parts[top]; st.S.cut.y = q.min[1] + 0.62 * (q.max[1] - q.min[1]); }, top);
    await p.click('[data-action="cut-apply"]');
    await p.waitForFunction(() => !window.__studio.S.cut, null, { timeout: 60000 });
    top = await topPart();
  }
  const parts = await S(() => window.__studio.S.parts.map((q) => ({ id: q.id, min: q.min, max: q.max, faces: q.faces })));
  const Hm = Math.max(...parts.map((q) => q.max[1])) - Math.min(...parts.map((q) => q.min[1]));
  log('top part', top, 'of', parts.length);
  // the top gets oak and sizes
  await S((top) => {
    const st = window.__studio;
    st.newGroup([top]); const g = st.S.groups.at(-1); g.name = '상판';
    st.addChoice(g, 'wood-oak', { hex: '#D8BF98', name: '라이트 오크' }); g.pick = 'wood-oak';
    st.refreshAll();
  }, top);
  for (const z of SIZES) { await p.fill('#sizeInput', `${z.w}×${z.d}`); await p.click('[data-action="size-add"]'); await p.waitForTimeout(300); }
  await p.click('[data-action="size-add-current"]');
  const followers = await S(() => { const st = window.__studio; return st.followersOf ? st.followersOf(st.S.groups.find((x) => x.name === "상판")) : []; });
  // everything else but the parts that go along is the base, in high gloss (as sunny's table)
  await S(({ top, followers }) => {
    const st = window.__studio, g = st.S.groups.find((x) => x.name === '상판');
    st.newGroup(st.S.parts.map((q) => q.id).filter((id) => id !== top && !followers.includes(id)));
    const base = st.S.groups.at(-1); base.name = '받침대';
    st.addChoice(base, 'paint-highgloss', { hex: '#6F3335', name: '' }); base.pick = 'paint-highgloss';
    st.setActive(g.key);
    st.refreshAll();
  }, { top, followers });
  await p.waitForFunction(() => window.__studio.S.groups.every((g) => g.skinShown), null, { timeout: 180000 });
  const note = await S(() => document.querySelector('#secMaterial')?.textContent.includes('같은 크기로 같이 바뀌어요'));
  log('followers', JSON.stringify(followers.map((id) => { const q = parts[id]; return { id, h: +((q.max[1] - q.min[1]) / Hm).toFixed(3) }; })));
  if ('followers' in opt) check(followers.length > 0, `parts under the top go along with its size (${followers.length})`);
  check(followers.every((id) => parts[id].max[1] - parts[id].min[1] < 0.1 * Hm), 'only thin parts of the slab, no legs or frame');
  check(note === followers.length > 0, `the size panel says which parts go along (${note ? 'yes' : 'none'})`);

  // the preview at 2200 from below: the followers are drawn stretched, the top closed
  await S(() => { const st = window.__studio, g = st.S.groups.find((x) => x.name === '상판'); g.activeSize = g.sizes[1].id; st.updatePreview(g); });
  await p.waitForFunction((n) => { const st = window.__studio.S; return st.followers.size >= n && [...st.followers.values()].every((f) => f.skinShown) && st.groups.every((g) => g.skinShown); }, followers.length ? 1 : 0, { timeout: 120000 });
  await p.waitForTimeout(1500);
  const dims = await S(() => document.querySelector('#stage').innerText);
  check(/W 2,?200/.test(dims) && /D 850/.test(dims), `the 3D view measures the resized table (${dims.match(/[WD] [\d,]+/g)})`);
  for (const [name, dir] of [['side', [0.15, 0.12, 1]], ['below', [0.35, -0.35, 1]]]) {
    await S((dir) => { const v = window.__studio.viewer, t = v.controls.target, d = v.camera.position.distanceTo(t); const n = v.camera.position.clone().set(...dir).normalize(); v.camera.position.copy(t).addScaledVector(n, d); v.controls.update(); v.dirty = true; }, dir);
    await p.waitForTimeout(800);
    await p.locator('#stage').screenshot({ path: `${OUT}/preview_2200_${name}.png` });
  }

  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) { for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) if (n.endsWith('.glb')) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = 1; } }
    else if (fname.endsWith('.glb')) { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = 1; }
  });
  await S(() => { window.__studio.S.photos = false; window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  const qc = await S(() => window.__studio.S.results.map((r) => ({ name: r.name, errors: r.qc?.check?.errors ?? null })));
  check(qc.length === SIZES.length + 1 && qc.every((r) => r.errors === 0), `${qc.length} files saved, Khronos validator without errors`);

  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const report = {};
  for (const f of Object.keys(saved).sort()) {
    const prims = triangles(await io.read(`${OUT}/${f}`));
    const own = prims.filter((q) => q.group === '상판' && /오크/.test(q.material));
    const under = prims.filter((q) => q.group === '상판' && !/오크/.test(q.material));
    const base = prims.filter((q) => /하이그로시/.test(q.material));
    const box = (list) => list.reduce((a, q) => ({ lo: a.lo.map((v, k) => Math.min(v, q.lo[k])), hi: a.hi.map((v, k) => Math.max(v, q.hi[k])) }), { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
    const t = box(own), u = box(under), bs = box(base);
    const holes = openFromBelow(prims, t);
    await require('sharp')(Buffer.from(holes.mask), { raw: { width: holes.nx, height: holes.nz, channels: 1 } }).png().toFile(`${OUT}/open_${f.replace(/\.glb$/, '')}.png`);
    const mm = (v) => Math.round(v * 1000);
    report[f] = { top: [mm(t.hi[0] - t.lo[0]), mm(t.hi[2] - t.lo[2])], under: under.length ? [mm(u.hi[0] - u.lo[0]), mm(u.hi[2] - u.lo[2])] : null, base: [mm(bs.hi[0] - bs.lo[0]), mm(bs.hi[2] - bs.lo[2])], inset: under.length ? [mm(u.lo[0] - t.lo[0]), mm(t.hi[0] - u.hi[0]), mm(u.lo[2] - t.lo[2]), mm(t.hi[2] - u.hi[2])] : null, open: holes.open, cells: holes.cells };
    log(f, JSON.stringify(report[f]));
  }
  const files = Object.keys(report);
  const current = files.find((f) => !SIZES.some((z) => f.includes(`${z.w}×${z.d}`)));
  const ref = report[current];
  check(!!ref, 'the current size was saved too (the reference)');
  for (const f of files.filter((x) => x !== current)) {
    const r = report[f];
    // the generated surface has its own pinholes and folds (the current size shows how many)
    check(r.open / r.cells <= ref.open / ref.cells + 0.02, `${f}: closed from below (${(100 * r.open / r.cells).toFixed(1)}% of the cells under the top open, current size ${(100 * ref.open / ref.cells).toFixed(1)}%)`);
    if (r.inset && ref.inset) check(r.inset.every((v, k) => v >= Math.min(0, ref.inset[k]) - 2), `${f}: the underside stays inside the top (inset ${r.inset} mm, current ${ref.inset})`);
    check(Math.abs(r.base[0] - ref.base[0]) < 2 && Math.abs(r.base[1] - ref.base[1]) < 2, `${f}: legs and frame keep their size (${r.base} vs ${ref.base})`);
  }
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
