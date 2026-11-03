// v1.4: glossy finishes and the grain of a table top's edges, through the command-line tool (same core
// as the app).
// - a glossy base (하이그로시) is evened out: its normals change less from vertex to vertex than the same
//   base in satin paint, and it keeps its size;
// - a file with a glossy material keeps its normals at 10 bits (meshopt without the 8-bit octahedral
//   filter), a file without one stays as small as before;
// - wood turned 90° on the top: on the long edges the grain runs along the edge as on the top;
// - a file saved before (8-bit normals, glossy pieces) opened and saved again keeping those pieces: their
//   normals are evened out once and marked, the other pieces are left as they were.
// usage: node dev/app-tests/t36.mjs MODEL.glb H TOP_PARTS BASE_PARTS [OLD_SAVED.glb]
//   e.g. vtable.glb 780 0 1,2,3 u2000.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const [GLB, H, TOP, BASE, OLD] = process.argv.slice(2);
const OUT = path.join(ROOT, 'dev/app-tests/out/t36');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const parts = (s) => s.split(',').map(Number);

function run(name, groups, input = GLB) {
  const dir = path.join(OUT, name);
  const job = { input: path.resolve(input), size: { h: +H }, groups, outDir: dir };
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(job));
  execFileSync('node', [path.join(ROOT, 'cli/skin.mjs'), 'run', path.join(OUT, `${name}.json`)], { stdio: 'pipe' });
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.glb'));
  return f.map((x) => path.join(dir, x));
}

/** GLB JSON chunk. */
function glbJson(file) {
  const b = fs.readFileSync(file);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
}

/** Primitives with welded positions and normals: { name, extras, pos, nrm, index, uv }. */
async function prims(file) {
  const doc = await io.read(file);
  const out = [];
  for (const p of doc.getRoot().listMeshes()[0].listPrimitives()) {
    const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL'), U = p.getAttribute('TEXCOORD_0'), I = p.getIndices();
    const n = P.getCount(), e3 = [0, 0, 0], e2 = [0, 0];
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = U ? new Float32Array(n * 2) : null;
    for (let i = 0; i < n; i++) {
      pos.set(P.getElement(i, e3), i * 3);
      if (N) nrm.set(N.getElement(i, e3), i * 3);
      if (uv) uv.set(U.getElement(i, e2), i * 2);
    }
    out.push({ name: p.getMaterial()?.getName() || '', extras: p.getExtras() || {}, pos, nrm, uv, index: Uint32Array.from(I.getArray()) });
  }
  return out;
}

/** Median angle (degrees) between a vertex normal and the mean of its neighbours' (vertices joined by position). */
function normalNoise(p) {
  const n = p.pos.length / 3, id = new Int32Array(n), key = new Map();
  for (let v = 0; v < n; v++) {
    const k = `${p.pos[v * 3]},${p.pos[v * 3 + 1]},${p.pos[v * 3 + 2]}`;
    let i = key.get(k);
    if (i === undefined) key.set(k, (i = key.size));
    id[v] = i;
  }
  const m = key.size, N = new Float64Array(m * 3), S = new Float64Array(m * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) N[id[v] * 3 + k] = p.nrm[v * 3 + k];
  for (let t = 0; t < p.index.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = id[p.index[t + c]], b = id[p.index[t + ((c + 1) % 3)]];
      for (let k = 0; k < 3; k++) { S[a * 3 + k] += N[b * 3 + k]; S[b * 3 + k] += N[a * 3 + k]; }
    }
  const ang = [];
  for (let v = 0; v < m; v++) {
    const l = Math.hypot(S[v * 3], S[v * 3 + 1], S[v * 3 + 2]);
    if (!l) continue;
    const d = (N[v * 3] * S[v * 3] + N[v * 3 + 1] * S[v * 3 + 1] + N[v * 3 + 2] * S[v * 3 + 2]) / l / (Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1);
    ang.push((Math.acos(Math.min(1, d)) * 180) / Math.PI);
  }
  ang.sort((a, b) => a - b);
  return ang[ang.length >> 1];
}

function box(p) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.pos[i + k]); hi[k] = Math.max(hi[k], p.pos[i + k]); }
  return { lo, hi };
}

/** Area-weighted mean direction in UV space of moving along world axis `ax`, over faces whose normal is near `faceAxis`. */
function uvDirection(p, faceAxis, ax) {
  let su = 0, sv = 0;
  for (let t = 0; t < p.index.length; t += 3) {
    const [a, b, c] = [p.index[t], p.index[t + 1], p.index[t + 2]];
    const P = (i) => [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]], U = (i) => [p.uv[i * 2], p.uv[i * 2 + 1]];
    const A = P(a), B = P(b), C = P(c);
    const e1 = B.map((x, k) => x - A[k]), e2 = C.map((x, k) => x - A[k]);
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz);
    if (!l || Math.abs([nx, ny, nz][faceAxis]) / l < 0.95) continue;
    // UV gradient along world axis ax within the face plane (least squares on the two edges)
    const du1 = U(b)[0] - U(a)[0], dv1 = U(b)[1] - U(a)[1], du2 = U(c)[0] - U(a)[0], dv2 = U(c)[1] - U(a)[1];
    const x1 = e1[ax], x2 = e2[ax];
    const den = x1 * x1 + x2 * x2;
    if (!den) continue;
    const w = l / 2;
    su += (w * (du1 * x1 + du2 * x2)) / den;
    sv += (w * (dv1 * x1 + dv2 * x2)) / den;
  }
  const L = Math.hypot(su, sv) || 1;
  return [su / L, sv / L];
}

// 1. glossy base + wood top turned 90°, and the same base in satin
const [glossFile] = run('gloss', [
  { name: 'top', parts: parts(TOP), choices: [{ material: 'wood-oak', color: '#D8BF98', rotate: 90 }] },
  { name: 'base', parts: parts(BASE), choices: [{ material: 'paint-highgloss', color: '#6F3335' }] },
]);
const [satinFile] = run('satin', [
  { name: 'top', parts: parts(TOP), choices: [{ material: 'wood-oak', color: '#D8BF98', rotate: 90 }] },
  { name: 'base', parts: parts(BASE), choices: [{ material: 'paint-satin', color: '#6F3335' }] },
]);
const G = await prims(glossFile), Sa = await prims(satinFile);
const gb = G.find((p) => p.extras.group === 'base'), sb = Sa.find((p) => p.extras.group === 'base');
const ng = normalNoise(gb), ns = normalNoise(sb);
console.log(`normal noise (median °): glossy ${ng.toFixed(3)}, satin ${ns.toFixed(3)}`);
check(ng < ns * 0.8, 'glossy base is evened out (normals change at least 20% less from vertex to vertex than in satin)');
check(gb.extras.normals === 'fine', 'glossy base is marked as having fine normals');
const bg = box(gb), bs = box(sb);
const dmax = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(bg.lo[k] - bs.lo[k]), Math.abs(bg.hi[k] - bs.hi[k])])) * 1000;
check(dmax < 1, `glossy base keeps its size (box within ${dmax.toFixed(2)} mm of the satin one)`);
const normalFilters = (file) => {
  const j = glbJson(file);
  return j.meshes[0].primitives.map((p) => {
    const a = j.accessors[p.attributes.NORMAL], v = j.bufferViews[a.bufferView];
    return `${a.componentType}:${v.extensions?.EXT_meshopt_compression?.filter || 'NONE'}`;
  });
};
check(normalFilters(glossFile).every((f) => f === '5122:NONE'), `glossy file stores normals as 10-bit shorts (${[...new Set(normalFilters(glossFile))]})`);
check(normalFilters(satinFile).every((f) => f.endsWith(':OCTAHEDRAL')), `file without a glossy material keeps the compact normals (${[...new Set(normalFilters(satinFile))]})`);
const kb = (f) => Math.round(fs.statSync(f).size / 1024);
console.log(`sizes: glossy ${kb(glossFile)} KB, satin ${kb(satinFile)} KB`);
check(fs.statSync(glossFile).size < fs.statSync(satinFile).size * 1.5, 'glossy file is at most 50% bigger');

// 2. grain over the edges of the top: along the length (the longer of x, z), the long sides map it as the top does
const top = G.find((p) => p.extras.group === 'top');
const tb = box(top), len = tb.hi[0] - tb.lo[0] > tb.hi[2] - tb.lo[2] ? 0 : 2, side = 2 - len;
const dTop = uvDirection(top, 1, len), dSide = uvDirection(top, side, len);
const dot = dTop[0] * dSide[0] + dTop[1] * dSide[1];
console.log(`pattern direction along the length: top (${dTop.map((x) => x.toFixed(2))}), long sides (${dSide.map((x) => x.toFixed(2))})`);
check(Math.abs(dot) > 0.95, 'wood grain runs along the long edges as on the top');

// 3. a file saved before, opened and saved again with every piece kept
if (OLD) {
  const before = await prims(OLD);
  const [again] = run('again', [], OLD);
  const after = await prims(again);
  const glossy = (p) => /하이그로시|유광 도장|미러|유리/.test(p.name);
  const b = before.filter(glossy), a = after.filter(glossy);
  check(b.length > 0 && a.length === b.length, `glossy pieces kept (${a.length})`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const nb = normalNoise(b[i]), na = normalNoise(a[i]);
    console.log(`  ${a[i].name}: normal noise ${nb.toFixed(3)}° → ${na.toFixed(3)}°`);
    check(na < nb && a[i].extras.normals === 'fine', `${a[i].name}: normals evened out once and marked`);
  }
  const other = after.filter((p) => !glossy(p) && p.extras.normals === 'fine');
  check(!other.length, 'other pieces are left as they were');
  const [third] = run('third', [], again);
  const c = (await prims(third)).filter(glossy);
  check(c.every((p, i) => Math.abs(normalNoise(p) - normalNoise(a[i])) < 0.02), 'saving once more does not smooth them again');
}
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
