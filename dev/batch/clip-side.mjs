// Cut a bed's side panels / nightstand wings off with a real plane cut (triangles split on the plane,
// every vertex attribute interpolated) and close the cut with a flat cap, for the "without panel" options.
// The plane sits at half the bed width (+ margin) from the centre line, on the left, right or both sides.
// The cap is filled from the cut outline (even-odd per row on a fine grid) and takes the texture of the
// nearest cut point, so it carries the same finish as the surface it closes.
// usage: node dev/batch/clip-side.mjs in.glb out.glb --h 1120 --bed 1600 --sides L|R|LR [--margin 3] [--cell 3] [--drop x0,y0,y1,z0,z1] [--w mm]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, compactPrimitive } from '@gltf-transform/functions';
import sharp from 'sharp';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const a = process.argv.slice(2); const [IN, OUT] = a; const opt = (k, d) => { const i = a.indexOf('--' + k); return i > 0 ? a[i + 1] : d; };
const capDark = !a.includes('--cap-any'); // cap takes only darker (frame) texels, not light trim/cushion ones
const H = +opt('h'), BED = +opt('bed'), sides = opt('sides', 'LR'), margin = +opt('margin', 3), cellMm = +opt('cell', 3);
const doc = await io.read(IN);
const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
let y0 = 1e9, y1 = -1e9, x0 = 1e9, x1 = -1e9;
for (const p of prims) { const s = p.getAttribute('POSITION').getArray(); for (let i = 0; i < s.length; i += 3) { y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]); x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]); } }
const u = (y1 - y0) / H, cx = (x0 + x1) / 2, half = (BED / 2 + margin) * u;
const planes = []; if (sides.includes('L')) planes.push({ s: -1, c: cx - half }); if (sides.includes('R')) planes.push({ s: 1, c: cx + half });
// signed distance: > 0 means outside (to be removed)
const dist = (pl, x) => pl.s * (x - pl.c);

// --drop "x0,y0,y1,z0,z1[,lum]": before the cut, remove the dark (wood) faces of a box on each cut side: all corners
// |x - centre| >= x0 mm, centroid height y0..y1 and depth z0..z1, base colour darker than lum (default 90). This takes the
// inner end of a nightstand shelf that reaches in over the bed edge, and leaves the light mattress next to it alone.
const dropArg = opt('drop'); if (dropArg) { const [dx0, dy0, dy1, dz0, dz1, dl = 90] = dropArg.split(',').map(Number); let n = 0;
  for (const p of prims) { const s = p.getAttribute('POSITION').getArray(), uv = p.getAttribute('TEXCOORD_0')?.getArray(), idx = p.getIndices().getArray(), keep = [];
    const tex = p.getMaterial()?.getBaseColorTexture(); let img = null;
    if (tex && uv) img = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const lumAt = (u0, v0) => { if (!img) return 0; const { data, info } = img; const x = Math.min(info.width - 1, Math.max(0, Math.floor((u0 - Math.floor(u0)) * info.width))), y = Math.min(info.height - 1, Math.max(0, Math.floor((v0 - Math.floor(v0)) * info.height))); const i = (y * info.width + x) * 3; return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11; };
    const V = (k) => [(s[k * 3] - cx) / u, (s[k * 3 + 1] - y0) / u, s[k * 3 + 2] / u];
    for (let f = 0; f < idx.length; f += 3) { const A = V(idx[f]), B = V(idx[f + 1]), C = V(idx[f + 2]); let drop = false;
      for (const sg of [-1, 1]) { if (!sides.includes(sg > 0 ? 'R' : 'L')) continue; const xs = [A, B, C].map((v) => sg * v[0]); if (Math.min(...xs) < dx0) continue;
        const cy = (A[1] + B[1] + C[1]) / 3, cz = (A[2] + B[2] + C[2]) / 3; if (cy < dy0 || cy > dy1 || cz < dz0 || cz > dz1) continue;
        const k = [idx[f], idx[f + 1], idx[f + 2]]; const L = uv ? lumAt((uv[k[0] * 2] + uv[k[1] * 2] + uv[k[2] * 2]) / 3, (uv[k[0] * 2 + 1] + uv[k[1] * 2 + 1] + uv[k[2] * 2 + 1]) / 3) : 0;
        if (L < dl) drop = true; }
      if (drop) n++; else keep.push(idx[f], idx[f + 1], idx[f + 2]); }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(p.getIndices().getBuffer())); }
  console.log('box faces dropped', n); }

for (const pl of planes) {
  const segs = []; // [{p:[z,y], q:[z,y], prim, uvA, uvB}]
  for (const p of prims) {
    const names = p.listSemantics(); const attrs = names.map((n) => p.getAttribute(n));
    const arrs = attrs.map((A) => Array.from(A.getArray())); const sizes = attrs.map((A) => A.getElementSize());
    const posI = names.indexOf('POSITION'), uvI = names.indexOf('TEXCOORD_0');
    let nv = attrs[posI].getCount();
    const idx = p.getIndices().getArray(), out = [];
    const P = (v) => [arrs[posI][v * 3], arrs[posI][v * 3 + 1], arrs[posI][v * 3 + 2]];
    const lerpV = (va, vb, t) => { for (let k = 0; k < arrs.length; k++) { const n = sizes[k]; for (let j = 0; j < n; j++) arrs[k].push(arrs[k][va * n + j] * (1 - t) + arrs[k][vb * n + j] * t); } return nv++; };
    const cache = new Map();
    const cut = (va, vb, da, db) => { const key = va < vb ? va + ':' + vb : vb + ':' + va; if (cache.has(key)) return cache.get(key);
      const t = da / (da - db); const v = lerpV(va, vb, t); arrs[posI][v * 3] = pl.c; cache.set(key, v); return v; };
    for (let f = 0; f < idx.length; f += 3) {
      const v = [idx[f], idx[f + 1], idx[f + 2]]; const d = v.map((x) => dist(pl, P(x)[0]));
      const ins = d.map((x) => x <= 0); const n = ins.filter(Boolean).length;
      if (n === 3) { out.push(...v); continue; } if (n === 0) continue;
      // Sutherland-Hodgman on one triangle
      const poly = [], cutPts = [];
      for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; if (ins[i]) poly.push(v[i]);
        if (ins[i] !== ins[j]) { const c = cut(v[i], v[j], d[i], d[j]); poly.push(c); cutPts.push(c); } }
      for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0], poly[i], poly[i + 1]);
      if (cutPts.length === 2) { const A = P(cutPts[0]), B = P(cutPts[1]);
        const uv = (x) => uvI >= 0 ? [arrs[uvI][x * 2], arrs[uvI][x * 2 + 1]] : [0, 0];
        segs.push({ p: [A[2], A[1]], q: [B[2], B[1]], prim: p, uvA: uv(cutPts[0]), uvB: uv(cutPts[1]) }); }
    }
    attrs.forEach((A, k) => { const T = A.getArray().constructor; A.setArray(new T(arrs[k])); });
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(out)).setBuffer(p.getIndices().getBuffer()));
  }
  if (!segs.length) { console.log('plane', pl.s, 'no cut'); continue; }
  // cap: even-odd fill per row of a grid on the plane, then one quad per filled run, put into the primitive with the most cut length
  const cell = cellMm * u; let zmin = 1e9, zmax = -1e9, ymin = 1e9, ymax = -1e9; const len = new Map();
  for (const s of segs) { for (const [z, y] of [s.p, s.q]) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    len.set(s.prim, (len.get(s.prim) || 0) + Math.hypot(s.p[0] - s.q[0], s.p[1] - s.q[1])); }
  const capPrim = [...len.entries()].sort((x, y) => y[1] - x[1])[0][0];
  // nearest-cut-point UV lookup on a coarse bucket grid
  const pts = segs.flatMap((s) => [[s.p[0], s.p[1], s.uvA], [s.q[0], s.q[1], s.uvB]]);
  const allPts = pts.slice(); let lumF = null, lightCut = Infinity;
  // keep only cut points whose base colour is in the darker half: the frame finish, not stray light texels
  const tex = capPrim.getMaterial()?.getBaseColorTexture();
  if (capDark && tex) { const { data, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const lum = (uv) => { const x = Math.min(info.width - 1, Math.max(0, Math.floor((uv[0] - Math.floor(uv[0])) * info.width))), y = Math.min(info.height - 1, Math.max(0, Math.floor((uv[1] - Math.floor(uv[1])) * info.height))); const i = (y * info.width + x) * 3; return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11; };
    lumF = lum; const L = pts.map((t) => lum(t[2])); const med = [...L].sort((x, y) => x - y)[Math.floor(L.length * 0.4)];
    const keep = pts.filter((t, i) => L[i] <= med); pts.length = 0; pts.push(...keep);
    // one texel for the whole cap: the dark cut point closest to the dark points' median tone (a flat cut face reads as one finish)
    const KL = keep.map((t) => lum(t[2])).sort((x, y) => x - y), mid = KL[Math.floor(KL.length / 2)];
    let best = keep[0]; for (const t of keep) if (Math.abs(lum(t[2]) - mid) < Math.abs(lum(best[2]) - mid)) best = t;
    pts.length = 0; pts.push(best); lightCut = Math.max(140, KL[KL.length - 1] + 40); }
  const B = 20 * u, bk = new Map(); for (const t of pts) { const k = Math.floor(t[0] / B) + ',' + Math.floor(t[1] / B); if (!bk.has(k)) bk.set(k, []); bk.get(k).push(t); }
  const nearUV = (z, y) => { if (pts.length === 1) return pts[0][2]; let best = null, bd = 1e18; for (let r = 0; r < 6 && !best; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const L = bk.get((Math.floor(z / B) + i) + ',' + (Math.floor(y / B) + j)); if (!L) continue; for (const t of L) { const dd = (t[0] - z) ** 2 + (t[1] - y) ** 2; if (dd < bd) { bd = dd; best = t; } } } return best ? best[2] : [0, 0]; };
  const names = capPrim.listSemantics(); const attrs = names.map((n) => capPrim.getAttribute(n)); const arrs = attrs.map((A) => Array.from(A.getArray())); const sizes = attrs.map((A) => A.getElementSize());
  let nv = attrs[0].getCount(); const idxArr = Array.from(capPrim.getIndices().getArray());
  // a run whose nearest cut point is light (a mattress or cushion cut through) takes that point's own texel instead
  const nearAny = (z, y) => { let best = allPts[0], bd = 1e18; for (const t of allPts) { const dd = (t[0] - z) ** 2 + (t[1] - y) ** 2; if (dd < bd) { bd = dd; best = t; } } return best; };
  let runUV = null;
  const addV = (z, y) => { const uv = runUV || nearUV(z, y); names.forEach((n, k) => { const A = arrs[k];
      if (n === 'POSITION') A.push(pl.c, y, z); else if (n === 'NORMAL') A.push(pl.s, 0, 0); else if (n === 'TEXCOORD_0') A.push(uv[0], uv[1]);
      else if (n === 'TANGENT') A.push(0, 0, -pl.s, 1); else for (let j = 0; j < sizes[k]; j++) A.push(n.startsWith('COLOR') ? 1 : 0); }); return nv++; };
  let quads = 0;
  for (let y = ymin + cell / 2; y < ymax; y += cell) {
    const xs = []; for (const s of segs) { const [za, ya] = s.p, [zb, yb] = s.q; if ((ya <= y) !== (yb <= y)) xs.push(za + (y - ya) / (yb - ya) * (zb - za)); }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) { const za = xs[i], zb = xs[i + 1]; if (zb - za < cell * 0.3) continue;
      const ya = y - cell / 2, yb = Math.min(y + cell / 2, ymax);
      runUV = null; if (lumF) { const t = nearAny((za + zb) / 2, y); if (lumF(t[2]) > lightCut) runUV = t[2]; }
      const v0 = addV(za, ya), v1 = addV(zb, ya), v2 = addV(zb, yb), v3 = addV(za, yb);
      // facing +x for the right plane, -x for the left
      if (pl.s > 0) idxArr.push(v0, v2, v1, v0, v3, v2); else idxArr.push(v0, v1, v2, v0, v2, v3); quads++; }
  }
  attrs.forEach((A, k) => { const T = A.getArray().constructor; A.setArray(new T(arrs[k])); });
  capPrim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idxArr)).setBuffer(capPrim.getIndices().getBuffer()));
  console.log('plane', pl.s > 0 ? 'R' : 'L', 'segments', segs.length, 'cap quads', quads);
}
// drop the vertices no face uses any more, so sizes measure the cut piece
for (const p of prims) compactPrimitive(p);
// --w mm: stretch across to this real width afterwards (the cut sits a little inside the bed edge)
const Wt = +opt('w', 0); if (Wt) { let a0 = 1e9, a1 = -1e9; for (const p of prims) { const q = p.getAttribute('POSITION').getArray(); for (let i = 0; i < q.length; i += 3) { a0 = Math.min(a0, q[i]); a1 = Math.max(a1, q[i]); } }
  const k = Wt * u / (a1 - a0); for (const p of prims) { const A = p.getAttribute('POSITION'), q = A.getArray().slice(); for (let i = 0; i < q.length; i += 3) q[i] = cx + (q[i] - cx) * k; A.setArray(q); }
  console.log('stretched across x', k.toFixed(4)); }
await doc.transform(prune());
await io.write(OUT, doc); console.log('wrote', OUT.split('/').pop());
