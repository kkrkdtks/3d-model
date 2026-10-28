#!/usr/bin/env node
// 명령줄 도구: 부분 분석 + 재질 변형 GLB 일괄 생성
//
//   node cli/skin.mjs analyze <input.glb> [--out dir]
//       부분(파트) 목록과 색칠한 미리보기 GLB를 만든다.
//   node cli/skin.mjs run <job.json>
//       job 파일대로 변형 GLB들을 만든다 (그룹별 재질 × 크기의 모든 조합).
//   node cli/skin.mjs compress <input.glb> [--h mm] [--w mm] [--d mm] [--out file] [--ratio 0.25] [--texture 4096]
//       재질은 그대로 두고 용량만 줄인다. --h를 주면 실제 크기(미터, 바닥 기준)로 맞춘다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyze, applyToGroup, colorLabel, compressKeptTextures, createMaterial, encodeVariant, facesOfParts, groupPrimitive,
  plainFloats, prepareOutput, releaseSource, resolveChoice, setVariant, DEFAULTS,
} from '../core/skin.js';
import { bboxWith, extentOf, outputTransform, sizeLabel, sizeWith, swapAxes } from '../core/size.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LIB_DIR = path.join(ROOT, 'materials');

async function makeIO() {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
  });
}

/** Resize to fit maxSize and re-encode as WebP (normal maps a bit higher quality). */
async function encodeTexture(bytes, mime, maxSize, quality = 85) {
  const img = sharp(Buffer.from(bytes));
  const meta = await img.metadata();
  const scale = Math.min(1, maxSize / Math.max(meta.width, meta.height));
  const out = await img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale)).webp({ quality }).toBuffer();
  return { bytes: new Uint8Array(out), mimeType: 'image/webp' };
}

function parseFlags(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
const slug = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-');

async function cmdAnalyze(input, flags) {
  const io = await makeIO();
  const doc = await io.read(input);
  await plainFloats(doc);
  const t = Date.now();
  const a = analyze(doc, flags.threshold ? { threshold: +flags.threshold } : {});
  console.log(`부분 ${a.parts.length}개 (${Date.now() - t}ms)`);
  const ext = extentOf(a.bbox);
  console.log(`모델 크기 비율 W:D:H = ${(ext[a.axes.w] / ext[1]).toFixed(3)} : ${(ext[a.axes.d] / ext[1]).toFixed(3)} : 1 (가로=${'xyz'[a.axes.w]}축, 깊이=${'xyz'[a.axes.d]}축)`);
  console.log('id  면적%   min(x,y,z)                 max(x,y,z)');
  for (const p of a.parts)
    console.log(String(p.id).padEnd(3), p.areaPct.toFixed(1).padStart(5) + '%', p.min.map((v) => v.toFixed(3)).join(',').padEnd(26), p.max.map((v) => v.toFixed(3)).join(','));
  const outDir = flags.out || path.dirname(input);
  await fs.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(input, '.glb'));
  await fs.writeFile(`${base}.parts.json`, JSON.stringify({ input: path.resolve(input), segment: { ...DEFAULTS.segment, ...(flags.threshold ? { threshold: +flags.threshold } : {}) }, parts: a.parts.map(({ id, areaPct, faces, min, max }) => ({ id, areaPct: +areaPct.toFixed(2), faces, min, max })) }, null, 2));
  // coloured preview: one flat colour per part
  const preview = await previewDoc(doc, a);
  await fs.writeFile(`${base}.parts.glb`, await io.writeBinary(preview));
  console.log(`저장: ${base}.parts.json, ${base}.parts.glb`);
}

const PREVIEW_COLORS = ['#c9c4bd', '#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8e7dbe', '#d4a5a5', '#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#9c6644', '#6d597a'];

async function previewDoc(doc, a) {
  const { Document } = await import('@gltf-transform/core');
  const out = new Document();
  const buf = out.createBuffer(), mesh = out.createMesh('parts');
  const { pos, index } = a.welded;
  for (const p of a.parts) {
    const faces = [];
    for (let f = 0; f < a.faceLabels.length; f++) if (a.faceLabels[f] === p.id) faces.push(index[f * 3], index[f * 3 + 1], index[f * 3 + 2]);
    const hex = PREVIEW_COLORS[p.id % PREVIEW_COLORS.length];
    const lin = [1, 3, 5].map((i) => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2));
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(faces)).setBuffer(buf))
      .setMaterial(out.createMaterial(`part ${p.id}`).setBaseColorFactor([...lin, 1]).setRoughnessFactor(0.8).setMetallicFactor(0))
      .setExtras({ part: p.id });
    mesh.addPrimitive(prim);
  }
  out.createScene().addChild(out.createNode().setMesh(mesh));
  const { compactPrimitive } = await import('@gltf-transform/functions');
  mesh.listPrimitives().forEach((p) => compactPrimitive(p));
  await out.transform(prune());
  return out;
}

/**
 * Real size (mm) and the transform to metres. job.size = { h, w?, d? } (h required);
 * older jobs give only widthMm, and the height then follows the model's proportions.
 */
function realSize(job, a) {
  const size = { ...(job.size || {}) };
  if (!size.h && job.widthMm) {
    const ext = extentOf(a.bbox);
    size.w ??= job.widthMm;
    size.h = Math.round((job.widthMm * ext[1]) / ext[a.axes.w]);
  }
  if (!(size.h > 0)) throw new Error('job 파일에 실제 높이를 넣어 주세요: "size": { "h": 750 } (mm)');
  return outputTransform(a.bbox, a.axes, size);
}

/** Current W × D (mm) of the faces in parts. */
function partSizeMm(a, xf, parts) {
  const { pos, index } = a.welded;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const f of facesOfParts(a.faceLabels, parts))
    for (let c = 0; c < 3; c++) {
      const v = index[f * 3 + c] * 3;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[v + k]); max[k] = Math.max(max[k], pos[v + k]); }
    }
  const ext = extentOf(bboxWith({ min, max }, xf));
  return { w: ext[a.axes.w] * 1000, d: ext[a.axes.d] * 1000 };
}

/**
 * Options of one group: (materials, or the original look when none) × (sizes, or the current size).
 * Same rule as the app, so a job and the screen give the same files.
 */
function optionsOf(g, key) {
  const mats = g.choices?.length ? g.choices : [null];
  const sizes = g.sizes?.length ? g.sizes : [null];
  return mats.flatMap((choice) => sizes.map((s) => ({ key, group: g, choice, size: s ? { w: s.w ?? null, d: s.d ?? null } : null })));
}

const optKey = (o) => `${o.key}|${o.choice ? 'skin' : 'keep'}|${o.size ? `${o.size.w ?? ''}x${o.size.d ?? ''}` : ''}`;

async function cmdRun(jobPath) {
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  const jobDir = path.dirname(path.resolve(jobPath));
  const input = path.resolve(jobDir, job.input);
  const outDir = path.resolve(jobDir, job.outDir || 'out');
  await fs.mkdir(outDir, { recursive: true });
  const lib = JSON.parse(await fs.readFile(path.join(LIB_DIR, 'library.json'), 'utf8'));
  const loadImage = async (p) => new Uint8Array(await fs.readFile(path.join(LIB_DIR, p)));
  const io = await makeIO();

  let t = Date.now();
  const doc = await io.read(input);
  await plainFloats(doc);
  const inSize = (await fs.stat(input)).size;
  const a = analyze(doc, job.segment || {});
  if (job.swapAxes) a.axes = swapAxes(a.axes);
  console.log(`분석: 부분 ${a.parts.length}개 (${Date.now() - t}ms)`); t = Date.now();
  const xf = realSize(job, a);
  const real = sizeWith(a.bbox, a.axes, xf);
  console.log(`저장 크기: W ${Math.round(real.w)} × D ${Math.round(real.d)} × H ${Math.round(real.h)} mm (미터 단위, 바닥 가운데 기준)`);

  const quality = { ...DEFAULTS, ...(job.quality || {}) };
  const groups = job.groups.map((g, i) => ({ key: `g${i}`, name: g.name, parts: g.parts }));
  const options = job.groups.map((g, i) => optionsOf({ ...g, key: groups[i].key }, groups[i].key));
  const ctx = prepareOutput(doc, a, xf, groups, quality);
  const built = new Map();
  for (const o of options.flat())
    if (!built.has(optKey(o))) built.set(optKey(o), groupPrimitive(ctx, groups.find((g) => g.key === o.key), { reskin: !!o.choice, size: o.size }));
  releaseSource(ctx);
  console.log(`형상 정리 (${Date.now() - t}ms)`); t = Date.now();
  await compressKeptTextures(doc, (b, m, s) => encodeTexture(b, m, s), quality.keptTextureSize);
  console.log(`원본 텍스처 압축 (${Date.now() - t}ms)`);

  const variants = options.reduce((acc, list) => acc.flatMap((combo) => list.map((o) => [...combo, o])), [[]]);
  const cache = new Map();
  const results = [], used = new Set();
  for (const combo of variants) {
    const parts = combo.map((o) => built.get(optKey(o)));
    setVariant(ctx, parts);
    const made = [], labels = [];
    for (let k = 0; k < combo.length; k++) {
      const o = combo[k];
      let look = '';
      if (o.choice && parts[k]) {
        const resolved = resolveChoice(lib, o.choice.material, o.choice.color);
        const { mat, def, color } = await createMaterial(doc, resolved.def, resolved.color, loadImage, cache);
        applyToGroup(doc, parts[k], mat, def, { rotate: o.choice.rotate ?? o.group.rotate ?? 0 });
        made.push(mat);
        look = [def.name, colorLabel(color)].filter(Boolean).join('-');
      }
      const size = o.size ? sizeLabel(o.size, partSizeMm(a, xf, o.group.parts)) : '';
      labels.push([o.group.name, size, look].filter(Boolean).map(slug).join('-'));
    }
    let name = `${path.basename(input, '.glb')}__${labels.join('__')}.glb`;
    for (let i = 2; used.has(name); i++) name = name.replace(/(-\d+)?\.glb$/, `-${i}.glb`);
    used.add(name);
    const bytes = await encodeVariant(io, doc);
    await fs.writeFile(path.join(outDir, name), bytes);
    console.log(`  ${name}  ${mb(bytes.byteLength)}`);
    results.push({
      file: name, bytes: bytes.byteLength,
      choices: combo.map((o) => ({ group: o.group.name, material: o.choice?.material ?? null, color: o.choice?.color ?? null, size: o.size })),
    });
    made.forEach((m) => m.dispose());
  }
  await fs.writeFile(path.join(outDir, 'variants.json'), JSON.stringify({ input, inputBytes: inSize, sizeMm: { w: Math.round(real.w), d: Math.round(real.d), h: Math.round(real.h) }, results }, null, 2));
  console.log(`완료: 변형 ${results.length}개 → ${outDir}`);
}

async function cmdCompress(input, flags) {
  const io = await makeIO();
  const doc = await io.read(input);
  await plainFloats(doc);
  const ratio = +(flags.ratio || 0.25);
  if (flags.h) {
    // same path as the app: real size in metres, standing on the floor
    const a = analyze(doc);
    if (flags.swap) a.axes = swapAxes(a.axes);
    const xf = outputTransform(a.bbox, a.axes, { h: +flags.h, w: +flags.w || null, d: +flags.d || null });
    const real = sizeWith(a.bbox, a.axes, xf);
    console.log(`저장 크기: W ${Math.round(real.w)} × D ${Math.round(real.d)} × H ${Math.round(real.h)} mm`);
    const ctx = prepareOutput(doc, a, xf, [], { ...DEFAULTS, keepSimplify: ratio });
    releaseSource(ctx);
    setVariant(ctx, []);
  } else {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001 }));
  }
  await compressKeptTextures(doc, (b, m, s) => encodeTexture(b, m, s), +(flags.texture || 4096));
  const bytes = await encodeVariant(io, doc);
  const out = flags.out || input.replace(/\.glb$/i, '.compressed.glb');
  await fs.writeFile(out, bytes);
  console.log(`${mb((await fs.stat(input)).size)} → ${mb(bytes.byteLength)}  ${out}`);
}

const { pos, flags } = parseFlags(process.argv.slice(2));
const [cmd, arg] = pos;
if (cmd === 'analyze' && arg) await cmdAnalyze(arg, flags);
else if (cmd === 'run' && arg) await cmdRun(arg);
else if (cmd === 'compress' && arg) await cmdCompress(arg, flags);
else {
  console.log('사용법:\n  node cli/skin.mjs analyze <input.glb> [--out dir]\n  node cli/skin.mjs run <job.json>\n  node cli/skin.mjs compress <input.glb> [--h 높이mm] [--w 가로mm] [--d 깊이mm] [--out file] [--ratio 0.25] [--texture 4096]');
  process.exit(1);
}
