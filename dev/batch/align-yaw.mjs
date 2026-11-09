// Square a piece up before the app run: a model generated slightly or 45° turned about the vertical axis
// gets the turn that makes its footprint box smallest (the piece's own sides then lie along X / Z), baked
// into the vertices. A later face-front run picks which side faces the front.
// usage: node dev/batch/align-yaw.mjs in.glb out.glb
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [IN, OUT] = process.argv.slice(2);
const doc = await io.read(IN);
const scene = doc.getRoot().listScenes()[0];
const xs = [], zs = [], v = [0, 0, 0];
for (const n of doc.getRoot().listNodes()) { const m = n.getMesh(); if (!m) continue; const M = n.getWorldMatrix();
  for (const p of m.listPrimitives()) { const A = p.getAttribute('POSITION'); const step = Math.max(1, Math.floor(A.getCount() / 60000));
    for (let i = 0; i < A.getCount(); i += step) { A.getElement(i, v); xs.push(M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12]); zs.push(M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]); } } }
const area = (a) => { const c = Math.cos(a), s = Math.sin(a); let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < xs.length; i++) { const x = c * xs[i] - s * zs[i], z = s * xs[i] + c * zs[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [(x1 - x0) * (z1 - z0), x1 - x0, z1 - z0]; };
let best = 0, ba = area(0)[0];
for (let d = -45; d < 45; d += 0.5) { const a = (d * Math.PI) / 180, r = area(a)[0]; if (r < ba - 1e-12) { ba = r; best = a; } }
for (let d = -0.5; d <= 0.5; d += 0.05) { const a = best + (d * Math.PI) / 180, r = area(a)[0]; if (r < ba) { ba = r; best = a; } }
const a0 = area(0), a1 = area(best);
const t = -best / 2; // rotation about +Y by -best maps (x,z) -> (c x - s z, s x + c z)
const root = doc.createNode('align').setRotation([0, Math.sin(t), 0, Math.cos(t)]);
for (const c of scene.listChildren()) { scene.removeChild(c); root.addChild(c); }
scene.addChild(root);
const bake = (n) => { for (const c of n.listChildren()) bake(c); };
// bake every mesh node's world transform into its vertices, then drop the transforms
for (const n of doc.getRoot().listNodes()) if (n.getMesh()) { const M = n.getWorldMatrix(); for (const p of n.getMesh().listPrimitives()) { for (const sem of ['POSITION', 'NORMAL']) { const A = p.getAttribute(sem); if (!A) continue; const e = [0, 0, 0]; for (let i = 0; i < A.getCount(); i++) { A.getElement(i, e); const w = sem === 'POSITION' ? 1 : 0; A.setElement(i, [M[0] * e[0] + M[4] * e[1] + M[8] * e[2] + M[12] * w, M[1] * e[0] + M[5] * e[1] + M[9] * e[2] + M[13] * w, M[2] * e[0] + M[6] * e[1] + M[10] * e[2] + M[14] * w]); } } } }
for (const n of doc.getRoot().listNodes()) n.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
await io.write(OUT, doc);
console.log(IN.split('/').pop(), `turned ${((best * 180) / Math.PI).toFixed(1)}°`, 'footprint', a0.slice(1).map((x) => x.toFixed(3)).join('x'), '->', a1.slice(1).map((x) => x.toFixed(3)).join('x'));
