// For every pair of acceptable levels (low to high): wall density between them, mean and thinnest
// window, against the density under the lowest level.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { plainFloats, mainPrimitive, meshWorldMatrix, weldedPositions, applyMatrix } from '../../core/skin.js';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file); await plainFloats(doc);
  const { prim, mesh } = mainPrimitive(doc);
  const w = weldedPositions(doc, prim); applyMatrix(w.pos, meshWorldMatrix(doc, mesh));
  const { pos, index } = w;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const H = hi[1] - lo[1], footprint = (hi[0] - lo[0]) * (hi[2] - lo[2]), B = 400, step = H / B;
  const down = new Float64Array(B), walls = new Float64Array(B + 1);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - lo[1], bin = Math.min(B - 1, Math.floor(y / step));
    if (ny < -0.7 * len) { if (y >= 0.015 * H) down[bin] += len / 2; }
    else if (ny <= 0.7 * len) walls[bin + 1] += len / 2;
  }
  for (let b = 1; b <= B; b++) walls[b] += walls[b - 1];
  const W = 8, n = B - W + 1, S = new Float64Array(n);
  for (let b = 0; b < n; b++) for (let k = b; k < b + W; k++) S[b] += down[k];
  const lv = [];
  for (let b = 0; b < n; b++) {
    if (S[b] < 0.1 * footprint) continue;
    let peak = true;
    for (let o = Math.max(0, b - W); o <= Math.min(n - 1, b + W) && peak; o++) if (S[o] > S[b] || (S[o] === S[b] && o < b)) peak = false;
    if (!peak) continue;
    let k = b, acc = down[b];
    while (k < b + W - 1 && acc < 0.1 * S[b]) acc += down[++k];
    while (k > 0 && down[k - 1] >= 0.01 * S[b]) k--;
    if (k >= 0.03 * B && walls[k] <= 4 * S[b]) lv.push({ k, area: S[b], score: S[b] / (1 + walls[k] / S[b]) });
  }
  lv.sort((a, b) => a.k - b.k);
  const fb = Math.ceil(0.015 * B), dens = (a, b) => (b > a ? (walls[b] - walls[a]) / (b - a) : 0);
  const thin = (a, b) => { let m = Infinity; for (let s = a; s + W <= b; s++) m = Math.min(m, dens(s, s + W)); return m === Infinity ? dens(a, b) : m; };
  const name = file.split('/').pop().replace('.glb', '');
  if (!lv.length) { console.log(name.padEnd(24), 'no level'); continue; }
  const ref = dens(fb, lv[0].k), best = Math.max(...lv.map((l) => l.score));
  const parts = [`${(lv[0].k / B * 100).toFixed(1)}% s${(lv[0].score / best).toFixed(2)}`];
  for (let i = 1; i < lv.length; i++)
    parts.push(`[mean ${(dens(lv[i - 1].k + W, lv[i].k) / ref).toFixed(1)} thin ${(thin(lv[i - 1].k + W, lv[i].k) / ref).toFixed(1)}] ${(lv[i].k / B * 100).toFixed(1)}% s${(lv[i].score / best).toFixed(2)}`);
  console.log(name.padEnd(24), parts.join(' '));
}
