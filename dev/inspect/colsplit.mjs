// Parts of a model by shape only and with the colour split (its colour texture, or the glow texture of a "shaded" export).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'fs';
import { plainFloats, mainPrimitive, meshWorldMatrix, weldedPositions, applyMatrix, DEFAULTS, faceColors, baseColorSource } from '../../core/skin.js';
import * as N from '../../core/segment.js';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const file = process.argv[2];
const doc = await io.read(file); await plainFloats(doc);
const { prim, mesh } = mainPrimitive(doc);
const w = weldedPositions(doc, prim); applyMatrix(w.pos, meshWorldMatrix(doc, mesh));
const { pos, index } = w, nv = pos.length / 3, nf = index.length / 3;
const edges = N.uniqueEdges(index, nv), adj = N.adjacency(edges.ea, edges.eb, nv);
const curvature = N.valleyCurvature(pos, adj, edges, N.vertexNormals(pos, index, nv), DEFAULTS.segment.smoothIters);
const src = baseColorSource(prim);
if (!src) { console.log('no colour texture'); process.exit(); }
const S = 1024, raw = await sharp(Buffer.from(src.image)).resize(S, S, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
const color = N.vertexColors(index, faceColors(prim, src.texCoord, raw, S, S), nv, adj, 2);
for (const c of [null, color]) {
  const r = N.segment(pos, index, { ...DEFAULTS.segment, edges, adj, curvature, color: c });
  console.log(c ? 'colour' : 'shape ', 'parts', r.parts.length, r.parts.map((p) => `${p.id}:${p.areaPct.toFixed(1)}% y ${p.min[1].toFixed(3)}..${p.max[1].toFixed(3)}`).join(' | '));
  if (c) fs.writeFileSync('collabels.bin', Buffer.from(r.faceLabels.buffer));
}
