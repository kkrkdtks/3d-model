// Turn a finished GLB about the vertical axis so it faces +Z (the glTF front) with its width along X: a sofa's
// seat side or a bed's foot end towards +Z, a table's long side along X. The turn is put on a new root node
// (the meshes and their compression stay as exported). Round pieces are left as they are.
// usage: node dev/batch/face-front.mjs in.glb out.glb
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { furnitureAxes } from '../../core/size.js';
const [IN, OUT] = process.argv.slice(2);
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(IN);
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
// world positions
const pts = [];
const v = [0, 0, 0];
for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh(); if (!m) continue;
  const M = n.getWorldMatrix();
  for (const p of m.listPrimitives()) {
    const A = p.getAttribute('POSITION');
    for (let i = 0; i < A.getCount(); i++) { A.getElement(i, v); pts.push(M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]); }
  }
}
const pos = Float32Array.from(pts);
const b = getBounds(scene), ex = b.max[0] - b.min[0], ez = b.max[2] - b.min[2];
const ax = furnitureAxes(pos);
let deg = 0;
if (Math.abs(ex / ez - 1) < 0.02) deg = 0; // round: any turn looks the same
else if (ax.d === 2) deg = ax.front === 1 ? 0 : 180;
else deg = -ax.front * 90;
if (deg) {
  const t = (deg * Math.PI) / 360, root = doc.createNode('front').setRotation([0, Math.sin(t), 0, Math.cos(t)]);
  for (const c of scene.listChildren()) { scene.removeChild(c); root.addChild(c); }
  scene.addChild(root);
  // keep the footprint centred where it was (the turn is about the origin; the app centres x/z on it)
}
console.log(IN.split('/').pop().slice(0, 50), `turned ${deg}°`);
await io.write(OUT, doc);
