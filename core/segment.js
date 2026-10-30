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
// facing down (on legs), or an overhang above a recessed plinth; what is under that level is the
// base, whatever its colour (white or black steel legs under fabric of any colour, wood).

/**
 * Height just under the body's underside: the lowest level above the floor where a large area
 * faces down, far more than everything below it (leg brackets, feet). Only the lower third of
 * the height is searched: higher up it would be a seat overhang or a table top. null when none.
 */
export function undersideHeight(pos, index) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const H = hi[1] - lo[1], footprint = (hi[0] - lo[0]) * (hi[2] - lo[2]), B = 400, step = H / B;
  if (!(H > 0 && footprint > 0)) return null;
  const down = new Float64Array(B);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    if (!(ny < -0.7 * len)) continue;
    const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - lo[1];
    if (y < 0.015 * H) continue; // standing on the floor: feet, the bottom of a plinth
    down[Math.min(B - 1, Math.floor(y / step))] += len / 2;
  }
  // a 2% slice of the height holding a tenth of the footprint facing down, five times all below it
  const W = 8;
  let below = 0;
  for (let b = 0; b + W <= 0.35 * B; b++) {
    let win = 0;
    for (let k = b; k < b + W; k++) win += down[k];
    if (win >= 0.1 * footprint && win >= 5 * below) {
      let acc = 0;
      for (let k = b; k < b + W; k++) {
        acc += down[k];
        if (acc >= 0.1 * win) return k >= 0.03 * B ? lo[1] + k * step : null;
      }
    }
    below += down[b];
  }
  return null;
}

/**
 * Split off the base under height h: in every part that is mostly above it, the triangles below
 * go to a base part they touch (legs that were parts of their own already), or else together to
 * one new part. faceLabels and vertex labels change in place; returns the new number of parts.
 */
function splitBase(faceLabels, label, count, pos, index, faceArea, total, h) {
  const nf = faceLabels.length;
  const under = new Uint8Array(nf), below = new Float64Array(count), all = new Float64Array(count);
  for (let f = 0; f < nf; f++) {
    const l = faceLabels[f];
    all[l] += faceArea[f];
    if (pos[index[f * 3] * 3 + 1] + pos[index[f * 3 + 1] * 3 + 1] + pos[index[f * 3 + 2] * 3 + 1] < 3 * h) { under[f] = 1; below[l] += faceArea[f]; }
  }
  const base = (l) => below[l] >= 0.5 * all[l];
  const moving = (f) => under[f] && !base(faceLabels[f]);
  // pieces to move, joined through shared vertices
  const parent = new Int32Array(pos.length / 3).fill(-1);
  for (let f = 0; f < nf; f++) {
    if (!moving(f)) continue;
    for (let k = 0; k < 3; k++) { const v = index[f * 3 + k]; if (parent[v] < 0) parent[v] = v; }
    for (let k = 1; k < 3; k++) {
      const ra = find(parent, index[f * 3]), rb = find(parent, index[f * 3 + k]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const pieces = new Map(); // root -> { area, touches: Map(base part -> shared vertices) }
  for (let f = 0; f < nf; f++) {
    if (!moving(f)) continue;
    const r = find(parent, index[f * 3]);
    if (!pieces.has(r)) pieces.set(r, { area: 0, touches: new Map() });
    pieces.get(r).area += faceArea[f];
  }
  if (!pieces.size) return count;
  for (let f = 0; f < nf; f++) {
    if (!base(faceLabels[f])) continue;
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      if (parent[v] < 0) continue;
      const t = pieces.get(find(parent, v)).touches;
      t.set(faceLabels[f], (t.get(faceLabels[f]) || 0) + 1);
    }
  }
  // a few stray triangles of a rim stay where they are; a new part must be worth having
  let fresh = 0;
  for (const p of pieces.values()) {
    p.to = p.area < 1e-4 * total ? -1 : p.touches.size ? [...p.touches].sort((x, y) => y[1] - x[1])[0][0] : count;
    if (p.to === count) fresh += p.area;
  }
  if (fresh < 5e-4 * total) for (const p of pieces.values()) if (p.to === count) p.to = -1;
  for (let f = 0; f < nf; f++) {
    if (!moving(f)) continue;
    const to = pieces.get(find(parent, index[f * 3])).to;
    if (to < 0) continue;
    faceLabels[f] = to;
    for (let k = 0; k < 3; k++) label[index[f * 3 + k]] = to;
  }
  return fresh >= 5e-4 * total ? count + 1 : count;
}

/**
 * Split a welded mesh into parts.
 * @param {Float32Array} pos  welded positions (xyz)
 * @param {Uint32Array} index triangle indices into pos
 * @param {object} opts threshold: valley strength (higher = fewer cuts);
 *   dilate: rings used to close small gaps in a groove; minArea: smallest part (fraction of surface);
 *   color: material colour per vertex (vertexColors) to also split where the material changes colour
 *   and to make every boundary follow the colour edge (colorSplit: false uses it for boundaries only);
 *   colorDist: how different two materials must be; base: false keeps legs and plinths under the
 *   body's underside in the parts they touch
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
