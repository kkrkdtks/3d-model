// Edges of saved files in a viewer that draws only the front of each triangle (the default of three.js
// and of most web viewers, such as 공간무드 STUDIO): export the model with its top re-skinned, then
// - count triangles that face the other way than their normals and degenerate ones,
// - count small patches of the new material projected along another axis than their surroundings
//   (they show as specks where the pattern jumps, mostly just inside the rim),
// - measure the seam between the re-skinned top and the rest (border vertices that have no partner),
// - render close-ups of the top's edge, the saved file and the original model at the same size,
//   single-sided vs double-sided, and compare the pixels that differ (holes) with the original's.
// usage: node t33.cjs MODEL.glb H [OUT_NAME] [--mat=stone-carrara] [--quality=standard]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [GLB, H, NAME = 't33'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

/** Triangles whose winding disagrees with their vertex normals, degenerate ones, per primitive. */
function faceReport(doc) {
  const out = [];
  for (const nd of doc.getRoot().listNodes()) {
    if (!nd.getMesh()) continue;
    const M = nd.getWorldMatrix();
    for (const p of nd.getMesh().listPrimitives()) {
      const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL'), I = p.getIndices();
      const n = I ? I.getCount() : P.getCount();
      const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], nr = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      let tris = 0, against = 0, degen = 0;
      for (let f = 0; f < n; f += 3) {
        for (let c = 0; c < 3; c++) {
          const i = I ? I.getScalar(f + c) : f + c;
          P.getElement(i, v[c]); N.getElement(i, nr[c]);
          const q = v[c];
          v[c] = [0, 1, 2].map((r) => M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]);
        }
        const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...fn);
        if (l < 1e-12) { degen++; continue; }
        tris++;
        const vn = [0, 1, 2].map((k) => nr[0][k] + nr[1][k] + nr[2][k]);
        if (fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2] < 0) against++;
      }
      out.push({ group: p.getExtras()?.group || '?', tris, against, degen });
    }
  }
  return out;
}

/**
 * Patches of each re-skinned primitive: box projection unwelds the mesh where the projection axis
 * changes, so triangles joined by shared vertices are one patch. Returns the patches under minArea m².
 */
function patchReport(doc, minArea = 0.0005) {
  const out = [];
  for (const nd of doc.getRoot().listNodes()) {
    if (!nd.getMesh()) continue;
    const M = nd.getWorldMatrix();
    for (const p of nd.getMesh().listPrimitives()) {
      if ((p.getExtras()?.group || 'rest') === 'rest') continue;
      const P = p.getAttribute('POSITION'), I = p.getIndices(), n = P.getCount();
      const parent = new Int32Array(n).map((_, i) => i);
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      for (let f = 0; f < I.getCount(); f += 3) {
        const a = find(I.getScalar(f)), b = find(I.getScalar(f + 1)), c = find(I.getScalar(f + 2));
        parent[b] = a; parent[find(c)] = a;
      }
      const area = new Map(), q = [0, 0, 0], v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let f = 0; f < I.getCount(); f += 3) {
        for (let c = 0; c < 3; c++) { P.getElement(I.getScalar(f + c), q); v[c] = [0, 1, 2].map((r) => M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]); }
        const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
        const A = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        const r = find(I.getScalar(f));
        area.set(r, (area.get(r) || 0) + A);
      }
      const small = [...area.values()].filter((a) => a < minArea);
      out.push({ group: p.getExtras().group, patches: area.size, small: small.length, smallAreaCm2: +(small.reduce((x, y) => x + y, 0) * 1e4).toFixed(1) });
    }
  }
  return out;
}

/** Border vertices of each primitive (on edges used once) that have no vertex of another primitive within tol. */
function seamReport(doc, tol = 0.0002) {
  const prims = [];
  for (const nd of doc.getRoot().listNodes()) {
    if (!nd.getMesh()) continue;
    const M = nd.getWorldMatrix();
    for (const p of nd.getMesh().listPrimitives()) {
      const P = p.getAttribute('POSITION'), I = p.getIndices();
      const pos = new Float64Array(P.getCount() * 3), q = [0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) { P.getElement(i, q); for (let r = 0; r < 3; r++) pos[i * 3 + r] = M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]; }
      // weld by position so UV seams inside a primitive are not borders
      const key = (i) => `${Math.round(pos[i * 3] / 1e-5)},${Math.round(pos[i * 3 + 1] / 1e-5)},${Math.round(pos[i * 3 + 2] / 1e-5)}`;
      const id = new Map(), wid = new Int32Array(P.getCount());
      for (let i = 0; i < P.getCount(); i++) { const k = key(i); if (!id.has(k)) id.set(k, i); wid[i] = id.get(k); }
      const edges = new Map();
      for (let f = 0; f < I.getCount(); f += 3) for (let c = 0; c < 3; c++) {
        const a = wid[I.getScalar(f + c)], b = wid[I.getScalar(f + ((c + 1) % 3))];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
      const border = new Set();
      for (const [k, cnt] of edges) if (cnt === 1) for (const x of k.split('_')) border.add(+x);
      prims.push({ group: p.getExtras()?.group || '?', pos, border: [...border] });
    }
  }
  const res = [];
  for (const a of prims) {
    if (a.group === 'rest') continue;
    const others = prims.filter((o) => o !== a);
    // grid of the other primitives' vertices
    const cell = 0.002, grid = new Map();
    for (const o of others) for (let i = 0; i < o.pos.length / 3; i++) {
      const k = `${Math.floor(o.pos[i * 3] / cell)},${Math.floor(o.pos[i * 3 + 1] / cell)},${Math.floor(o.pos[i * 3 + 2] / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]]);
    }
    let far = 0, worst = 0;
    const dists = [];
    for (const i of a.border) {
      const x = a.pos[i * 3], y = a.pos[i * 3 + 1], z = a.pos[i * 3 + 2];
      let best = Infinity;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
        for (const q of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) best = Math.min(best, Math.hypot(q[0] - x, q[1] - y, q[2] - z));
      dists.push(best);
      if (best > tol) far++;
      if (best < Infinity) worst = Math.max(worst, best);
    }
    dists.sort((p, q) => p - q);
    res.push({ group: a.group, border: a.border.length, unmatched: far, medianMm: +(dists[Math.floor(dists.length / 2)] * 1000).toFixed(3), worstMm: +(worst * 1000).toFixed(2) });
  }
  return res;
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
  if (opt.quality) await S((q) => { window.__studio.S.quality = q; }, opt.quality);
  // the top: the part reaching highest with the largest area there
  const top = await S(() => {
    const ps = window.__studio.S.parts, maxY = Math.max(...ps.map((q) => q.max[1]));
    return ps.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6).sort((a, c) => c.area - a.area)[0].id;
  });
  log('top part', top, 'of', await S(() => window.__studio.S.parts.length));
  await S(({ top, mat }) => { const st = window.__studio; st.newGroup([top]); const g = st.S.groups[0]; g.name = '상판'; st.addChoice(g, mat, { hex: '#EDE8DC', name: '아이보리' }); g.pick = mat; st.updatePreview(g); st.refreshAll(); }, { top, mat: opt.mat || 'stone-carrara' });
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = 1; }
    else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = 1; }
  });
  await S(() => { window.__studio.S.photos = false; window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  const glb = Object.keys(saved).find((n) => n.endsWith('.glb'));
  log('saved', glb);
  fs.copyFileSync(`${OUT}/${glb}`, `${OUT}/out.glb`);

  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(`${OUT}/out.glb`);
  const faces = faceReport(doc);
  for (const f of faces) log(`faces ${f.group}: ${f.tris} triangles, ${f.against} against their normals (${(100 * f.against / f.tris).toFixed(2)}%), ${f.degen} degenerate`);
  const seams = seamReport(doc);
  for (const s of seams) log(`seam ${s.group}: ${s.border} border vertices, ${s.unmatched} without a partner within 0.2 mm, median ${s.medianMm} mm, worst ${s.worstMm} mm`);
  const patches = patchReport(doc);
  for (const q of patches) log(`patches ${q.group}: ${q.patches} projection patches, ${q.small} under 5 cm² (${q.smallAreaCm2} cm² together)`);
  for (const m of doc.getRoot().listMaterials()) log(`material ${m.getName()}: doubleSided ${m.getDoubleSided()}`);

  // the original model at the same size and place (uniform scale to H, centred, 10 mm off the floor)
  const ref = await io.read(GLB);
  {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], q = [0, 0, 0];
    for (const nd of ref.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION');
        for (let i = 0; i < A.getCount(); i++) {
          A.getElement(i, q);
          for (let r = 0; r < 3; r++) { const w = M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]; lo[r] = Math.min(lo[r], w); hi[r] = Math.max(hi[r], w); }
        }
      }
    }
    const k = H / 1000 / (hi[1] - lo[1]), scene = ref.getRoot().listScenes()[0];
    const wrap = ref.createNode('ref').setScale([k, k, k]).setTranslation([-k * (lo[0] + hi[0]) / 2, -k * lo[1] + 0.01, -k * (lo[2] + hi[2]) / 2]);
    for (const c of scene.listChildren()) wrap.addChild(c);
    scene.addChild(wrap);
    fs.writeFileSync(`${OUT}/ref.glb`, await io.writeBinary(ref));
  }

  // close-up renders of the top edge, as a plain three.js viewer draws them
  const view = await ctx.newPage();
  view.on('pageerror', (e) => log('view pageerror:', e.message));
  const bundle = path.join(OUT, 'viewer.js');
  require('esbuild').buildSync({
    stdin: { contents: `
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
      import { MeshoptDecoder } from 'meshoptimizer';
      window.shoot = async (b64, side, cam) => {
        const r = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
        r.setSize(900, 600); document.body.innerHTML = ''; document.body.appendChild(r.domElement);
        const scene = new THREE.Scene(); scene.background = new THREE.Color('#ffffff');
        const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bin.buffer, '');
        gltf.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) { m.side = side === 'double' ? THREE.DoubleSide : THREE.FrontSide; m.needsUpdate = true; } });
        scene.add(gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
        const camera = new THREE.PerspectiveCamera(30, 1.5, 0.05, 100);
        // near a corner of the top, slightly below its rim, looking at it
        const corner = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
        const t = new THREE.Vector3().lerpVectors(c, corner, 0.85); t.y = box.max.y - 0.015;
        camera.position.set(t.x + size.x * cam[0], t.y + cam[1], t.z + size.z * cam[2]);
        camera.lookAt(t);
        r.render(scene, camera);
        return r.domElement.toDataURL('image/png');
      };` , resolveDir: path.resolve(__dirname, '../..'), loader: 'js' },
    bundle: true, format: 'iife', outfile: bundle, logLevel: 'error',
  });
  fs.writeFileSync(path.join(OUT, 'view.html'), '<!doctype html><body style="margin:0"><script src="viewer.js"></script></body>');
  await view.goto('file://' + path.join(OUT, 'view.html'));
  const sharp = require('sharp');
  const holes = { out: [], ref: [] };
  for (const which of ['out', 'ref']) {
    const b64 = fs.readFileSync(`${OUT}/${which}.glb`).toString('base64');
    for (const [i, cam] of [[0.35, 0.06, 0.25], [0.5, 0.02, -0.1], [-0.2, 0.1, 0.45]].entries()) {
      const imgs = {};
      for (const side of ['front', 'double']) {
        const url = await view.evaluate(({ b64, side, cam }) => window.shoot(b64, side, cam), { b64, side, cam });
        const buf = Buffer.from(url.split(',')[1], 'base64');
        fs.writeFileSync(`${OUT}/${which}_edge${i}_${side}.png`, buf);
        imgs[side] = await sharp(buf).raw().toBuffer();
      }
      let differ = 0;
      for (let k = 0; k < imgs.front.length; k += 3) if (Math.abs(imgs.front[k] - imgs.double[k]) + Math.abs(imgs.front[k + 1] - imgs.double[k + 1]) + Math.abs(imgs.front[k + 2] - imgs.double[k + 2]) > 60) differ++;
      holes[which].push(differ);
    }
    log(`${which === 'out' ? 'saved file' : 'original  '}: ${holes[which].join(', ')} pixels differ between single- and double-sided`);
  }
  // side by side for a look: original above, saved file below
  for (let i = 0; i < 3; i++)
    await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#ffffff' } })
      .composite([{ input: `${OUT}/ref_edge${i}_front.png`, top: 0, left: 0 }, { input: `${OUT}/out_edge${i}_front.png`, top: 600, left: 0 }])
      .png().toFile(`${OUT}/compare${i}.png`);
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ faces, seams, patches, holes }, null, 1));
  const against = faces.reduce((s, f) => s + f.against, 0), tris = faces.reduce((s, f) => s + f.tris, 0);
  check(against / tris < 0.003, `few triangles face against their normals (${against} of ${tris})`);
  check(seams.every((s) => s.unmatched / Math.max(1, s.border) < 0.02), 'the re-skinned top meets the rest without gaps');
  check(patches.every((q) => q.smallAreaCm2 < 20), `no specks of the pattern projected another way (${patches.map((q) => q.small).join(', ')} small patches)`);
  check(Math.max(...holes.out) <= Math.max(...holes.ref) + 30, `no more holes than the original when only front faces are drawn (${holes.out.join(', ')} vs ${holes.ref.join(', ')} px)`);
  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
