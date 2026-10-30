# Realistic stress textures painted in 3D: (d) glossy leather highlights from a light, (e) high-contrast 3D stripes
import numpy as np, sys, io, json, struct, time
from PIL import Image, ImageDraw
glb = open(sys.argv[1], 'rb').read()
jlen = struct.unpack_from('<I', glb, 12)[0]
js = json.loads(glb[20:20 + jlen]); bin_off = 20 + jlen + 8
mat = js['materials'][0]; tex = js['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]
bv = js['bufferViews'][js['images'][tex['source']]['bufferView']]
data = glb[bin_off + bv.get('byteOffset', 0): bin_off + bv.get('byteOffset', 0) + bv['byteLength']]
S = 2048
base = np.asarray(Image.open(io.BytesIO(data)).convert('RGB').resize((S, S), Image.LANCZOS), np.float32)
F = np.fromfile(sys.argv[2], dtype=np.float32).reshape(-1, 12)
uv, n, c = F[:, :6].reshape(-1, 3, 2), F[:, 6:9], F[:, 9:12]
def raster(values):
    im = Image.new('L', (S, S), 0); d = ImageDraw.Draw(im)
    t = time.time()
    pts = (uv % 1) * S
    for tri, val in zip(pts, values):
        d.polygon([tuple(p) for p in tri], fill=int(val))
    print('raster', round(time.time() - t), 's')
    return np.asarray(im, np.float32)[:, :, None] / 255
# (d) gloss: Blinn-Phong highlight, light from upper front left, viewer in front
L = np.array([-0.4, 1.0, 0.6]); L /= np.linalg.norm(L)
V = np.array([0.0, 0.35, 1.0]); V /= np.linalg.norm(V)
H = (L + V) / np.linalg.norm(L + V)
s = 0.8 * np.clip(n @ H, 0, 1) ** 6
g = raster(s * 255)
out = base * (1 - g) + 238 * g
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(sys.argv[3] + '_gloss.jpg', quality=92)
print('gloss mean', float(g.mean()), 'p95', float(np.percentile(s, 95)))
# (e) stripes in 3D: cream / navy, 4 cm period along x (model ~1.8 m per unit)
period = 0.04 / 1.8
st = ((np.floor(c[:, 0] / (period / 2)) % 2) * 255)
m = raster(st)
cream = np.array([232, 222, 200], np.float32)
out = base * (1 - m) + cream * m
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(sys.argv[3] + '_stripes3d.jpg', quality=92)
print('ok')
