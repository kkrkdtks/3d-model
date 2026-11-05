// Background worker: everything heavy (reading the GLB, finding parts, building
// geometry, writing variant files) runs here so the screen never freezes.
//
// Messages in:  { id, cmd, args }
// Messages out: { id, ok: true, result } | { id, ok: false, error } | { id, progress: { text, frac } }
//               | { id, file: { name, bytes, sizeMm, qc } } while exporting
import { ImageUtils, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import {
  DEFAULTS, applyToGroup, baseColorSource, compressKeptTextures, createMaterial, cutPart, encodeVariant,
  faceColors, facesOfParts, GLOSS_FAIR, groupPrimitive, isGlossy, partStats, plainFloats, prepareOutput,
  colorLabel, hexToLinear, releaseSource, reskinGeometry, setVariant, srgbToLinear, stampGlb, triangleSources, weldedSources,
} from '../core/skin.js';
import { adjacency, segment, undersideHeight, uniqueEdges, valleyCurvature, vertexColors, vertexNormals } from '../core/segment.js';
import { bboxOf, furnitureAxes } from '../core/size.js';
import { stripWebPProfile } from './webp.js';
import { validateBytes } from 'gltf-validator';

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
  checkOpenable(new Uint8Array(bytes));
  const doc = await io.readBinary(new Uint8Array(bytes));
  T.mark('read');
  await plainFloats(doc);
  // every triangle primitive: one in a 3DAISTUDIO file, several in a file made with this program
  const sources = triangleSources(doc);
  const faceCount = sources.reduce((a, s) => a + s.faceCount, 0);
  const textures = doc.getRoot().listTextures().map((t) => {
    const size = t.getSize();
    return { name: t.getName() || t.getURI(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength || 0, width: size?.[0] || 0, height: size?.[1] || 0 };
  });
  // the colour textures decode on another thread while the shape is worked out; it needs this
  // thread for a moment to start and to finish, hence the short breaks below
  const colorImages = readLooks(sources).catch((e) => { console.warn('색을 읽지 못했어요', e); return null; });
  await pause();
  progress('모양 정리 중', 0.2);
  // scene ("world") units: 3DAISTUDIO lifts the mesh onto the floor with a node offset
  const welded = weldedSources(doc, sources);
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
  const looks = (await colorImages) || sources.map(() => ({ pixels: null, factor: [1, 1, 1], glow: false }));
  T.mark('color image');
  const faces = faceLooks(sources, looks, faceCount);
  const color = faces && vertexColors(welded.index, faces.rgb, nv, adj);
  T.mark('color');
  const faceSource = new Uint16Array(faceCount);
  sources.forEach((s, i) => faceSource.fill(i, s.faceOffset, s.faceOffset + s.faceCount));
  Object.assign(state, {
    bytes: new Uint8Array(bytes), welded, edges, adj, curvature, color, faceRGB: faces?.rgb || null, faceTex: faces?.tex || null,
    faceSource, made: sources.map((s) => s.made), looks: looks.map(({ glow, factor, pixels }) => ({ glow, factor, tex: !!pixels })),
    faceArea: null, previews: new Map(),
  });
  progress('부분 나누는 중', 0.75);
  const seg = runSegment(segOpts);
  T.mark('segment');
  return {
    timings: T.done(),
    info: {
      triangles: faceCount, vertices: sources.reduce((a, s) => a + s.prim.getAttribute('POSITION').getCount(), 0), weldedVertices: nv,
      // the pieces in face order, so the screen finds the same ones in its copy of the file
      sources: sources.map((s) => ({ indexCount: s.faceCount * 3, vertexCount: s.prim.getAttribute('POSITION').getCount() })),
      textures, bbox: bboxOf(welded.pos), underside: undersideHeight(welded.pos, welded.index),
      materials: doc.getRoot().listMaterials().length, meshes: doc.getRoot().listMeshes().length,
    },
    axes: furnitureAxes(welded.pos),
    welded: { pos: welded.pos.slice(), index: welded.index.slice() },
    ...seg,
  };
}

/**
 * What each source looks like: its colour texture read at 1024² (fine enough to tell a wooden
 * base from the fabric, coarse enough to ignore the weave) as { pixels (RGBA), size, texCoord },
 * the colour factor it is multiplied by (linear), and glow: the look is in the glow (emissive)
 * texture of a "shaded" export. A texture used by several sources is read once.
 */
async function readLooks(sources) {
  const decoded = new Map();
  return Promise.all(sources.map(async (s) => {
    const mat = s.prim.getMaterial();
    const src = baseColorSource(s.prim);
    const glow = !!(src && mat && !mat.getBaseColorTexture());
    const factor = !mat ? [1, 1, 1] : glow ? mat.getEmissiveFactor().slice(0, 3) : mat.getBaseColorFactor().slice(0, 3);
    if (!src) return { pixels: null, factor, glow: false };
    if (!decoded.has(src.image)) decoded.set(src.image, decodeImage(src.image, src.mime));
    return { pixels: await decoded.get(src.image), size: 1024, texCoord: src.texCoord, factor, glow };
  }));
}

async function decodeImage(bytes, mime) {
  const N = 1024, opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const ctx = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  // ImageDecoder keeps decoding on its own thread while this one is busy, and reads a JPEG
  // straight at the smaller size; createImageBitmap only gets on with it when this thread is free
  if (self.ImageDecoder && await ImageDecoder.isTypeSupported(mime)) {
    const decoder = new ImageDecoder({ data: bytes, type: mime, desiredWidth: N, desiredHeight: N, ...opts });
    try {
      const { image } = await decoder.decode();
      ctx.drawImage(image, 0, 0, N, N);
      image.close();
    } finally {
      decoder.close();
    }
  } else {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { ...opts, resizeWidth: N, resizeHeight: N, resizeQuality: 'high' });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }
  return ctx.getImageData(0, 0, N, N).data;
}

/**
 * Colour under every triangle (8-bit sRGB, 3 per face, all sources in face order): tex is the
 * texture alone (white without one), rgb what the surface shows (texture × colour factor).
 * null for a single piece without any texture (nothing to tell apart by colour).
 */
function faceLooks(sources, looks, faceCount) {
  if (sources.length === 1 && !looks[0].pixels) return null;
  const tex = new Uint8Array(faceCount * 3).fill(255), rgb = new Uint8Array(faceCount * 3);
  sources.forEach((s, i) => {
    const L = looks[i], o = s.faceOffset * 3, n = s.faceCount * 3;
    if (L.pixels) tex.set(faceColors(s.prim, L.texCoord, L.pixels, L.size, L.size), o);
    const f = L.factor;
    if (f.every((c) => Math.abs(c - 1) < 1e-4)) { rgb.set(tex.subarray(o, o + n), o); return; }
    for (let k = 0; k < n; k += 3)
      for (let c = 0; c < 3; c++) rgb[o + k + c] = SRGB8[Math.min(4096, Math.round(LIN[tex[o + k + c]] * f[c] * 4096))];
  });
  return { tex, rgb };
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
 * in metres in the output frame (xf), resized when size is given, evened out for a glossy finish.
 */
function preview({ parts, simplify, xf, size, sizeBox = null, hold = null, minY = null, axes, gloss = false }) {
  const key = JSON.stringify([[...parts].sort((a, b) => a - b), simplify, xf, size, sizeBox, hold, minY, axes, !!gloss]);
  let geo = state.previews.get(key);
  if (!geo) {
    const faces = facesOfParts(state.faceLabels, parts);
    // pieces this program wrote were simplified when they were saved: not again (as in the export)
    const made = faces.length > 0 && faces.every((f) => state.made[state.faceSource[f]]);
    geo = reskinGeometry(state.welded, faces, { simplify: made ? 1 : simplify, xf, size, sizeBox, hold, minY, axes, gloss: gloss ? GLOSS_FAIR : false });
    if (state.previews.size > 24) state.previews.clear();
    state.previews.set(key, geo);
  }
  return { position: geo.position.slice(), normal: geo.normal.slice(), uv: geo.uv.slice(), uvFold: geo.uvFold.slice(), index: geo.index.slice() };
}

const LIN = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const toSrgb8 = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
// linear -> 8-bit sRGB, fine enough steps for dark colours
const SRGB8 = Uint8Array.from({ length: 4097 }, (_, i) => toSrgb8(i / 4096));

/**
 * The look of some parts in their own texture, for "original texture, new colour", per source
 * piece they come from (each has its own texture): lum = the texture's typical brightness
 * (linear luminance; area-weighted median, so a dark edge band or a lighter trim does not move
 * the main surface off the chosen colour; with baked light, the lit side: 70th percentile);
 * hex = the average colour shown near that brightness (texture × colour factor).
 * Returns { hex, lum (of the biggest piece), sources: [{ source, hex, lum, tex, glow, area }] },
 * or null without colour information.
 */
function groupColor({ parts }) {
  const { faceTex, faceRGB, faceLabels, faceSource, welded, looks } = state;
  if (!faceTex) return null;
  if (!state.faceArea) {
    const { pos, index } = welded, nf = index.length / 3, area = new Float32Array(nf);
    for (let f = 0; f < nf; f++) {
      const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      area[f] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    state.faceArea = area;
  }
  const want = new Set(parts), area = state.faceArea;
  // brightness histograms per source (square-root steps: fine resolution for dark fabrics too)
  const BINS = 2048, per = new Map();
  const lumOf = (f) => 0.2126 * LIN[faceTex[f * 3]] + 0.7152 * LIN[faceTex[f * 3 + 1]] + 0.0722 * LIN[faceTex[f * 3 + 2]];
  const binOf = (l) => Math.min(BINS - 1, Math.floor(Math.sqrt(l) * BINS));
  for (let f = 0; f < faceLabels.length; f++) {
    if (!want.has(faceLabels[f])) continue;
    const s = faceSource[f];
    if (!per.has(s)) per.set(s, { hist: new Float64Array(BINS), total: 0 });
    const e = per.get(s);
    e.hist[binOf(lumOf(f))] += area[f];
    e.total += area[f];
  }
  const out = [];
  for (const [s, { hist, total }] of per) {
    if (!total) continue;
    const q = (looks[s].glow ? 0.7 : 0.5) * total;
    let acc = 0, mid = 0;
    while (mid < BINS - 1 && acc + hist[mid] < q) acc += hist[mid++];
    const lum = (((mid + (q - acc) / (hist[mid] || 1)) / BINS) ** 2) || 1e-4;
    // average colour shown by the faces within about ±25 % of that brightness
    let r = 0, g = 0, b = 0, w = 0;
    for (let f = 0; f < faceLabels.length; f++) {
      if (faceSource[f] !== s || !want.has(faceLabels[f])) continue;
      const l = lumOf(f);
      if (l < lum * 0.75 || l > lum * 1.25) continue;
      const a = area[f];
      r += a * LIN[faceRGB[f * 3]]; g += a * LIN[faceRGB[f * 3 + 1]]; b += a * LIN[faceRGB[f * 3 + 2]]; w += a;
    }
    if (w) { r /= w; g /= w; b /= w; } else { const fa = looks[s].factor; r = lum * fa[0]; g = lum * fa[1]; b = lum * fa[2]; }
    const hex = `#${[r, g, b].map((c) => toSrgb8(Math.min(1, c)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    out.push({ source: s, hex, lum, tex: looks[s].tex, glow: looks[s].glow, area: total });
  }
  if (!out.length) return null;
  const main = out.reduce((a, e) => (e.area > a.area ? e : a));
  return { hex: main.hex, lum: main.lum, sources: out };
}

/**
 * The original texture in a new colour: each pixel keeps its brightness relative to the part's
 * average (folds, grain and shading stay), the colour comes from factor (target / average
 * brightness, linear). Same formula as the screen preview (viewer recolorMaterial).
 */
async function recolorTexture(bytes, mime, factor, maxSize, { type, quality }) {
  const size = ImageUtils.getSize(bytes, mime);
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const scale = size ? Math.min(1, maxSize / Math.max(size[0], size[1])) : 1;
  const blob = new Blob([bytes], { type: mime });
  const bmp = scale < 1
    ? await createImageBitmap(blob, { ...opts, resizeWidth: Math.round(size[0] * scale), resizeHeight: Math.round(size[1] * scale), resizeQuality: 'high' })
    : await createImageBitmap(blob, opts);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g2 = canvas.getContext('2d', { willReadFrequently: true });
  g2.drawImage(bmp, 0, 0);
  bmp.close();
  const img = g2.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
  const [fr, fg, fb] = factor.map((f) => f * 4096);
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.2126 * LIN[px[i]] + 0.7152 * LIN[px[i + 1]] + 0.0722 * LIN[px[i + 2]];
    px[i] = SRGB8[Math.min(4096, Math.round(fr * lum))];
    px[i + 1] = SRGB8[Math.min(4096, Math.round(fg * lum))];
    px[i + 2] = SRGB8[Math.min(4096, Math.round(fb * lum))];
  }
  g2.putImageData(img, 0, 0);
  const out = await canvas.convertToBlob({ type, quality });
  const data = new Uint8Array(await out.arrayBuffer());
  return { bytes: type === 'image/webp' ? stripWebPProfile(data) : data, mimeType: type };
}

/**
 * Resize to fit maxSize and re-encode in the browser (no extra libraries).
 * WebP normally; JPEG in compatibility mode for viewers without EXT_texture_webp.
 * keepIfFits: a texture already in that format and size comes back as null (kept as it is):
 * a file made with this program is not encoded again each time it is opened and saved.
 */
async function encodeTexture(bytes, mime, maxSize, { quality = 0.85, type = 'image/webp', keepIfFits = false } = {}) {
  const blob = new Blob([bytes], { type: mime });
  const size = ImageUtils.getSize(bytes, mime);
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  const scale = size ? Math.min(1, maxSize / Math.max(size[0], size[1])) : 1;
  if (keepIfFits && mime === type && size && scale === 1) return null;
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

// compressions this program cannot read (it reads meshopt, WebP, JPEG and PNG): said plainly
// instead of the reader's own error ("Cannot read properties of undefined ...")
const UNREADABLE = {
  KHR_draco_mesh_compression: 'Draco로 압축된 GLB라서 열 수 없어요',
  KHR_texture_basisu: 'KTX2(Basis) 텍스처를 쓰는 GLB라서 열 수 없어요',
};

/** Throws, in plain words, when the bytes are not a GLB this program can open. */
function checkOpenable(bytes) {
  let json;
  try {
    ({ json } = glbChunks(bytes));
  } catch {
    throw new Error('GLB 파일이 아니거나 파일이 깨졌어요. 3DAISTUDIO에서 받은 .glb 파일을 다시 내려받아 열어 주세요.');
  }
  for (const name of json.extensionsRequired || [])
    if (UNREADABLE[name]) throw new Error(`${UNREADABLE[name]}. 3DAISTUDIO에서 받은 원본이나 이 프로그램으로 저장한 GLB를 열어 주세요.`);
}

/** The JSON chunk and the binary chunk of a GLB. */
function glbChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB 파일이 아니에요.');
  let o = 12, json = null, bin = null;
  while (o + 8 <= bytes.byteLength) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const chunk = bytes.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB 안에 JSON이 없어요.');
  return { json, bin };
}

/**
 * What a written file holds, read back from its bytes (so it is what any viewer will see):
 * triangles, vertices, primitives, materials, images (size and format), extensions.
 */
function glbStats(bytes) {
  const { json, bin } = glbChunks(bytes);
  const acc = json.accessors || [];
  let triangles = 0, vertices = 0, primitives = 0;
  for (const m of json.meshes || [])
    for (const p of m.primitives || []) {
      const mode = p.mode ?? 4, n = p.indices != null ? acc[p.indices]?.count || 0 : acc[p.attributes?.POSITION]?.count || 0;
      primitives++;
      if (mode === 4) triangles += n / 3;
      else if (mode === 5 || mode === 6) triangles += Math.max(0, n - 2);
      vertices += acc[p.attributes?.POSITION]?.count || 0;
    }
  const images = (json.images || []).map((im) => {
    const bv = json.bufferViews?.[im.bufferView];
    const data = bv && bin ? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) : null;
    const size = (data && ImageUtils.getSize(data, im.mimeType)) || [0, 0];
    return { mime: im.mimeType || '', width: size[0], height: size[1], bytes: bv?.byteLength || 0 };
  });
  return {
    bytes: bytes.byteLength, triangles: Math.round(triangles), vertices, primitives,
    meshes: (json.meshes || []).length, nodes: (json.nodes || []).length, materials: (json.materials || []).length,
    textures: (json.textures || []).length, images, animations: (json.animations || []).length,
    extensionsUsed: json.extensionsUsed || [], extensionsRequired: json.extensionsRequired || [],
  };
}

/** Khronos glTF validator on the written bytes: { errors, warnings, infos, messages: [{ severity, code, message, pointer }] }. */
async function validateGlb(bytes) {
  // tangents are left to the viewer (three.js, model-viewer and Babylon derive them), so that warning is not news
  const r = await validateBytes(bytes, { maxIssues: 30, ignoredIssues: ['MESH_PRIMITIVE_GENERATED_TANGENT_SPACE'] });
  const i = r.issues;
  return {
    errors: i.numErrors, warnings: i.numWarnings, infos: i.numInfos, hints: i.numHints,
    messages: (i.messages || []).filter((m) => m.severity <= 1).slice(0, 12).map((m) => ({ severity: m.severity, code: m.code, message: m.message, pointer: m.pointer || '' })),
    validator: r.validatorVersion || '',
  };
}

/** Both checks on a written file; a failure in the validator itself is reported, not thrown. */
async function inspectGlb(bytes) {
  const stats = glbStats(bytes);
  let check;
  try { check = await validateGlb(bytes); } catch (e) { check = { failed: String(e?.message || e) }; }
  return { ...stats, check };
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
 *         groups: [{ key, name, parts, sizeBox?, hold?, minY?, colorFrom? }],  (pieces, see core/size outputPieces:
 *           sizeBox = box in metres the resize is measured on, hold / minY in metres, colorFrom = parts the
 *           original colour is measured on)
 *         variants: [[{ group, def | null, color, rotate, size: { w, d } | null }]],  (def null = keep the original look)
 *         textures: { path: Uint8Array } }
 * The file is in metres (xf), standing on the floor.
 */
async function exportVariants(args, progress, sendFile) {
  const io = await getIO();
  const T = timer();
  const { groups, variants, textures } = args;
  const avoid = new Set(args.avoidSizes || []); // byte sizes of files saved before from this model
  progress('원본 다시 읽는 중', 0.02);
  const doc = await io.readBinary(state.bytes);
  await plainFloats(doc);
  T.mark('read');
  const sources = triangleSources(doc);
  if (sources.reduce((a, s) => a + s.faceCount, 0) !== state.faceLabels.length) throw new Error('열어 둔 모델과 내용이 달라요. 파일을 다시 열어 주세요.');
  const analysis = { sources, welded: state.welded, faceLabels: state.faceLabels, axes: args.axes };
  // "original texture, new colour" works on the texture that carries each piece's look (colour,
  // or glow in shaded exports), read before the kept textures are compressed
  const looks = sources.map((s) => {
    const mat = s.prim.getMaterial(), look = baseColorSource(s.prim);
    return { mat, image: look ? { bytes: look.image, mime: look.mime } : null, slot: !mat ? 'none' : look ? (mat.getBaseColorTexture() ? 'baseColor' : 'emissive') : 'flat' };
  });
  progress('모양 정리 중', 0.06);
  const ctx = prepareOutput(doc, analysis, args.xf, groups, { ...DEFAULTS, ...args.quality });
  T.mark('rest');

  // every option (group × material or original look × size) is built once and reused
  const reskin = (c) => !!c.def && !c.def.recolor;
  const gloss = (c) => reskin(c) && isGlossy(c.def);
  const optKey = (c) => `${c.group}|${reskin(c) ? (gloss(c) ? 'gloss' : 'skin') : 'keep'}|${c.size ? `${c.size.w ?? ''}x${c.size.d ?? ''}` : ''}`;
  const built = new Map();
  const needed = [...new Map(variants.flat().map((c) => [optKey(c), c])).values()];
  for (let i = 0; i < needed.length; i++) {
    const c = needed[i];
    progress(`부분 모양 만드는 중 ${i + 1}/${needed.length}`, 0.08 + (0.12 * i) / needed.length);
    built.set(optKey(c), groupPrimitive(ctx, groups.find((g) => g.key === c.group), { reskin: reskin(c), size: c.size, gloss: gloss(c) }));
  }
  releaseSource(ctx);
  T.mark('geometry');
  progress('원본 텍스처 압축 중', 0.2);
  const texType = args.compat ? 'image/jpeg' : 'image/webp';
  await compressKeptTextures(doc, (b, m, s) => encodeTexture(b, m, s, { type: texType, quality: args.compat ? 0.9 : 0.85, keepIfFits: true }), args.keptTextureSize || DEFAULTS.keptTextureSize);
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
  // the recoloured texture of a group, colour and source piece is made once; its material and
  // texture are added for each variant that uses it and dropped after, so no file carries
  // another variant's texture
  const recolored = new Map(), stats = new Map();
  const recolor = async (c, si) => {
    const L = looks[si];
    if (!L.mat) return null;
    const key = `${c.group}|${c.color.hex}|${si}`;
    if (!recolored.has(key)) {
      // measured on the whole group the look comes from (a piece split off for resizing included)
      if (!stats.has(c.group)) { const g = groups.find((x) => x.key === c.group); stats.set(c.group, groupColor({ parts: g.colorFrom || g.parts })); }
      const st = L.image && (L.slot === 'baseColor' || L.slot === 'emissive') ? stats.get(c.group)?.sources.find((e) => e.source === si) : null;
      const target = hexToLinear(c.color.hex);
      const out = st ? await recolorTexture(L.image.bytes, L.image.mime, target.map((t) => t / Math.max(st.lum, 1e-4)),
        args.keptTextureSize || DEFAULTS.keptTextureSize, { type: texType, quality: args.compat ? 0.9 : 0.85 }) : null;
      recolored.set(key, { target, out });
    }
    const { target, out } = recolored.get(key);
    const alpha = L.mat.getBaseColorFactor()[3];
    const mat = L.mat.clone().setName(`원래 질감 ${colorLabel(c.color)}`);
    let tex = null;
    if (!out) {
      mat.setBaseColorTexture(null).setBaseColorFactor([...target, alpha]);
    } else {
      const uri = `recolor_${c.color.hex.replace('#', '')}${si ? `_${si}` : ''}${out.mimeType === 'image/webp' ? '.webp' : '.jpg'}`;
      tex = doc.createTexture(uri).setImage(out.bytes).setMimeType(out.mimeType).setURI(uri);
      if (L.slot === 'baseColor') mat.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, alpha]);
      else mat.setEmissiveTexture(tex).setEmissiveFactor([1, 1, 1]);
    }
    mat.setExtras({ ...(L.mat.getExtras() || {}), material: 'original', color: c.color.name || c.color.hex, colorHex: c.color.hex });
    return { mat, tex };
  };
  const cache = new Map(), files = [];
  for (let i = 0; i < variants.length; i++) {
    const combo = variants[i];
    progress(`변형 ${i + 1}/${variants.length} 만드는 중`, 0.25 + (0.75 * i) / variants.length);
    const parts = combo.map((c) => built.get(optKey(c)));
    setVariant(ctx, parts);
    const made = [], madeTex = [];
    for (let k = 0; k < combo.length; k++) {
      const c = combo[k];
      if (!parts[k]) continue;
      // kept triangles are shared by the original look and every new colour of this group
      const own = parts[k].sources || [];
      if (!c.def) { own.forEach((s, j) => { if (s.material) parts[k].prims[j].setMaterial(s.material); }); continue; }
      if (c.def.recolor) {
        if (!c.color?.hex) continue;
        for (let j = 0; j < own.length; j++) {
          const r = await recolor(c, sources.indexOf(own[j]));
          if (!r) continue;
          parts[k].prims[j].setMaterial(r.mat);
          made.push(r.mat);
          if (r.tex) madeTex.push(r.tex);
        }
        continue;
      }
      const { mat, def } = await createMaterial(doc, c.def, c.color, loadImage, cache);
      applyToGroup(doc, parts[k], mat, def, { rotate: c.rotate || 0 });
      made.push(mat);
    }
    T.mark(`variant ${i + 1} materials`);
    const name = args.names[i];
    const liftMm = Math.max(0, +args.liftMm || 0);
    // a note on how it was made; never the byte size of a file saved before from this model (see stampGlb)
    const bytes = stampGlb(await encodeVariant(io, doc, { meshopt: args.meshopt !== false, liftM: liftMm / 1000 }),
      { app: args.app || '가구 스킨 스튜디오', savedAt: new Date().toISOString(), floorGapMm: liftMm, file: name }, avoid);
    avoid.add(bytes.byteLength);
    T.mark(`variant ${i + 1} encode`);
    const sizeMm = outerSizeMm(doc, args.axes);
    // what the file holds, read back from the bytes, and the Khronos validator's verdict
    progress(`변형 ${i + 1}/${variants.length} 검사 중`, 0.25 + (0.75 * (i + 0.8)) / variants.length);
    const qc = args.inspect === false ? null : await inspectGlb(bytes).catch((e) => ({ failed: String(e?.message || e) }));
    T.mark(`variant ${i + 1} check`);
    const size = bytes.byteLength; // read before sendFile hands the buffer over (it is empty after)
    sendFile({ name, bytes, sizeMm, qc });
    files.push({ name, size, sizeMm, qc });
    made.forEach((m) => m.dispose());
    madeTex.forEach((t) => t.dispose());
  }
  progress('완료', 1);
  return { files, timings: T.done() };
}

const handlers = {
  open: (args, progress) => open(args, progress),
  segment: (args) => runSegment(args),
  cut: (args) => cut(args),
  preview: (args) => preview(args),
  groupColor: (args) => groupColor(args),
  export: (args, progress, sendFile) => exportVariants(args, progress, sendFile),
  inspect: ({ bytes }) => inspectGlb(new Uint8Array(bytes)),
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
