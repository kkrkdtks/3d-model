// Replace one texture image of a GLB (same UVs): node dev/batch/swap-texture.mjs in.glb out.glb image.webp textureNamePrefix
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'; import fs from 'fs';
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [a, b, img, name] = process.argv.slice(2); const d = await io.read(a);
const t = d.getRoot().listTextures().find((x) => x.getName().startsWith(name)); if (!t) throw new Error('no tex');
t.setImage(fs.readFileSync(img)); await io.write(b, d); console.log('wrote', b, fs.statSync(b).size);
