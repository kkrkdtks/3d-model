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

// ---------- colour ----------
//
// A wooden base or metal legs fused to a fabric body often meet without any groove, but the
// texture changes colour there. AI textures also carry baked shading (dark creases, a darker
// underside), so colours are compared as "material colour": hue and chroma measured relative to
// lightness, with lightness itself counting little. A navy fabric and its near-black shadows
// stay close; navy and walnut are far apart.

const SRGB_LINEAR = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** Material colour of 8-bit sRGB, written to out[o..o+2]: CIELAB with a, b scaled by 30 / (L + 10) and L by 1/4. */
function materialColor(r, g, b, out, o) {
  const R = SRGB_LINEAR[r], G = SRGB_LINEAR[g], B = SRGB_LINEAR[b];
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  const L = 116 * fy - 16, k = 30 / (Math.max(0, L) + 10);
  out[o] = 0.25 * L; out[o + 1] = 500 * (fx - fy) * k; out[o + 2] = 200 * (fy - fz) * k;
}

function colorDist(c, i, d, j) {
  const x = c[i] - d[j], y = c[i + 1] - d[j + 1], z = c[i + 2] - d[j + 2];
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * How much each vertex colour says about its material: nothing in near-black creases (L < 4,
 * fully from L 14), and little in near-white glare (light and almost grey, as baked highlights on leather).
 */
function colorTrust(c) {
  const t = new Float32Array(c.length / 3);
  for (let v = 0; v < t.length; v++) {
    const L = 4 * c[v * 3], chroma = (Math.hypot(c[v * 3 + 1], c[v * 3 + 2]) * (L + 10)) / 30;
    const dark = Math.min(1, Math.max(0, (L - 4) / 10));
    const glare = chroma < 12 ? Math.min(1, Math.max(0, (97 - L) / 12)) : 1;
    t[v] = Math.min(dark, glare);
  }
  return t;
}

/**
 * Material colour of every vertex from one texture sample per face (8-bit sRGB, 3 per face):
 * averaged around each vertex, then smoothed over a couple of rings so fabric grain and wood
 * figure do not read as edges.
 */
export function vertexColors(index, faceRGB, vertexCount, adj, smoothIters = 2) {
  let c = new Float32Array(vertexCount * 3);
  const n = new Uint32Array(vertexCount), m = new Float32Array(3);
  for (let f = 0; f < index.length / 3; f++) {
    materialColor(faceRGB[f * 3], faceRGB[f * 3 + 1], faceRGB[f * 3 + 2], m, 0);
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      c[v * 3] += m[0]; c[v * 3 + 1] += m[1]; c[v * 3 + 2] += m[2]; n[v]++;
    }
  }
  for (let v = 0; v < vertexCount; v++) if (n[v]) { c[v * 3] /= n[v]; c[v * 3 + 1] /= n[v]; c[v * 3 + 2] /= n[v]; }
  let tmp = new Float32Array(c.length);
  for (let it = 0; it < smoothIters; it++) {
    for (let v = 0; v < vertexCount; v++) {
      let x = c[v * 3], y = c[v * 3 + 1], z = c[v * 3 + 2], k = 1;
      for (let j = adj.offset[v]; j < adj.offset[v + 1]; j++) { const u = adj.nbr[j] * 3; x += c[u]; y += c[u + 1]; z += c[u + 2]; k++; }
      tmp[v * 3] = x / k; tmp[v * 3 + 1] = y / k; tmp[v * 3 + 2] = z / k;
    }
    [c, tmp] = [tmp, c];
  }
  return c;
}

/**
 * The main material colour of a region: 2-means over its vertex colours (weighted by area and
 * trust), the centre of the cluster covering more surface. A region of one material gives its mean.
 */
function mainColor(verts, color, trust, area) {
  const n = verts.length, w = new Float32Array(n), mean = new Float64Array(3);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = verts[i], a = area[v] * trust[v];
    w[i] = a; total += a;
    mean[0] += a * color[v * 3]; mean[1] += a * color[v * 3 + 1]; mean[2] += a * color[v * 3 + 2];
  }
  if (!(total > 0)) return mean;
  for (let k = 0; k < 3; k++) mean[k] /= total;
  // start from the two sides of the axis with the most colour spread
  const cov = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    const v = verts[i] * 3;
    const d = [color[v] - mean[0], color[v + 1] - mean[1], color[v + 2] - mean[2]];
    for (let r = 0; r < 3; r++) for (let q = r; q < 3; q++) cov[r * 3 + q] += w[i] * d[r] * d[q];
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  let axis = [1, 1, 1];
  for (let it = 0; it < 20; it++) {
    const x = [0, 1, 2].map((r) => cov[r * 3] * axis[0] + cov[r * 3 + 1] * axis[1] + cov[r * 3 + 2] * axis[2]);
    const l = Math.hypot(...x) || 1;
    axis = x.map((q) => q / l);
  }
  const cluster = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = verts[i] * 3;
    cluster[i] = (color[v] - mean[0]) * axis[0] + (color[v + 1] - mean[1]) * axis[1] + (color[v + 2] - mean[2]) * axis[2] >= 0 ? 1 : 0;
  }
  const centers = new Float64Array(6), ws = new Float64Array(2);
  for (let it = 0; it < 8; it++) {
    centers.fill(0); ws.fill(0);
    for (let i = 0; i < n; i++) {
      const k = cluster[i], v = verts[i] * 3;
      ws[k] += w[i];
      centers[k * 3] += w[i] * color[v]; centers[k * 3 + 1] += w[i] * color[v + 1]; centers[k * 3 + 2] += w[i] * color[v + 2];
    }
    if (!(ws[0] > 0 && ws[1] > 0)) return mean;
    for (let k = 0; k < 2; k++) for (let d = 0; d < 3; d++) centers[k * 3 + d] /= ws[k];
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const v = verts[i] * 3, k = colorDist(color, v, centers, 0) <= colorDist(color, v, centers, 3) ? 0 : 1;
      if (k !== cluster[i]) { cluster[i] = k; changed++; }
    }
    if (!changed) break;
  }
  return ws[0] >= ws[1] ? centers.slice(0, 3) : centers.slice(3, 6);
}

function vertexLists(label, count) {
  const lists = Array.from({ length: count }, () => []);
  for (let v = 0; v < label.length; v++) if (label[v] >= 0) lists[label[v]].push(v);
  return lists;
}

/**
 * Regions (label >= 0) are checked for surface far from their main colour (another material).
 * A piece of it becomes a part of its own (a fused wooden base) when it is big, mostly well away
 * from the main colour and not too ragged: baked highlights and shading fade in gradually, and a
 * printed pattern breaks into many pieces with long outlines. Small pieces are left unlabelled so
 * growByColor gives them to the neighbour they match (the top of a leg that ran into the frame).
 * Everything else keeps its region's label. Relabels in place; returns the new number of labels.
 */
function splitByColor(label, count, color, trust, area, pos, edges, minPart, minDist) {
  const nv = label.length;
  const dist = new Float32Array(nv), far = new Uint8Array(nv);
  vertexLists(label, count).forEach((verts) => {
    const main = mainColor(verts, color, trust, area);
    for (const v of verts) {
      dist[v] = colorDist(color, v * 3, main, 0);
      far[v] = trust[v] >= 0.5 && dist[v] >= minDist ? 1 : 0;
    }
  });
  // pieces of off-colour surface inside one region
  const parent = new Int32Array(nv);
  for (let v = 0; v < nv; v++) parent[v] = v;
  for (let i = 0; i < edges.ea.length; i++) {
    const a = edges.ea[i], b = edges.eb[i];
    if (!far[a] || !far[b] || label[a] !== label[b]) continue;
    const ra = find(parent, a), rb = find(parent, b);
    if (ra !== rb) parent[ra] = rb;
  }
  const piece = new Map(); // root -> { area, verts, core: area at twice the distance, outline }
  for (let v = 0; v < nv; v++) {
    if (!far[v]) continue;
    const p = find(parent, v);
    let e = piece.get(p);
    if (!e) piece.set(p, (e = { area: 0, verts: 0, core: 0, outline: 0 }));
    e.area += area[v]; e.verts++;
    if (dist[v] >= 2 * minDist) e.core += area[v];
  }
  for (let i = 0; i < edges.ea.length; i++) {
    const a = edges.ea[i], b = edges.eb[i];
    if (far[a] === far[b] || label[a] !== label[b]) continue;
    piece.get(find(parent, far[a] ? a : b)).outline += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  }
  // outline² / (4π area) is 1 for a disc; a band around the base is a few tens, a pattern far more
  const own = (e) => e.area >= minPart && e.core >= 0.5 * e.area && e.outline * e.outline <= 300 * 4 * Math.PI * e.area;
  const small = (e) => e.area < minPart;
  const pieces = new Int32Array(count), smalls = new Int32Array(count), farArea = new Float64Array(count), ownArea = new Float64Array(count);
  for (const [p, e] of piece) {
    const r = label[p];
    farArea[r] += e.area;
    if (own(e)) ownArea[r] += e.area;
    if (e.area >= minPart / 10) pieces[r]++;
    if (small(e) && e.verts >= 3) smalls[r]++;
  }
  // a region with many pieces is a patterned fabric or glare and stays whole; it splits only when
  // its pieces of their own hold most of its off-colour surface
  const pattern = (r) => pieces[r] > 6 || smalls[r] > 40;
  const split = (r) => !pattern(r) && ownArea[r] >= 0.5 * farArea[r];
  const ids = new Map();
  const idOf = (k) => { if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const next = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) {
    const r = label[v];
    if (r < 0) continue;
    if (!far[v] || pattern(r)) { next[v] = idOf(`r${r}`); continue; }
    const p = find(parent, v), e = piece.get(p);
    next[v] = own(e) && split(r) ? idOf(`p${p}`) : small(e) ? -1 : idOf(`r${r}`);
  }
  label.set(next);
  return ids.size;
}

/**
 * Grow labels back into unlabelled vertices (grooves, small off-colour pieces) ring by ring. A
 * label first takes only vertices that match its own material colour, so a groove between a blue
 * frame and a brown leg splits where blue turns brown, and the brown top of a leg goes to the leg.
 * Dark creases match everything; what matches no neighbour (glare) is filled in afterwards.
 */
function growByColor(label, count, color, trust, area, adj, minDist) {
  const nv = label.length;
  const main = vertexLists(label, count).map((verts) => mainColor(verts, color, trust, area));
  const matches = (u, l) => trust[u] * colorDist(color, u * 3, main[l], 0) < minDist;
  for (const strict of [true, false]) {
    let frontier = [];
    for (let v = 0; v < nv; v++) if (label[v] >= 0) frontier.push(v);
    while (frontier.length) {
      const next = [];
      for (const v of frontier)
        for (let j = adj.offset[v]; j < adj.offset[v + 1]; j++) {
          const u = adj.nbr[j];
          if (label[u] < 0 && (!strict || matches(u, label[v]))) { label[u] = label[v]; next.push(u); }
        }
      frontier = next;
    }
  }
}

// ---------- base ----------
//
// Legs and plinths stand under the body. Seen from below, the body has a large flat underside
// facing down: a sofa, bed or cabinet on legs, the overhang above a recessed plinth, a table top,
// a chair or stool seat. What is under that level is the base, whatever its colour (white or
// black steel legs under fabric of any colour, wood).

/**
 * Height just under the body's underside, table top or seat: of the levels above the floor where
 * a large area faces down, the biggest with the least under it (walls below at most four times
 * its area: not a shelf inside a bookcase), or a higher one nearly as good (a coffee table's top
 * over its shelf). Rungs between chair legs are too small to count. A level is only reached
 * through legs, not through a body's sides: a bed frame's bottom edge, not the bottom panel set
 * up inside it. null when there is none.
 */
export function undersideHeight(pos, index) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const H = hi[1] - lo[1], footprint = (hi[0] - lo[0]) * (hi[2] - lo[2]), B = 400, step = H / B;
  if (!(H > 0 && footprint > 0)) return null;
  const down = new Float64Array(B), walls = new Float64Array(B + 1); // walls: area of steep faces below each bin
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - lo[1], bin = Math.min(B - 1, Math.floor(y / step));
    if (ny < -0.7 * len) { if (y >= 0.015 * H) down[bin] += len / 2; } // feet and plinth bottoms stand on the floor
    else if (ny <= 0.7 * len) walls[bin + 1] += len / 2;
  }
  for (let b = 1; b <= B; b++) walls[b] += walls[b - 1];
  // area facing down in every 2% slice of the height
  const W = 8, n = B - W + 1, S = new Float64Array(n);
  for (let b = 0; b < n; b++) for (let k = b; k < b + W; k++) S[b] += down[k];
  const levels = [];
  for (let b = 0; b < n; b++) {
    if (S[b] < 0.1 * footprint) continue;
    let peak = true;
    for (let o = Math.max(0, b - W); o <= Math.min(n - 1, b + W) && peak; o++) if (S[o] > S[b] || (S[o] === S[b] && o < b)) peak = false;
    if (!peak) continue;
    // past the lowest tenth of the slice, then down through anything still facing down right under
    // it (a tilted or wavy underside, a seam that bulges) so all of the body stays above
    let k = b, acc = down[b];
    while (k < b + W - 1 && acc < 0.1 * S[b]) acc += down[++k];
    while (k > 0 && down[k - 1] >= 0.01 * S[b]) k--;
    if (k >= 0.03 * B && walls[k] <= 4 * S[b]) levels.push({ k, score: S[b] / (1 + walls[k] / S[b]) });
  }
  if (!levels.length) return null;
  // up from the lowest level only past what is as thin as the legs under it somewhere (rungs or a
  // shelf between legs), never through the sides of a body that comes down all the way (a bed
  // frame on short legs with its bottom panel set up inside)
  levels.sort((a, b) => a.k - b.k);
  const dens = (a, b) => (walls[b] - walls[a]) / (b - a);
  const thinnest = (a, b) => {
    let m = 0;
    if (b - a >= W) { m = Infinity; for (let s = a; s + W <= b; s++) m = Math.min(m, dens(s, s + W)); }
    return m;
  };
  const legs = dens(Math.ceil(0.015 * B), levels[0].k);
  let top = 1;
  while (top < levels.length && thinnest(levels[top - 1].k + W, levels[top].k) <= 4 * legs) top++;
  const stack = levels.slice(0, top);
  // big, with little under it; a higher level nearly as good wins (a top over a shelf, not a
  // canopy over a whole bed)
  const best = Math.max(...stack.map((l) => l.score));
  const k = Math.max(...stack.filter((l) => l.score >= 0.75 * best).map((l) => l.k));
  return lo[1] + k * step;
}

/**
 * Split off the base under height h: in every part that is not almost all below it, the triangles
 * below go to a base part they touch (legs that were parts of their own already), or else
 * together to one new part. Legs that go on up past h (beside a rounded body or a drawer box,
 * under a tilted top) take their steep sides along until they meet the body. faceLabels and
 * vertex labels change in place; returns the new number of parts.
 */
function splitBase(faceLabels, label, count, pos, index, faceArea, total, h) {
  const nf = faceLabels.length, nv = pos.length / 3;
  const cy = new Float32Array(nf), under = new Uint8Array(nf), below = new Float64Array(count), all = new Float64Array(count);
  let ylo = Infinity, yhi = -Infinity;
  for (let v = 0; v < nv; v++) { ylo = Math.min(ylo, pos[v * 3 + 1]); yhi = Math.max(yhi, pos[v * 3 + 1]); }
  for (let f = 0; f < nf; f++) {
    const l = faceLabels[f];
    cy[f] = (pos[index[f * 3] * 3 + 1] + pos[index[f * 3 + 1] * 3 + 1] + pos[index[f * 3 + 2] * 3 + 1]) / 3;
    all[l] += faceArea[f];
    if (cy[f] < h) { under[f] = 1; below[l] += faceArea[f]; }
  }
  const base = (l) => below[l] >= 0.8 * all[l];
  const moving = (f) => under[f] && !base(faceLabels[f]);
  // pieces to move, joined through shared vertices
  const parent = new Int32Array(nv).fill(-1);
  for (let f = 0; f < nf; f++) {
    if (!moving(f)) continue;
    for (let k = 0; k < 3; k++) { const v = index[f * 3 + k]; if (parent[v] < 0) parent[v] = v; }
    for (let k = 1; k < 3; k++) {
      const ra = find(parent, index[f * 3]), rb = find(parent, index[f * 3 + k]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const pieceOf = new Int32Array(nf).fill(-1), pieces = [], ids = new Map(); // { area, grown, touches: Map(base part -> shared vertices) }
  for (let f = 0; f < nf; f++) {
    if (!moving(f)) continue;
    const r = find(parent, index[f * 3]);
    if (!ids.has(r)) { ids.set(r, pieces.length); pieces.push({ area: 0, grown: 0, touches: new Map() }); }
    pieceOf[f] = ids.get(r);
    pieces[pieceOf[f]].area += faceArea[f];
  }
  if (!pieces.length) return count;
  for (let f = 0; f < nf; f++) {
    if (!base(faceLabels[f])) continue;
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      if (parent[v] < 0) continue;
      const t = pieces[ids.get(find(parent, v))].touches;
      t.set(faceLabels[f], (t.get(faceLabels[f]) || 0) + 1);
    }
  }
  const grownInto = growLegs(pieces, pieceOf, faceLabels, base, cy, pos, index, faceArea, h, h + 0.25 * (yhi - ylo));
  // a few stray triangles of a rim stay where they are; a new part must be worth having
  let fresh = 0;
  for (const p of pieces) {
    p.to = p.area < 1e-4 * total ? -1 : p.touches.size ? [...p.touches].sort((x, y) => y[1] - x[1])[0][0] : count;
    if (p.to === count) fresh += p.area;
  }
  if (fresh < 5e-4 * total) for (const p of pieces) if (p.to === count) p.to = -1;
  for (let f = 0; f < nf; f++) {
    const p = pieceOf[f] >= 0 ? pieceOf[f] : grownInto[f];
    if (p < 0 || pieces[p].to < 0 || (pieceOf[f] < 0 && pieces[p].grown > pieces[p].area)) continue;
    faceLabels[f] = pieces[p].to;
    for (let k = 0; k < 3; k++) label[index[f * 3 + k]] = pieces[p].to;
  }
  return fresh >= 5e-4 * total ? count + 1 : count;
}

/**
 * Follow legs up from h to top: the triangles above h are taken lowest first; a steep one that
 * touches legs grows them, anything else is body. Where a leg meets the body the triangle is body
 * but the leg grows on beside it (a leg against a curved underside meets it lower on one side),
 * until a flat underside closes it. Returns the piece each grown triangle joined (-1 for the
 * rest) and adds up pieces[].grown; a piece that grows more than its own area (a bookcase side,
 * a bed post) is left as it was.
 */
function growLegs(pieces, pieceOf, faceLabels, base, cy, pos, index, faceArea, h, top) {
  const nf = faceLabels.length, nv = pos.length / 3, P = pieces.length, NB = 1024;
  const grownInto = new Int32Array(nf).fill(-1);
  // triangles of the body parts between h and top, by height
  const bins = new Int32Array(NB + 1), slot = (f) => Math.min(NB - 1, Math.floor((cy[f] - h) / (top - h) * NB));
  const take = (f) => pieceOf[f] < 0 && cy[f] >= h && cy[f] < top && !base(faceLabels[f]);
  for (let f = 0; f < nf; f++) if (take(f)) bins[slot(f) + 1]++;
  for (let b = 0; b < NB; b++) bins[b + 1] += bins[b];
  const order = new Int32Array(bins[NB]);
  for (let f = 0; f < nf; f++) if (take(f)) order[bins[slot(f)]++] = f;
  // one union-find over vertices plus a node per piece; roots are legs (piece nodes) or body
  const LEG = 1, BODY = 2, up = new Int32Array(nv + P).fill(-1), state = new Uint8Array(nv + P);
  for (let p = 0; p < P; p++) { up[nv + p] = nv + p; state[nv + p] = LEG; }
  for (let f = 0; f < nf; f++) if (pieceOf[f] >= 0) for (let k = 0; k < 3; k++) up[index[f * 3 + k]] = nv + pieceOf[f];
  for (const f of order) {
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const ny = uz * vx - ux * vz, len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
    let leg = -1, body = -1;
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      if (up[v] < 0) continue;
      const r = find(up, v);
      if (state[r] === LEG) { if (leg < 0) leg = r; } else body = r;
    }
    if (leg >= 0 && body >= 0) { // the seam: its new corners belong to neither side yet
      for (let k = 0; k < 3; k++) if (up[index[f * 3 + k]] === -1) up[index[f * 3 + k]] = -2;
      continue;
    }
    const grows = leg >= 0 && Math.abs(ny) <= 0.7 * len;
    const root = grows ? leg : body >= 0 ? body : leg >= 0 ? leg : index[f * 3];
    if (!grows) state[root] = BODY;
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      if (up[v] < 0) { up[v] = root; continue; }
      const r = find(up, v);
      if (r !== root) up[r] = root;
    }
    if (up[root] < 0) up[root] = root;
    if (grows) { grownInto[f] = root - nv; pieces[root - nv].grown += faceArea[f]; }
  }
  return grownInto;
}

/**
 * Split a welded mesh into parts.
 * @param {Float32Array} pos  welded positions (xyz)
 * @param {Uint32Array} index triangle indices into pos
 * @param {object} opts threshold: valley strength (higher = fewer cuts);
 *   dilate: rings used to close small gaps in a groove; minArea: smallest part (fraction of surface);
 *   color: material colour per vertex (vertexColors) to also split where the material changes colour
 *   and to make every boundary follow the colour edge (colorSplit: false uses it for boundaries only);
 *   colorDist: how different two materials must be; base: false keeps legs, frames and plinths under
 *   the body's underside, a table top or a seat in the parts they touch
 * @returns {{faceLabels:Int32Array, vertexLabels:Int32Array, parts:Array}}
 */
export function segment(pos, index, opts = {}) {
  const { threshold = 60, dilate = 4, minArea = 0.002, smoothIters = 5, color = null, colorDist: minColorDist = 14 } = opts;
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
  let labelCount = ids.size;
  const trust = color && colorTrust(color);
  if (color && labelCount && opts.colorSplit !== false) labelCount = splitByColor(label, labelCount, color, trust, area, pos, edges, minArea * total, minColorDist);

  // grow labels back into the grooves: breadth-first, with colour keeping each material to itself
  if (color) growByColor(label, labelCount, color, trust, area, adj, minColorDist);
  else {
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
  }
  if (labelCount === 0) label.fill(0);

  const faceLabels = new Int32Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = label[index[f * 3]], b = label[index[f * 3 + 1]], c = label[index[f * 3 + 2]];
    faceLabels[f] = Math.max(0, a === b || a === c ? a : b === c ? b : a);
  }
  let count = Math.max(labelCount, 1);
  if (opts.base !== false) {
    const h = undersideHeight(pos, index);
    if (h !== null) count = splitBase(faceLabels, label, count, pos, index, faceArea, total, h);
  }
  const parts = Array.from({ length: count }, (_, id) => ({ id, area: 0, faces: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  for (let f = 0; f < nf; f++) {
    const p = parts[faceLabels[f]];
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
