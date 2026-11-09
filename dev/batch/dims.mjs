// Real size (mm) and floor gap of exported GLBs: node dev/batch/dims.mjs out/*.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { getBounds } from '@gltf-transform/core';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) { const d = await io.read(f); const b = getBounds(d.getRoot().listScenes()[0]); const e = [0,1,2].map(i => Math.round((b.max[i]-b.min[i])*1000)); console.log(f.split('/').pop().slice(0,40), 'W/H/D mm', e.join(' '), 'floor', Math.round(b.min[1]*1000), 'mm'); }
