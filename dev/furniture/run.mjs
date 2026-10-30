// Segment synthetic furniture and report what each part is made of (by the generator's element roles).
// usage: node run.mjs [--nobase] [--quiet] models/a.glb ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import { analyze, plainFloats } from '../../core/skin.js';
import * as seg from '../../core/segment.js';

const args = process.argv.slice(2);
const base = !args.includes('--nobase'), quiet = args.includes('--quiet');
const files = args.filter((a) => !a.startsWith('--'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
let bad = 0;
for (const file of files) {
  const doc = await io.read(file);
  await plainFloats(doc);
  const t = Date.now();
  const a = analyze(doc, { base });
  const ms = Date.now() - t;
  const gt = JSON.parse(fs.readFileSync(file.replace(/\.glb$/, '.labels.json'), 'utf8'));
  const src = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getArray();
  const key = (p, i) => `${p[i]},${p[i + 1]},${p[i + 2]}`;
  const elemOf = new Map();
  for (let v = 0; v < src.length / 3; v++) elemOf.set(key(src, v * 3), gt.vertexElement[v]);
  const { pos, index } = a.welded, nf = index.length / 3;
  const H = a.bbox.max[1] - a.bbox.min[1];
  const parts = a.parts.map((p) => ({ id: p.id, area: 0, role: { body: 0, base: 0, frame: 0 }, elem: {} }));
  let total = 0;
  for (let f = 0; f < nf; f++) {
    const vs = [0, 1, 2].map((k) => index[f * 3 + k]);
    const els = vs.map((v) => elemOf.get(key(pos, v * 3)));
    const e = els[0] === els[1] || els[0] === els[2] ? els[0] : els[1] === els[2] ? els[1] : els[0];
    const [p0, p1, p2] = vs.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    const u = p1.map((x, i) => x - p0[i]), w = p2.map((x, i) => x - p0[i]);
    const ar = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    const P = parts[a.faceLabels[f]];
    P.area += ar; total += ar;
    P.role[gt.roles[e]] += ar;
    const en = gt.elements[e];
    P.elem[en] = (P.elem[en] || 0) + ar;
  }
  const h = seg.undersideHeight(pos, index);
  let mixed = 0;
  const lines = [];
  for (const P of parts) {
    const mix = Math.min(P.role.body, P.role.base);
    const isMixed = mix >= 0.1 * P.area && mix >= 0.002 * total;
    if (isMixed) mixed++;
    lines.push(`   ${isMixed ? 'MIXED' : '     '} part ${P.id} ${(P.area / total * 100).toFixed(1)}%  ` +
      Object.entries(P.elem).sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${(v / P.area * 100).toFixed(0)}%`).join(', '));
  }
  let baseAll = 0, baseKept = 0;
  for (const P of parts) { baseAll += P.role.base; if (P.role.base > P.role.body) baseKept += P.role.base; }
  const recall = baseAll ? baseKept / baseAll : 1;
  if (mixed || recall < 0.8) bad++;
  console.log(`${file.split('/').pop().padEnd(26)} parts ${String(parts.length).padStart(2)}  underside ${h === null ? '  -  ' : ((h - a.bbox.min[1]) / H * 100).toFixed(1) + '%'}  ${mixed ? 'MIXED ' + mixed : 'ok'} base-recall ${(recall * 100).toFixed(0)}%  ${ms}ms`);
  if (!quiet || mixed) console.log(lines.join('\n'));
}
console.log('models with mixed parts:', bad, '/', files.length);
