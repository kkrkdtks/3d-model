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
  EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsAnisotropy, KHRMaterialsClearcoat, KHRMaterialsSheen,
  KHRMeshQuantization,
} from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { segment, smoothNormals, vertexNormals } from './segment.js';
import { boxUV } from './uvbox.js';
import {
  bboxOf, fitToBox, furnitureAxes, mulMat4, stretchFor, stretchGeometry, transformPositions, xfMatrix,
} from './size.js';

export const DEFAULTS = {
  segment: { threshold: 60, dilate: 4, minArea: 0.002, smoothIters: 5 },
  simplify: 0.25,      // triangles kept on re-skinned parts (their old UVs are dropped, so this stays clean)
  keepSimplify: 0.35,  // triangles kept on parts that stay as generated (old UVs must survive)
  error: 0.001,
  smoothNormals: 12,    // passes of edge-keeping normal smoothing on re-skinned parts (0: off)
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

/**
 * Every triangle primitive of the scene with the node that places it, in scene order (the order
 * three.js GLTFLoader builds them in). A 3DAISTUDIO file has one; a file made with this program
 * has the kept rest plus one per changed group, and all of them are parts of the furniture.
 * Each gets faceOffset / faceCount: its triangles in the one face numbering used for parts, and
 * made: written by this program (extras.group), so already simplified once and not again.
 */
export function triangleSources(doc) {
  const out = [];
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh)
      for (const prim of mesh.listPrimitives())
        if (prim.getMode() === 4 && prim.getAttribute('POSITION'))
          out.push({ prim, mesh, node, world: node.getWorldMatrix(), made: typeof prim.getExtras()?.group === 'string' });
    for (const child of node.listChildren()) visit(child);
  };
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  if (scene) for (const node of scene.listChildren()) visit(node);
  if (!out.length) {
    const { prim, mesh } = mainPrimitive(doc);
    out.push({ prim, mesh, node: null, world: meshWorldMatrix(doc, mesh) });
  }
  let offset = 0;
  for (const s of out) {
    s.faceCount = (s.prim.getIndices() ? s.prim.getIndices().getCount() : s.prim.getAttribute('POSITION').getCount()) / 3;
    s.faceOffset = offset;
    offset += s.faceCount;
  }
  return out;
}

/**
 * Welded positions of all sources together in scene ("world") units, triangles in source order.
 * Each source is welded on its own, so separate primitives stay separate pieces.
 */
export function weldedSources(doc, sources) {
  const parts = sources.map((s) => {
    const w = weldedPositions(doc, s.prim);
    applyMatrix(w.pos, s.world);
    return w;
  });
  if (parts.length === 1) return parts[0];
  const pos = new Float32Array(parts.reduce((a, w) => a + w.pos.length, 0));
  const index = new Uint32Array(parts.reduce((a, w) => a + w.index.length, 0));
  let v = 0, i = 0;
  for (const w of parts) {
    pos.set(w.pos, v * 3);
    for (let k = 0; k < w.index.length; k++) index[i + k] = w.index[k] + v;
    v += w.pos.length / 3;
    i += w.index.length;
  }
  return { pos, index };
}

/** True when every one of these (sorted) faces comes from a piece this program already simplified. */
export function madeFaces(sources, faces) {
  return faces.length > 0 && facesBySource(sources, faces).every(([s]) => s.made);
}

/** Faces (sorted, global numbering) split by source: [[source, local face list], ...]. */
function facesBySource(sources, faces) {
  const out = [];
  let k = 0;
  for (const s of sources) {
    const end = s.faceOffset + s.faceCount, local = [];
    while (k < faces.length && faces[k] < end) local.push(faces[k++] - s.faceOffset);
    if (local.length) out.push([s, local]);
  }
  return out;
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
  const sources = triangleSources(doc);
  const welded = weldedSources(doc, sources);
  const seg = segment(welded.pos, welded.index, { ...DEFAULTS.segment, ...segOpts });
  const { prim, mesh, world } = sources[0];
  return { sources, prim, mesh, world, welded, axes: furnitureAxes(welded.pos), bbox: bboxOf(welded.pos), ...seg };
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

/** Drop unused vertices and renumber, keeping first-use order (and any per-vertex vec3 attribute). */
function compactIndexed(pos, index, nrm = null) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = new Uint32Array(index.length);
  let n = 0;
  for (let i = 0; i < index.length; i++) {
    const v = index[i];
    if (remap[v] < 0) remap[v] = n++;
    out[i] = remap[v];
  }
  const p = new Float32Array(n * 3), q = nrm ? new Float32Array(n * 3) : null;
  for (let v = 0; v < remap.length; v++) {
    if (remap[v] < 0) continue;
    p.set(pos.subarray(v * 3, v * 3 + 3), remap[v] * 3);
    if (q) q.set(nrm.subarray(v * 3, v * 3 + 3), remap[v] * 3);
  }
  return q ? { pos: p, index: out, nrm: q } : { pos: p, index: out };
}

// How much a change of surface direction counts against a change of shape when triangles are
// removed. Positions alone keep the outline but not the way light falls on it: glossy parts then
// show jagged, broken-looking highlights along edges and rims.
const NORMAL_WEIGHT = 1;

/**
 * meshoptimizer simplification on plain arrays (MeshoptSimplifier.ready must have resolved).
 * With nrm (unit normals per vertex) the surface direction is kept too, and the result carries the
 * surviving vertices' normals.
 */
export function simplifyIndexed(pos, index, ratio, error, lockBorder = true, nrm = null) {
  if (ratio >= 1) return compactIndexed(pos, index, nrm);
  const target = Math.floor((ratio * index.length) / 3) * 3;
  const flags = lockBorder ? ['LockBorder'] : [];
  const [dst] = nrm
    ? MeshoptSimplifier.simplifyWithAttributes(index, pos, 3, nrm, 3, [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT], null, target, error, flags)
    : MeshoptSimplifier.simplify(index, pos, 3, target, error, flags);
  return compactIndexed(pos, dst, nrm);
}

/**
 * New geometry for faces that get a tiling material: welded, in the output frame (metres, see
 * outputTransform), optionally resized (opts.size {w, d} mm along opts.axes), simplified, with
 * smooth normals and box-projected UVs in metres.
 * Normals come from the full-detail surface, with the ripples of a generated surface smoothed out
 * (real edges stay), and are kept through simplification, so edges and rims shade cleanly instead
 * of following the coarser triangles.
 * Shared by the export and the live preview, so what you see is what gets saved.
 */
export function reskinGeometry(welded, faces, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sub = compactIndexed(welded.pos, trianglesOf(welded.index, faces));
  const pos = o.xf ? transformPositions(sub.pos, o.xf) : sub.pos;
  if (o.size) stretchGeometry(pos, null, stretchFor(bboxOf(pos), o.axes, o.size));
  const box = bboxOf(pos);
  const dense = vertexNormals(pos, sub.index, pos.length / 3);
  // pieces this app already simplified (o.simplify 1) were smoothed when they were made
  if (o.smoothNormals && o.simplify < 1) smoothNormals(sub.index, dense, o.smoothNormals);
  const simp = simplifyIndexed(pos, sub.index, o.simplify, o.error, true, dense);
  fitToBox(simp.pos, box);
  return boxUV(simp.pos, simp.nrm, simp.index, 1);
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
  const { faceLabels } = analysis;
  const sources = analysis.sources || [{ prim: analysis.prim, mesh: analysis.mesh, world: analysis.world, faceOffset: 0, faceCount: faceLabels.length }];
  const buffer = doc.getRoot().listBuffers()[0];
  const out = xfMatrix(xf);
  for (const s of sources) {
    s.A = mulMat4(out, s.world);
    s.index = indexArray(s.prim);
    s.material = s.prim.getMaterial();
  }
  // every output primitive goes into the first source's mesh; the sources themselves are only
  // read from now on, so they leave their meshes (nothing of them is written as it was)
  const mesh = sources[0].mesh;
  for (const s of sources) s.mesh.removePrimitive(s.prim);
  const covered = new Set(groups.flatMap((g) => g.parts));
  const restFaces = [];
  for (let f = 0; f < faceLabels.length; f++) if (!covered.has(faceLabels[f])) restFaces.push(f);
  const rest = [];
  for (const [s, faces] of facesBySource(sources, restFaces)) {
    const p = s.prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(s.index, faces)).setBuffer(buffer));
    compactPrimitive(p);
    transformPrimitive(p, s.A);
    if (!s.made) simplifyKept(p, o);
    p.setExtras({ group: 'rest' });
    rest.push(p);
  }
  // whatever else is in the file (lines, points: rare) and all node transforms -> plain metres at the scene root
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
  for (const node of nodes)
    if (node.getMesh().listPrimitives().length) transformMesh(node.getMesh(), mulMat4(out, node.getWorldMatrix()));
  for (const node of nodes) {
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    if (scene && node.getParentNode()) scene.addChild(node);
  }
  // meshes left empty (their primitives were sources) are not valid glTF: drop them
  for (const node of nodes) {
    const m = node.getMesh();
    if (m !== mesh && !m.listPrimitives().length) {
      node.setMesh(null);
      if (!m.listParents().some((q) => q !== doc.getRoot())) m.dispose();
    }
  }
  return { doc, analysis, sources, xf, mesh, rest, buffer, opts: o, shown: [] };
}

/**
 * Geometry of one group for one variant option.
 * reskin: new welded geometry with metre UVs for a tiling material; otherwise the original
 * triangles with their own texture (one primitive per source primitive they come from).
 * size: { w, d } mm resizes the part (ends keep their shape).
 * Returns { prim, prims, uvMeters? | sources? } (prim = prims[0]).
 */
export function groupPrimitive(ctx, group, { reskin, size = null }) {
  const { doc, analysis, xf, buffer, opts } = ctx;
  const faces = selectFaces(analysis.faceLabels, group.parts);
  if (!faces.length) return null;
  const extras = { group: group.name, size: size ? { w: size.w ?? null, d: size.d ?? null } : null };
  if (reskin) {
    const simplify = madeFaces(ctx.sources, faces) ? 1 : opts.simplify;
    const geo = reskinGeometry(analysis.welded, faces, { ...opts, simplify, xf, size, axes: analysis.axes });
    const p = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.position).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.normal).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(geo.uv.slice()).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.index).setBuffer(buffer))
      .setExtras(extras);
    return { prim: p, prims: [p], uvMeters: geo.uv };
  }
  // the parts' own triangles and texture: one primitive per source they come from
  const prims = [], from = [];
  for (const [s, local] of facesBySource(ctx.sources, faces)) {
    const p = s.prim.clone().setIndices(doc.createAccessor().setType('SCALAR').setArray(trianglesOf(s.index, local)).setBuffer(buffer));
    compactPrimitive(p);
    transformPrimitive(p, s.A);
    prims.push(p);
    from.push(s);
  }
  if (size) {
    // one stretch for the whole group, measured over all its pieces
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) {
      const b = bboxOf(p.getAttribute('POSITION').getArray());
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.min[k]); hi[k] = Math.max(hi[k], b.max[k]); }
    }
    const st = stretchFor({ min: lo, max: hi }, analysis.axes, size);
    if (st)
      for (const p of prims) {
        const pos = p.getAttribute('POSITION'), nrm = p.getAttribute('NORMAL');
        const P = pos.getArray().slice(), N = nrm ? Float32Array.from(nrm.getArray()) : null;
        stretchGeometry(P, N, st);
        pos.setArray(P);
        if (N) nrm.setArray(N).setNormalized(false);
      }
  }
  prims.forEach((p, i) => {
    if (!from[i].made) simplifyKept(p, opts);
    p.setExtras(extras);
  });
  return { prim: prims[0], prims, sources: from };
}

/**
 * Simplify a part that keeps its original texture (its UV seams stay locked), keeping its exact
 * extent. Its own normals count too, so smooth and glossy areas keep their shading.
 */
function simplifyKept(p, o) {
  const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
  const box = bboxOf(P.getArray());
  const I = p.getIndices();
  if (!N || !I || o.keepSimplify >= 1) {
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: o.keepSimplify, error: o.error, lockBorder: true });
  } else {
    const index = Uint32Array.from(I.getArray());
    const target = Math.floor((o.keepSimplify * index.length) / 3) * 3;
    const [dst] = MeshoptSimplifier.simplifyWithAttributes(index, floatArray(P), 3, floatArray(N), 3,
      [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT], null, target, o.error, ['LockBorder']);
    I.setArray(dst); // this part's own index list (made for it in prepareOutput / groupPrimitive)
    compactPrimitive(p);
  }
  const pos = p.getAttribute('POSITION');
  pos.setArray(fitToBox(pos.getArray().slice(), box));
}

/** Show exactly these primitives (rest + one option per group) in the output mesh. */
export function setVariant(ctx, built) {
  for (const p of ctx.shown) ctx.mesh.removePrimitive(p);
  ctx.shown = [...ctx.rest, ...built.flatMap((b) => (b ? b.prims || [b.prim] : []))];
  for (const p of ctx.shown) ctx.mesh.addPrimitive(p);
}

/**
 * Every option is built: drop the full-resolution source primitives so each variant file is
 * cloned and written without carrying them along.
 */
export function releaseSource(ctx) {
  for (const { prim } of ctx.sources) {
    if (prim.isDisposed()) continue;
    const accessors = [...prim.listAttributes(), prim.getIndices()].filter(Boolean);
    prim.dispose();
    for (const a of accessors) if (!a.isDisposed() && a.listParents().length <= 1) a.dispose();
  }
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
  if (def.anisotropy) {
    // brushed (hairline) metal: highlights stretch across the brushing; viewers without the
    // extension show the same metal without the stretch
    const ext = doc.createExtension(KHRMaterialsAnisotropy);
    mat.setExtension('KHR_materials_anisotropy', ext.createAnisotropy()
      .setAnisotropyStrength(def.anisotropy.strength ?? 0.6)
      .setAnisotropyRotation(((def.anisotropy.rotation ?? 0) * Math.PI) / 180));
  }
  if (def.alpha != null) {
    // glass: see-through by blending, both sides drawn
    mat.setBaseColorFactor([...base, def.alpha]).setAlphaMode('BLEND').setDoubleSided(true);
  }
  mat.setExtras({ material: def.id, color: tint ? color.name || color.hex : null, colorHex: tint ? color.hex : null });
  return { mat, def, color: tint ? color : null };
}

/**
 * UVs in texture tiles from UVs in metres. A tile is tileCm wide (tileHeightCm high, default square).
 * rotate turns the pattern on the surface by that many degrees (90 = a quarter turn, e.g. wood grain
 * along the other side of a table top). def.rotate, the correction of a photo material whose grain was
 * captured askew, is added: the pattern is straightened once in the material and turned per part.
 */
export function tileUV(uvMeters, def, rotate = 0) {
  const tu = (def.tileCm || 25) / 100, tv = (def.tileHeightCm || def.tileCm || 25) / 100;
  const deg = ((+rotate || 0) + (+def.rotate || 0)) % 360;
  const rad = (deg * Math.PI) / 180;
  // quarter turns exactly (cos 90° is not 0 in floating point)
  const c = deg % 90 === 0 ? Math.round(Math.cos(rad)) : Math.cos(rad);
  const s = deg % 90 === 0 ? Math.round(Math.sin(rad)) : Math.sin(rad);
  const uv = new Float32Array(uvMeters.length);
  for (let i = 0; i < uvMeters.length; i += 2) {
    const u = uvMeters[i], v = uvMeters[i + 1];
    uv[i] = (c * u + s * v) / tu;
    uv[i + 1] = (-s * u + c * v) / tv;
  }
  return uv;
}

/** Point a re-skinned group at a material, scaling its metre UVs to the material's tile size. */
export function applyToGroup(doc, group, mat, def, opts = {}) {
  group.prim.getAttribute('TEXCOORD_0').setArray(tileUV(group.uvMeters, def, opts.rotate || 0));
  group.prim.setMaterial(mat);
}

/**
 * Shrink the textures that stay from the original model (kept parts). encodeTexture may return
 * null to keep a texture as it is (already small and in the right format).
 */
export async function compressKeptTextures(doc, encodeTexture, maxSize = DEFAULTS.keptTextureSize) {
  for (const t of doc.getRoot().listTextures()) {
    const out = await encodeTexture(t.getImage(), t.getMimeType(), maxSize);
    if (!out && t.getMimeType() === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
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
 * Lift every mesh by liftM metres: the floor stays at y = 0 (the origin), the furniture stands a
 * little above it, so a room floor that is not quite flat or a rug laid under it does not swallow
 * the legs. Each position accessor moves once, even when primitives share it.
 */
export function liftDocument(doc, liftM) {
  if (!liftM) return;
  const seen = new Set();
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc || seen.has(acc)) continue;
      seen.add(acc);
      const n = acc.getCount(), out = new Float32Array(n * 3), el = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        acc.getElement(i, el);
        out[i * 3] = el[0]; out[i * 3 + 1] = el[1] + liftM; out[i * 3 + 2] = el[2];
      }
      acc.setArray(out).setNormalized(false);
    }
}

/**
 * Compress a finished variant document and return GLB bytes.
 * meshopt (EXT_meshopt_compression) gives the smallest files; without it only quantization is used.
 * liftM raises the furniture off the floor (see liftDocument) in the written copy only.
 */
export async function encodeVariant(io, doc, opts = {}) {
  const { meshopt = true, liftM = 0 } = opts;
  const copy = cloneDocument(doc);
  liftDocument(copy, liftM);
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

/**
 * Write a note about how the file was made into asset.extras of finished GLB bytes (only the JSON
 * chunk changes, so the compressed data stays as it is). When the result has a byte size listed in
 * avoid, the note is padded until it does not: a placement service that told two uploads apart by
 * size took a re-saved file (same model, only the floor gap changed, identical size) for the old one.
 */
export function stampGlb(bytes, note, avoid = null) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(16, true) !== 0x4e4f534a) return u8;
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
  const rest = u8.subarray(20 + jsonLen);
  const build = (pad) => {
    json.asset.extras = { ...(json.asset.extras || {}), ...note, ...(pad ? { pad: '-'.repeat(pad) } : {}) };
    if (!pad) delete json.asset.extras.pad;
    let text = new TextEncoder().encode(JSON.stringify(json));
    const fill = (4 - (text.length % 4)) % 4;
    const out = new Uint8Array(20 + text.length + fill + rest.length);
    const o = new DataView(out.buffer);
    o.setUint32(0, 0x46546c67, true); o.setUint32(4, 2, true); o.setUint32(8, out.length, true);
    o.setUint32(12, text.length + fill, true); o.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + text.length + fill);
    out.set(rest, 20 + text.length + fill);
    return out;
  };
  let out = build(0);
  for (let pad = 1; avoid && avoid.has(out.length) && pad < 4096; pad++) out = build(pad);
  return out;
}

export const EXTENSIONS = [EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsAnisotropy, KHRMaterialsClearcoat, KHRMaterialsSheen, KHRMeshQuantization];
export { Document };
