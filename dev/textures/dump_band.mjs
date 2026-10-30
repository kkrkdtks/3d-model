// UV triangles of frame faces in a low band (to paint a fused wooden plinth into the texture).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import { analyze, plainFloats } from '../../core/skin.js';
const [file, out, y0, y1] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
await plainFloats(doc);
const a = analyze(doc);
const pos = a.welded.pos, wi = a.welded.index, nf = wi.length / 3;
const uv = a.prim.getAttribute('TEXCOORD_0').getArray(), idx = a.prim.getIndices().getArray();
const tris = [];
for (let f = 0; f < nf; f++) {
  if (a.faceLabels[f] !== 0) continue;
  const cy = (pos[wi[f * 3] * 3 + 1] + pos[wi[f * 3 + 1] * 3 + 1] + pos[wi[f * 3 + 2] * 3 + 1]) / 3;
  if (cy < +y0 || cy > +y1) continue;
  for (let c = 0; c < 3; c++) { const i = idx[f * 3 + c]; tris.push(uv[i * 2], uv[i * 2 + 1]); }
}
fs.writeFileSync(out, Buffer.from(Float32Array.from(tris).buffer));
console.log('faces', tris.length / 6);
