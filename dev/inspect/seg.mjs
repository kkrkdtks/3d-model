// Parts of a model with the base split off and on: underside height, and each part's share and extent.
// usage: node seg.mjs model.glb   (writes labels.bin: the face labels with the base split)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import { analyze, plainFloats } from '../../core/skin.js';
import * as seg from '../../core/segment.js';
const [file, ...rest] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file); await plainFloats(doc);
for (const base of [false, true]) {
  const t = Date.now();
  const a = analyze(doc, { base });
  const { pos, index } = a.welded;
  const H = a.bbox.max[1] - a.bbox.min[1];
  const h = seg.undersideHeight(pos, index);
  console.log(`base ${base}: parts ${a.parts.length} underside ${h === null ? '-' : ((h - a.bbox.min[1]) / H * 100).toFixed(1) + '% (' + (h * 1000).toFixed(0) + ' mm)'} ${Date.now() - t}ms tris ${index.length / 3}`);
  for (const p of a.parts) console.log(`   part ${p.id} ${p.areaPct.toFixed(1)}% faces ${p.faces} x ${p.min[0].toFixed(3)}..${p.max[0].toFixed(3)} y ${p.min[1].toFixed(3)}..${p.max[1].toFixed(3)} z ${p.min[2].toFixed(3)}..${p.max[2].toFixed(3)}`);
  if (base) fs.writeFileSync('labels.bin', Buffer.from(a.faceLabels.buffer));
}
