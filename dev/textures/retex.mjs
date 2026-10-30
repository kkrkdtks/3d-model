// Copy of a GLB with its colour texture replaced by another image (to test colour splitting in the app).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
const [src, img, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const tex = doc.getRoot().listMaterials()[0].getBaseColorTexture();
tex.setImage(new Uint8Array(fs.readFileSync(img))).setMimeType('image/jpeg');
await io.write(out, doc);
console.log('wrote', out, fs.statSync(out).size);
