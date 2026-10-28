// Material library on the screen side: three.js materials that mirror the
// glTF materials written by core/skin.js, and small swatch images for the
// material cards.
import * as THREE from 'three';
import { hexToLinear } from '../core/skin.js';

const texCache = new Map();

/** three.js texture from an image Blob (cached per path). Colour maps are sRGB, data maps linear. */
export function threeTexture(path, blob, isColor, anisotropy = 8) {
  const key = `${path}|${isColor ? 'c' : 'd'}`;
  if (!texCache.has(key)) {
    texCache.set(key, createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }).then((bmp) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false; // glTF texture convention, same as GLTFLoader
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = anisotropy;
      t.userData.shared = true;
      t.needsUpdate = true;
      return t;
    }));
  }
  return texCache.get(key);
}

export function forgetTextures(prefix) {
  for (const k of [...texCache.keys()]) if (k.startsWith(prefix)) texCache.delete(k);
}

/** Linear base colour factor, exactly as core/skin.js createMaterial computes it. */
export function baseFactor(def, color) {
  const tint = def.colorMode !== 'photo' && color?.hex;
  return tint ? hexToLinear(color.hex).map((c) => Math.min(1, c / (def.albedoMean || 1))) : [1, 1, 1];
}

/** MeshPhysicalMaterial matching the exported glTF material. getBlob(path) -> Blob. */
export async function makeThreeMaterial(def, color, getBlob, anisotropy) {
  const base = baseFactor(def, color);
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(base[0], base[1], base[2], THREE.LinearSRGBColorSpace),
    roughness: def.roughness ?? 1,
    metalness: def.metallic ?? 0,
  });
  const maps = def.maps || {};
  const [bc, nm, orm] = await Promise.all([
    maps.baseColor ? threeTexture(maps.baseColor, await getBlob(maps.baseColor), true, anisotropy) : null,
    maps.normal ? threeTexture(maps.normal, await getBlob(maps.normal), false, anisotropy) : null,
    maps.orm ? threeTexture(maps.orm, await getBlob(maps.orm), false, anisotropy) : null,
  ]);
  if (bc) m.map = bc;
  if (nm) { m.normalMap = nm; m.normalScale.set(def.normalScale ?? 1, def.normalScale ?? 1); }
  if (orm) {
    m.roughnessMap = orm;
    m.metalnessMap = orm;
    if (def.occlusion !== false) { m.aoMap = orm; m.aoMapIntensity = def.occlusionStrength ?? 1; }
  }
  if (def.sheen) {
    const k = def.sheen.intensity ?? 0.5;
    const tint = def.colorMode !== 'photo' && color?.hex;
    const s = (tint ? base : [0.5, 0.5, 0.5]).map((c) => Math.min(1, (c * 0.7 + 0.06) * k * 2));
    m.sheen = 1;
    m.sheenColor.setRGB(s[0], s[1], s[2], THREE.LinearSRGBColorSpace);
    m.sheenRoughness = def.sheen.roughness ?? 0.6;
  }
  if (def.clearcoat) {
    m.clearcoat = def.clearcoat.factor ?? 1;
    m.clearcoatRoughness = def.clearcoat.roughness ?? 0.1;
  }
  return m;
}

// ---------- swatches ----------

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LUT = new Float32Array(256).map((_, i) => toLin(i / 255));
const swatchCache = new Map();

async function pixels(blob, sx, sy, sw, sh, size) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx * bmp.width, sy * bmp.height, sw * bmp.width, sh * bmp.height, 0, 0, size, size);
  bmp.close();
  return g.getImageData(0, 0, size, size).data;
}

/**
 * A small lit square of the material in the given colour (data URL).
 * Shows about 7 cm of the surface so leather grain or weave is visible.
 */
export async function swatch(def, color, getBlob, size = 160) {
  const key = `${def.id}|${def.rev || 0}|${color?.hex || ''}|${size}`;
  if (swatchCache.has(key)) return swatchCache.get(key);
  const p = (async () => {
    const base = baseFactor(def, color);
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const out = img.data;
    const maps = def.maps || {};
    const frac = Math.min(1, 7 / (def.tileCm || 25));
    const [alb, nrm] = await Promise.all([
      maps.baseColor ? pixels(await getBlob(maps.baseColor), 0.1, 0.1, frac, frac * (def.tileCm || 25) / (def.tileHeightCm || def.tileCm || 25), size) : null,
      maps.normal ? pixels(await getBlob(maps.normal), 0.1, 0.1, frac, frac * (def.tileCm || 25) / (def.tileHeightCm || def.tileCm || 25), size) : null,
    ]);
    const L = [-0.55, 0.6, 0.58], lLen = Math.hypot(...L);
    const rough = def.roughness ?? 1, metal = def.metallic ?? 0;
    const coat = def.clearcoat ? def.clearcoat.factor ?? 1 : 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        let nx = 0, ny = 0, nz = 1;
        if (nrm) {
          const s = (def.normalScale ?? 1) * 1.6; // exaggerate a little: the swatch is tiny
          nx = ((nrm[i] / 255) * 2 - 1) * s; ny = ((nrm[i + 1] / 255) * 2 - 1) * s; nz = (nrm[i + 2] / 255) * 2 - 1;
          const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        }
        // gentle pillow shape so flat colours still read as a surface
        const u = x / size - 0.5, v = y / size - 0.5;
        const ndl = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / lLen);
        const shade = 0.28 + 0.8 * ndl - 0.3 * (u * u + v * v);
        const spec = Math.pow(Math.max(0, 1 - Math.hypot(u + 0.18, v + 0.22) * (1.2 + 3 * (1 - rough))), 2) * (0.5 * (1 - rough) + coat * 0.35);
        for (let k = 0; k < 3; k++) {
          const a = alb ? LUT[alb[i + k]] : 1;
          let lin = a * base[k] * shade;
          lin += spec * (metal ? base[k] : 1);
          out[i + k] = Math.round(Math.min(1, toSrgb(Math.max(0, lin))) * 255);
        }
        out[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return URL.createObjectURL(blob);
  })();
  swatchCache.set(key, p);
  return p;
}

export function forgetSwatches(id) {
  for (const k of [...swatchCache.keys()]) if (k.startsWith(`${id}|`)) swatchCache.delete(k);
}
