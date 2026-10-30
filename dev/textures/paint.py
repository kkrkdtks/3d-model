# Paint a wooden plinth into a colour texture: the UV triangles from dump_band.mjs get a wood colour.
# usage: python3 paint.py model.glb band.bin out.jpg
import numpy as np, sys, io, json, struct
from PIL import Image, ImageDraw
glb = open(sys.argv[1], 'rb').read()
# pull the baseColor image out of the GLB (JSON chunk + BIN chunk)
jlen = struct.unpack_from('<I', glb, 12)[0]
js = json.loads(glb[20:20 + jlen])
bin_off = 20 + jlen + 8
mat = js['materials'][0]
tex = js['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]
img = js['images'][tex['source']]
bv = js['bufferViews'][img['bufferView']]
data = glb[bin_off + bv.get('byteOffset', 0): bin_off + bv.get('byteOffset', 0) + bv['byteLength']]
im = Image.open(io.BytesIO(data)).convert('RGB').resize((2048, 2048), Image.LANCZOS)
uv = np.frombuffer(open(sys.argv[2], 'rb').read(), dtype=np.float32).reshape(-1, 3, 2)
mask = Image.new('L', im.size, 0)
d = ImageDraw.Draw(mask)
S = 2048
for t in uv:
    pts = [((u % 1) * S, (v % 1) * S) for u, v in t]
    d.polygon(pts, fill=255)
rng = np.random.default_rng(1)
walnut = np.zeros((S, S, 3), np.float32)
grain = rng.normal(0, 1, (S, 1)).astype(np.float32) * 10
walnut[:] = np.array([92, 58, 34], np.float32)
walnut += grain[:, :, None] * np.array([1, 0.7, 0.5], np.float32)
walnut += rng.normal(0, 4, (S, S, 1)).astype(np.float32)
base = np.asarray(im, np.float32)
m = (np.asarray(mask, np.float32) / 255)[:, :, None]
out = base * (1 - m) + np.clip(walnut, 0, 255) * m
Image.fromarray(out.astype(np.uint8)).save(sys.argv[3], quality=92)
print('painted', int(m.sum()), 'px')
