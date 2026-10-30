# Synthetic furniture as one fused, watertight mesh (signed distance field + surface nets), the way
# photo-to-3D tools produce them. Writes <name>.glb plus <name>.labels.json: per-vertex element and role.
import json, struct, sys, io, os
import numpy as np
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__)) + '/models'
os.makedirs(OUT, exist_ok=True)

# ---- distance functions on broadcast coordinate arrays ----
def box(c, h, r=0.004):
    c = np.asarray(c, np.float32); h = np.asarray(h, np.float32)
    def f(X, Y, Z):
        qx = np.abs(X - c[0]) - (h[0] - r); qy = np.abs(Y - c[1]) - (h[1] - r); qz = np.abs(Z - c[2]) - (h[2] - r)
        out = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
        return out + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0) - r
    f.bounds = (c - h, c + h)
    return f

def ybox(x0, x1, y0, y1, z0, z1, r=0.004):
    return box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), ((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2), r)

def cyl(cx, cz, y0, y1, rad):
    def f(X, Y, Z):
        dr = np.sqrt((X - cx) ** 2 + (Z - cz) ** 2) - rad
        dy = np.abs(Y - (y0 + y1) / 2) - (y1 - y0) / 2
        return np.minimum(np.maximum(dr, dy), 0) + np.sqrt(np.maximum(dr, 0) ** 2 + np.maximum(dy, 0) ** 2)
    f.bounds = (np.array([cx - rad, y0, cz - rad]), np.array([cx + rad, y1, cz + rad]))
    return f

def capsule(a, b, ra, rb=None):
    a = np.asarray(a, np.float32); b = np.asarray(b, np.float32); rb = ra if rb is None else rb
    ba = b - a; L2 = float(ba @ ba)
    def f(X, Y, Z):
        px, py, pz = X - a[0], Y - a[1], Z - a[2]
        t = np.clip((px * ba[0] + py * ba[1] + pz * ba[2]) / L2, 0, 1)
        d = np.sqrt((px - t * ba[0]) ** 2 + (py - t * ba[1]) ** 2 + (pz - t * ba[2]) ** 2)
        return d - (ra + (rb - ra) * t)
    r = max(ra, rb)
    f.bounds = (np.minimum(a, b) - r, np.maximum(a, b) + r)
    return f

def torus(cx, cy, cz, R, r):
    def f(X, Y, Z):
        q = np.sqrt((X - cx) ** 2 + (Z - cz) ** 2) - R
        return np.sqrt(q ** 2 + (Y - cy) ** 2) - r
    f.bounds = (np.array([cx - R - r, cy - r, cz - R - r]), np.array([cx + R + r, cy + r, cz + R + r]))
    return f

def smin(a, b, k):
    if k <= 0: return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)

# ---- surface nets ----
def surface_nets(field, origin, step):
    s = field < 0
    nx, ny, nz = field.shape
    C = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    def corner(i, j, k, a): return a[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k]
    cnt = sum(corner(*c, s).astype(np.int8) for c in C)
    active = (cnt > 0) & (cnt < 8)
    acc = np.zeros(active.shape + (3,), np.float32); num = np.zeros(active.shape, np.int8)
    E = []
    for j in (0, 1):
        for k in (0, 1): E.append(((0, j, k), (1, j, k)))
    for i in (0, 1):
        for k in (0, 1): E.append(((i, 0, k), (i, 1, k)))
    for i in (0, 1):
        for j in (0, 1): E.append(((i, j, 0), (i, j, 1)))
    for a, b in E:
        fa, fb = corner(*a, field), corner(*b, field)
        m = (fa < 0) != (fb < 0)
        t = np.where(m, fa / np.where(m, fa - fb, 1), 0).astype(np.float32)
        for d in range(3):
            acc[..., d] += np.where(m, a[d] + t * (b[d] - a[d]), 0)
        num += m
    idx = -np.ones(active.shape, np.int64)
    ii = np.nonzero(active)
    idx[ii] = np.arange(len(ii[0]))
    verts = (np.stack(ii, -1) + acc[ii] / num[ii][:, None]) * step + origin
    quads = []
    # x edges: cells (i, j-1..j, k-1..k)
    sx = s[:-1, 1:-1, 1:-1] != s[1:, 1:-1, 1:-1]; inside_low = s[:-1, 1:-1, 1:-1]
    i, j, k = np.nonzero(sx); j = j + 1; k = k + 1
    q = np.stack([idx[i, j - 1, k - 1], idx[i, j, k - 1], idx[i, j, k], idx[i, j - 1, k]], -1)
    flip = ~inside_low[i, j - 1, k - 1]; q[flip] = q[flip][:, ::-1]; quads.append(q)
    sy = s[1:-1, :-1, 1:-1] != s[1:-1, 1:, 1:-1]; inside_low = s[1:-1, :-1, 1:-1]
    i, j, k = np.nonzero(sy); i = i + 1; k = k + 1
    q = np.stack([idx[i - 1, j, k - 1], idx[i - 1, j, k], idx[i, j, k], idx[i, j, k - 1]], -1)
    flip = ~inside_low[i - 1, j, k - 1]; q[flip] = q[flip][:, ::-1]; quads.append(q)
    sz = s[1:-1, 1:-1, :-1] != s[1:-1, 1:-1, 1:]; inside_low = s[1:-1, 1:-1, :-1]
    i, j, k = np.nonzero(sz); i = i + 1; j = j + 1
    q = np.stack([idx[i - 1, j - 1, k], idx[i, j - 1, k], idx[i, j, k], idx[i - 1, j, k]], -1)
    flip = ~inside_low[i - 1, j - 1, k]; q[flip] = q[flip][:, ::-1]; quads.append(q)
    q = np.concatenate(quads)
    assert (q >= 0).all()
    tris = np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]])
    return verts.astype(np.float32), tris.astype(np.uint32)

def build(elements, step, k):
    lo = np.min([e[2].bounds[0] for e in elements], 0) - 3 * step
    hi = np.max([e[2].bounds[1] for e in elements], 0) + 3 * step
    n = np.ceil((hi - lo) / step).astype(int) + 1
    xs = lo[0] + np.arange(n[0], dtype=np.float32) * step
    ys = (lo[1] + np.arange(n[1], dtype=np.float32) * step)[None, :, None]
    zs = (lo[2] + np.arange(n[2], dtype=np.float32) * step)[None, None, :]
    field = np.empty(tuple(n), np.float32)
    for x0 in range(0, n[0], 24):
        X = xs[x0:x0 + 24][:, None, None]
        d = None
        for e in elements:
            v = e[2](X, ys, zs)
            d = v if d is None else smin(d, v, k)
        field[x0:x0 + 24] = d
    verts, tris = surface_nets(field, lo, step)
    # element of every vertex: the nearest one
    X, Y, Z = verts[:, 0], verts[:, 1], verts[:, 2]
    D = np.stack([e[2](X, Y, Z) for e in elements], -1)
    return verts, tris, np.argmin(D, -1)

def write_glb(path, verts, tris, rgb=(118, 118, 118)):
    nv = len(verts)
    normals = np.zeros_like(verts)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    for col in range(3): np.add.at(normals, tris[:, col], fn)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    uv = np.stack([verts[:, 0] + verts[:, 2], verts[:, 1]], -1).astype(np.float32)
    img = Image.new('RGB', (64, 64), rgb); bio = io.BytesIO(); img.save(bio, 'PNG'); png = bio.getvalue()
    blobs = [verts.astype(np.float32).tobytes(), normals.astype(np.float32).tobytes(), uv.tobytes(), tris.astype(np.uint32).tobytes(), png]
    views, off, binbuf = [], 0, b''
    for bl in blobs:
        pad = (-len(binbuf)) % 4; binbuf += b'\0' * pad; off = len(binbuf)
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(bl)}); binbuf += bl
    binbuf += b'\0' * ((-len(binbuf)) % 4)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'furn-test'},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': os.path.basename(path)}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3, 'material': 0}]}],
        'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.8}}],
        'textures': [{'source': 0, 'sampler': 0}], 'samplers': [{}], 'images': [{'bufferView': 4, 'mimeType': 'image/png'}],
        'buffers': [{'byteLength': len(binbuf)}], 'bufferViews': views,
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': nv, 'type': 'VEC3', 'min': verts.min(0).tolist(), 'max': verts.max(0).tolist()},
            {'bufferView': 1, 'componentType': 5126, 'count': nv, 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5126, 'count': nv, 'type': 'VEC2'},
            {'bufferView': 3, 'componentType': 5125, 'count': int(tris.size), 'type': 'SCALAR'},
        ],
    }
    js = json.dumps(gltf).encode(); js += b' ' * ((-len(js)) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)))
        fh.write(struct.pack('<II', len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack('<II', len(binbuf), 0x004E4942)); fh.write(binbuf)

# ---- the furniture: (name, role, sdf); role base | body | frame (frame: either is fine) ----
def table_4legs():
    E = [('top', 'body', ybox(-0.8, 0.8, 0.72, 0.75, -0.45, 0.45))]
    E += [('apron', 'frame', ybox(-0.70, 0.70, 0.64, 0.72, z - 0.01, z + 0.01)) for z in (-0.37, 0.37)]
    E += [('apron', 'frame', ybox(x - 0.01, x + 0.01, 0.64, 0.72, -0.37, 0.37)) for x in (-0.72, 0.72)]
    E += [('leg', 'base', ybox(x - 0.025, x + 0.025, 0, 0.72, z - 0.025, z + 0.025)) for x in (-0.72, 0.72) for z in (-0.37, 0.37)]
    return E

def table_noapron():
    E = [('top', 'body', ybox(-0.8, 0.8, 0.72, 0.75, -0.45, 0.45))]
    E += [('leg', 'base', capsule((x, 0, z), (x * 0.93, 0.72, z * 0.9), 0.018, 0.026)) for x in (-0.7, 0.7) for z in (-0.36, 0.36)]
    return E

def table_trestle():
    E = [('top', 'body', ybox(-0.8, 0.8, 0.72, 0.75, -0.45, 0.45, r=0.006))]
    for x in (-0.62, 0.62):
        E += [('post', 'base', ybox(x - 0.02, x + 0.02, 0.0, 0.72, z - 0.02, z + 0.02, r=0.003)) for z in (-0.34, 0.34)]
        E += [('foot', 'base', ybox(x - 0.02, x + 0.02, 0.0, 0.04, -0.36, 0.36, r=0.003)),
              ('bar', 'frame', ybox(x - 0.02, x + 0.02, 0.68, 0.72, -0.36, 0.36, r=0.003))]
    return E

def table_pedestal():
    return [('top', 'body', cyl(0, 0, 0.72, 0.75, 0.6)), ('column', 'base', cyl(0, 0, 0.03, 0.72, 0.05)), ('foot', 'base', cyl(0, 0, 0.0, 0.035, 0.3))]

def coffee_shelf():
    E = [('top', 'body', ybox(-0.6, 0.6, 0.36, 0.40, -0.3, 0.3)), ('shelf', 'frame', ybox(-0.55, 0.55, 0.10, 0.12, -0.25, 0.25))]
    E += [('leg', 'base', ybox(x - 0.02, x + 0.02, 0, 0.36, z - 0.02, z + 0.02)) for x in (-0.56, 0.56) for z in (-0.26, 0.26)]
    return E

def chair_rungs():
    E = [('seat', 'body', ybox(-0.23, 0.23, 0.42, 0.47, -0.23, 0.23, r=0.008)),
         ('backrest', 'body', ybox(-0.21, 0.21, 0.62, 0.87, -0.225, -0.20, r=0.006))]
    E += [('leg', 'base', ybox(x - 0.018, x + 0.018, 0, 0.42, z - 0.018, z + 0.018)) for x in (-0.20, 0.20) for z in (-0.20, 0.20)]
    E += [('post', 'body', ybox(x - 0.018, x + 0.018, 0.47, 0.90, -0.218, -0.182)) for x in (-0.20, 0.20)]
    E += [('rung', 'base', ybox(x - 0.01, x + 0.01, 0.14, 0.16, -0.20, 0.20)) for x in (-0.20, 0.20)]
    E += [('rung', 'base', ybox(-0.20, 0.20, 0.14, 0.16, 0.19, 0.21))]
    return E

def stool_bar():
    E = [('seat', 'body', cyl(0, 0, 0.72, 0.77, 0.2))]
    E += [('leg', 'base', capsule((x * 0.2, 0, z * 0.2), (x * 0.11, 0.73, z * 0.11), 0.016)) for x in (-1, 1) for z in (-1, 1)]
    E += [('ring', 'base', torus(0, 0.28, 0, 0.165, 0.011))]
    return E

def armchair_legs():
    E = [('base', 'body', ybox(-0.40, 0.40, 0.15, 0.40, -0.40, 0.40, r=0.03)),
         ('cushion', 'body', ybox(-0.28, 0.28, 0.40, 0.52, -0.22, 0.40, r=0.04)),
         ('back', 'body', ybox(-0.40, 0.40, 0.40, 0.85, -0.40, -0.22, r=0.05))]
    E += [('arm', 'body', ybox(x - 0.06, x + 0.06, 0.40, 0.65, -0.40, 0.40, r=0.04)) for x in (-0.34, 0.34)]
    E += [('leg', 'base', capsule((x, 0, z), (x * 0.95, 0.17, z * 0.95), 0.014, 0.022)) for x in (-0.33, 0.33) for z in (-0.33, 0.33)]
    return E

def sofa(legs):
    y0 = 0.12 if legs else 0.0
    E = [('base', 'body', ybox(-1.0, 1.0, y0, y0 + 0.25, -0.45, 0.45, r=0.03))]
    E += [('cushion', 'body', ybox(x - 0.42, x + 0.42, y0 + 0.25, y0 + 0.42, -0.25, 0.45, r=0.05)) for x in (-0.43, 0.43)]
    E += [('back', 'body', ybox(-1.0, 1.0, y0 + 0.25, y0 + 0.72, -0.45, -0.25, r=0.06))]
    E += [('arm', 'body', ybox(x - 0.08, x + 0.08, y0, y0 + 0.55, -0.45, 0.45, r=0.05)) for x in (-0.92, 0.92)]
    if legs: E += [('leg', 'base', ybox(x - 0.02, x + 0.02, 0, 0.13, z - 0.02, z + 0.02, r=0.004)) for x in (-0.93, 0, 0.93) for z in (-0.38, 0.38)]
    return E

def bed_legs():
    E = [('frame', 'body', ybox(-0.82, 0.82, 0.12, 0.37, -1.05, 1.05, r=0.02)),
         ('mattress', 'body', ybox(-0.78, 0.78, 0.37, 0.59, -0.98, 1.02, r=0.06)),
         ('headboard', 'body', ybox(-0.82, 0.82, 0.12, 1.12, -1.13, -1.05, r=0.03))]
    E += [('leg', 'base', cyl(x, z, 0, 0.13, 0.025)) for x in (-0.76, 0.76) for z in (-1.0, 0.0, 1.0)]
    return E

def sideboard(kind):
    if kind == 'legs':
        E = [('cabinet', 'body', ybox(-0.8, 0.8, 0.2, 0.8, -0.22, 0.22, r=0.006))]
        E += [('leg', 'base', capsule((x, 0, z), (x, 0.21, z), 0.013, 0.02)) for x in (-0.74, 0.74) for z in (-0.17, 0.17)]
    elif kind == 'plinth':
        E = [('cabinet', 'body', ybox(-0.8, 0.8, 0.08, 0.8, -0.22, 0.22, r=0.006)), ('plinth', 'base', ybox(-0.76, 0.76, 0, 0.09, -0.19, 0.19, r=0.003))]
    else:
        E = [('cabinet', 'body', ybox(-0.8, 0.8, 0.09, 0.8, -0.22, 0.22, r=0.006)), ('plinth', 'base', ybox(-0.8, 0.8, 0, 0.08, -0.22, 0.22, r=0.006)),
             ('joint', 'frame', ybox(-0.79, 0.79, 0.075, 0.095, -0.21, 0.21, r=0.002))]
    return E

def desk_drawers():
    return [('top', 'body', ybox(-0.7, 0.7, 0.72, 0.75, -0.35, 0.35)), ('drawers', 'frame', ybox(0.25, 0.65, 0.0, 0.72, -0.30, 0.30, r=0.005)),
            ('leg', 'base', ybox(-0.67, -0.63, 0, 0.72, -0.32, -0.28)), ('leg', 'base', ybox(-0.67, -0.63, 0, 0.72, 0.28, 0.32))]

def bookshelf():
    E = [('side', 'frame', ybox(x - 0.01, x + 0.01, 0, 1.8, -0.15, 0.15, r=0.003)) for x in (-0.41, 0.41)]
    E += [('shelf', 'body', ybox(-0.40, 0.40, y, y + 0.02, -0.15, 0.15, r=0.003)) for y in (0.06, 0.42, 0.78, 1.14, 1.50, 1.78)]
    E += [('back', 'frame', ybox(-0.40, 0.40, 0.06, 1.8, -0.15, -0.14, r=0.002))]
    return E

def side_table():
    E = [('top', 'body', cyl(0, 0, 0.50, 0.53, 0.25))]
    E += [('leg', 'base', capsule((0.22 * np.cos(a), 0, 0.22 * np.sin(a)), (0.15 * np.cos(a), 0.51, 0.15 * np.sin(a)), 0.012, 0.016)) for a in (0, 2.0944, 4.18879)]
    return E

def bench_legs():
    E = [('seat', 'body', ybox(-0.6, 0.6, 0.38, 0.46, -0.2, 0.2, r=0.03)), ('frame', 'frame', ybox(-0.58, 0.58, 0.33, 0.39, -0.18, 0.18, r=0.004))]
    E += [('leg', 'base', ybox(x - 0.02, x + 0.02, 0, 0.34, z - 0.02, z + 0.02)) for x in (-0.54, 0.54) for z in (-0.14, 0.14)]
    return E

MODELS = {
    'table_4legs': (table_4legs, 0.005), 'table_noapron': (table_noapron, 0.005), 'table_trestle': (table_trestle, 0.005),
    'table_pedestal': (table_pedestal, 0.005), 'coffee_shelf': (coffee_shelf, 0.004), 'chair_rungs': (chair_rungs, 0.004),
    'stool_bar': (stool_bar, 0.004), 'armchair_legs': (armchair_legs, 0.005), 'sofa_legs': (lambda: sofa(True), 0.006),
    'sofa_flush': (lambda: sofa(False), 0.006), 'bed_legs': (bed_legs, 0.007), 'sideboard_legs': (lambda: sideboard('legs'), 0.005),
    'sideboard_plinth': (lambda: sideboard('plinth'), 0.005), 'sideboard_flush': (lambda: sideboard('flush'), 0.005),
    'desk_drawers': (desk_drawers, 0.005), 'bookshelf': (bookshelf, 0.005), 'side_table': (side_table, 0.004), 'bench_legs': (bench_legs, 0.005),
}

def canopy_bed():
    E = bed_legs()
    E += [('post', 'body', cyl(x, z, 0.0, 2.0, 0.03)) for x in (-0.82, 0.82) for z in (-1.1, 1.05)]
    E += [('canopy', 'body', ybox(-0.86, 0.86, 1.96, 2.0, -1.14, 1.09, r=0.005))]
    return E

def etagere():
    E = [('board', 'body', ybox(-0.4, 0.4, y, y + 0.02, -0.2, 0.2, r=0.003)) for y in (0.15, 0.5, 0.85)]
    E += [('leg', 'base', ybox(x - 0.012, x + 0.012, 0, 0.87, z - 0.012, z + 0.012, r=0.002)) for x in (-0.39, 0.39) for z in (-0.19, 0.19)]
    return E

def armchair_dining():
    E = chair_rungs()
    E += [('arm', 'body', ybox(x - 0.02, x + 0.02, 0.64, 0.67, -0.21, 0.20, r=0.006)) for x in (-0.22, 0.22)]
    E += [('armpost', 'body', ybox(x - 0.012, x + 0.012, 0.47, 0.65, 0.17, 0.195)) for x in (-0.22, 0.22)]
    return E

def tub_chair():
    def body(X, Y, Z):
        # a rounded tub: ellipsoid-ish block, flattened bottom at 0.18
        d = np.sqrt((X / 0.38) ** 2 + ((Y - 0.42) / 0.30) ** 2 + (Z / 0.36) ** 2) - 1
        return np.maximum(d * 0.3, 0.16 - Y)
    body.bounds = (np.array([-0.4, 0.1, -0.38]), np.array([0.4, 0.74, 0.38]))
    E = [('tub', 'body', body)]
    E += [('leg', 'base', capsule((x, 0, z), (x * 0.9, 0.2, z * 0.9), 0.012, 0.018)) for x in (-0.22, 0.22) for z in (-0.2, 0.2)]
    return E

def console_drawer():
    E = [('top', 'body', ybox(-0.6, 0.6, 0.76, 0.79, -0.2, 0.2)), ('drawer', 'frame', ybox(-0.5, 0.5, 0.62, 0.76, -0.16, 0.16, r=0.004))]
    E += [('leg', 'base', ybox(x - 0.02, x + 0.02, 0, 0.76, z - 0.02, z + 0.02)) for x in (-0.55, 0.55) for z in (-0.17, 0.17)]
    return E

MODELS.update({'canopy_bed': (canopy_bed, 0.008), 'etagere': (etagere, 0.004), 'armchair_dining': (armchair_dining, 0.004),
               'tub_chair': (tub_chair, 0.005), 'console_drawer': (console_drawer, 0.004), 'table_tilted': (table_4legs, 0.005)})

if __name__ == '__main__':
    names = sys.argv[1:] or list(MODELS)
    k = float(os.environ.get('K', '0.012'))
    suffix = os.environ.get('SUFFIX', '')
    for name in names:
        fn, step = MODELS[name]
        E = fn()
        verts, tris, elem = build(E, step, k)
        if name == 'table_tilted':
            a = np.radians(1.5); c, sn = np.cos(a), np.sin(a)
            x, y = verts[:, 0].copy(), verts[:, 1].copy(); verts[:, 0] = c * x - sn * y; verts[:, 1] = sn * x + c * y
        write_glb(f'{OUT}/{name}{suffix}.glb', verts, tris)
        names_ = [e[0] for e in E]; roles = [e[1] for e in E]
        with open(f'{OUT}/{name}{suffix}.labels.json', 'w') as fh:
            json.dump({'elements': names_, 'roles': roles, 'vertexElement': elem.tolist()}, fh)
        vol = np.einsum('ij,ij->i', verts[tris[:, 0]], np.cross(verts[tris[:, 1]], verts[tris[:, 2]])).sum() / 6
        print(name, 'verts', len(verts), 'tris', len(tris), 'volume', round(float(vol), 4), flush=True)
