// Re-tone only the wood of a model's own texture to a target colour, leaving light, unsaturated texels
// (bedding, cushions, fabric straps) exactly as they are. Texels count as wood when they are saturated warm
// browns; their mean is moved to the target per channel (grain and shading kept), with a soft mask edge.
// usage: node dev/batch/tint-wood.mjs in.glb out.glb --hex 4E2E1C [--sat 0.3] [--lmax 0.62]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const a = process.argv.slice(2); const [IN, OUT] = a; const opt = (k, d) => { const i = a.indexOf('--' + k); return i > 0 ? a[i + 1] : d; };
const hex = opt('hex').replace('#', ''), T = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const SAT = +opt('sat', 0.3), LMAX = +opt('lmax', 0.62);
const doc = await io.read(IN);
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const srgb = (l) => Math.round(255 * Math.min(1, Math.max(0, l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055)));
const LUT = Float64Array.from({ length: 256 }, (_, i) => lin(i));
const texs = new Set(doc.getRoot().listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean));
for (const tex of texs) {
  const { data, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, w = new Float32Array(n), acc = [0, 0, 0]; let ws = 0;
  for (let i = 0; i < n; i++) { const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const s = mx ? (mx - mn) / mx : 0, l = mx / 255; if (!(r >= g && g >= b * 0.85)) continue; // warm hues only (red-orange-brown)
    const m = Math.min(1, Math.max(0, (s - SAT) / 0.1)) * Math.min(1, Math.max(0, (LMAX - l) / 0.08)); if (m <= 0) continue;
    w[i] = m; ws += m; acc[0] += m * LUT[r]; acc[1] += m * LUT[g]; acc[2] += m * LUT[b]; }
  if (!ws) { console.log('no wood texels in', tex.getName() || tex.getURI()); continue; }
  const mean = acc.map((x) => x / ws), k = T.map((t, c) => lin(t) / mean[c]);
  const outBuf = Buffer.from(data);
  for (let i = 0; i < n; i++) { const m = w[i]; if (!m) continue; for (let c = 0; c < 3; c++) { const v = LUT[data[i * 3 + c]]; outBuf[i * 3 + c] = srgb(v * (1 - m) + v * k[c] * m); } }
  const mime = tex.getMimeType(); const img = sharp(outBuf, { raw: { width: info.width, height: info.height, channels: 3 } });
  tex.setImage(new Uint8Array(mime === 'image/png' ? await img.png().toBuffer() : await img.jpeg({ quality: 92 }).toBuffer()));
  console.log('texture', info.width + 'x' + info.height, 'wood share', (ws / n * 100).toFixed(1) + '%', 'mean was #' + mean.map(srgb).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase(), '-> #' + hex.toUpperCase());
}
await io.write(OUT, doc); console.log('wrote', OUT.split('/').pop());
