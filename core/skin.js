// Re-skin a 3DAISTUDIO furniture GLB: split it into parts, give chosen parts a
// tiling PBR material (leather, fabric, ...) in a chosen colour, keep the rest
// as generated, and write one compact GLB per variant.
//
// Environment-agnostic: callers pass a gltf-transform IO and a function that
// loads material texture files (fs in Node, fetch in the browser).

import { Document } from '@gltf-transform/core';
import {
  cloneDocument, compactPrimitive, dequantize, prune, quantize, reorder, simplifyPrimitive, transformMesh,
  transformPrimitive, weldPrimitive,
} from '@gltf-transform/functions';
import {
  EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsSheen, KHRMeshQuantization,
} from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { segment, vertexNormals } from './segment.js';
import { boxUV } from './uvbox.js';
import {
  bboxOf, fitToBox, furnitureAxes, mulMat4, stretchFor, stretchGeometry, transformPositions, xfMatrix,
} from './size.js';

export const DEFAULTS = {
  segment: { threshold: 60, dilate: 4, minArea: 0.002, smoothIters: 5 },
  simplify: 0.25,      // triangles kept on re-skinned parts (their old UVs are dropped, so this stays clean)
  keepSimplify: 0.35,  // triangles kept on parts that stay as generated (old UVs must survive)
  error: 0.001,
  keptTextureSize: 4096,
};

/** The biggest triangle primitive: 3DAISTUDIO puts the whole model in one. */
export function mainPrimitive(doc) {
  let best = null, bestCount = -1, bestMesh = null;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const n = prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount();
      if (prim.getMode() === 4 && n > bestCount) { best = prim; bestCount = n; bestMesh = mesh; }
    }
  if (!best) throw new Error('삼각형 메시를 찾지 못했어요.');
  return { prim: best, mesh: bestMesh };
}

function floatArray(accessor) {
  const a = accessor.getArray();
  if (a instanceof Float32Array && !accessor.getNormalized()) return a;
  const out = new Float32Array(accessor.getCount() * accessor.getElementSize()), el = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, el);
    out.set(el, i * el.length);
  }
  return out;
}

function indexArray(prim) {
  const idx = prim.getIndices();
  if (idx) return Uint32Array.from(idx.getArray());
  return Uint32Array.from({ length: prim.getAttribute('POSITION').getCount() }, (_, i) => i);
}

/** Positions-only, welded copy of a primitive. Triangle order is preserved. */
export function weldedPositions(doc, prim) {
  const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  const tmp = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(floatArray(prim.getAttribute('POSITION')).slice()).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indexArray(prim)).setBuffer(buffer));
  weldPrimitive(tmp, { overwrite: true });
  const pos = tmp.getAttribute('POSITION').getArray().slice(), index = Uint32Array.from(tmp.getIndices().getArray());
  tmp.getAttribute('POSITION').dispose(); tmp.getIndices().dispose(); tmp.dispose();
  return { pos, index };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where the mesh sits in the scene (3DAISTUDIO lifts it onto the floor with a node offset). */
export function meshWorldMatrix(doc, mesh) {
  const node = doc.getRoot().listNodes().find((n) => n.getMesh() === mesh);
  return node ? node.getWorldMatrix() : IDENTITY;
}

export function applyMatrix(pos, m) {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return pos;
}

/**
 * Find the parts of the model. Positions are in scene ("world") units, face labels in the
 * original triangle order; axes says which horizontal axis is the width and which the depth.
 */
export function analyze(doc, segOpts = {}) {
  const { prim, mesh } = mainPrimitive(doc);
  const world = meshWorldMatrix(doc, mesh);
  const welded = weldedPositions(doc, prim);
  applyMatrix(welded.pos, world);
  const seg = segment(welded.pos, welded.index, { ...DEFAULTS.segment, ...segOpts });
  return { prim, mesh, world, welded, axes: furnitureAxes(welded.pos), bbox: bboxOf(welded.pos), ...seg };
}

/**
 * The colour texture of a primitive and the UV set it uses, or null (plain colour, or a texture
 * without image). A "shaded" export has no colour texture and carries its look as glow instead.
 */
export function baseColorSource(prim) {
  const mat = prim.getMaterial();
  const shaded = mat && !mat.getBaseColorTexture() && mat.getEmissiveTexture() && Math.max(...mat.getEmissiveFactor()) > 0;
  const tex = shaded ? mat.getEmissiveTexture() : mat?.getBaseColorTexture();
  const texCoord = (shaded ? mat.getEmissiveTextureInfo() : mat?.getBaseColorTextureInfo())?.getTexCoord() || 0;
  if (!tex?.getImage() || !prim.getAttribute(`TEXCOORD_${texCoord}`)) return null;
  return { image: tex.getImage(), mime: tex.getMimeType(), texCoord };
}

/**
 * Texture colour under the middle of every triangle (8-bit sRGB, 3 per face, in the original
 * triangle order) from decoded RGBA pixels, row 0 at the top as in glTF.
 */
export function faceColors(prim, texCoord, pixels, width, height) {
  const uv = floatArray(prim.getAttribute(`TEXCOORD_${texCoord}`)), index = indexArray(prim);
  const nf = index.length / 3, out = new Uint8Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let u = 0, v = 0;
    for (let c = 0; c < 3; c++) { const i = index[f * 3 + c]; u += uv[i * 2]; v += uv[i * 2 + 1]; }
    u /= 3; v /= 3;
    const x = Math.min(width - 1, Math.floor((u - Math.floor(u)) * width));
    const y = Math.min(height - 1, Math.floor((v - Math.floor(v)) * height));
    const o = (y * width + x) * 4;
    out[f * 3] = pixels[o]; out[f * 3 + 1] = pixels[o + 1]; out[f * 3 + 2] = pixels[o + 2];
  }
  return out;
}

/** Area, triangle count and box of the given parts (pos in the units the box should be in). */
export function partStats(pos, index, faceLabels, ids) {
  const stats = new Map(ids.map((id) => [id, { id, area: 0, faces: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }]));
  for (let f = 0; f < faceLabels.length; f++) {
    const p = stats.get(faceLabels[f]);
    if (!p) continue;
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    p.area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    p.faces++;
    for (const i of [a, b, c]) for (let d = 0; d < 3; d++) { p.min[d] = Math.min(p.min[d], pos[i + d]); p.max[d] = Math.max(p.max[d], pos[i + d]); }
  }
  return ids.map((id) => stats.get(id));
}

/**
 * Cut one part at a height: its triangles whose middle is below y become part newId.
 * Changes faceLabels in place; returns how many triangles moved.
 */
export function cutPart(pos, index, faceLabels, part, y, newId) {
  let moved = 0;
  for (let f = 0; f < faceLabels.length; f++) {
    if (faceLabels[f] !== part) continue;
    if (pos[index[f * 3] * 3 + 1] + pos[index[f * 3 + 1] * 3 + 1] + pos[index[f * 3 + 2] * 3 + 1] < 3 * y) { faceLabels[f] = newId; moved++; }
  }
  return moved;
}

function selectFaces(faceLabels, parts) {
  const set = new Set(parts), out = [];
  for (let f = 0; f < faceLabels.length; f++) if (set.has(faceLabels[f])) out.push(f);
  return out;
}

function trianglesOf(index, faces) {
  const out = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => { out[i * 3] = index[f * 3]; out[i * 3 + 1] = index[f * 3 + 1]; out[i * 3 + 2] = index[f * 3 + 2]; });
  return out;
}

/** Drop unused vertices and renumber, keeping first-use order. */
function compactIndexed(pos, index) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = new Uint32Array(index.length);
  let n = 0;
  for (let i = 0; i < index.length; i++) {
    const v = index[i];
    if (remap[v] < 0) remap[v] = n++;
    out[i] = remap[v];
  }
  const p = new Float32Array(n * 3);
  for (let v = 0; v < remap.length; v++) if (remap[v] >= 0) p.set(pos.subarray(v * 3, v * 3 + 3), remap[v] * 3);
  return { pos: p, index: out };
}

/** meshoptimizer simplification on plain arrays (MeshoptSimplifier.ready must have resolved). */
export function simplifyIndexed(pos, index, ratio, error, lockBorder = true) {
  if (ratio >= 1) return compactIndexed(pos, index);
  const target = Math.floor((ratio * index.length) / 3) * 3;
  const [dst] = MeshoptSimplifier.simplify(index, pos, 3, target, error, lockBorder ? ['LockBorder'] : []);
  return compactIndexed(pos, dst);
}

/**
 * New geometry for faces that get a tiling material: welded, in the output frame (metres, see
 * outputTransform), optionally resized (opts.size {w, d} mm along opts.axes), simplified, with
 * smooth normals and box-projected UVs in metres.
 * Shared by the export and the live preview, so what you see is what gets saved.
 */
export function reskinGeometry(welded, faces, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sub = compactIndexed(welded.pos, trianglesOf(welded.index, faces));
  const pos = o.xf ? transformPositions(sub.pos, o.xf) : sub.pos;
  if (o.size) stretchGeometry(pos, null, stretchFor(bboxOf(pos), o.axes, o.size));
  const box = bboxOf(pos);
  const simp = simplifyIndexed(pos, sub.index, o.simplify, o.error, true);
  fitToBox(simp.pos, box);
  const nrm = vertexNormals(simp.pos, simp.index, simp.pos.length / 3);
  return boxUV(simp.pos, nrm, simp.index, 1);
}

export function facesOfParts(faceLabels, parts) {
  return selectFaces(faceLabels, parts);
}

/**
 * Put the document into the output frame and keep what stays as generated.
 * xf: outputTransform (model units -> metres, standing on the floor). groups: [{ parts }] that
 * will be replaced per variant; every other face goes to the "rest" primitive, which keeps the
 * original texture. Node transforms are baked into the geometry, so the file is plain metres.
 * Returns the context groupPrimitive and setVariant need.
 */
export function prepareOutput(doc, analysis, xf, groups, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { prim, mesh, faceLabels } = analysis;
  const buffer = doc.getRoot().listBuffers()[0];
  const out = xfMatrix(xf);
  const A = mulMat4(out, analysis.world);
  const origIndex = indexArray(prim);
  const covered = new Set(groups.flatMap((g) => g.parts));
  const restParts = [...new Set(faceLabels)].filter((p) => !covered.has(p));
  let rest = null;
  if (restParts.length) {
    rest = prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(origIndex, selectFaces(faceLabels, restParts))).setBuffer(buffer));
    compactPrimitive(rest);
    transformPrimitive(rest, A);
    simplifyKept(rest, o);
    rest.setExtras({ group: 'rest' });
  }
  // other meshes (rare in 3DAISTUDIO files) and all node transforms -> plain metres at the scene root
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
  for (const node of nodes)
    if (node.getMesh() !== mesh) transformMesh(node.getMesh(), mulMat4(out, node.getWorldMatrix()));
  for (const node of nodes) {
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    if (scene && node.getParentNode()) scene.addChild(node);
  }
  mesh.removePrimitive(prim);
  return { doc, analysis, xf, A, origIndex, mesh, rest, buffer, opts: o };
}

/**
 * Geometry of one group for one variant option.
 * reskin: new welded geometry with metre UVs for a tiling material; otherwise the original
 * triangles with their own texture. size: { w, d } mm resizes the part (ends keep their shape).
 * Returns { prim, uvMeters? }.
 */
export function groupPrimitive(ctx, group, { reskin, size = null }) {
  const { doc, analysis, xf, A, origIndex, buffer, opts } = ctx;
  const faces = selectFaces(analysis.faceLabels, group.parts);
  if (!faces.length) return null;
  const extras = { group: group.name, size: size ? { w: size.w ?? null, d: size.d ?? null } : null };
  if (reskin) {
    const geo = reskinGeometry(analysis.welded, faces, { ...opts, xf, size, axes: analysis.axes });
    const p = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.position).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.normal).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(geo.uv.slice()).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.index).setBuffer(buffer))
      .setExtras(extras);
    return { prim: p, uvMeters: geo.uv };
  }
  const p = analysis.prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(origIndex, faces)).setBuffer(buffer));
  compactPrimitive(p);
  transformPrimitive(p, A);
  if (size) {
    const pos = p.getAttribute('POSITION'), nrm = p.getAttribute('NORMAL');
    const st = stretchFor(bboxOf(pos.getArray()), analysis.axes, size);
    if (st) {
      const P = pos.getArray().slice(), N = nrm ? Float32Array.from(nrm.getArray()) : null;
      stretchGeometry(P, N, st);
      pos.setArray(P);
      if (N) nrm.setArray(N).setNormalized(false);
    }
  }
  simplifyKept(p, opts);
  p.setExtras(extras);
  return { prim: p };
}

/** Simplify a part that keeps its original texture (its UV seams stay locked), keeping its exact extent. */
function simplifyKept(p, o) {
  const box = bboxOf(p.getAttribute('POSITION').getArray());
  simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: o.keepSimplify, error: o.error, lockBorder: true });
  const pos = p.getAttribute('POSITION');
  pos.setArray(fitToBox(pos.getArray().slice(), box));
}

/** Show exactly these primitives (rest + one option per group) in the output mesh. */
export function setVariant(ctx, built) {
  for (const p of ctx.mesh.listPrimitives()) ctx.mesh.removePrimitive(p);
  if (ctx.rest) ctx.mesh.addPrimitive(ctx.rest);
  for (const b of built) if (b) ctx.mesh.addPrimitive(b.prim);
}

/**
 * Every option is built: drop the full-resolution source primitive so each variant file is
 * cloned and written without carrying it along.
 */
export function releaseSource(ctx) {
  const prim = ctx.analysis.prim;
  const accessors = [...prim.listAttributes(), prim.getIndices()].filter(Boolean);
  prim.dispose();
  for (const a of accessors) if (a.listParents().length <= 1) a.dispose();
}

/** Older files from this program are quantized; work on plain floats. */
export async function plainFloats(doc) {
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'KHR_mesh_quantization')) await doc.transform(dequantize());
}

// ---------- materials ----------

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** Library entry + colour for a job choice. colorId is a palette id or a hex code. */
export function resolveChoice(lib, materialId, colorId) {
  const def = lib.materials.find((m) => m.id === materialId);
  if (!def) throw new Error(`재질을 찾을 수 없어요: ${materialId}`);
  if (def.colorMode === 'photo') return { def, color: null };
  const palette = lib.palettes?.[def.palette] || [];
  const hex = HEX.exec(colorId || '');
  const color = palette.find((c) => c.id === colorId) || (hex ? { id: `#${hex[1].toUpperCase()}`, name: `#${hex[1].toUpperCase()}`, hex: `#${hex[1].toUpperCase()}` } : null);
  if (!color) throw new Error(`${def.name}에 없는 색상이에요: ${colorId}`);
  return { def, color };
}

/** Short label for file and material names, e.g. "코냑-8B4A22" or "8B4A22". */
export function colorLabel(color) {
  if (!color?.hex) return '';
  const hex = color.hex.replace('#', '').toUpperCase();
  return color.name && color.name.replace('#', '').toUpperCase() !== hex ? `${color.name}-${hex}` : hex;
}

/**
 * Create a glTF material for a library entry + colour.
 * color: { name, hex } tints a neutral texture; null keeps a photo material's own colours.
 * loadImage(path) -> Promise<Uint8Array> reads a texture file from the library.
 */
export async function createMaterial(doc, def, color, loadImage, cache = new Map()) {
  const tex = async (path) => {
    if (!path) return null;
    if (!cache.has(path)) {
      // loadImage may return raw bytes, or { bytes, mime } when it converted the image
      const img = await loadImage(path);
      const bytes = img instanceof Uint8Array ? img : img.bytes;
      const mime = img.mime || (path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/jpeg');
      if (mime === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
      cache.set(path, doc.createTexture(path).setImage(bytes).setMimeType(mime).setURI(path.replace(/\//g, '_')));
    }
    return cache.get(path);
  };

  // the colour chip is the average colour we want to see, so divide out the texture's own brightness
  const tint = def.colorMode !== 'photo' && color?.hex;
  const base = tint ? hexToLinear(color.hex).map((c) => Math.min(1, c / (def.albedoMean || 1))) : [1, 1, 1];
  const label = colorLabel(tint ? color : null);
  const mat = doc.createMaterial(label ? `${def.name} ${label}` : def.name)
    .setBaseColorFactor([...base, 1])
    .setMetallicFactor(def.metallic ?? 0)
    .setRoughnessFactor(def.roughness ?? 1)
    .setDoubleSided(false);
  const bc = await tex(def.maps?.baseColor), nm = await tex(def.maps?.normal), orm = await tex(def.maps?.orm);
  if (bc) mat.setBaseColorTexture(bc);
  if (nm) mat.setNormalTexture(nm).setNormalScale(def.normalScale ?? 1);
  if (orm) {
    mat.setMetallicRoughnessTexture(orm);
    if (def.occlusion !== false) mat.setOcclusionTexture(orm).setOcclusionStrength(def.occlusionStrength ?? 1);
  }
  if (def.sheen) {
    // fabric fibres scatter light at grazing angles: a soft, slightly lighter rim of the same colour
    const ext = doc.createExtension(KHRMaterialsSheen);
    const k = def.sheen.intensity ?? 0.5;
    const sheenBase = tint ? base : [0.5, 0.5, 0.5];
    mat.setExtension('KHR_materials_sheen', ext.createSheen()
      .setSheenColorFactor(sheenBase.map((c) => Math.min(1, (c * 0.7 + 0.06) * k * 2)))
      .setSheenRoughnessFactor(def.sheen.roughness ?? 0.6));
  }
  if (def.clearcoat) {
    const ext = doc.createExtension(KHRMaterialsClearcoat);
    mat.setExtension('KHR_materials_clearcoat', ext.createClearcoat()
      .setClearcoatFactor(def.clearcoat.factor ?? 1)
      .setClearcoatRoughnessFactor(def.clearcoat.roughness ?? 0.1));
  }
  mat.setExtras({ material: def.id, color: tint ? color.name || color.hex : null, colorHex: tint ? color.hex : null });
  return { mat, def, color: tint ? color : null };
}

/**
 * UVs in texture tiles from UVs in metres. A tile is tileCm wide (tileHeightCm high, default square);
 * rotate: 90 turns the pattern a quarter turn (e.g. wood grain along the other side of a table top).
 */
export function tileUV(uvMeters, def, rotate = 0) {
  const tu = (def.tileCm || 25) / 100, tv = (def.tileHeightCm || def.tileCm || 25) / 100;
  const uv = new Float32Array(uvMeters.length);
  for (let i = 0; i < uvMeters.length; i += 2) {
    const u = rotate === 90 ? uvMeters[i + 1] : uvMeters[i];
    const v = rotate === 90 ? -uvMeters[i] : uvMeters[i + 1];
    uv[i] = u / tu;
    uv[i + 1] = v / tv;
  }
  return uv;
}

/** Point a re-skinned group at a material, scaling its metre UVs to the material's tile size. */
export function applyToGroup(doc, group, mat, def, opts = {}) {
  group.prim.getAttribute('TEXCOORD_0').setArray(tileUV(group.uvMeters, def, opts.rotate || 0));
  group.prim.setMaterial(mat);
}

/** Shrink the textures that stay from the original model (kept parts). */
export async function compressKeptTextures(doc, encodeTexture, maxSize = DEFAULTS.keptTextureSize) {
  for (const t of doc.getRoot().listTextures()) {
    const out = await encodeTexture(t.getImage(), t.getMimeType(), maxSize);
    if (out) {
      t.setImage(out.bytes).setMimeType(out.mimeType);
      if (out.mimeType === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
      const uri = t.getURI();
      const ext = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg' }[out.mimeType] || '';
      if (uri && ext) t.setURI(uri.replace(/\.(png|jpe?g|webp)$/i, ext));
    }
  }
}

/**
 * Compress a finished variant document and return GLB bytes.
 * meshopt (EXT_meshopt_compression) gives the smallest files; without it only quantization is used.
 */
export async function encodeVariant(io, doc, opts = {}) {
  const { meshopt = true } = opts;
  const copy = cloneDocument(doc);
  if (meshopt) {
    await MeshoptEncoder.ready;
    await copy.transform(prune({ keepExtras: true }), reorder({ encoder: MeshoptEncoder }), quantize());
    copy.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  } else {
    await copy.transform(prune({ keepExtras: true }), quantize());
  }
  copy.createExtension(KHRMeshQuantization).setRequired(true);
  return io.writeBinary(copy);
}

export const EXTENSIONS = [EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsSheen, KHRMeshQuantization];
export { Document };
