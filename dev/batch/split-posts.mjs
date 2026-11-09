// Split the back posts of a chair off the seat before the app run, where the model joins them into one
// piece (the app's height cut would also cut the seat): the posts are found as the two thin tubes that
// stand alone in a band above the seat; faces lower down that lie inside those tubes (extended down the
// same slant) go to a primitive of their own, so the app sees them as a separate part.
// usage: node dev/batch/split-posts.mjs in.glb out.glb --band 0.64,0.70 --from 0.40 [--grow 1.25]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const args = process.argv.slice(2); const [IN, OUT] = args;
const opt = (k, d) => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : d; };
const [b0, b1] = opt('band', '0.64,0.70').split(',').map(Number), from = +opt('from', 0.4), grow = +opt('grow', 1.25);
const doc = await io.read(IN);
const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives().map((p) => [m, p]));
let ymin = 1e9, ymax = -1e9;
for (const [, p] of prims) { const a = p.getAttribute('POSITION').getArray(); for (let i = 1; i < a.length; i += 3) { ymin = Math.min(ymin, a[i]); ymax = Math.max(ymax, a[i]); } }
const Y = (f) => ymin + f * (ymax - ymin);
// tube centres in two sub-bands, split left/right by x
// which horizontal axis the two tubes stand apart along, and the split value
const band = []; for (const [, p] of prims) { const a = p.getAttribute('POSITION').getArray(); for (let i = 0; i < a.length; i += 3) if (a[i + 1] >= Y(b0) && a[i + 1] < Y(b1)) band.push([a[i], a[i + 2]]); }
const rng = (k) => Math.max(...band.map((q) => q[k])) - Math.min(...band.map((q) => q[k]));
const AX = rng(0) >= rng(1) ? 0 : 1, SPLIT = (Math.max(...band.map((q) => q[AX])) + Math.min(...band.map((q) => q[AX]))) / 2;
const side = (x, z) => ((AX === 0 ? x : z) < SPLIT ? 'L' : 'R');
const cen = (lo, hi) => { const pts = { L: [], R: [] };
  for (const [, p] of prims) { const a = p.getAttribute('POSITION').getArray(); for (let i = 0; i < a.length; i += 3) if (a[i + 1] >= Y(lo) && a[i + 1] < Y(hi)) pts[side(a[i], a[i + 2])].push([a[i], a[i + 2]]); }
  const out = {}; for (const k of ['L', 'R']) { const P = pts[k]; const cx = P.reduce((t, q) => t + q[0], 0) / P.length, cz = P.reduce((t, q) => t + q[1], 0) / P.length; const r = Math.max(...P.map((q) => Math.hypot(q[0] - cx, q[1] - cz))); out[k] = { cx, cz, r, n: P.length, y: (Y(lo) + Y(hi)) / 2 }; } return out; };
const mid = (b0 + b1) / 2, A = cen(b0, mid), Bc = cen(mid, b1);
console.log('tubes', JSON.stringify({ A, Bc }, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
const at = (k, y) => { const a = A[k], b = Bc[k], t = (y - a.y) / (b.y - a.y); return [a.cx + t * (b.cx - a.cx), a.cz + t * (b.cz - a.cz), Math.max(a.r, b.r) * grow]; };
let moved = 0;
for (const [m, p] of prims) {
  const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices().getArray(); const keep = [], take = [];
  for (let f = 0; f < idx.length; f += 3) { let cx = 0, cy = 0, cz = 0; for (let j = 0; j < 3; j++) { const v = idx[f + j] * 3; cx += pos[v] / 3; cy += pos[v + 1] / 3; cz += pos[v + 2] / 3; }
    let hit = false; if (cy >= Y(from) && cy < Y(b1)) { const [tx, tz, r] = at(side(cx, cz), cy); hit = Math.hypot(cx - tx, cz - tz) <= r; }
    (hit ? take : keep).push(idx[f], idx[f + 1], idx[f + 2]); }
  if (!take.length) continue; moved += take.length / 3;
  const q = p.clone(); const I = p.getIndices(); p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(I.getBuffer()));
  q.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(take)).setBuffer(I.getBuffer())); m.addPrimitive(q);
}
console.log('faces moved to the post piece', moved); await io.write(OUT, doc);
