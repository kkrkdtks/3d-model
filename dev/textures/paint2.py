# Stress textures: (a) glossy highlights all over, (b) wide stripes (patterned fabric), (c) strong dark shading
import numpy as np, sys, io, json, struct
from PIL import Image, ImageFilter
glb = open(sys.argv[1], 'rb').read()
jlen = struct.unpack_from('<I', glb, 12)[0]
js = json.loads(glb[20:20 + jlen]); bin_off = 20 + jlen + 8
mat = js['materials'][0]; tex = js['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]
bv = js['bufferViews'][js['images'][tex['source']]['bufferView']]
data = glb[bin_off + bv.get('byteOffset', 0): bin_off + bv.get('byteOffset', 0) + bv['byteLength']]
S = 2048
base = np.asarray(Image.open(io.BytesIO(data)).convert('RGB').resize((S, S), Image.LANCZOS), np.float32)
rng = np.random.default_rng(2)
# (a) highlights: 300 soft white blobs of 6..40 px
hl = np.zeros((S, S), np.float32)
yy, xx = np.mgrid[0:S, 0:S]
for _ in range(300):
    cx, cy, r = rng.integers(0, S), rng.integers(0, S), rng.integers(6, 40)
    x0, x1, y0, y1 = max(0, cx - 2 * r), min(S, cx + 2 * r), max(0, cy - 2 * r), min(S, cy + 2 * r)
    d2 = (xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2
    hl[y0:y1, x0:x1] = np.maximum(hl[y0:y1, x0:x1], np.exp(-d2 / (2 * r * r)))
a = base * (1 - hl[:, :, None] * 0.85) + 245 * hl[:, :, None] * 0.85
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2] + '_highlights.jpg', quality=92)
# (b) stripes in texture space (beige / navy, 64 px period) - a strong two-colour pattern everywhere
stripes = ((xx // 32) % 2).astype(np.float32)[:, :, None]
beige = np.array([200, 180, 150], np.float32)
b = base * (1 - stripes) + (beige * (0.5 + base / 255)) * stripes
Image.fromarray(np.clip(b, 0, 255).astype(np.uint8)).save(sys.argv[2] + '_stripes.jpg', quality=92)
# (c) heavy random dark shading (multiplicative blotches down to 10%)
sh = Image.fromarray((rng.random((64, 64)) * 255).astype(np.uint8)).resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(20))
shf = 0.1 + 0.9 * (np.asarray(sh, np.float32) / 255)[:, :, None]
Image.fromarray(np.clip(base * shf, 0, 255).astype(np.uint8)).save(sys.argv[2] + '_shading.jpg', quality=92)
print('ok')
