#!/usr/bin/env node
// 명령줄 도구: 부분 분석 + 재질 변형 GLB 일괄 생성
//
//   node cli/skin.mjs analyze <input.glb> [--out dir]
//       부분(파트) 목록과 색칠한 미리보기 GLB를 만든다.
//   node cli/skin.mjs run <job.json>
//       job 파일대로 변형 GLB들을 만든다 (그룹별 선택지의 모든 조합).
//   node cli/skin.mjs compress <input.glb> [--out file] [--ratio 0.25] [--texture 4096]
//       재질은 그대로 두고 용량만 줄인다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyze, applyToGroup, buildGroups, compressKeptTextures, createMaterial, encodeVariant, DEFAULTS,
} from '../core/skin.js';

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
  const t = Date.now();
  const a = analyze(doc, flags.threshold ? { threshold: +flags.threshold } : {});
  console.log(`부분 ${a.parts.length}개 (${Date.now() - t}ms)`);
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

function combinations(groups) {
  return groups.reduce((acc, g) => acc.flatMap((combo) => g.choices.map((c) => [...combo, { group: g.name, ...c }])), [[]]);
}

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
  const inSize = (await fs.stat(input)).size;
  const a = analyze(doc, job.segment || {});
  console.log(`분석: 부분 ${a.parts.length}개 (${Date.now() - t}ms)`); t = Date.now();

  const quality = { ...DEFAULTS, ...(job.quality || {}), widthMm: job.widthMm };
  const groups = buildGroups(doc, a, job.groups.map((g) => ({ name: g.name, parts: g.parts, reskin: true })), quality);
  console.log(`형상 정리 (${Date.now() - t}ms)`); t = Date.now();
  await compressKeptTextures(doc, (b, m, s) => encodeTexture(b, m, s), quality.keptTextureSize);
  console.log(`원본 텍스처 압축 (${Date.now() - t}ms)`);

  const variants = combinations(job.groups);
  const cache = new Map();
  const results = [];
  for (const combo of variants) {
    const made = [];
    for (const choice of combo) {
      const g = groups.find((x) => x.name === choice.group);
      const { mat, def, color } = await createMaterial(doc, lib, choice.material, choice.color, loadImage, cache);
      applyToGroup(doc, g, mat, def);
      made.push(mat);
      choice.label = `${def.name}-${color.name}`;
    }
    const name = `${path.basename(input, '.glb')}__${combo.map((c) => `${c.group}-${c.label}`).map(slug).join('__')}.glb`;
    const bytes = await encodeVariant(io, doc);
    await fs.writeFile(path.join(outDir, name), bytes);
    console.log(`  ${name}  ${mb(bytes.byteLength)}`);
    results.push({ file: name, bytes: bytes.byteLength, choices: combo.map(({ group, material, color }) => ({ group, material, color })) });
    made.forEach((m) => m.dispose());
  }
  await fs.writeFile(path.join(outDir, 'variants.json'), JSON.stringify({ input, inputBytes: inSize, results }, null, 2));
  console.log(`완료: 변형 ${results.length}개 → ${outDir}`);
}

async function cmdCompress(input, flags) {
  const io = await makeIO();
  const doc = await io.read(input);
  const ratio = +(flags.ratio || 0.25);
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001 }));
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
  console.log('사용법:\n  node cli/skin.mjs analyze <input.glb> [--out dir]\n  node cli/skin.mjs run <job.json>\n  node cli/skin.mjs compress <input.glb> [--out file] [--ratio 0.25] [--texture 4096]');
  process.exit(1);
}
