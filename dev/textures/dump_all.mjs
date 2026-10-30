// Every face: UV triangle (6), unit face normal (3), centroid (3) as float32, to paint 3D effects into the texture.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import { analyze, plainFloats } from '../../core/skin.js';
const [file, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
await plainFloats(doc);
const a = analyze(doc);
const pos = a.welded.pos, wi = a.welded.index, nf = wi.length / 3;
const uv = a.prim.getAttribute('TEXCOORD_0').getArray(), idx = a.prim.getIndices().getArray();
const o = new Float32Array(nf * 12);
for (let f = 0; f < nf; f++) {
  for (let c = 0; c < 3; c++) { const i = idx[f * 3 + c]; o[f * 12 + c * 2] = uv[i * 2]; o[f * 12 + c * 2 + 1] = uv[i * 2 + 1]; }
  const A = wi[f * 3] * 3, B = wi[f * 3 + 1] * 3, C = wi[f * 3 + 2] * 3;
  const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2];
  const vx = pos[C] - pos[A], vy = pos[C + 1] - pos[A + 1], vz = pos[C + 2] - pos[A + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  o[f * 12 + 6] = nx / l; o[f * 12 + 7] = ny / l; o[f * 12 + 8] = nz / l;
  for (let d = 0; d < 3; d++) o[f * 12 + 9 + d] = (pos[A + d] + pos[B + d] + pos[C + d]) / 3;
}
fs.writeFileSync(out, Buffer.from(o.buffer));
console.log('faces', nf);
