// Re-skin a 3DAISTUDIO furniture GLB: split it into parts, give chosen parts a
// tiling PBR material (leather, fabric, ...) in a chosen colour, keep the rest
// as generated, and write one compact GLB per variant.
//
// Environment-agnostic: callers pass a gltf-transform IO and a function that
// loads material texture files (fs in Node, fetch in the browser).

import { Document } from '@gltf-transform/core';
import {
  cloneDocument, compactPrimitive, prune, quantize, reorder, simplifyPrimitive, weldPrimitive,
} from '@gltf-transform/functions';
import {
  EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsSheen, KHRMeshQuantization,
} from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { segment, vertexNormals } from './segment.js';
import { boxUV } from './uvbox.js';

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

/** Find the parts of the model. Returns face labels in the original triangle order. */
export function analyze(doc, segOpts = {}) {
  const { prim, mesh } = mainPrimitive(doc);
  const welded = weldedPositions(doc, prim);
  const seg = segment(welded.pos, welded.index, { ...DEFAULTS.segment, ...segOpts });
  return { prim, mesh, welded, ...seg };
}

function bbox(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

/**
 * Model units -> metres, from the real width of the piece (its longest horizontal side).
 * 3DAISTUDIO normalises models, so the real size has to come from the user.
 */
export function unitsToMeters(pos, widthMm) {
  const { size } = bbox(pos);
  return widthMm / 1000 / Math.max(size[0], size[2]);
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

/**
 * Replace the main primitive with one primitive per group.
 * groups: [{ name, parts: [partIds], reskin: true|false }]; faces not covered go to a kept "rest" group.
 * Re-skinned groups get welded, simplified geometry with box UVs in metres (TEXCOORD_0, rescaled per material).
 */
export function buildGroups(doc, analysis, groups, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { prim, mesh, welded, faceLabels } = analysis;
  const buffer = doc.getRoot().listBuffers()[0];
  const covered = new Set(groups.flatMap((g) => g.parts));
  const allParts = [...new Set(faceLabels)];
  const rest = allParts.filter((p) => !covered.has(p));
  const list = [...groups];
  if (rest.length) list.push({ name: 'rest', parts: rest, reskin: false });
  const m2u = unitsToMeters(welded.pos, o.widthMm || 1000);
  const origIndex = indexArray(prim);
  const out = [];

  for (const g of list) {
    const faces = selectFaces(faceLabels, g.parts);
    if (!faces.length) continue;
    let p;
    if (g.reskin) {
      p = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(welded.pos).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(welded.index, faces)).setBuffer(buffer));
      compactPrimitive(p);
      simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: o.simplify, error: o.error, lockBorder: true });
      const pos = floatArray(p.getAttribute('POSITION')), idx = indexArray(p);
      const nrm = vertexNormals(pos, idx, pos.length / 3);
      const uv = boxUV(pos, nrm, idx, m2u);
      for (const a of [p.getAttribute('POSITION'), p.getIndices()]) a.dispose();
      p.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(uv.position).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(uv.normal).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv.uv.slice()).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(uv.index).setBuffer(buffer));
      p.setExtras({ group: g.name });
      out.push({ ...g, prim: p, uvMeters: uv.uv });
    } else {
      p = prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(origIndex, faces)).setBuffer(buffer));
      compactPrimitive(p);
      simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: o.keepSimplify, error: o.error, lockBorder: true });
      p.setExtras({ group: g.name });
      out.push({ ...g, prim: p });
    }
    mesh.addPrimitive(p);
  }
  mesh.removePrimitive(prim);
  prim.dispose();
  return out;
}

// ---------- materials ----------

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
}

/**
 * Create a glTF material for a library entry + colour.
 * loadImage(path) -> Promise<Uint8Array> reads a texture file from the library.
 */
export async function createMaterial(doc, lib, materialId, colorId, loadImage, cache = new Map()) {
  const def = lib.materials.find((m) => m.id === materialId);
  if (!def) throw new Error(`재질을 찾을 수 없어요: ${materialId}`);
  const palette = lib.palettes[def.palette] || [];
  const color = palette.find((c) => c.id === colorId) || (colorId?.startsWith('#') ? { id: colorId, name: colorId, hex: colorId } : null);
  if (!color) throw new Error(`${def.name}에 없는 색상이에요: ${colorId}`);

  const tex = async (path) => {
    if (!path) return null;
    if (!cache.has(path)) {
      const bytes = await loadImage(path);
      const mime = path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      if (mime === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
      cache.set(path, doc.createTexture(path).setImage(bytes).setMimeType(mime).setURI(path.replace(/\//g, '_')));
    }
    return cache.get(path);
  };

  // chip colour is the average colour we want to see, so divide out the texture's own brightness
  const lin = hexToLinear(color.hex);
  const mean = def.albedoMean || 1;
  const base = lin.map((c) => Math.min(1, c / mean));
  const mat = doc.createMaterial(`${def.name} ${color.name}`)
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
    mat.setExtension('KHR_materials_sheen', ext.createSheen()
      .setSheenColorFactor(base.map((c) => Math.min(1, (c * 0.7 + 0.06) * k * 2)))
      .setSheenRoughnessFactor(def.sheen.roughness ?? 0.6));
  }
  if (def.clearcoat) {
    const ext = doc.createExtension(KHRMaterialsClearcoat);
    mat.setExtension('KHR_materials_clearcoat', ext.createClearcoat()
      .setClearcoatFactor(def.clearcoat.factor ?? 1)
      .setClearcoatRoughnessFactor(def.clearcoat.roughness ?? 0.1));
  }
  mat.setExtras({ material: def.id, color: color.id, colorHex: color.hex });
  return { mat, def, color };
}

/** Point a re-skinned group at a material, scaling its metre UVs to the material's tile size. */
export function applyToGroup(doc, group, mat, def) {
  const tile = (def.tileCm || 25) / 100;
  const uv = group.uvMeters.map((x) => x / tile);
  group.prim.getAttribute('TEXCOORD_0').setArray(uv);
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
      if (uri) t.setURI(uri.replace(/\.(png|jpe?g)$/i, '.webp'));
    }
  }
}

/** meshopt-compress a finished variant document and return GLB bytes. */
export async function encodeVariant(io, doc) {
  await MeshoptEncoder.ready;
  const copy = cloneDocument(doc);
  await copy.transform(prune({ keepExtras: true }), reorder({ encoder: MeshoptEncoder }), quantize());
  copy.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  copy.createExtension(KHRMeshQuantization).setRequired(true);
  return io.writeBinary(copy);
}

export const EXTENSIONS = [EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsSheen, KHRMeshQuantization];
export { Document };
