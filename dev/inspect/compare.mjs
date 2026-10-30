// Same model, an older core/segment.js and the current one: underside height and parts, are they
// identical? (with colour, as the app does)
// usage: git show v0.5.2:core/segment.js > old.js; OLD=old.js node compare.mjs a.glb b.glb ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import path from 'path';
import { pathToFileURL } from 'url';
import { plainFloats, mainPrimitive, meshWorldMatrix, weldedPositions, applyMatrix, DEFAULTS, baseColorSource, faceColors } from '../../core/skin.js';
import * as N from '../../core/segment.js';
const O = await import(pathToFileURL(path.resolve(process.env.OLD || 'segment.old.js')).href);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file); await plainFloats(doc);
  const { prim, mesh } = mainPrimitive(doc);
  const w = weldedPositions(doc, prim); applyMatrix(w.pos, meshWorldMatrix(doc, mesh));
  const { pos, index } = w, nv = pos.length / 3, nf = index.length / 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
  const pct = (h) => (h === null ? '-' : ((h - lo) / (hi - lo) * 100).toFixed(2) + '%');
  console.log(file.split('/').pop().padEnd(24), 'underside old', pct(O.undersideHeight(pos, index)), 'new', pct(N.undersideHeight(pos, index)));
  const edges = N.uniqueEdges(index, nv), adj = N.adjacency(edges.ea, edges.eb, nv);
  const curvature = N.valleyCurvature(pos, adj, edges, N.vertexNormals(pos, index, nv), DEFAULTS.segment.smoothIters);
  let color = null;
  const src = baseColorSource(prim);
  if (src) {
    const S = 1024, raw = await sharp(Buffer.from(src.image)).resize(S, S, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    color = N.vertexColors(index, faceColors(prim, src.texCoord, raw, S, S), nv, adj, 2);
  }
  for (const useColor of color ? [false, true] : [false]) {
    const opts = { ...DEFAULTS.segment, edges, adj, curvature, color: useColor ? color : null };
    let t0 = Date.now(); const a = O.segment(pos, index, opts); const ta = Date.now() - t0;
    t0 = Date.now(); const b = N.segment(pos, index, opts); const tb = Date.now() - t0;
    let diff = 0; const tr = new Map(); let ymin = Infinity, ymax = -Infinity;
    for (let f = 0; f < nf; f++) {
      if (a.faceLabels[f] === b.faceLabels[f]) continue;
      diff++;
      const key = `${a.faceLabels[f]}->${b.faceLabels[f]}`; tr.set(key, (tr.get(key) || 0) + 1);
      const y = pos[index[f * 3] * 3 + 1]; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    console.log('   ', useColor ? 'colour' : 'shape ', 'parts old', a.parts.length, 'new', b.parts.length, 'faces differing', diff, '/', nf, `ms ${ta} / ${tb}`);
    if (diff) console.log('      moved', JSON.stringify([...tr]), 'y', ymin.toFixed(4), '..', ymax.toFixed(4));
  }
}
