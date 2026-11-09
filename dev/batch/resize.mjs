// Whole-piece resize before the app run, for size options of a whole product (a dining table 1400 /
// 1600 / 1900 long): the legs and the ends of the top and frame move rigidly, only the middle stretches,
// so leg thickness, corner radii and edge profiles stay exactly as modelled (the app's own top-only
// resize keeps the frame; here the frame and leg spacing must follow the product's size).
//
// usage: node dev/batch/resize.mjs in.glb out.glb --h 750 [--w 1600] [--d 900] [--band auto|mm]
//   h: real height (mm) the model will be given in the app (sets the model-unit scale)
//   w / d: real width / depth wanted (mm); either may be left out
//   --bandw / --bandd mm: per axis; --legzone 0.05-0.55: height band the legs are found in (below a shelf);
//   --margin 30: mm added past the legs' inner edge
//   band: rigid end zone; auto = from the legs (the parts of the lower half near each end) + 30 mm
// oval tops: --oval 2000x1000 --y0 0.88: the top scaled per axis, the pedestal kept
// round tops: node dev/batch/resize.mjs in.glb out.glb --h 750 --round 1000 --y0 0.93
//   the top (everything from y0, a fraction of the height, up) is resized radially to the diameter: what
//   stands under it (pedestal, legs and their fixings, out to their reach + 20 mm) stays exactly as it is,
//   the outer 60 mm (edge profile) moves rigidly, between them it stretches; so the top stays a true circle
//   (the app's top resize works per axis and would square a round top off a little)
//   --legs edge | mm: a 4-leg round table: the legs move rigidly, keeping their distance from the edge
//   (edge) or to a leg centre spacing seen from the front (mm, from the product drawing); the piece is
//   turned so the legs stand on the diagonals; --legd mm: leg thickness from the drawing
// Prints the band, the stretch per axis and the result size. Textures and materials are left as they are.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { bboxOf, extentOf, furnitureAxes } from '../../core/size.js';

const args = process.argv.slice(2);
const [IN, OUT] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const flag = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const ROUND = flag('round') ? +flag('round') : null, LEGS = flag('legs') || null, OVAL = flag('oval') || null, LEGD = flag('legd') ? +flag('legd') : null, Y0 = flag('y0') ? +flag('y0') : null;
const LZ = (flag('legzone') || '0.05-0.55').split('-').map(Number), MARGIN = flag('margin') ? +flag('margin') : 30;
const H = +flag('h'), W = flag('w') ? +flag('w') : null, D = flag('d') ? +flag('d') : null, BAND = flag('band') || 'auto';

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(IN);
// a turn the modelling tool stored on the node (a viewing angle, not the piece's own) is dropped, so the
// piece's own axes are the room's axes (the app reads world positions and would measure a turned box)
for (const n of doc.getRoot().listNodes()) if (n.getMesh()) { n.setTranslation([0, 0, 0]); n.setRotation([0, 0, 0, 1]); n.setScale([1, 1, 1]); }
const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
// all positions together (models from 3DAISTUDIO / Tripo are one primitive; node transforms are identity there)
const cat = (list) => { const out = new Float32Array(list.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; };
let pos = cat(prims.map((p) => p.getAttribute('POSITION').getArray()));

// Turn the piece about the vertical axis so its top lines up with x / z (AI models often come turned by a few
// degrees, which makes the measured W / D the size of a turned box): the angle with the smallest footprint
// of the upper 12 % (the top), searched in 0.25° steps over 90°, refined to 0.02°.
{
  const b0 = bboxOf(pos), y0 = b0.max[1] - 0.12 * (b0.max[1] - b0.min[1]);
  const pts = [];
  for (let i = 0; i < pos.length; i += 3 * 7) if (pos[i + 1] >= y0) pts.push(pos[i], pos[i + 2]);
  const area = (a) => { const c = Math.cos(a), s = Math.sin(a); let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let i = 0; i < pts.length; i += 2) { const x = c * pts[i] - s * pts[i + 1], z = s * pts[i] + c * pts[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } return (x1 - x0) * (z1 - z0); };
  let best = 0, bestA = area(0);
  for (let d = -45; d < 45; d += 0.25) { const a = (d * Math.PI) / 180, v = area(a); if (v < bestA - 1e-12) { bestA = v; best = a; } }
  for (let d = -0.25; d <= 0.25; d += 0.02) { const a = best + (d * Math.PI) / 180, v = area(a); if (v < bestA - 1e-12) { bestA = v; best = a; } }
  const deg = (best * 180) / Math.PI;
  const gain = 1 - bestA / area(0);
  const e0 = extentOf(b0), round = Math.abs(e0[0] / e0[2] - 1) < 0.04; // round tops: any turn looks the same
  if (!round && Math.abs(deg) > 0.3 && gain > 0.005) {
    const c = Math.cos(best), s = Math.sin(best), cx = (b0.min[0] + b0.max[0]) / 2, cz = (b0.min[2] + b0.max[2]) / 2;
    for (const p of prims) {
      for (const name of ['POSITION', 'NORMAL']) {
        const A = p.getAttribute(name); if (!A) continue;
        const a = A.getArray().slice(), off = name === 'POSITION';
        for (let i = 0; i < a.length; i += 3) { const x = a[i] - (off ? cx : 0), z = a[i + 2] - (off ? cz : 0); a[i] = c * x - s * z + (off ? cx : 0); a[i + 2] = s * x + c * z + (off ? cz : 0); }
        A.setArray(a);
      }
    }
    pos = cat(prims.map((p) => p.getAttribute('POSITION').getArray()));
    console.log(`turned ${deg.toFixed(2)}° so the top lines up (footprint ${(gain * 100).toFixed(1)}% smaller)`);
  }
}
const box = bboxOf(pos), ext = extentOf(box), axes = furnitureAxes(pos);
const unit = H / 1000 / ext[1]; // metres per model unit
const mm = (v) => Math.round(v * unit * 1000);
console.log(`model ${mm(ext[axes.w])} W × ${mm(ext[axes.d])} D × ${H} H (axes w=${'xyz'[axes.w]} d=${'xyz'[axes.d]})`);

/** Rigid end zone on one axis: how far from each end the legs reach inwards (lower 5–55 % of the height). */
function legBand(axis) {
  const y0 = box.min[1] + LZ[0] * ext[1], y1 = box.min[1] + LZ[1] * ext[1];
  const c = (box.min[axis] + box.max[axis]) / 2, half = ext[axis] / 2;
  const bins = new Array(100).fill(0);
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    if (y < y0 || y > y1) continue;
    bins[Math.min(99, Math.floor(((pos[i + axis] - box.min[axis]) / ext[axis]) * 100))]++;
  }
  // legs near the ends with nothing in the middle third: band reaches to the inner edge of the legs
  const mid = bins.slice(34, 66).reduce((s, v) => s + v, 0);
  const tot = bins.reduce((s, v) => s + v, 0) || 1;
  if (mid / tot > 0.03) return null; // a pedestal or a middle leg: no whole-piece stretch
  let lo = 0, hi = 99;
  while (lo < 50 && bins[lo + 1] > 0) lo++;
  for (let i = 0; i < 34; i++) if (bins[i] > 0) lo = Math.max(lo, i);
  for (let i = 99; i >= 66; i--) if (bins[i] > 0) hi = Math.min(hi, i);
  const inner = Math.max((lo + 1) / 100 * ext[axis], (100 - hi) / 100 * ext[axis]);
  return Math.min(half * 0.9, inner + MARGIN / 1000 / unit);
}

if (OVAL) {
  // an oval top: scaled per axis as a whole (an ellipse stays an ellipse; the app's top resize keeps the
  // ends rigid and stretches the middle, which straightens an ellipse's sides), the pedestal under it kept:
  // inside the pedestal's reach + 20 mm nothing moves, out from there the scale blends in over 150 mm
  const [tw, td] = OVAL.split(/[x×]/).map(Number);
  const yCut = box.min[1] + Y0 * ext[1];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] >= yCut) { x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, ex = (x1 - x0) / 2, ez = (z1 - z0) / 2;
  const S = [0, 0, 0]; S[axes.w] = tw / 2000 / unit / (axes.w === 0 ? ex : ez); S[axes.d] = td / 2000 / unit / (axes.d === 0 ? ex : ez);
  let reach = 0; // normalised elliptical radius of what stands under the top
  for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1]; if (y < yCut && y > yCut - 0.08 * ext[1]) reach = Math.max(reach, Math.hypot((pos[i] - cx) / ex, (pos[i + 2] - cz) / ez)); }
  const rho0 = Math.min(0.85, reach + 0.02 / unit / Math.min(ex, ez)), rho1 = Math.min(0.97, rho0 + 0.15 / unit / Math.min(ex, ez));
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  console.log(`oval: ${mm(2 * ex)} × ${mm(2 * ez)} -> ${OVAL} (x × ${S[0].toFixed(3)}, z × ${S[2].toFixed(3)}), kept inside ${(rho0 * 100).toFixed(0)} % of the radius`);
  for (const p of prims) {
    const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
    const a = P.getArray().slice(), n = N ? N.getArray().slice() : null;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i + 1] < yCut) continue;
      const rho = Math.hypot((a[i] - cx) / ex, (a[i + 2] - cz) / ez), t = sm((rho - rho0) / (rho1 - rho0));
      if (t === 0) continue;
      const fx = 1 + (S[0] - 1) * t, fz = 1 + (S[2] - 1) * t;
      a[i] = cx + (a[i] - cx) * fx; a[i + 2] = cz + (a[i + 2] - cz) * fz;
      if (n) { n[i] /= fx; n[i + 2] /= fz; const L = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= L; n[i + 1] /= L; n[i + 2] /= L; }
    }
    P.setArray(a); if (N) N.setArray(n);
  }
  const nb = bboxOf(cat(prims.map((p) => p.getAttribute('POSITION').getArray()))), ne = extentOf(nb);
  console.log(`result ${mm(ne[axes.w])} W × ${mm(ne[axes.d])} D × ${mm(ne[1])} H`);
  await io.write(OUT, doc);
  process.exit(0);
}
if (ROUND) {
  const yCut = box.min[1] + Y0 * ext[1];
  // centre and radius of the top
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] >= yCut) { x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, R = Math.max(x1 - x0, z1 - z0) / 2;
  const newR = ROUND / 2000 / unit, shift = newR - R;
  // legs: what stands in the 10-60 % height band, by quadrant (round tables here have 4 legs or a pedestal)
  const legs = [];
  if (LEGS) {
    // turn the piece about its middle so the legs stand on the diagonals (as in the product drawings,
    // two legs seen at the front): the legs' angle mod 90° from the 10-60 % height band
    const lo0 = box.min[1] + 0.1 * ext[1], hi0 = box.min[1] + 0.6 * ext[1];
    let sx4 = 0, sz4 = 0;
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > lo0 && pos[i + 1] < hi0) { const t = 4 * Math.atan2(pos[i + 2] - cz, pos[i] - cx); sx4 += Math.cos(t); sz4 += Math.sin(t); }
    const th0 = Math.atan2(sz4, sx4) / 4, turn = Math.PI / 4 - th0;
    const c = Math.cos(turn), sn = Math.sin(turn);
    for (const p of prims) for (const name of ['POSITION', 'NORMAL']) {
      const A = p.getAttribute(name); if (!A) continue;
      const a = A.getArray().slice(), off = name === 'POSITION';
      for (let i = 0; i < a.length; i += 3) { const x = a[i] - (off ? cx : 0), z = a[i + 2] - (off ? cz : 0); a[i] = c * x - sn * z + (off ? cx : 0); a[i + 2] = sn * x + c * z + (off ? cz : 0); }
      A.setArray(a);
    }
    pos = cat(prims.map((p) => p.getAttribute('POSITION').getArray()));
    console.log(`legs turned ${((turn * 180) / Math.PI).toFixed(1)}° onto the diagonals`);
    const q = [0, 1, 2, 3].map(() => ({ x: 0, z: 0, n: 0, r: 0 }));
    const lo = box.min[1] + 0.1 * ext[1], hi = box.min[1] + 0.6 * ext[1];
    const quad = (x, z) => (x - cx >= 0 ? 1 : 0) + (z - cz >= 0 ? 2 : 0);
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > lo && pos[i + 1] < hi) { const k = quad(pos[i], pos[i + 2]); q[k].x += pos[i]; q[k].z += pos[i + 2]; q[k].n++; }
    for (const l of q) { l.x /= l.n || 1; l.z /= l.n || 1; }
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > lo && pos[i + 1] < hi) { const l = q[quad(pos[i], pos[i + 2])]; l.r = Math.max(l.r, Math.hypot(pos[i] - l.x, pos[i + 2] - l.z)); }
    // leg thickness: twice the median distance from its axis in the band
    for (const l of q) l.d = [];
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > lo && pos[i + 1] < hi) { const l = q[quad(pos[i], pos[i + 2])]; l.d.push(Math.hypot(pos[i] - l.x, pos[i + 2] - l.z)); }
    for (const l of q) { l.d.sort((a, b) => a - b); l.thick = 2 * l.d[Math.floor(l.d.length * 0.5)]; delete l.d; }
    const thick = q.reduce((s, l) => s + l.thick, 0) / 4;
    var legScale = LEGD ? LEGD / 1000 / unit / thick : 1;
    console.log(`leg thickness ${mm(thick)} mm${LEGD ? ` -> ${LEGD} mm` : ''}`);
    if (q.some((l) => !l.n || Math.hypot(l.x - cx, l.z - cz) < 0.3 * R)) { console.log('round: no 4 legs found'); process.exit(4); }
    const rho = q.reduce((s, l) => s + Math.hypot(l.x - cx, l.z - cz), 0) / 4;
    const halfX = q.reduce((s, l) => s + Math.abs(l.x - cx), 0) / 4;
    // LEGS: 'edge' = legs keep their distance from the edge; a number = leg centre spacing (mm) seen from the front
    const rhoNew = LEGS === 'edge' ? rho + shift : (+LEGS / 2000 / unit) * Math.SQRT2; // legs on the diagonals
    for (const l of q) { const d = Math.hypot(l.x - cx, l.z - cz); l.dx = ((l.x - cx) / d) * (rhoNew - rho); l.dz = ((l.z - cz) / d) * (rhoNew - rho); legs.push(l); }
    console.log(`legs: 4, Ø ${mm(2 * q[0].r)} mm, centres ${mm(rho)} -> ${mm(rhoNew)} mm from the middle (front spacing ${mm(2 * halfX)} -> ${mm(2 * halfX * rhoNew / rho)})`);
    var rho0 = rho, rho1 = rhoNew;
  }
  // reach of what stands under the top (pedestal) when there are no legs to move
  let reach = 0;
  if (!LEGS) for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1]; if (y < yCut && y > yCut - 0.08 * ext[1]) reach = Math.max(reach, Math.hypot(pos[i] - cx, pos[i + 2] - cz)); }
  const edge = Math.min(0.06 / unit, 0.15 * R, 0.5 * (R - (LEGS ? rho0 : reach)));
  const r1 = R - edge;
  // radial map: pedestal: kept to its reach, stretched between it and the edge band; legs: the leg circle
  // goes where the legs go (so the top meets them), stretched to the edge band; the edge band moves rigidly
  const P0 = LEGS ? [[0, 0], [rho0, rho1], [r1, r1 + shift]] : [[0, 0], [Math.min(reach + 0.02 / unit, 0.8 * R), Math.min(reach + 0.02 / unit, 0.8 * R)], [r1, r1 + shift]];
  if (!(P0[2][1] - P0[1][1] > 0.2 * (P0[2][0] - P0[1][0]))) { console.log(`round: ${ROUND} mm is too small for what stands under the top`); process.exit(3); }
  const map = (r) => { if (r >= r1) return r + shift; for (let j = 1; j < P0.length; j++) if (r <= P0[j][0]) { const [a0, b0] = P0[j - 1], [a1, b1] = P0[j]; return b0 + ((r - a0) * (b1 - b0)) / (a1 - a0); } return r + shift; };
  const slope = (r) => { if (r >= r1) return 1; for (let j = 1; j < P0.length; j++) if (r <= P0[j][0]) return (P0[j][1] - P0[j - 1][1]) / (P0[j][0] - P0[j - 1][0]); return 1; };
  console.log(`round: ${mm(2 * R)} -> ${ROUND} mm (top from ${(Y0 * 100).toFixed(1)} % of the height), edge ${mm(edge)} mm rigid, ring × ${slope((P0[1][0] + r1) / 2).toFixed(3)}`);
  for (const p of prims) {
    const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
    const a = P.getArray().slice(), n = N ? N.getArray().slice() : null;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i] - cx, dz = a[i + 2] - cz, r = Math.hypot(dx, dz);
      if (a[i + 1] < yCut) {
        if (!LEGS) continue;
        // a leg moves rigidly; anything else under the top (rails, brackets) follows the top's map
        const l = legs.find((l) => Math.hypot(a[i] - l.x, a[i + 2] - l.z) <= l.r * 1.15);
        if (l) { a[i] = l.x + (a[i] - l.x) * legScale + l.dx; a[i + 2] = l.z + (a[i + 2] - l.z) * legScale + l.dz; continue; }
      }
      if (r < 1e-9) continue;
      const f = map(r) / r;
      a[i] = cx + dx * f; a[i + 2] = cz + dz * f;
      if (n) {
        // radial scale k = slope, tangential scale f: normal components / those scales
        const k = slope(r), ux = dx / r, uz = dz / r;
        const nr = (n[i] * ux + n[i + 2] * uz) / k, nt = (-n[i] * uz + n[i + 2] * ux) / f;
        n[i] = nr * ux - nt * uz; n[i + 2] = nr * uz + nt * ux;
        const L = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= L; n[i + 1] /= L; n[i + 2] /= L;
      }
    }
    P.setArray(a); if (N) N.setArray(n);
  }
  const r0 = P0[1][1];
  // a top modelled a few mm out of round: even its two axes out to the diameter exactly (outer part only)
  {
    let ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity;
    for (const p of prims) { const a = p.getAttribute('POSITION').getArray(); for (let i = 0; i < a.length; i += 3) if (a[i + 1] >= yCut) { ax0 = Math.min(ax0, a[i]); ax1 = Math.max(ax1, a[i]); az0 = Math.min(az0, a[i + 2]); az1 = Math.max(az1, a[i + 2]); } }
    const sx = (2 * newR) / (ax1 - ax0), sz = (2 * newR) / (az1 - az0), ncx = (ax0 + ax1) / 2, ncz = (az0 + az1) / 2;
    for (const p of prims) {
      const P = p.getAttribute('POSITION'), a = P.getArray().slice();
      for (let i = 0; i < a.length; i += 3) {
        if (a[i + 1] < yCut) continue;
        const r = Math.hypot(a[i] - cx, a[i + 2] - cz); if (r <= r0) continue;
        const t = Math.min(1, (r - r0) / (r1 + shift - r0));
        a[i] = ncx + (a[i] - ncx) * (1 + (sx - 1) * t); a[i + 2] = ncz + (a[i + 2] - ncz) * (1 + (sz - 1) * t);
      }
      P.setArray(a);
    }
  }
  const nb = bboxOf(cat(prims.map((p) => p.getAttribute('POSITION').getArray()))), ne = extentOf(nb);
  console.log(`result ${mm(ne[0])} × ${mm(ne[2])} × ${mm(ne[1])} H`);
  await io.write(OUT, doc);
  process.exit(0);
}

const plan = [];
for (const [key, target] of [['w', W], ['d', D]]) {
  if (!target) continue;
  const axis = axes[key], half = ext[axis] / 2, newHalf = target / 2000 / unit;
  if (Math.abs(newHalf - half) < 1e-6) continue;
  const b = flag(`band${key}`) || BAND;
  const band = b === 'auto' ? legBand(axis) : +b / 1000 / unit;
  if (band === null) { console.log(`${key}: legs in the middle (pedestal): use the app's top resize instead`); process.exit(2); }
  const c = (box.min[axis] + box.max[axis]) / 2, r = half - band, shift = newHalf - half;
  if (r + shift <= 0.02 * half) { console.log(`${key}: ${target} mm is too small for the legs (band ${mm(band)} mm)`); process.exit(3); }
  plan.push({ axis, c, r, shift, k: (r + shift) / r });
  console.log(`${key}: ${mm(ext[axis])} -> ${target} mm, rigid ends ${mm(band)} mm, middle × ${((r + shift) / r).toFixed(3)}`);
}

for (const p of prims) {
  const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
  const a = P.getArray().slice(), n = N ? N.getArray().slice() : null;
  for (let i = 0; i < a.length; i += 3) {
    let changed = false;
    for (const s of plan) {
      const d = a[i + s.axis] - s.c, ad = Math.abs(d), sg = d < 0 ? -1 : 1;
      if (ad >= s.r) a[i + s.axis] += sg * s.shift;
      else { a[i + s.axis] = s.c + d * s.k; if (n) { n[i + s.axis] /= s.k; changed = true; } }
    }
    if (n && changed) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  }
  P.setArray(a);
  if (N) N.setArray(n);
}
const nb = bboxOf(cat(prims.map((p) => p.getAttribute('POSITION').getArray())));
const ne = extentOf(nb);
console.log(`result ${mm(ne[axes.w])} W × ${mm(ne[axes.d])} D × ${mm(ne[1])} H`);
await io.write(OUT, doc);
