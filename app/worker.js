// Background worker: everything heavy (reading the GLB, finding parts, building
// geometry, writing variant files) runs here so the screen never freezes.
//
// Messages in:  { id, cmd, args }
// Messages out: { id, ok: true, result } | { id, ok: false, error } | { id, progress: { text, frac } }
//               | { id, file: { name, bytes } } while exporting
import { ImageUtils, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import {
  DEFAULTS, applyToGroup, buildGroups, compressKeptTextures, createMaterial, encodeVariant,
  facesOfParts, mainPrimitive, reskinGeometry, weldedPositions,
} from '../core/skin.js';
import { adjacency, segment, uniqueEdges, valleyCurvature, vertexNormals } from '../core/segment.js';
import { stripWebPProfile } from './webp.js';

const ready = Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
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

async function getIO() {
  await ready;
  io ??= new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
  });
  return io;
}

function bboxOf(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min, max };
}

async function open({ bytes }, progress) {
  const io = await getIO();
  const T = timer();
  progress('파일 읽는 중', 0.05);
  const doc = await io.readBinary(new Uint8Array(bytes));
  T.mark('read');
  const { prim } = mainPrimitive(doc);
  const indexCount = prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount();
  const textures = doc.getRoot().listTextures().map((t) => {
    const size = t.getSize();
    return { name: t.getName() || t.getURI(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength || 0, width: size?.[0] || 0, height: size?.[1] || 0 };
  });
  progress('모양 정리 중', 0.2);
  const welded = weldedPositions(doc, prim);
  T.mark('weld');
  progress('경계 찾는 중', 0.4);
  const nv = welded.pos.length / 3;
  const edges = uniqueEdges(welded.index, nv);
  const adj = adjacency(edges.ea, edges.eb, nv);
  T.mark('edges');
  const curvature = valleyCurvature(welded.pos, adj, edges, vertexNormals(welded.pos, welded.index, nv), DEFAULTS.segment.smoothIters);
  T.mark('curvature');
  Object.assign(state, { bytes: new Uint8Array(bytes), welded, edges, adj, curvature, previews: new Map() });
  progress('부분 나누는 중', 0.75);
  const seg = runSegment({});
  T.mark('segment');
  return {
    timings: T.done(),
    info: {
      triangles: indexCount / 3, vertices: prim.getAttribute('POSITION').getCount(), weldedVertices: nv,
      indexCount, textures, bbox: bboxOf(welded.pos),
      materials: doc.getRoot().listMaterials().length, meshes: doc.getRoot().listMeshes().length,
    },
    welded: { pos: welded.pos.slice(), index: welded.index.slice() },
    ...seg,
  };
}

function runSegment(opts) {
  const { welded, edges, adj, curvature } = state;
  const seg = segment(welded.pos, welded.index, { ...DEFAULTS.segment, ...opts, edges, adj, curvature });
  state.faceLabels = seg.faceLabels;
  state.previews = new Map();
  return {
    faceLabels: seg.faceLabels.slice(),
    parts: seg.parts.map(({ id, areaPct, faces, min, max }) => ({ id, areaPct, faces, min, max })),
  };
}

/** Geometry for the live preview of a re-skinned group (same code path as the export). */
function preview({ parts, simplify }) {
  const key = `${[...parts].sort((a, b) => a - b).join(',')}|${simplify}`;
  let geo = state.previews.get(key);
  if (!geo) {
    geo = reskinGeometry(state.welded, facesOfParts(state.faceLabels, parts), { simplify });
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

/**
 * Write one GLB per combination of choices.
 * args: { names, widthMm, quality: { simplify, keepSimplify }, keptTextureSize, meshopt, compat,
 *         groups: [{ key, name, parts }], variants: [[{ group, def, color, rotate }]], textures: { path: Uint8Array } }
 */
async function exportVariants(args, progress, sendFile) {
  const io = await getIO();
  const T = timer();
  const { groups, variants, textures } = args;
  progress('원본 다시 읽는 중', 0.02);
  const doc = await io.readBinary(state.bytes);
  T.mark('read');
  const { prim, mesh } = mainPrimitive(doc);
  const analysis = { prim, mesh, welded: state.welded, faceLabels: state.faceLabels };
  progress('모양 정리 중', 0.08);
  const built = buildGroups(doc, analysis, groups.map((g) => ({ name: g.key, parts: g.parts, reskin: true })), {
    ...DEFAULTS, ...args.quality, widthMm: args.widthMm,
  });
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
    const made = [];
    for (const choice of combo) {
      const g = built.find((x) => x.name === choice.group);
      const { mat, def } = await createMaterial(doc, choice.def, choice.color, loadImage, cache);
      applyToGroup(doc, g, mat, def, { rotate: choice.rotate || 0 });
      made.push(mat);
    }
    T.mark(`variant ${i + 1} materials`);
    const bytes = await encodeVariant(io, doc, { meshopt: args.meshopt !== false });
    T.mark(`variant ${i + 1} encode`);
    const name = args.names[i];
    sendFile({ name, bytes });
    files.push({ name, size: bytes.byteLength });
    made.forEach((m) => m.dispose());
  }
  progress('완료', 1);
  return { files, timings: T.done() };
}

const handlers = {
  open: (args, progress) => open(args, progress),
  segment: (args) => runSegment(args),
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
