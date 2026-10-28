// Turn a photo (marble slab, wood board, a supplier's fabric or leather swatch)
// into a tiling PBR material: even out the lighting, make the edges wrap
// seamlessly, and derive bump (normal) and gloss (roughness) maps from it.
import { stripWebPProfile } from './webp.js';

export const KINDS = {
  marble: { label: '대리석', category: '대리석', colorMode: 'photo', widthCm: 60, bump: 0.2, gloss: 0.85 },
  wood: { label: '나무', category: '나무', colorMode: 'photo', widthCm: 40, bump: 0.6, gloss: 0.35 },
  fabric: { label: '원단', category: '패브릭', colorMode: 'tint', widthCm: 10, bump: 1, gloss: 0, sheen: true },
  leather: { label: '가죽', category: '가죽', colorMode: 'tint', widthCm: 15, bump: 0.8, gloss: 0.35 },
  other: { label: '기타', category: '기타', colorMode: 'photo', widthCm: 50, bump: 0.4, gloss: 0.3 },
};

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LUT = new Float32Array(256).map((_, i) => toLin(i / 255));

/** Box blur, one axis. wrap: treat the image as tiling; otherwise clamp at the edges. */
function blurAxis(src, w, h, r, horizontal, wrap) {
  const out = new Float32Array(src.length);
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  const at = (line, i) => {
    if (wrap) i = ((i % n) + n) % n;
    else i = i < 0 ? 0 : i >= n ? n - 1 : i;
    return horizontal ? src[line * w + i] : src[i * w + line];
  };
  const k = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(line, i);
    for (let i = 0; i < n; i++) {
      if (horizontal) out[line * w + i] = sum * k;
      else out[i * w + line] = sum * k;
      sum += at(line, i + r + 1) - at(line, i - r);
    }
  }
  return out;
}

/** Approximate Gaussian blur (three box passes). */
export function blur(src, w, h, r, wrap = false) {
  r = Math.max(1, Math.round(r));
  let a = src;
  for (let p = 0; p < 3; p++) a = blurAxis(blurAxis(a, w, h, r, true, wrap), w, h, r, false, wrap);
  return a;
}

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Cross-fade the far edge strip onto the near edge so the image wraps.
 * Variance-preserving blend keeps the contrast of veins and grain in the blended band.
 */
function wrapEdges(ch, w, h, ox, oy) {
  const means = ch.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
  const blend = (a, b, t, m) => {
    const u = smooth(t);
    return m + ((a - m) * (1 - u) + (b - m) * u) / Math.sqrt((1 - u) ** 2 + u ** 2);
  };
  // horizontal: width w -> W
  const W = w - ox;
  let cur = ch.map((c, k) => {
    const out = new Float32Array(W * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < W; x++)
        out[y * W + x] = x < ox ? blend(c[y * w + x + W], c[y * w + x], (x + 0.5) / ox, means[k]) : c[y * w + x];
    return out;
  });
  // vertical: height h -> H
  const H = h - oy;
  cur = cur.map((c, k) => {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        out[y * W + x] = y < oy ? blend(c[(y + H) * W + x], c[y * W + x], (y + 0.5) / oy, means[k]) : c[y * W + x];
    return out;
  });
  return { ch: cur, W, H };
}

function toCanvas(w, h, fill) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  fill(img.data);
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Process a photo. src: ImageBitmap. size: longest side of the finished tile.
 * o: { kind, colorMode, overlap 0..0.4, flatten, bump 0..2, gloss 0..1 }
 * Returns canvases + numbers needed for the material definition.
 */
export async function processPhoto(src, o, size = 1024) {
  const ov = Math.max(0, Math.min(0.4, o.overlap ?? 0.2));
  const scale = Math.min(1, size / (1 - ov) / Math.max(src.width, src.height));
  const w = Math.max(16, Math.round(src.width * scale)), h = Math.max(16, Math.round(src.height * scale));
  const c0 = new OffscreenCanvas(w, h);
  const g0 = c0.getContext('2d');
  g0.imageSmoothingQuality = 'high';
  g0.drawImage(src, 0, 0, w, h);
  const px = g0.getImageData(0, 0, w, h).data;
  const n = w * h;
  let ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) ch[k][i] = LUT[px[i * 4 + k]];

  // 1) even out lighting: divide by a very blurred brightness
  if (o.flatten !== false) {
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.2126 * ch[0][i] + 0.7152 * ch[1][i] + 0.0722 * ch[2][i];
    const low = blur(lum, w, h, Math.min(w, h) / 8);
    const mean = lum.reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) {
      const f = mean / Math.max(low[i], 1e-4);
      for (let k = 0; k < 3; k++) ch[k][i] *= f;
    }
  }

  // 2) seamless edges
  const wrapped = wrapEdges(ch, w, h, Math.round(w * ov), Math.round(h * ov));
  ch = wrapped.ch;
  const { W, H } = wrapped;
  const m = W * H;
  const lum = new Float32Array(m);
  for (let i = 0; i < m; i++) lum[i] = Math.max(0, 0.2126 * ch[0][i] + 0.7152 * ch[1][i] + 0.0722 * ch[2][i]);
  const lumMean = lum.reduce((s, v) => s + v, 0) / m || 1;

  // 3) colour map: photo colours, or neutral grey for hex tinting
  let albedoMean = 1;
  let albedo;
  if (o.colorMode === 'tint') {
    const target = 0.75;
    let sum = 0;
    const gray = new Float32Array(m);
    for (let i = 0; i < m; i++) { gray[i] = Math.min(1, (lum[i] / lumMean) * target); sum += gray[i]; }
    albedoMean = +(sum / m).toFixed(4);
    albedo = toCanvas(W, H, (d) => {
      for (let i = 0; i < m; i++) {
        const v = Math.round(toSrgb(gray[i]) * 255);
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
    });
  } else {
    albedo = toCanvas(W, H, (d) => {
      for (let i = 0; i < m; i++) {
        for (let k = 0; k < 3; k++) d[i * 4 + k] = Math.round(toSrgb(Math.min(1, Math.max(0, ch[k][i]))) * 255);
        d[i * 4 + 3] = 255;
      }
    });
  }

  // 4) height from fine detail of the brightness, then a normal map (glTF: +X right, +Y up)
  const logL = lum.map((v) => Math.log(v + 0.02));
  const low = blur(logL, W, H, Math.max(2, Math.min(W, H) / 48), true);
  let hp = new Float32Array(m);
  let varSum = 0;
  for (let i = 0; i < m; i++) { hp[i] = logL[i] - low[i]; varSum += hp[i] * hp[i]; }
  const std = Math.sqrt(varSum / m) || 1;
  hp = blur(hp.map((v) => v / std), W, H, 1, true);
  const k = 0.6; // slope per unit of normalised height; the material's normalScale sets the final strength
  const at = (x, y) => hp[((y + H) % H) * W + ((x + W) % W)];
  const normal = toCanvas(W, H, (d) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * k;
        const dy = (at(x, y + 1) - at(x, y - 1)) * k;
        let nx = -dx, ny = dy, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const i = (y * W + x) * 4;
        d[i] = Math.round((nx * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
  });

  // 5) ORM: soft cavity occlusion, raised areas slightly smoother, not metal
  const orm = toCanvas(W, H, (d) => {
    for (let i = 0; i < m; i++) {
      const v = hp[i];
      d[i * 4] = Math.round(255 * Math.max(0.6, 1 - 0.08 * Math.max(0, -v)));
      d[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0.5, 1 - 0.06 * v)));
      d[i * 4 + 2] = 0;
      d[i * 4 + 3] = 255;
    }
  });

  return { albedo, normal, orm, width: W, height: H, albedoMean };
}

/** Roughness / clearcoat from the 0..1 gloss slider. */
export function glossToSurface(gloss) {
  const roughness = +(0.92 - 0.8 * gloss).toFixed(3);
  const clearcoat = gloss >= 0.7 ? { factor: +Math.min(1, (gloss - 0.6) * 2.5).toFixed(2), roughness: 0.06 } : null;
  return { roughness, clearcoat };
}

export async function canvasBlob(canvas, type = 'image/webp', quality = 0.92) {
  const blob = await canvas.convertToBlob({ type, quality });
  if (type !== 'image/webp') return blob;
  return new Blob([stripWebPProfile(new Uint8Array(await blob.arrayBuffer()))], { type });
}
