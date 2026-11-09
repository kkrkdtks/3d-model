// prints the model size at a real height and the size of what stands under the top (below a height fraction)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const [f, H, frac] = [process.argv[2], +process.argv[3], +(process.argv[4] || 0.85)];
const d = await io.read(f);
const ps = d.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).map((p) => p.getAttribute('POSITION').getArray());
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (const a of ps) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a[i + k]); mx[k] = Math.max(mx[k], a[i + k]); }
const u = H / (mx[1] - mn[1]), yc = mn[1] + frac * (mx[1] - mn[1]);
let bn = [1e9, 1e9, 1e9], bx = [-1e9, -1e9, -1e9];
for (const a of ps) for (let i = 0; i < a.length; i += 3) if (a[i + 1] < yc) for (let k = 0; k < 3; k++) { bn[k] = Math.min(bn[k], a[i + k]); bx[k] = Math.max(bx[k], a[i + k]); }
console.log(f.split('/').pop(), 'all x', Math.round((mx[0] - mn[0]) * u), 'z', Math.round((mx[2] - mn[2]) * u), '| under', frac, 'x', Math.round((bx[0] - bn[0]) * u), 'z', Math.round((bx[2] - bn[2]) * u));
