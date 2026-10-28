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
 * @param {Float32Array} pos welded positions
 * @param {Float32Array} nrm welded smooth normals
 * @param {Uint32Array} index triangles
 * @param {number} unitsToMeters model units -> metres
 * @returns {{position:Float32Array, normal:Float32Array, uv:Float32Array, index:Uint32Array}}
 *   unwelded only where the projection axis changes; uv in metres
 */
export function boxUV(pos, nrm, index, unitsToMeters, smoothIters = 3) {
  const nf = index.length / 3;
  const cls = new Uint8Array(nf), fn = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let x = 0, y = 0, z = 0;
    for (let c = 0; c < 3; c++) { const v = index[f * 3 + c] * 3; x += nrm[v]; y += nrm[v + 1]; z += nrm[v + 2]; }
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
  // unweld per (vertex, class)
  const remap = new Map();
  const outPos = [], outNrm = [], outUv = [], outIdx = new Uint32Array(index.length);
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
      }
      outIdx[f * 3 + c] = ni;
    }
  }
  return { position: new Float32Array(outPos), normal: new Float32Array(outNrm), uv: new Float32Array(outUv), index: outIdx, classes: cls };
}
