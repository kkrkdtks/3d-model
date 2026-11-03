// Box (cube) projection UVs in real-world units, the usual way upholstery and
// wood are mapped in furniture visualisation. Each face is projected along the
// axis its normal points to most, so leather grain or fabric weave keeps the
// same size everywhere and seams fall on the edges where the direction turns,
// much like the sewn seams of a real cushion.

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function faceAdjacency(index) {
  const nf = index.length / 3;
  let vmax = 0;
  for (let i = 0; i < index.length; i++) if (index[i] > vmax) vmax = index[i];
  const nv = vmax + 1;
  const keys = new Float64Array(nf * 3), owner = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++)
    for (let c = 0; c < 3; c++) {
      const a = index[f * 3 + c], b = index[f * 3 + ((c + 1) % 3)];
      keys[f * 3 + c] = a < b ? a * nv + b : b * nv + a;
      owner[f * 3 + c] = f;
    }
  const order = Array.from(keys.keys()).sort((i, j) => keys[i] - keys[j]);
  const nbr = new Int32Array(nf * 3).fill(-1), slots = new Uint8Array(nf);
  for (let i = 1; i < order.length; i++) {
    if (keys[order[i]] !== keys[order[i - 1]]) continue;
    const fa = owner[order[i - 1]], fb = owner[order[i]];
    if (slots[fa] < 3) nbr[fa * 3 + slots[fa]++] = fb;
    if (slots[fb] < 3) nbr[fb * 3 + slots[fb]++] = fa;
  }
  return nbr;
}

/**
 * Small patches projected along another axis than everything around them (a few steep triangles in a
 * rippled generated surface, typically just inside a rim) show as specks where the pattern jumps.
 * Each patch under minArea (m²) joins the projection it borders most, if it faces that way at all.
 */
function removeIslands(pos, index, fn, cls, nbr, unitsToMeters, minArea = 0.0005) {
  const nf = cls.length, area = new Float64Array(nf), s2 = unitsToMeters * unitsToMeters;
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    area[f] = (0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)) * s2;
  }
  for (let round = 0; round < 2; round++) {
    const comp = new Int32Array(nf).fill(-1), stack = [];
    let changed = 0;
    for (let f0 = 0; f0 < nf; f0++) {
      if (comp[f0] >= 0) continue;
      const k = cls[f0], faces = [];
      let sum = 0, nx = 0, ny = 0, nz = 0;
      comp[f0] = f0; stack.push(f0);
      while (stack.length) {
        const f = stack.pop();
        faces.push(f);
        sum += area[f]; nx += fn[f * 3] * area[f]; ny += fn[f * 3 + 1] * area[f]; nz += fn[f * 3 + 2] * area[f];
        for (let j = 0; j < 3; j++) {
          const g = nbr[f * 3 + j];
          if (g >= 0 && comp[g] < 0 && cls[g] === k) { comp[g] = f0; stack.push(g); }
        }
      }
      if (sum >= minArea) continue;
      const votes = new Float64Array(6);
      for (const f of faces)
        for (let j = 0; j < 3; j++) { const g = nbr[f * 3 + j]; if (g >= 0 && cls[g] !== k) votes[cls[g]]++; }
      let best = -1;
      for (let c = 0; c < 6; c++) {
        const ax = AXES[c];
        if (votes[c] > 0 && nx * ax[0] + ny * ax[1] + nz * ax[2] > 0.2 * sum && (best < 0 || votes[c] > votes[best])) best = c;
      }
      if (best < 0) continue;
      for (const f of faces) cls[f] = best;
      changed++;
    }
    if (!changed) break;
  }
}

/**
 * @param {Float32Array} pos welded positions
 * @param {Float32Array} nrm welded smooth normals
 * @param {Uint32Array} index triangles
 * @param {number} unitsToMeters model units -> metres
 * @returns {{position:Float32Array, normal:Float32Array, uv:Float32Array, uvFold:Float32Array, index:Uint32Array}}
 *   unwelded only where the projection axis changes; uv in metres, image up = world up on every side;
 *   uvFold the top's pattern folded down over the edges of the part's box onto the sides (see core/skin uvFor)
 */
export function boxUV(pos, nrm, index, unitsToMeters, smoothIters = 3) {
  const nf = index.length / 3;
  const cls = new Uint8Array(nf), fn = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    // projected along the mean of the triangle's own direction and its (smoothed) vertex normals:
    // vertex normals alone lean far from a large triangle at a rounded rim, the triangle alone
    // follows every little step of a rippled generated surface
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, d = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    let x = nrm[a] + nrm[b] + nrm[d], y = nrm[a + 1] + nrm[b + 1] + nrm[d + 1], z = nrm[a + 2] + nrm[b + 2] + nrm[d + 2];
    const gl = Math.hypot(gx, gy, gz), vl = Math.hypot(x, y, z) || 1;
    x /= vl; y /= vl; z /= vl;
    // a folded triangle (facing against its normals) or one without area: vertex normals only
    if (gl > 1e-20 && gx * x + gy * y + gz * z > 0) { x += gx / gl; y += gy / gl; z += gz / gl; }
    const l = Math.hypot(x, y, z) || 1;
    fn[f * 3] = x / l; fn[f * 3 + 1] = y / l; fn[f * 3 + 2] = z / l;
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    cls[f] = ax >= ay && ax >= az ? (x >= 0 ? 0 : 1) : ay >= az ? (y >= 0 ? 2 : 3) : (z >= 0 ? 4 : 5);
  }
  // majority filter: avoid tiny islands of a different projection on curved areas
  const nbr = faceAdjacency(index);
  for (let it = 0; it < smoothIters; it++) {
    const next = cls.slice();
    for (let f = 0; f < nf; f++) {
      const a = nbr[f * 3], b = nbr[f * 3 + 1], c = nbr[f * 3 + 2];
      let cand = -1;
      if (a >= 0 && b >= 0 && cls[a] === cls[b]) cand = cls[a];
      else if (a >= 0 && c >= 0 && cls[a] === cls[c]) cand = cls[a];
      else if (b >= 0 && c >= 0 && cls[b] === cls[c]) cand = cls[b];
      if (cand < 0 || cand === cls[f]) continue;
      const ax = AXES[cand];
      if (fn[f * 3] * ax[0] + fn[f * 3 + 1] * ax[1] + fn[f * 3 + 2] * ax[2] > 0.3) next[f] = cand;
    }
    cls.set(next);
  }
  removeIslands(pos, index, fn, cls, nbr, unitsToMeters);
  // the box the folded UVs turn over: its top edges are where a side meets the top
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k] * unitsToMeters;
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  // unweld per (vertex, class)
  const remap = new Map();
  const outPos = [], outNrm = [], outUv = [], outFold = [], outIdx = new Uint32Array(index.length);
  for (let f = 0; f < nf; f++) {
    const k = cls[f];
    for (let c = 0; c < 3; c++) {
      const v = index[f * 3 + c], key = v * 6 + k;
      let ni = remap.get(key);
      if (ni === undefined) {
        ni = outPos.length / 3;
        remap.set(key, ni);
        const x = pos[v * 3] * unitsToMeters, y = pos[v * 3 + 1] * unitsToMeters, z = pos[v * 3 + 2] * unitsToMeters;
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        outNrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        // (u, v) seen from outside the face, image "up" = world up (glTF v grows downward)
        let u, w;
        switch (k) {
          case 0: u = -z; w = -y; break;
          case 1: u = z; w = -y; break;
          case 2: u = x; w = z; break;
          case 3: u = x; w = -z; break;
          case 4: u = x; w = -y; break;
          default: u = -x; w = -y;
        }
        outUv.push(u, w);
        // the top's pattern folded down over its edges, as on a board or a stone slab whose grain carries
        // over the edge: it runs on along each side the way it runs on the top, and meets the top's where
        // the side turns into it (so a wavy rim does not show the seam as teeth)
        switch (k) {
          case 0: outFold.push(hi[0] + hi[1] - y, z); break;
          case 1: outFold.push(lo[0] - hi[1] + y, z); break;
          case 4: outFold.push(x, hi[2] + hi[1] - y); break;
          case 5: outFold.push(x, lo[2] - hi[1] + y); break;
          case 2: outFold.push(x, z); break;
          default: outFold.push(u, w);
        }
      }
      outIdx[f * 3 + c] = ni;
    }
  }
  return { position: new Float32Array(outPos), normal: new Float32Array(outNrm), uv: new Float32Array(outUv), uvFold: new Float32Array(outFold), index: outIdx, classes: cls };
}
