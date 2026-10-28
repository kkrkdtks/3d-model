// Automatic part segmentation for AI-generated furniture meshes.
//
// 3DAISTUDIO exports a sofa or table as one fused mesh. Real furniture parts
// (cushion, backrest, frame, legs) meet in grooves where the surface folds
// inward, so we cut along strongly concave "valleys" and keep everything else
// connected. Works on plain typed arrays so it runs in Node and in the browser.

/** Unique undirected edges of a triangle list, as two parallel arrays (a < b). */
export function uniqueEdges(index, vertexCount) {
  const faceCount = index.length / 3;
  const keys = new Float64Array(faceCount * 3);
  for (let f = 0, k = 0; f < faceCount; f++) {
    for (let c = 0; c < 3; c++) {
      const a = index[f * 3 + c], b = index[f * 3 + ((c + 1) % 3)];
      keys[k++] = a < b ? a * vertexCount + b : b * vertexCount + a;
    }
  }
  keys.sort();
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (i === 0 || keys[i] !== keys[i - 1]) keys[n++] = keys[i];
  const ea = new Uint32Array(n), eb = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    ea[i] = Math.floor(keys[i] / vertexCount);
    eb[i] = keys[i] - ea[i] * vertexCount;
  }
  return { ea, eb };
}

/** Compressed adjacency (CSR) from an edge list. */
export function adjacency(ea, eb, vertexCount) {
  const deg = new Uint32Array(vertexCount);
  for (let i = 0; i < ea.length; i++) { deg[ea[i]]++; deg[eb[i]]++; }
  const offset = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offset[v + 1] = offset[v] + deg[v];
  const fill = offset.slice(0, vertexCount);
  const nbr = new Uint32Array(offset[vertexCount]);
  for (let i = 0; i < ea.length; i++) { nbr[fill[ea[i]]++] = eb[i]; nbr[fill[eb[i]]++] = ea[i]; }
  return { offset, nbr };
}

/** Area-weighted vertex normals. */
export function vertexNormals(pos, index, vertexCount) {
  const n = new Float32Array(vertexCount * 3);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  normalize3(n);
  return n;
}

function normalize3(n) {
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
}

function bboxExtent(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/**
 * Signed curvature per vertex (negative = concave valley), measured on normals
 * smoothed over a few rings so that triangle noise does not dominate.
 * Scaled by the model size so thresholds do not depend on units.
 */
export function valleyCurvature(pos, adj, edges, normals, smoothIters = 5) {
  const nv = pos.length / 3, { offset, nbr } = adj;
  let n = normals, tmp = new Float32Array(n.length);
  for (let it = 0; it < smoothIters; it++) {
    for (let v = 0; v < nv; v++) {
      let x = 0, y = 0, z = 0;
      for (let j = offset[v]; j < offset[v + 1]; j++) { const u = nbr[j] * 3; x += n[u]; y += n[u + 1]; z += n[u + 2]; }
      tmp[v * 3] = x; tmp[v * 3 + 1] = y; tmp[v * 3 + 2] = z;
    }
    normalize3(tmp);
    [n, tmp] = [tmp, n === normals ? new Float32Array(n.length) : n];
  }
  const sum = new Float32Array(nv), cnt = new Uint32Array(nv), { ea, eb } = edges;
  for (let i = 0; i < ea.length; i++) {
    const a = ea[i] * 3, b = eb[i] * 3;
    const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
    const l2 = dx * dx + dy * dy + dz * dz || 1e-18;
    const k = ((n[b] - n[a]) * dx + (n[b + 1] - n[a + 1]) * dy + (n[b + 2] - n[a + 2]) * dz) / l2;
    sum[ea[i]] += k; sum[eb[i]] += k; cnt[ea[i]]++; cnt[eb[i]]++;
  }
  const size = bboxExtent(pos);
  for (let v = 0; v < nv; v++) sum[v] = cnt[v] ? (sum[v] / cnt[v]) * size : 0;
  return sum;
}

function find(parent, x) {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
  return x;
}

/**
 * Split a welded mesh into parts.
 * @param {Float32Array} pos  welded positions (xyz)
 * @param {Uint32Array} index triangle indices into pos
 * @param {object} opts threshold: valley strength (higher = fewer cuts);
 *   dilate: rings used to close small gaps in a groove; minArea: smallest part (fraction of surface)
 * @returns {{faceLabels:Int32Array, vertexLabels:Int32Array, parts:Array}}
 */
export function segment(pos, index, opts = {}) {
  const { threshold = 60, dilate = 4, minArea = 0.002, smoothIters = 5 } = opts;
  const nv = pos.length / 3, nf = index.length / 3;
  const edges = opts.edges || uniqueEdges(index, nv);
  const adj = opts.adj || adjacency(edges.ea, edges.eb, nv);
  const curv = opts.curvature || valleyCurvature(pos, adj, edges, vertexNormals(pos, index, nv), smoothIters);

  // valley mask, dilated to close small breaks in a groove
  let mask = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) mask[v] = curv[v] < -threshold ? 1 : 0;
  for (let it = 0; it < dilate; it++) {
    const next = mask.slice();
    for (let v = 0; v < nv; v++) {
      if (mask[v]) continue;
      for (let j = adj.offset[v]; j < adj.offset[v + 1]; j++) if (mask[adj.nbr[j]]) { next[v] = 1; break; }
    }
    mask = next;
  }

  // connected regions of non-valley vertices
  const parent = new Int32Array(nv).map((_, i) => i);
  for (let i = 0; i < edges.ea.length; i++) {
    const a = edges.ea[i], b = edges.eb[i];
    if (mask[a] || mask[b]) continue;
    const ra = find(parent, a), rb = find(parent, b);
    if (ra !== rb) parent[ra] = rb;
  }
  const area = new Float32Array(nv), faceArea = new Float32Array(nf);
  let total = 0;
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const s = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    area[index[f * 3]] += s; area[index[f * 3 + 1]] += s; area[index[f * 3 + 2]] += s;
    faceArea[f] = 3 * s; total += 3 * s;
  }
  const rootArea = new Map();
  for (let v = 0; v < nv; v++) if (!mask[v]) { const r = find(parent, v); rootArea.set(r, (rootArea.get(r) || 0) + area[v]); }
  const label = new Int32Array(nv).fill(-1), ids = new Map();
  for (let v = 0; v < nv; v++) {
    if (mask[v]) continue;
    const r = find(parent, v);
    if (rootArea.get(r) < minArea * total) continue;
    if (!ids.has(r)) ids.set(r, ids.size);
    label[v] = ids.get(r);
  }

  // grow labels back into the grooves (breadth-first from labelled vertices)
  let frontier = [];
  for (let v = 0; v < nv; v++) if (label[v] >= 0) frontier.push(v);
  while (frontier.length) {
    const next = [];
    for (const v of frontier)
      for (let j = adj.offset[v]; j < adj.offset[v + 1]; j++) {
        const u = adj.nbr[j];
        if (label[u] < 0) { label[u] = label[v]; next.push(u); }
      }
    frontier = next;
  }
  if (ids.size === 0) label.fill(0);

  const faceLabels = new Int32Array(nf);
  const count = Math.max(ids.size, 1);
  const parts = Array.from({ length: count }, (_, id) => ({ id, area: 0, faces: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  for (let f = 0; f < nf; f++) {
    const a = label[index[f * 3]], b = label[index[f * 3 + 1]], c = label[index[f * 3 + 2]];
    const l = Math.max(0, a === b || a === c ? a : b === c ? b : a);
    faceLabels[f] = l;
    const p = parts[l];
    p.faces++;
    p.area += faceArea[f];
    for (let k = 0; k < 3; k++) {
      const vi = index[f * 3 + k];
      for (let d = 0; d < 3; d++) { p.min[d] = Math.min(p.min[d], pos[vi * 3 + d]); p.max[d] = Math.max(p.max[d], pos[vi * 3 + d]); }
    }
  }
  // number parts by size, biggest first, so ids read naturally (0 = main body)
  const order = parts.map((p) => p.id).sort((x, y) => parts[y].area - parts[x].area || x - y);
  const rank = new Int32Array(count);
  order.forEach((old, i) => { rank[old] = i; });
  for (let f = 0; f < nf; f++) faceLabels[f] = rank[faceLabels[f]];
  for (let v = 0; v < nv; v++) label[v] = label[v] >= 0 ? rank[label[v]] : 0;
  const sorted = order.map((old, i) => ({ ...parts[old], id: i, areaPct: (100 * parts[old].area) / total }));
  return { faceLabels, vertexLabels: label, parts: sorted, curvature: curv };
}
