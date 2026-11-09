// Stretch an exported GLB vertically to a new real height, floor gap kept:
// node dev/batch/height-fix.mjs in.glb out.glb 750
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [a, b, H] = process.argv.slice(2); const d = await io.read(a);
const sc = d.getRoot().listScenes()[0]; const bb = getBounds(sc);
const y0 = bb.min[1], s = (+H / 1000) / (bb.max[1] - bb.min[1]);
const wrap = d.createNode('height').setScale([1, s, 1]).setTranslation([0, y0 * (1 - s), 0]);
for (const n of sc.listChildren()) { sc.removeChild(n); wrap.addChild(n); }
sc.addChild(wrap); await io.write(b, d);
const nb = getBounds(sc); console.log(b.split('/').pop().slice(0, 30), 'H', Math.round((nb.max[1] - nb.min[1]) * 1000), 'floor', Math.round(nb.min[1] * 1000));
