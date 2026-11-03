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
 * A band at each end moves rigidly (rounded corners, edge profile) and the middle stretches.
 * hold [x, y, z] (metres from the part's centre, per axis): the structure under it (frame, legs) reaches
 * that far and stays; the part then keeps its middle up to there as it is and stretches only between
 * there and the end bands, so a top's underside keeps meeting the frame it sits on instead of pulling
 * its cut-out away from it (see slabPlan).
 * Returns a list of per-axis stretches, or null when nothing changes.
 */
export function stretchFor(bbox, axes, size, { band = STRETCH_BAND, hold = null } = {}) {
  const out = [];
  for (const key of ['w', 'd']) {
    const target = size?.[key];
    if (!target) continue;
    const axis = axes[key];
    const min = bbox.min[axis], max = bbox.max[axis];
    const half = (max - min) / 2, newHalf = target / 2000;
    if (!(half > 1e-6) || Math.abs(newHalf - half) < 5e-5) continue;
    const b = Math.min(band, half * 0.3, newHalf * 0.3);
    const inner = half - b, shift = newHalf - half, c = (min + max) / 2;
    let m = 0, r = inner;
    const h = hold?.[axis] || 0;
    if (h > 0 && h < half) {
      // past the structure, and the end band starts no closer than halfway from it to the end
      const rr = Math.max(inner, h + 0.5 * (half - h));
      if (rr + shift - h > 0.05 * (rr - h)) { m = h; r = rr; }
    }
    out.push({ axis, c, m, r, shift, k: (r + shift - m) / (r - m) });
  }
  return out.length ? out : null;
}

export function stretchValue(v, s) {
  const d = v - s.c, a = Math.abs(d), sg = d < 0 ? -1 : 1;
  if (a >= s.r) return v + sg * s.shift;
  if (a <= s.m) return v;
  return s.c + sg * (s.m + (a - s.m) * s.k);
}

/**
 * Normals first (they need the positions before the stretch), then positions. In place.
 * minY: only points from that height up move (the underside of a top in one part with the legs under it).
 */
export function stretchGeometry(pos, nrm, st, minY = -Infinity) {
  if (!st) return;
  if (nrm)
    for (let i = 0; i < nrm.length; i += 3) {
      if (pos[i + 1] < minY) continue;
      let changed = false;
      for (const s of st) {
        const a = Math.abs(pos[i + s.axis] - s.c);
        if (a > s.m && a < s.r) { nrm[i + s.axis] /= s.k; changed = true; }
      }
      if (changed) {
        const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
        nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
      }
    }
  for (const s of st)
    for (let i = s.axis; i < pos.length; i += 3) if (pos[i - s.axis + 1] >= minY) pos[i] = stretchValue(pos[i], s);
}

// ---------- parts that resize along with a group ----------

const unionBox = (list) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of list) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.min[k]); max[k] = Math.max(max[k], p.max[k]); }
  return { min, max };
};

/**
 * Parts that make one slab with a group being resized and so take the same new size: the underside of
 * a table top, or a second layer of it (AI models often have the top as a light upper layer and a dark
 * lower one, split into two parts by colour). Left as they were, a top made 2000 mm long hangs open
 * past its 1980 mm underside (see-through from below and at the rim) and the underside sticks out at
 * the sides of a top made narrower.
 * A follower is thin (at most 2.5 × the group's thickness, or 8 % of the model's height), about as wide
 * and deep as the group (70 % or more of it both ways, at most 10 % past it, centred within it) and
 * touches it from below or above; a layer touching a follower counts too. Frames, aprons and legs are
 * never that, so they keep their size.
 * stats: [{ id, min, max }] in model units (y up), axes from furnitureAxes. Returns ids, none in leader or skip.
 */
export function slabFollowers(stats, leader, axes, skip = []) {
  const lead = stats.filter((p) => leader.includes(p.id));
  if (!lead.length) return [];
  const box = unionBox(lead), all = unionBox(stats);
  const H = all.max[1] - all.min[1], tol = 0.01 * H;
  const thin = Math.max(2.5 * (box.max[1] - box.min[1]), 0.08 * H);
  const fits = (p) => {
    if (!(p.max[1] - p.min[1] <= thin)) return false;
    for (const k of [axes.w, axes.d]) {
      const e = box.max[k] - box.min[k], c = (p.min[k] + p.max[k]) / 2;
      if (p.max[k] - p.min[k] < 0.7 * e || p.min[k] < box.min[k] - 0.1 * e || p.max[k] > box.max[k] + 0.1 * e) return false;
      if (c < box.min[k] || c > box.max[k]) return false;
    }
    return true;
  };
  const out = [], taken = new Set([...leader, ...skip]);
  let lo = box.min[1], hi = box.max[1];
  for (let grew = true; grew;) {
    grew = false;
    for (const p of stats) {
      if (taken.has(p.id) || p.faces === 0 || !fits(p) || p.max[1] < lo - tol || p.min[1] > hi + tol) continue;
      out.push(p.id);
      taken.add(p.id);
      lo = Math.min(lo, p.min[1]);
      hi = Math.max(hi, p.max[1]);
      grew = true;
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * How a resized group takes its slab along, from the welded mesh the parts are made of
 * (geo: { pos, index, faceLabels }, model units, y up):
 * - followers: [{ id, minY }]: the thin layers of slabFollowers (minY null: all of them moves), and parts
 *   that hold the top's underside together with legs below it (one part from the floor up; minY: only
 *   their points from just under the slab up move, the legs stay);
 * - hold: [x, y, z]: how far from the group's centre the structure under the slab (frame, legs, apron)
 *   reaches, per axis: the slab keeps its middle up to there (see stretchFor), so cut-outs of its
 *   underside around the frame stay around it. null when nothing is under it.
 * - underside: whether the group itself has an underside (it is stretched the same way then; a top
 *   that is only the upper skin keeps the even stretch, which keeps its own texture even).
 */
export function slabPlan(geo, stats, leader, axes, skip = []) {
  const lead = stats.filter((p) => leader.includes(p.id));
  if (!lead.length) return { followers: [], hold: null, underside: false };
  const box = unionBox(lead), all = unionBox(stats);
  const H = all.max[1] - all.min[1], tol = 0.01 * H;
  const thin = slabFollowers(stats, leader, axes, skip);
  const slab = unionBox(stats.filter((p) => leader.includes(p.id) || thin.includes(p.id)));
  const yb = slab.min[1] - tol;
  const hk = [axes.w, axes.d], c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  const ext = (b, k) => b.max[k] - b.min[k];
  const used = new Set([...leader, ...thin, ...skip]);
  const mixed = new Set(stats.filter((p) => !used.has(p.id) && p.faces !== 0 && p.max[1] >= yb && p.min[1] < yb
    && hk.every((k) => ext(p, k) >= 0.7 * ext(box, k) && ext(p, k) <= 1.25 * ext(box, k))).map((p) => p.id));
  const { pos, index, faceLabels } = geo;
  const isLead = new Set(leader), isThin = new Set(thin);
  const inBand = (f) => pos[index[f * 3] * 3 + 1] >= yb && pos[index[f * 3 + 1] * 3 + 1] >= yb && pos[index[f * 3 + 2] * 3 + 1] >= yb;
  // area of a level triangle (either way up: generated meshes do not always wind them alike), else 0
  const level = (f) => {
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, d = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    return l > 0 && Math.abs(ny) / l > 0.5 ? l / 2 : 0;
  };
  // the underside: of the group itself (level triangles in its lower half), and of a bigger part from
  // the floor up (level triangles in its top band, over the legs)
  const down = new Map(), mid = (box.min[1] + box.max[1]) / 2;
  let leadDown = 0;
  for (let f = 0; f < faceLabels.length; f++) {
    const id = faceLabels[f];
    if (isLead.has(id)) {
      if (pos[index[f * 3] * 3 + 1] + pos[index[f * 3 + 1] * 3 + 1] + pos[index[f * 3 + 2] * 3 + 1] < 3 * mid) leadDown += level(f);
    } else if (mixed.has(id) && inBand(f)) down.set(id, (down.get(id) || 0) + level(f));
  }
  const footprint = ext(box, axes.w) * ext(box, axes.d);
  const banded = new Set([...mixed].filter((id) => (down.get(id) || 0) >= 0.5 * footprint));
  // the structure the slab sits on: everything else right under it and within its outline
  const fixedLo = yb - 0.03 * H, hold = [0, 0, 0];
  let fixedSeen = false;
  for (let f = 0; f < faceLabels.length; f++) {
    const id = faceLabels[f];
    if (isLead.has(id) || isThin.has(id) || (banded.has(id) && inBand(f))) continue;
    for (let c3 = 0; c3 < 3; c3++) {
      const v = index[f * 3 + c3] * 3, y = pos[v + 1];
      if (y < fixedLo || y > slab.max[1]) continue;
      if (hk.some((k) => pos[v + k] < slab.min[k] || pos[v + k] > slab.max[k])) continue;
      fixedSeen = true;
      for (const k of hk) hold[k] = Math.max(hold[k], Math.abs(pos[v + k] - c[k]));
    }
  }
  const followers = [...thin.map((id) => ({ id, minY: null })), ...[...banded].map((id) => ({ id, minY: yb }))];
  return { followers: followers.sort((x, y) => x.id - y.id), hold: fixedSeen ? hold : null, underside: leadDown >= 0.3 * footprint };
}

/**
 * What is written (and shown) for the groups when some are resized. Every group keeps its parts but
 * the followers of a resized group (slabPlan), which become pieces of their own: their look is still
 * that of the group they are in (or the original, when in none), their size that of the resized group,
 * stretched as it is (measured on the resized group, so their edges keep their distance to its edges).
 * groups: [{ key, name, parts, sized }] (sized: the group has sizes to make); geo, stats, axes as slabPlan.
 * Returns [{ key, name, parts, look, lead, follows, minY, hold }]: look = key of the group whose material
 * it shows (null: original look), lead = key of the group whose size it takes (null: none), follows =
 * lead for followers, minY / hold for the stretch (model units; see stretchFor / stretchGeometry).
 * Groups left without parts are left out.
 */
export function outputPieces(groups, geo, stats, axes) {
  const owner = new Map();
  for (const g of groups) for (const p of g.parts) owner.set(p, g);
  const sized = groups.filter((g) => g.sized && g.parts.length);
  const fixed = sized.flatMap((g) => g.parts), taken = new Set();
  const extra = [], plans = new Map();
  for (const L of sized) {
    const plan = slabPlan(geo, stats, L.parts, axes, [...fixed, ...taken]);
    plans.set(L.key, plan);
    const by = new Map();
    for (const { id, minY } of plan.followers) {
      taken.add(id);
      const o = owner.get(id) || null, k = `${o ? o.key : 'rest'}${minY === null ? '' : '|band'}`;
      if (!by.has(k)) by.set(k, { o, minY, parts: [] });
      by.get(k).parts.push(id);
    }
    for (const [k, { o, minY, parts }] of by)
      extra.push({ key: `${L.key}~${k}`, name: o ? o.name : L.name, parts, look: o ? o.key : null, lead: L.key, follows: L.key, minY, hold: plan.hold });
  }
  const own = groups.map((g) => {
    const plan = plans.get(g.key);
    return { key: g.key, name: g.name, parts: g.parts.filter((p) => !taken.has(p)), look: g.key, lead: g.sized ? g.key : null, minY: null, hold: plan?.underside ? plan.hold : null };
  });
  return [...own.filter((x) => x.parts.length), ...extra];
}

/** A hold of slabPlan (model units, from the centre) in metres for stretchFor. */
export const holdWith = (hold, xf) => (hold ? hold.map((h, k) => h * Math.abs(xf.scale[k])) : null);
/** A height in model units in the output frame (metres). */
export const yWith = (y, xf) => (y === null || y === undefined ? -Infinity : y * xf.scale[1] + xf.offset[1]);

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
