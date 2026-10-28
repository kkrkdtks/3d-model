// Real size of a piece of furniture, and resizing one part of it.
//
// 3DAISTUDIO models come in a normalised size, so the real W × D × H (mm) has to
// come from the user. The output GLB is in metres, stands on the floor (y = 0)
// and is centred on x/z, so it drops into a room at the right size.
//
// Resizing a part (a table top from 1600 to 2000 mm) does not scale it: a band
// at each end moves rigidly and only the middle stretches, so rounded corners
// and edge profiles keep their exact shape.
//
// Pure functions on plain arrays: shared by the screen, the worker and the CLI.

export function bboxOf(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}

export const extentOf = (b) => [0, 1, 2].map((k) => b.max[k] - b.min[k]);

/**
 * Which horizontal axis is the width (W) and which the depth (D), and which way is the front.
 * Seating: the backrest (top 15 % of the height) sits at the back, so the axis it is pushed
 * along is the depth. Tables, beds and the like: the shorter side is the depth.
 * Returns { w: 0|2, d: 0|2, front: 1|-1 } (front = sign of the front along d).
 */
export function furnitureAxes(pos) {
  const b = bboxOf(pos), ext = extentOf(b);
  const yCut = b.max[1] - ext[1] * 0.15;
  let sx = 0, sz = 0, n = 0;
  for (let i = 0; i < pos.length; i += 3)
    if (pos[i + 1] > yCut) { sx += pos[i]; sz += pos[i + 2]; n++; }
  const ox = n && ext[0] ? (sx / n - (b.min[0] + b.max[0]) / 2) / ext[0] : 0;
  const oz = n && ext[2] ? (sz / n - (b.min[2] + b.max[2]) / 2) / ext[2] : 0;
  let d;
  if (Math.max(Math.abs(ox), Math.abs(oz)) > 0.08) d = Math.abs(ox) > Math.abs(oz) ? 0 : 2;
  else d = ext[0] < ext[2] ? 0 : 2;
  const off = d === 0 ? ox : oz;
  return { w: d === 0 ? 2 : 0, d, front: Math.abs(off) > 0.05 ? -Math.sign(off) : 1 };
}

/** The same axes with W and D swapped (when the guess was wrong). */
export const swapAxes = (a) => ({ w: a.d, d: a.w, front: 1 });

/**
 * Model units -> metres from the real size in mm. h is required; w and d are optional and,
 * when left out, follow the height (the proportions of the model stay as they are).
 * Returns { scale: [sx, sy, sz], offset: [tx, ty, tz] }: p_out = p * scale + offset.
 */
export function outputTransform(bbox, axes, size) {
  const ext = extentOf(bbox);
  const sy = size.h / 1000 / ext[1];
  const scale = [sy, sy, sy];
  if (size.w) scale[axes.w] = size.w / 1000 / ext[axes.w];
  if (size.d) scale[axes.d] = size.d / 1000 / ext[axes.d];
  const offset = [
    -((bbox.min[0] + bbox.max[0]) / 2) * scale[0],
    -bbox.min[1] * scale[1],
    -((bbox.min[2] + bbox.max[2]) / 2) * scale[2],
  ];
  return { scale, offset };
}

/** Real size (mm) the model gets with a transform: { w, d, h }. */
export function sizeWith(bbox, axes, xf) {
  const ext = extentOf(bbox);
  return { w: ext[axes.w] * xf.scale[axes.w] * 1000, d: ext[axes.d] * xf.scale[axes.d] * 1000, h: ext[1] * xf.scale[1] * 1000 };
}

export function transformPositions(pos, xf) {
  const out = new Float32Array(pos.length);
  const [sx, sy, sz] = xf.scale, [tx, ty, tz] = xf.offset;
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = pos[i] * sx + tx;
    out[i + 1] = pos[i + 1] * sy + ty;
    out[i + 2] = pos[i + 2] * sz + tz;
  }
  return out;
}

/** Column-major 4×4 matrix of a transform (glTF / gl-matrix layout). */
export const xfMatrix = (xf) => [
  xf.scale[0], 0, 0, 0,
  0, xf.scale[1], 0, 0,
  0, 0, xf.scale[2], 0,
  xf.offset[0], xf.offset[1], xf.offset[2], 1,
];

export function mulMat4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

/**
 * Simplifying can pull the outermost vertices in by a millimetre or two. Put the extremes back
 * exactly (a tiny per-axis rescale), so a top made 2000 mm wide measures 2000 mm in the file.
 * pos and target in metres; only a small drift (2 %, or 3 mm on thin parts) is undone.
 */
export function fitToBox(pos, target) {
  const cur = bboxOf(pos);
  for (let k = 0; k < 3; k++) {
    const e = cur.max[k] - cur.min[k], t = target.max[k] - target.min[k];
    if (!(e > 1e-9) || Math.abs(e - t) > Math.max(0.02 * t, 0.003)) continue;
    const s = t / e;
    for (let i = k; i < pos.length; i += 3) pos[i] = target.min[k] + (pos[i] - cur.min[k]) * s;
  }
  return pos;
}

/** World units of the bbox -> metres. */
export function bboxWith(b, xf) {
  const p = transformPositions(new Float32Array([...b.min, ...b.max]), xf);
  return { min: [0, 1, 2].map((k) => Math.min(p[k], p[k + 3])), max: [0, 1, 2].map((k) => Math.max(p[k], p[k + 3])) };
}

// ---------- resizing one part ----------

export const STRETCH_BAND = 0.15; // metres kept rigid at each end (corner radius, edge profile)

/**
 * How to bring a part (bbox in metres) to a new size { w, d } in mm (either may be missing).
 * Returns a list of per-axis stretches, or null when nothing changes.
 */
export function stretchFor(bbox, axes, size, band = STRETCH_BAND) {
  const out = [];
  for (const key of ['w', 'd']) {
    const target = size?.[key];
    if (!target) continue;
    const axis = axes[key];
    const min = bbox.min[axis], max = bbox.max[axis];
    const half = (max - min) / 2, newHalf = target / 2000;
    if (!(half > 1e-6) || Math.abs(newHalf - half) < 5e-5) continue;
    const b = Math.min(band, half * 0.3, newHalf * 0.3);
    const inner = half - b, newInner = newHalf - b;
    out.push({ axis, c: (min + max) / 2, inner, newInner, k: newInner / inner });
  }
  return out.length ? out : null;
}

export function stretchValue(v, s) {
  const d = v - s.c;
  if (d > s.inner) return s.c + s.newInner + (d - s.inner);
  if (d < -s.inner) return s.c - s.newInner + (d + s.inner);
  return s.c + d * s.k;
}

/** Normals first (they need the positions before the stretch), then positions. In place. */
export function stretchGeometry(pos, nrm, st) {
  if (!st) return;
  if (nrm)
    for (let i = 0; i < nrm.length; i += 3) {
      let changed = false;
      for (const s of st)
        if (Math.abs(pos[i + s.axis] - s.c) <= s.inner) { nrm[i + s.axis] /= s.k; changed = true; }
      if (changed) {
        const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
        nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
      }
    }
  for (const s of st) for (let i = s.axis; i < pos.length; i += 3) pos[i] = stretchValue(pos[i], s);
}

/** "1800×900, 2000x1000, 2200" -> [{ w: 1800, d: 900 }, { w: 2000, d: 1000 }, { w: 2200, d: null }] */
export function parseSizes(text) {
  const out = [];
  for (const m of String(text).matchAll(/(\d{2,5}(?:\.\d+)?)\s*(?:[x×X*]\s*(\d{2,5}(?:\.\d+)?))?/g)) {
    const w = Math.round(+m[1]), d = m[2] ? Math.round(+m[2]) : null;
    if (w < 50 || (d !== null && d < 50)) continue;
    if (!out.some((s) => s.w === w && s.d === d)) out.push({ w, d });
  }
  return out;
}

export const sizeLabel = (s, current) => {
  const w = s.w ?? Math.round(current?.w || 0), d = s.d ?? Math.round(current?.d || 0);
  return d ? `${w}×${d}` : `${w}`;
};
