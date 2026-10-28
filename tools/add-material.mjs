// Add or update a material in materials/library.json from source images.
// usage: node tools/add-material.mjs <id> --albedo a.png [--normal n.png] [--orm orm.png] [--size 1024]
// The albedo's average brightness is stored so colour chips render at their true colour.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const [id, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];
if (!id || !args.albedo) {
  console.error('usage: node tools/add-material.mjs <id> --albedo a.png [--normal n.png] [--orm orm.png] [--size 1024]');
  process.exit(1);
}
const size = +(args.size || 1024);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'materials');
await fs.mkdir(path.join(root, id), { recursive: true });

const maps = {};
for (const [slot, file, q] of [['baseColor', args.albedo, 90], ['normal', args.normal, 94], ['orm', args.orm, 92]]) {
  if (!file) continue;
  const name = { baseColor: 'albedo', normal: 'normal', orm: 'orm' }[slot];
  await sharp(file).resize(size, size, { fit: 'fill' }).webp({ quality: q, smartSubsample: true }).toFile(path.join(root, id, `${name}.webp`));
  maps[slot] = `${id}/${name}.webp`;
}

// mean linear albedo (luminance), used to divide the chip colour
const { data, info } = await sharp(args.albedo).resize(256, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
let sum = 0;
for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * lin(data[i] / 255) + 0.7152 * lin(data[i + 1] / 255) + 0.0722 * lin(data[i + 2] / 255);
const albedoMean = +(sum / (data.length / info.channels)).toFixed(4);

const libPath = path.join(root, 'library.json');
const lib = JSON.parse(await fs.readFile(libPath, 'utf8'));
const entry = lib.materials.find((m) => m.id === id);
if (!entry) { console.error(`library.json에 "${id}" 항목을 먼저 만들어 주세요.`); process.exit(1); }
entry.maps = maps;
entry.albedoMean = albedoMean;
await fs.writeFile(libPath, JSON.stringify(lib, null, 2) + '\n');
console.log(id, maps, 'albedoMean', albedoMean);
