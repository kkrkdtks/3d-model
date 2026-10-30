// Material and texture facts of a GLB (factors, texture type and size, extensions).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  for (const m of doc.getRoot().listMaterials()) {
    const t = (x) => x ? `${x.getMimeType()} ${x.getSize()?.join('x')} ${(x.getImage()?.byteLength / 1e6).toFixed(2)}MB` : '-';
    console.log(file.split('/').pop(), m.getName(), 'baseFactor', m.getBaseColorFactor().map((v) => +v.toFixed(3)), 'baseTex', t(m.getBaseColorTexture()),
      'emissive', m.getEmissiveFactor().map((v) => +v.toFixed(3)), 'emTex', t(m.getEmissiveTexture()), 'normal', t(m.getNormalTexture()), 'mr', t(m.getMetallicRoughnessTexture()),
      'metal', m.getMetallicFactor(), 'rough', m.getRoughnessFactor(), 'ext', m.listExtensions().map((e) => e.extensionName).join(','));
  }
}
