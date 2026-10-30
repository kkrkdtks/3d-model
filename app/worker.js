// Background worker: everything heavy (reading the GLB, finding parts, building
// geometry, writing variant files) runs here so the screen never freezes.
//
// Messages in:  { id, cmd, args }
// Messages out: { id, ok: true, result } | { id, ok: false, error } | { id, progress: { text, frac } }
//               | { id, file: { name, bytes, sizeMm } } while exporting
import { ImageUtils, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import {
  DEFAULTS, applyMatrix, applyToGroup, baseColorSource, compressKeptTextures, createMaterial, cutPart, encodeVariant,
  faceColors, facesOfParts, groupPrimitive, mainPrimitive, meshWorldMatrix, partStats, plainFloats, prepareOutput,
  releaseSource, reskinGeometry, setVariant, weldedPositions,
} from '../core/skin.js';
import { adjacency, segment, undersideHeight, uniqueEdges, valleyCurvature, vertexColors, vertexNormals } from '../core/segment.js';
import { bboxOf, furnitureAxes } from '../core/size.js';
import { stripWebPProfile } from './webp.js';

const ready = Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
// tell the page the worker really runs (some sandboxes load it but block WebAssembly)
ready.then(() => self.postMessage({ hello: true }), (err) => self.postMessage({ hello: false, error: String(err?.message || err) }));
let io = null;
const state = {};

/** Stage timings, returned with results so slow steps can be found on any PC. */
function timer() {
  const t0 = performance.now(), marks = [];
  let last = t0;
  return {
    mark(label) { const now = performance.now(); marks.push([label, Math.round(now - last)]); last = now; },
    done() { return { total: Math.round(performance.now() - t0), marks }; },
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function getIO() {
  await ready;
  io ??= new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
  });
  return io;
}

/**
 * args: { bytes, segment: { threshold, color, cuts } } (how to split it: see runSegment)
 */
async function open({ bytes, segment: segOpts = {} }, progress) {
  const io = await getIO();
  const T = timer();
  progress('파일 읽는 중', 0.05);
  const doc = await io.readBinary(new Uint8Array(bytes));
  T.mark('read');
  await plainFloats(doc);
  const { prim, mesh } = mainPrimitive(doc);
  const indexCount = prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount();
  const textures = doc.getRoot().listTextures().map((t) => {
    const size = t.getSize();
    return { name: t.getName() || t.getURI(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength || 0, width: size?.[0] || 0, height: size?.[1] || 0 };
  });
  // the colour texture decodes on another thread while the shape is worked out; it needs this
  // thread for a moment to start and to finish, hence the short breaks below
  const colorImage = readColorImage(prim).catch((e) => { console.warn('색을 읽지 못했어요', e); return null; });
  await pause();
  progress('모양 정리 중', 0.2);
  // scene ("world") units: 3DAISTUDIO lifts the mesh onto the floor with a node offset
  const welded = weldedPositions(doc, prim);
  applyMatrix(welded.pos, meshWorldMatrix(doc, mesh));
  T.mark('weld');
  await pause();
  progress('경계 찾는 중', 0.4);
  const nv = welded.pos.length / 3;
  const edges = uniqueEdges(welded.index, nv);
  const adj = adjacency(edges.ea, edges.eb, nv);
  T.mark('edges');
  await pause();
  const curvature = valleyCurvature(welded.pos, adj, edges, vertexNormals(welded.pos, welded.index, nv), DEFAULTS.segment.smoothIters);
  T.mark('curvature');
  progress('색 살피는 중', 0.65);
  const image = await colorImage;
  T.mark('color image');
  const color = image && vertexColors(welded.index, faceColors(prim, image.texCoord, image.pixels, image.size, image.size), nv, adj);
  T.mark('color');
  Object.assign(state, { bytes: new Uint8Array(bytes), welded, edges, adj, curvature, color, previews: new Map() });
  progress('부분 나누는 중', 0.75);
  const seg = runSegment(segOpts);
  T.mark('segment');
  return {
    timings: T.done(),
    info: {
      triangles: indexCount / 3, vertices: prim.getAttribute('POSITION').getCount(), weldedVertices: nv,
      indexCount, textures, bbox: bboxOf(welded.pos), underside: undersideHeight(welded.pos, welded.index),
      materials: doc.getRoot().listMaterials().length, meshes: doc.getRoot().listMeshes().length,
    },
    axes: furnitureAxes(welded.pos),
    welded: { pos: welded.pos.slice(), index: welded.index.slice() },
    ...seg,
  };
}

/**
 * The colour texture read at 1024² (fine enough to tell a wooden base from the fabric, coarse
 * enough to ignore the weave): { pixels (RGBA), size, texCoord }, or null without a texture.
 */
async function readColorImage(prim) {
  const src = baseColorSource(prim);
  if (!src) return null;
  const N = 1024, opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const ctx = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  // ImageDecoder keeps decoding on its own thread while this one is busy, and reads a JPEG
  // straight at the smaller size; createImageBitmap only gets on with it when this thread is free
  if (self.ImageDecoder && await ImageDecoder.isTypeSupported(src.mime)) {
    const decoder = new ImageDecoder({ data: src.image, type: src.mime, desiredWidth: N, desiredHeight: N, ...opts });
    try {
      const { image } = await decoder.decode();
      ctx.drawImage(image, 0, 0, N, N);
      image.close();
    } finally {
      decoder.close();
    }
  } else {
    const bmp = await createImageBitmap(new Blob([src.image], { type: src.mime }), { ...opts, resizeWidth: N, resizeHeight: N, resizeQuality: 'high' });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }
  return { pixels: ctx.getImageData(0, 0, N, N).data, size: N, texCoord: src.texCoord };
}

/**
 * Split into parts. opts: threshold (valley strength), color (also split where the material
 * colour changes, default on), cuts ([{ part, y }] height cuts to repeat, in order; the ones
 * that could be made come back as cuts), labels (a split saved earlier, one part id per
 * triangle: used as it is, cuts included, when it fits this model).
 */
function runSegment({ color = true, cuts = [], labels = null, ...opts } = {}) {
  const { welded, edges, adj, curvature } = state;
  let done = cuts;
  if (labels?.length === welded.index.length / 3) {
    state.faceLabels = Int32Array.from(labels);
    const count = state.faceLabels.reduce((m, l) => Math.max(m, l + 1), 0);
    state.parts = partStats(welded.pos, welded.index, state.faceLabels, Array.from({ length: count }, (_, i) => i));
  } else {
    const seg = segment(welded.pos, welded.index, { ...DEFAULTS.segment, ...opts, edges, adj, curvature, color: color ? state.color : null });
    state.faceLabels = seg.faceLabels;
    state.parts = seg.parts.map(({ id, area, faces, min, max }) => ({ id, area, faces, min, max }));
    done = cuts.filter((c) => applyCut(c.part, c.y));
  }
  state.totalArea = state.parts.reduce((sum, p) => sum + p.area, 0);
  state.previews = new Map();
  return { ...splitResult(), hasColor: !!state.color, cuts: done };
}

function splitResult() {
  return {
    faceLabels: state.faceLabels.slice(),
    parts: state.parts.map(({ id, area, faces, min, max }) => ({ id, areaPct: (100 * area) / state.totalArea, faces, min, max })),
  };
}

/** Triangles of a part below height y (scene units) become a new part; false when one side would be empty. */
function applyCut(part, y) {
  const { pos, index } = state.welded, p = state.parts[part];
  if (!p) return false;
  const labels = state.faceLabels.slice(), id = state.parts.length;
  const moved = cutPart(pos, index, labels, part, y, id);
  if (!moved || moved === p.faces) return false;
  state.faceLabels = labels;
  const [rest, piece] = partStats(pos, index, labels, [part, id]);
  state.parts[part] = rest;
  state.parts.push(piece);
  return true;
}

function cut({ part, y }) {
  if (!applyCut(part, y)) throw new Error('그 높이에서는 나눌 게 없어요. 높이를 바꿔 보세요.');
  state.previews = new Map();
  return splitResult();
}

/**
 * Geometry for the live preview of a re-skinned group (same code path as the export):
 * in metres in the output frame (xf), resized when size is given.
 */
function preview({ parts, simplify, xf, size, axes }) {
  const key = JSON.stringify([[...parts].sort((a, b) => a - b), simplify, xf, size, axes]);
  let geo = state.previews.get(key);
  if (!geo) {
    geo = reskinGeometry(state.welded, facesOfParts(state.faceLabels, parts), { simplify, xf, size, axes });
    if (state.previews.size > 24) state.previews.clear();
    state.previews.set(key, geo);
  }
  return { position: geo.position.slice(), normal: geo.normal.slice(), uv: geo.uv.slice(), index: geo.index.slice() };
}

/**
 * Resize to fit maxSize and re-encode in the browser (no extra libraries).
 * WebP normally; JPEG in compatibility mode for viewers without EXT_texture_webp.
 */
async function encodeTexture(bytes, mime, maxSize, { quality = 0.85, type = 'image/webp' } = {}) {
  const blob = new Blob([bytes], { type: mime });
  const size = ImageUtils.getSize(bytes, mime);
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const scale = size ? Math.min(1, maxSize / Math.max(size[0], size[1])) : 1;
  const bmp = scale < 1
    ? await createImageBitmap(blob, { ...opts, resizeWidth: Math.round(size[0] * scale), resizeHeight: Math.round(size[1] * scale), resizeQuality: 'high' })
    : await createImageBitmap(blob, opts);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const out = await canvas.convertToBlob({ type, quality });
  const data = new Uint8Array(await out.arrayBuffer());
  return { bytes: type === 'image/webp' ? stripWebPProfile(data) : data, mimeType: type };
}

/** Outer size of a variant in mm: W and D along the furniture axes, H up (the document is in metres by now). */
function outerSizeMm(doc, axes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes())
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const lo = pos.getMin([]), hi = pos.getMax([]);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], lo[k]); max[k] = Math.max(max[k], hi[k]); }
    }
  const mm = (k) => Math.round((max[k] - min[k]) * 1000);
  return { w: mm(axes.w), d: mm(axes.d), h: mm(1) };
}

/**
 * Write one GLB per combination of choices.
 * args: { names, xf, axes, quality: { simplify, keepSimplify }, keptTextureSize, meshopt, compat,
 *         groups: [{ key, name, parts }],
 *         variants: [[{ group, def | null, color, rotate, size: { w, d } | null }]],  (def null = keep the original look)
 *         textures: { path: Uint8Array } }
 * The file is in metres (xf), standing on the floor.
 */
async function exportVariants(args, progress, sendFile) {
  const io = await getIO();
  const T = timer();
  const { groups, variants, textures } = args;
  progress('원본 다시 읽는 중', 0.02);
  const doc = await io.readBinary(state.bytes);
  await plainFloats(doc);
  T.mark('read');
  const { prim, mesh } = mainPrimitive(doc);
  const analysis = { prim, mesh, world: meshWorldMatrix(doc, mesh), welded: state.welded, faceLabels: state.faceLabels, axes: args.axes };
  progress('모양 정리 중', 0.06);
  const ctx = prepareOutput(doc, analysis, args.xf, groups, { ...DEFAULTS, ...args.quality });
  T.mark('rest');

  // every option (group × material or original look × size) is built once and reused
  const optKey = (c) => `${c.group}|${c.def ? 'skin' : 'keep'}|${c.size ? `${c.size.w ?? ''}x${c.size.d ?? ''}` : ''}`;
  const built = new Map();
  const needed = [...new Map(variants.flat().map((c) => [optKey(c), c])).values()];
  for (let i = 0; i < needed.length; i++) {
    const c = needed[i];
    progress(`부분 모양 만드는 중 ${i + 1}/${needed.length}`, 0.08 + (0.12 * i) / needed.length);
    built.set(optKey(c), groupPrimitive(ctx, groups.find((g) => g.key === c.group), { reskin: !!c.def, size: c.size }));
  }
  releaseSource(ctx);
  T.mark('geometry');
  progress('원본 텍스처 압축 중', 0.2);
  const texType = args.compat ? 'image/jpeg' : 'image/webp';
  await compressKeptTextures(doc, (b, m, s) => encodeTexture(b, m, s, { type: texType, quality: args.compat ? 0.9 : 0.85 }), args.keptTextureSize || DEFAULTS.keptTextureSize);
  T.mark('kept textures');

  // library textures are WebP; compatibility mode turns them into JPEG once
  const converted = new Map();
  const loadImage = async (path) => {
    const b = textures[path];
    if (!b) throw new Error(`텍스처가 없어요: ${path}`);
    if (!args.compat || !path.endsWith('.webp')) return b;
    if (!converted.has(path)) {
      const out = await encodeTexture(b, 'image/webp', 8192, { type: 'image/jpeg', quality: 0.92 });
      converted.set(path, { bytes: out.bytes, mime: out.mimeType });
    }
    return converted.get(path);
  };
  const cache = new Map(), files = [];
  for (let i = 0; i < variants.length; i++) {
    const combo = variants[i];
    progress(`변형 ${i + 1}/${variants.length} 만드는 중`, 0.25 + (0.75 * i) / variants.length);
    const parts = combo.map((c) => built.get(optKey(c)));
    setVariant(ctx, parts);
    const made = [];
    for (let k = 0; k < combo.length; k++) {
      const c = combo[k];
      if (!c.def || !parts[k]) continue;
      const { mat, def } = await createMaterial(doc, c.def, c.color, loadImage, cache);
      applyToGroup(doc, parts[k], mat, def, { rotate: c.rotate || 0 });
      made.push(mat);
    }
    T.mark(`variant ${i + 1} materials`);
    const bytes = await encodeVariant(io, doc, { meshopt: args.meshopt !== false });
    T.mark(`variant ${i + 1} encode`);
    const name = args.names[i];
    const sizeMm = outerSizeMm(doc, args.axes);
    sendFile({ name, bytes, sizeMm });
    files.push({ name, size: bytes.byteLength, sizeMm });
    made.forEach((m) => m.dispose());
  }
  progress('완료', 1);
  return { files, timings: T.done() };
}

const handlers = {
  open: (args, progress) => open(args, progress),
  segment: (args) => runSegment(args),
  cut: (args) => cut(args),
  preview: (args) => preview(args),
  export: (args, progress, sendFile) => exportVariants(args, progress, sendFile),
};

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  const progress = (text, frac) => self.postMessage({ id, progress: { text, frac } });
  const sendFile = (file) => self.postMessage({ id, file }, [file.bytes.buffer]);
  try {
    await ready;
    const result = await handlers[cmd](args, progress, sendFile);
    const transfer = [];
    const collect = (o) => {
      if (!o || typeof o !== 'object') return;
      if (ArrayBuffer.isView(o)) { if (!transfer.includes(o.buffer)) transfer.push(o.buffer); return; }
      for (const v of Object.values(o)) collect(v);
    };
    collect(result);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
