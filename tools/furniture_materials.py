"""Furniture surface materials for the built-in library: seamless PBR textures made from the
structure of each material (yarns and weaves, pile, grain cells, growth rings and pores, stone
veins, brushing marks), neutral in colour so the hex chip gives the colour.

    python tools/furniture_materials.py              # every material -> materials/<id>/ + library.json
    python tools/furniture_materials.py fabric-boucle wood-oak   # only these
    python tools/furniture_materials.py --preview out/   # PNG previews only, library untouched

Each generator returns maps at its own resolution: albedo (0..1, display values, neutral grey),
height (any units; turned into a normal map with the material's strength), roughness, ao and
optionally metal. Maps that come out flat are left out and their value goes into the factors.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


# ---------------------------------------------------------------- periodic fields

def _freqs(n):
    f = np.fft.fftfreq(n) * n
    return f[None, :], f[:, None]


def band(n, rng, lo, hi, ex=1.0, ey=1.0, beta=1.0, angle=0.0):
    """Periodic band-limited noise in [-1, 1]; lo/hi in cycles per tile. ex > 1 squeezes the x
    frequencies so features stretch along x (ey likewise along y); angle (degrees) turns that x
    direction (the filter acts on the tile's own frequency grid, so the noise still tiles)."""
    fx, fy = _freqs(n)
    if angle:
        c, s_ = np.cos(np.radians(angle)), np.sin(np.radians(angle))
        fx, fy = c * fx + s_ * fy, -s_ * fx + c * fy
    f = np.sqrt((fx * ex) ** 2 + (fy * ey) ** 2) + 1e-9
    mid, width = np.log(np.sqrt(lo * hi)), 0.5 * np.log(hi / lo) + 0.3
    g = np.exp(-((np.log(f) - mid) ** 2) / (2 * width ** 2)) / f ** beta
    g[0, 0] = 0
    out = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((n, n))) * g))
    out -= out.mean()
    return (out / (np.abs(out).max() + 1e-12)).astype(np.float32)


def blur(a, rx, ry=None):
    """Periodic gaussian blur, radii in pixels (ry defaults to rx)."""
    ry = rx if ry is None else ry
    n0, n1 = a.shape
    fy = np.fft.fftfreq(n0)[:, None]
    fx = np.fft.fftfreq(n1)[None, :]
    g = np.exp(-2 * np.pi ** 2 * ((rx * fx) ** 2 + (ry * fy) ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g)).astype(np.float32)


def warp(a, dx, dy):
    """a sampled at (x + dx, y + dy), wrapping around the tile."""
    n0, n1 = a.shape
    ys, xs = np.mgrid[0:n0, 0:n1].astype(np.float32)
    return ndimage.map_coordinates(a, [ys + dy, xs + dx], order=1, mode='grid-wrap').astype(np.float32)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def worley(n, cells, rng, jitter=1.0, aniso=1.0, metric='e', dx=None, dy=None):
    """Periodic Worley noise on a cells x cells grid: F1, F2 (in cell units) and cell id.
    aniso > 1 stretches the cells along x; metric 'c' gives square (Chebyshev) cells."""
    pts = 0.5 + (rng.random((cells, cells, 2)) - 0.5) * jitter
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xs + 0.5) / n * cells
    y = (ys + 0.5) / n * cells
    if dx is not None:
        x = x + dx
        y = y + dy
    cx = np.floor(x).astype(np.int32)
    cy = np.floor(y).astype(np.int32)
    F1 = np.full((n, n), 9.0, np.float32)
    F2 = F1.copy()
    ID = np.zeros((n, n), np.int32)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            gx, gy = cx + ox, cy + oy
            p = pts[gy % cells, gx % cells]
            ddx = (gx + p[..., 0] - x) / aniso
            ddy = gy + p[..., 1] - y
            d = np.maximum(np.abs(ddx), np.abs(ddy)) if metric == 'c' else np.sqrt(ddx ** 2 + ddy ** 2)
            closer = d < F1
            F2 = np.where(closer, F1, np.minimum(F2, d))
            ID = np.where(closer, (gy % cells) * cells + (gx % cells), ID)
            F1 = np.minimum(F1, d)
    return F1, F2, ID


def cavity(h, r):
    """How far a point sits below its surroundings (0 on tops, 1 in the deepest creases)."""
    c = blur(h, r) - h
    return np.clip(c / (np.percentile(np.abs(c), 99.5) + 1e-9), 0, 1)


def norm01(a, lo=0.5, hi=99.5):
    p0, p1 = np.percentile(a, [lo, hi])
    return np.clip((a - p0) / (p1 - p0 + 1e-12), 0, 1).astype(np.float32)


def downsample(a, k):
    """Box-filter a by an integer factor (for supersampled thin structures)."""
    if k == 1:
        return a
    n0, n1 = a.shape[:2]
    return a.reshape(n0 // k, k, n1 // k, k, *a.shape[2:]).mean(axis=(1, 3))


# ---------------------------------------------------------------- yarns and weaves

def weave(n, rng, up, nx, ny, yarn=(0.86, 0.86), amp=0.32, thick=0.55, wobble=0.18, slub=0.0,
          fibre=0.06, hair=0.0, tone=(1.0, 1.0), tone_var=0.03, fleck=0.0, twist=(2.5, 0.35),
          gap=-0.6, melange=0.0):
    """Woven cloth: warp yarns run along y (nx of them across the tile), weft along x (ny).
    up(i, j) -> True where warp i passes over weft j. Returns height, albedo, which (1 = warp)."""
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    X = (xs + 0.5) / n * nx + wobble * band(n, rng, 2, 9)
    Y = (ys + 0.5) / n * ny + wobble * band(n, rng, 2, 9)
    i = np.floor(X).astype(np.int32)
    j = np.floor(Y).astype(np.int32)
    a, b = X - i, Y - j

    def updown(ii, jj):
        return np.where(up(ii % nx, jj % ny), 1.0, -1.0).astype(np.float32)

    # each yarn bends over and under the yarns it crosses (cosine between crossing centres)
    tw = Y - 0.5
    k0 = np.floor(tw).astype(np.int32)
    u = tw - k0
    s = 0.5 - 0.5 * np.cos(np.pi * u)
    zw = (1 - s) * updown(i, k0) + s * updown(i, k0 + 1)
    tf = X - 0.5
    m0 = np.floor(tf).astype(np.int32)
    v = tf - m0
    s2 = 0.5 - 0.5 * np.cos(np.pi * v)
    zf = -((1 - s2) * updown(m0, j) + s2 * updown(m0 + 1, j))

    # thickness changes along each yarn (slubs): noise read along the yarn's own centre line
    col = ((i + 0.5) / nx * n).astype(np.int32) % n
    row = ((j + 0.5) / ny * n).astype(np.int32) % n
    Sw = band(n, rng, 6, 40, ey=0.5)
    Sf = band(n, rng, 6, 40, ex=0.5)
    ww = yarn[0] * (1 + slub * Sw[ys.astype(np.int32), col])
    wf = yarn[1] * (1 + slub * Sf[row, xs.astype(np.int32)])
    pw = np.clip(1 - ((a - 0.5) / (ww / 2)) ** 2, 0, 1) ** 0.5
    pf = np.clip(1 - ((b - 0.5) / (wf / 2)) ** 2, 0, 1) ** 0.5
    Hw = np.where(pw > 0, amp * zw + thick * pw, -9)
    Hf = np.where(pf > 0, amp * zf + thick * pf, -9)
    which = (Hw >= Hf).astype(np.float32)
    H = np.maximum(np.maximum(Hw, Hf), gap)

    # fibres twisted round each yarn: fine streaks at a slant along the yarn
    fw = band(n, rng, n / 10, n / 3, ex=1.0, ey=twist[0])
    ff = band(n, rng, n / 10, n / 3, ex=twist[0], ey=1.0)
    fw = warp(fw, (a - 0.5) * twist[1] * n / nx, 0)
    ff = warp(ff, 0, (b - 0.5) * twist[1] * n / ny)
    fib = np.where(which > 0, fw, ff)
    H = H + fibre * fib
    if hair:
        H = H + hair * band(n, rng, n / 8, n / 2.5)

    # colour: warp/weft tone, thread-to-thread variation, mélange and flecks
    tw_i = 1 + tone_var * rng.standard_normal(nx)[i % nx]
    tf_j = 1 + tone_var * rng.standard_normal(ny)[j % ny]
    alb = np.where(which > 0, tone[0] * tw_i, tone[1] * tf_j)
    if melange:
        alb = alb * (1 + melange * np.sign(fib) * np.abs(fib) ** 0.5)
    if fleck:
        Bw, Bf = band(n, rng, 8, 60, ey=0.35), band(n, rng, 8, 60, ex=0.35)
        Fw = (Bw / (Bw.std() + 1e-9))[ys.astype(np.int32), col]
        Ff = (Bf / (Bf.std() + 1e-9))[row, xs.astype(np.int32)]
        F = np.where(which > 0, Fw, Ff)
        alb = alb * (1 + fleck * (smoothstep(1.5, 2.3, F) - 0.8 * smoothstep(1.6, 2.4, -F)))
    top = np.where(which > 0, pw, pf)
    alb = alb * (0.86 + 0.14 * top)
    alb = np.where(H <= gap + 1e-6, alb * 0.45, alb)
    return H.astype(np.float32), alb.astype(np.float32), which


def plain(i, j):
    return ((i + j) % 2) == 0


def twill(k=2):
    return lambda i, j: ((i + j) % (2 * k)) < k


def herringbone(k=2, block=8):
    def up(i, j):
        flip = (i // block) % 2 == 1
        d = np.where(flip, -i + block - 1 + k, i)
        return ((d + j) % (2 * k)) < k
    return up


def basket(k=2):
    return lambda i, j: ((i // k + j // k) % 2) == 0


def fabric_maps(H, alb, rough, sheen_ao=0.55, ao_r=6):
    h = norm01(H)
    ao = 1 - sheen_ao * cavity(H, ao_r)
    return dict(albedo=np.clip(alb * (0.85 + 0.15 * ao), 0, None), height=h, roughness=rough, ao=ao)


def gen_canvas(n=2048, seed=21):
    rng = np.random.default_rng(seed)
    H, alb, w = weave(n, rng, plain, 84, 80, yarn=(0.92, 0.9), amp=0.28, thick=0.6, slub=0.08,
                      fibre=0.05, hair=0.015, tone_var=0.02, twist=(3, 0.45))
    rough = 0.9 - 0.05 * norm01(H)
    alb = alb * (1 + 0.025 * band(n, rng, 1.5, 6))
    return fabric_maps(H, alb, rough, 0.6, 4)


def gen_herringbone(n=2048, seed=22):
    rng = np.random.default_rng(seed)
    # two-tone yarns, about 1.2 mm apart, turning every 12 mm: the zigzag reads from a step away
    H, alb, w = weave(n, rng, herringbone(2, 10), 60, 60, yarn=(0.95, 0.93), amp=0.25, thick=0.6,
                      slub=0.1, fibre=0.07, hair=0.03, tone=(0.62, 1.0), tone_var=0.03, twist=(3, 0.5),
                      melange=0.06)
    rough = 0.92 - 0.04 * norm01(H)
    return fabric_maps(H, alb, rough, 0.55, 5)


def gen_tweed(n=2048, seed=23):
    rng = np.random.default_rng(seed)
    H, alb, w = weave(n, rng, twill(2), 56, 56, yarn=(0.98, 0.98), amp=0.24, thick=0.65, slub=0.25,
                      fibre=0.1, hair=0.1, tone=(0.84, 1.0), tone_var=0.07, fleck=0.6, twist=(2.2, 0.6),
                      melange=0.2, wobble=0.22)
    rough = 0.95 - 0.03 * norm01(H)
    return fabric_maps(H, alb, rough, 0.55, 6)


def gen_basket_rattan(n=2048, seed=24):
    """Woven rattan (wicker): round reeds over and under each other with open gaps."""
    rng = np.random.default_rng(seed)
    H, alb, w = weave(n, rng, basket(1), 14, 14, yarn=(0.8, 0.8), amp=0.45, thick=0.9, slub=0.05,
                      fibre=0.0, tone=(0.95, 1.0), tone_var=0.06, twist=(8, 0.05), gap=-1.2, wobble=0.08)
    # glossy reed skin with lengthwise streaks and nodes
    streak = np.where(w > 0, band(n, rng, 20, 120, ey=6), band(n, rng, 20, 120, ex=6))
    alb = alb * (1 + 0.06 * streak)
    open_ = H <= -1.2 + 1e-6
    rough = np.where(open_, 0.9, 0.42 - 0.08 * norm01(H) + 0.05 * streak)
    out = fabric_maps(H, alb, rough, 0.7, 10)
    out['albedo'] = np.where(open_, 0.08, out['albedo'])
    return out


def gen_chenille(n=2048, seed=25, tile_cm=8, rows=56):
    """Chenille: soft pile yarns ("caterpillars") lying side by side along x, each a fuzzy round
    cord of short fibres standing out from its core; slubs make the cords swell and thin."""
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    Y = (ys + 0.5) / n * rows + 0.12 * band(n, rng, 1.5, 6, ex=5)
    j = np.floor(Y).astype(np.int32)
    b = Y - j
    row = ((j + 0.5) / rows * n).astype(np.int32) % n
    sl = band(n, rng, 4, 30, ey=0.4)[row, xs.astype(np.int32)]
    half = 0.5 * (0.9 + 0.12 * sl)
    prof = np.clip(1 - ((b - 0.5) / half) ** 2, 0, 1) ** 0.6
    # fibres stand across the cord (stretched along y), plus loose fibre ends everywhere
    fib = band(n, rng, n / 7, n / 2.5, ey=2.5)
    fuzz = band(n, rng, n / 6, n / 2.2)
    H = prof + 0.3 * fib * prof + 0.2 * fuzz
    tone = 1 + 0.03 * rng.standard_normal(rows).astype(np.float32)[j % rows]
    alb = (0.84 + 0.16 * prof) * tone * (1 + 0.05 * fib) * (1 + 0.02 * band(n, rng, 1.5, 6))
    rough = 0.86 + 0.04 * fuzz
    return fabric_maps(H, alb, rough, 0.55, 8)


def gen_corduroy(n=2048, seed=26, wales=12):
    """Corduroy: straight rounded ribs (wales) of cut pile along y with narrow sunk channels; the
    pile has a fine nap and catches light along the ribs."""
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    X = (xs + 0.5) / n * wales + 0.006 * band(n, rng, 2, 6, ey=4)
    a = X - np.floor(X)
    rib = np.clip(np.sin(np.pi * np.clip((a - 0.06) / 0.88, 0, 1)), 0, 1) ** 0.45
    nap = band(n, rng, n / 7, n / 2.5) + 0.6 * band(n, rng, n / 30, n / 10, ey=3.0)
    H = rib + 0.12 * nap
    alb = (0.7 + 0.3 * rib) * (1 + 0.04 * nap) * (1 + 0.02 * band(n, rng, 1.5, 5, ey=3))
    rough = 0.8 + 0.08 * (1 - rib)
    return fabric_maps(H, alb, rough, 0.5, 10)


def gen_velvet(n=2048, seed=27):
    """Velvet: short dense pile; shading comes from the sheen, the pile only ripples and gets
    crushed into soft lighter and darker patches."""
    rng = np.random.default_rng(seed)
    crush = band(n, rng, 1.5, 7)
    crush = warp(crush, 18 * band(n, rng, 2, 6), 18 * band(n, rng, 2, 6))
    pile = band(n, rng, n / 6, n / 2.2)
    flow = band(n, rng, 6, 30, ex=2.0)
    H = 0.05 * pile + 0.25 * crush + 0.08 * flow
    alb = 1 + 0.07 * crush + 0.02 * pile + 0.025 * flow
    rough = 0.72 + 0.08 * crush
    ao = 1 - 0.08 * smoothstep(0.1, 0.9, -crush)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


def _stamp_loops(n, rng, count, r_mm, t_mm, px_mm, base=None, lift_map=None, arc_range=(0.55, 1.0),
                 asp_range=(0.55, 1.0)):
    """Loops of yarn: small rings and arcs piled on each other (highest wins). Returns the height
    and the tone of the loop on top. lift_map (0..1) raises loops where it is high."""
    H = np.full((n, n), -0.2, np.float32) if base is None else base.copy()
    T = np.ones((n, n), np.float32)
    for _ in range(count):
        r = r_mm * (0.6 + 0.8 * rng.random()) / px_mm
        t = t_mm * (0.75 + 0.5 * rng.random()) / px_mm
        asp = rng.uniform(*asp_range)
        rot = rng.random() * np.pi
        arc0, arc = rng.random() * 2 * np.pi, rng.uniform(*arc_range) * 2 * np.pi
        cx, cy = rng.random() * n, rng.random() * n
        lift = 0.55 + 0.45 * rng.random()
        if lift_map is not None:
            lift = lift * (0.35 + 0.65 * lift_map[int(cy) % n, int(cx) % n])
        tilt = (rng.random() - 0.5) * 0.6
        tone = 1 + 0.06 * rng.standard_normal()
        R = int(r + t + 2)
        x0, y0 = int(cx) - R, int(cy) - R
        yy, xx = np.mgrid[0:2 * R + 1, 0:2 * R + 1].astype(np.float32)
        dx, dy = xx + x0 - cx, yy + y0 - cy
        c, s_ = np.cos(rot), np.sin(rot)
        u, v = (c * dx + s_ * dy), (-s_ * dx + c * dy) / asp
        rho = np.sqrt(u * u + v * v)
        ang = (np.arctan2(v, u) - arc0) % (2 * np.pi)
        d = np.abs(rho - r)
        prof = np.clip(1 - (d / t) ** 2, 0, 1) ** 0.5
        prof = prof * (ang < arc) * smoothstep(0, 0.35, np.minimum(ang, arc - ang))
        h = np.where(prof > 0, prof * (lift + tilt * u / max(r, 1)), -9)
        iy = (np.arange(y0, y0 + 2 * R + 1) % n)[:, None]
        ix = (np.arange(x0, x0 + 2 * R + 1) % n)[None, :]
        cur = H[iy, ix]
        top = h > cur
        H[iy, ix] = np.where(top, h, cur)
        T[iy, ix] = np.where(top, tone, T[iy, ix])
    return H, T


def gen_boucle(n=2048, seed=28, tile_cm=10):
    """Bouclé: a solid cover of small yarn loops and curls (1-2 mm) piled on each other."""
    rng = np.random.default_rng(seed)
    px = tile_cm * 10 / n
    H0, _, _ = weave(n, rng, plain, 60, 60, yarn=(0.9, 0.9), amp=0.2, thick=0.4, fibre=0.03)
    base = 0.25 * norm01(H0) - 0.4
    H, T = _stamp_loops(n, rng, 7000, 1.1, 0.42, px, base)
    fuzz = band(n, rng, n / 8, n / 2.5)
    H = H + 0.05 * fuzz
    top = norm01(H)
    alb = (0.68 + 0.32 * top) * T * (1 + 0.03 * fuzz) * (1 + 0.025 * band(n, rng, 2, 8))
    rough = 0.94 - 0.03 * top
    return fabric_maps(H, alb, rough, 0.6, 6)


def gen_teddy(n=2048, seed=29, tile_cm=10):
    """Teddy / faux shearling: dense fine curly fibres gathered into soft rounded clumps 4-6 mm
    across, with shadowed hollows between the clumps."""
    rng = np.random.default_rng(seed)
    px = tile_cm * 10 / n
    # soft irregular tufts (no cell outlines): smooth blobs 3-6 mm across
    b = band(n, rng, 16, 34)
    clump = smoothstep(-0.9, 1.3, b / (b.std() + 1e-9))
    clump = blur(clump, 2)
    H, T = _stamp_loops(n, rng, 26000, 0.55, 0.13, px, np.full((n, n), -0.3, np.float32), lift_map=clump,
                        arc_range=(0.3, 0.8), asp_range=(0.5, 1.0))
    fib = band(n, rng, n / 6, n / 2.2)
    H = 0.8 * H + 0.45 * clump + 0.04 * fib
    top = norm01(H)
    alb = (0.86 + 0.14 * top) * (1 + 0.35 * (T - 1))
    rough = 0.9 - 0.04 * top
    return fabric_maps(H, alb, rough, 0.5, 8)


def gen_microfiber(n=2048, seed=30):
    """Performance microfibre (easy-clean sofa cloth): a fine brushed nap with soft light and dark
    patches where the nap lies one way or the other."""
    rng = np.random.default_rng(seed)
    nap = band(n, rng, n / 6, n / 2.2)
    brush = band(n, rng, 2, 9)
    brush = warp(brush, 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    streak = band(n, rng, 30, 120, ex=3.5)
    W, _, _ = weave(n, rng, twill(2), 400, 400, yarn=(0.95, 0.95), amp=0.2, thick=0.4, fibre=0.05, wobble=0.1)
    H = 0.15 * nap + 0.3 * brush + 0.06 * streak + 0.12 * norm01(W)
    alb = 1 + 0.05 * brush + 0.015 * streak + 0.012 * nap + 0.02 * norm01(W)
    rough = 0.82 + 0.05 * brush
    return dict(albedo=alb, height=H, roughness=rough, ao=1 - 0.05 * smoothstep(0, 1, -brush))


# ---------------------------------------------------------------- leather

def gen_semi_aniline(n=2048, seed=41):
    """Semi-aniline: natural full grain (fine irregular cells), growth wrinkles, light cloudy tone."""
    rng = np.random.default_rng(seed)
    w1 = (0.5 * band(n, rng, 3, 12), 0.5 * band(n, rng, 3, 12))
    F1, F2, ID = worley(n, 110, rng, jitter=1.0, aniso=1.25, dx=w1[0], dy=w1[1])
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.8
    wr = band(n, rng, 3, 14, ex=3.0)
    wr = warp(wr, 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    wrinkle = np.exp(-(wr / 0.07) ** 2)
    pores = smoothstep(0.6, 0.95, band(n, rng, n / 8, n / 3))
    H = 0.18 * blur(cell, 0.8) - 0.5 * blur(wrinkle, 2.0) + 0.35 * band(n, rng, 1.5, 6) - 0.04 * pores
    cloud = band(n, rng, 1.5, 8)
    alb = 1 + 0.05 * cloud - 0.04 * blur(wrinkle, 1.5) - 0.02 * (1 - cell) - 0.02 * pores
    rough = 0.48 + 0.06 * (1 - cell) + 0.05 * blur(wrinkle, 1.5) + 0.03 * cloud
    ao = 1 - 0.12 * blur(wrinkle, 1.5) - 0.06 * (1 - cell)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


def gen_pu(n=2048, seed=42):
    """Synthetic (PU) leather: an even, shallow embossed grain repeated without natural marks."""
    rng = np.random.default_rng(seed)
    F1, F2, ID = worley(n, 96, rng, jitter=0.75, aniso=1.1)
    cell = smoothstep(0.0, 0.45, F2 - F1) ** 0.7
    H = blur(cell, 0.9) + 0.04 * band(n, rng, n / 6, n / 2.5)
    alb = 1 - 0.025 * (1 - cell)
    rough = 0.36 + 0.06 * (1 - cell)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=1 - 0.06 * (1 - cell))


def gen_croc(n=2048, seed=43, tile_cm=22):
    """Croc-embossed leather (belly pattern): rows of domed rectangular scales of uneven size,
    separated by deep narrow grooves; fine creases on the scales, darker grooves."""
    rng = np.random.default_rng(seed)
    L = tile_cm * 10.0
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    X = (xs + 0.5) / n * L + 2.5 * band(n, rng, 2, 6)
    Y = (ys + 0.5) / n * L + 2.5 * band(n, rng, 2, 6)
    # belly: wide scales in the middle of the hide, narrower toward the flanks
    X = X - 0.28 * L / (2 * np.pi) * np.sin(2 * np.pi * X / L)
    Xm, Ym = np.mod(X, L), np.mod(Y, L)
    R = int(round(L / 19))
    rh = rng.uniform(14, 25, R)
    yb = np.concatenate([[0], np.cumsum(rh / rh.sum() * L)])
    j = np.clip(np.searchsorted(yb, Ym, side='right') - 1, 0, R - 1)
    yc = (yb[j] + yb[j + 1]) / 2
    hh = (yb[j + 1] - yb[j]) / 2
    dY = Ym - yc
    xc = np.zeros_like(X)
    hw = np.zeros_like(X)
    sid = np.zeros(X.shape, np.int32)
    for r in range(R):
        C = max(3, int(round(L / rng.uniform(18, 30))))
        cw = rng.uniform(0.7, 1.3, C)
        xb = np.concatenate([[0], np.cumsum(cw / cw.sum() * L)])
        off = rng.random() * L
        on = j == r
        xr = np.mod(Xm[on] + off, L)
        c = np.clip(np.searchsorted(xb, xr, side='right') - 1, 0, C - 1)
        xc[on] = (xb[c] + xb[c + 1]) / 2 - off
        hw[on] = (xb[c + 1] - xb[c]) / 2
        sid[on] = r * 64 + c
    dX = np.mod(Xm - xc + L / 2, L) - L / 2
    groove, rad = 0.9, 4.0
    qx = np.abs(dX) - (hw - groove - rad)
    qy = np.abs(dY) - (hh - groove - rad)
    d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rad
    inner = smoothstep(0.0, 2.8, -d)
    bulge = 1 + 0.25 * (1 - np.clip((dX / hw) ** 2 + (dY / hh) ** 2, 0, 2) / 2)
    tone = 1 + 0.045 * rng.standard_normal(R * 64).astype(np.float32)[sid]
    crease = band(n, rng, 30, 120)
    crease = np.exp(-(crease / 0.08) ** 2)
    pebble = band(n, rng, n / 12, n / 5)
    H = inner ** 0.6 * bulge - 0.06 * crease * inner + 0.02 * band(n, rng, n / 6, n / 2.5) + 0.012 * pebble / (pebble.std() + 1e-9) * inner
    edge = 1 - smoothstep(0.0, 1.6, -d)
    alb = (1 - 0.17 * edge - 0.03 * crease) * tone
    rough = 0.3 + 0.22 * edge + 0.05 * crease
    ao = 1 - 0.45 * edge
    return dict(albedo=alb, height=blur(H, 1.0), roughness=rough, ao=ao)


# ---------------------------------------------------------------- stone

def fbm(n, rng, f0, octaves=5, gain=0.5, ex=1.0, angle=0.0):
    """Sum of band noise octaves from f0 cycles per tile up, each scaled to unit spread."""
    out = np.zeros((n, n), np.float32)
    amp, tot = 1.0, 0.0
    for k in range(octaves):
        f = f0 * 2 ** k
        if f > n / 3:
            break
        b = band(n, rng, f, 2 * f, ex=ex, angle=angle)
        out += amp * b / (b.std() + 1e-9)
        tot += amp
        amp *= gain
    return out / tot


def flowveins(n, rng, lo, hi, stretch, angle, warp_px, width_px, wvar=0.6):
    """Marble veins: thin lines along the zero crossings of noise stretched along the flow
    direction (angle, degrees), bent by a slow warp. Width (pixels at 1024) wanders along each vein."""
    k = n / 1024
    f = band(n, rng, lo, hi, ex=stretch, angle=angle)
    if warp_px:
        f = warp(f, k * warp_px * band(n, rng, 1.5, 6), k * warp_px * band(n, rng, 1.5, 6))
    gy, gx = np.gradient(f)
    d = np.abs(f) / (np.hypot(gx, gy) + 1e-7)
    w = k * width_px * np.exp(wvar * 1.5 * band(n, rng, 1.5, 6))
    return np.exp(-(d / w) ** 2).astype(np.float32)


def gen_marble_carrara(n=2048, seed=51):
    """Carrara: grey-white with many soft grey veins running one way, cloudy grey haze round them."""
    rng = np.random.default_rng(seed)
    k = n / 1024
    cloud = fbm(n, rng, 1.5, 5, 0.55)
    v1 = flowveins(n, rng, 2, 5, 7, 30, 40, 1.0)
    v2 = flowveins(n, rng, 4, 12, 5, 40, 25, 0.7)
    v3 = flowveins(n, rng, 10, 30, 3, 22, 10, 0.5)
    i1 = smoothstep(-0.7, 0.5, band(n, rng, 1.2, 4))
    i2 = smoothstep(-0.5, 0.6, band(n, rng, 1.5, 5))
    i3 = smoothstep(-0.2, 0.8, band(n, rng, 2, 6))
    haze = blur(v1 * i1, 14 * k) + 0.7 * blur(v2 * i2, 8 * k)
    alb = (0.92 + 0.04 * cloud - 0.26 * v1 * i1 - 0.17 * v2 * i2 - 0.09 * v3 * i3
           - 0.34 * haze / (haze.max() + 1e-9) - 0.04 * smoothstep(0.3, 1.6, cloud))
    return dict(albedo=alb, height=None, roughness=0.08 + 0.02 * v1, ao=None, ref='median')


def gen_marble_calacatta(n=2048, seed=52):
    """Calacatta: bright white with a few bold, uneven veins and finer ones branching near them."""
    rng = np.random.default_rng(seed)
    k = n / 1024
    cloud = fbm(n, rng, 1.2, 4, 0.5)
    v1 = flowveins(n, rng, 1.2, 3, 3, 40, 60, 2.4, wvar=0.8)
    v2 = flowveins(n, rng, 3, 9, 3, 55, 30, 0.8)
    v3 = flowveins(n, rng, 8, 24, 2, 30, 12, 0.5)
    i1 = smoothstep(-0.5, 0.5, band(n, rng, 1.2, 3))
    near = blur(v1 * i1, 30 * k)
    near = near / (near.max() + 1e-9)
    i2 = np.clip(1.6 * near + 0.25 * smoothstep(0.2, 0.9, band(n, rng, 1.5, 5)), 0, 1)
    haze = blur(v1 * i1, 10 * k)
    alb = (0.95 + 0.02 * cloud - 0.45 * v1 * i1 - 0.2 * v2 * i2 - 0.08 * v3 * i2
           - 0.22 * haze / (haze.max() + 1e-9))
    return dict(albedo=alb, height=None, roughness=0.07 + 0.02 * v1, ao=None, ref='median')


def gen_marble_nero(n=2048, seed=56):
    """Nero Marquina: black with crisp white veins and a web of finer ones (chip colour = the black)."""
    rng = np.random.default_rng(seed)
    k = n / 1024
    cloud = fbm(n, rng, 1.5, 5, 0.5)
    v1 = flowveins(n, rng, 1.5, 4, 3, -35, 35, 1.4, wvar=0.8)
    v2 = flowveins(n, rng, 3, 9, 2.5, -55, 25, 0.8)
    v3 = flowveins(n, rng, 6, 18, 2, -20, 15, 0.55)
    v4 = flowveins(n, rng, 12, 36, 1.5, 10, 8, 0.45)
    i1 = smoothstep(-0.8, 0.3, band(n, rng, 1.2, 4))
    near = blur(v1 * i1, 30 * k)
    near = near / (near.max() + 1e-9)
    i2 = np.clip(1.4 * near + 0.4 * smoothstep(-0.1, 0.8, band(n, rng, 1.5, 5)), 0, 1)
    i3 = smoothstep(-0.2, 0.7, band(n, rng, 1.5, 5))
    white = np.clip(1.0 * v1 * i1 + 0.75 * v2 * i2 + 0.5 * v3 * i3 + 0.28 * v4 * i2, 0, 1)
    glow = blur(white, 4 * k)
    alb = 0.12 + 0.02 * cloud + 0.8 * white + 0.1 * glow / (glow.max() + 1e-9)
    return dict(albedo=alb, height=None, roughness=0.06 + 0.03 * white, ao=None, ref='median')


def gen_marble_emperador(n=2048, seed=54):
    """Emperador: brown breccia, fragments of slightly different tone held in a web of light
    calcite veins of every thickness."""
    rng = np.random.default_rng(seed)
    k = n / 1024
    mott = fbm(n, rng, 2, 5, 0.6)
    light = np.zeros((n, n), np.float32)
    tone = np.zeros((n, n), np.float32)
    for j, (c, wv, a) in enumerate(((7, 0.035, 0.9), (18, 0.025, 0.6), (45, 0.02, 0.3))):
        wx = 0.35 * band(n, rng, 2, 8) + 0.1 * band(n, rng, 8, 30)
        wy = 0.35 * band(n, rng, 2, 8) + 0.1 * band(n, rng, 8, 30)
        F1, F2, ID = worley(n, c, rng, dx=wx * c / 7, dy=wy * c / 7)
        width = wv * np.exp(0.7 * band(n, rng, 2, 8) * 1.5)
        e = np.exp(-((F2 - F1) / width) ** 2)
        keep = smoothstep(-0.5, 0.4, band(n, rng, 1.5, 6)) if j else 1.0
        light = np.maximum(light, a * e * keep)
        if j == 0:
            tone = 0.05 * rng.standard_normal(c * c).astype(np.float32)[ID]
    v = flowveins(n, rng, 2, 5, 3, 30, 40, 1.2)
    light = np.maximum(light, 0.8 * v * smoothstep(-0.3, 0.5, band(n, rng, 1.5, 4)))
    glow = blur(light, 6 * k)
    alb = 0.48 + 0.06 * mott + tone + 0.42 * light + 0.12 * glow / (glow.max() + 1e-9)
    return dict(albedo=alb, height=None, roughness=0.08 + 0.02 * light, ao=None, ref='median')


def gen_travertine(n=2048, seed=55, tile_cm=60):
    """Travertine, vein cut and honed, unfilled: stripes of cream and beige laid down in layers, with
    long open pits and small pores lying along the layers."""
    rng = np.random.default_rng(seed)
    L = tile_cm * 10.0
    lay = (1.0 * band(n, rng, 3, 12, ex=10) + 0.6 * band(n, rng, 10, 40, ex=12) + 0.35 * band(n, rng, 40, 160, ex=14))
    lay = warp(lay, 0, n / L * 6 * band(n, rng, 1.5, 5))
    lay = lay / (lay.std() + 1e-9)
    fy, fx = L / (2 * 1.6), L / (2 * 9.0)
    pf = band(n, rng, 0.6 * fy, 1.5 * fy, ex=fy / fx)
    pf = warp(pf, 0, n / L * 6 * band(n, rng, 1.5, 5))
    zone = smoothstep(-0.2, 0.9, band(n, rng, 2, 10, ex=8))
    pit = smoothstep(2.0, 2.7, pf / (pf.std() + 1e-9) + 0.7 * zone)
    fy2, fx2 = L / (2 * 4.0), L / (2 * 22.0)
    pb = band(n, rng, 0.6 * fy2, 1.5 * fy2, ex=fy2 / fx2)
    pb = warp(pb, 0, n / L * 6 * band(n, rng, 1.5, 5))
    pit = np.maximum(pit, smoothstep(2.5, 3.1, pb / (pb.std() + 1e-9) + 0.5 * zone))
    fp = L / (2 * 0.7)
    po = band(n, rng, 0.6 * fp, 1.5 * fp, ex=1.5)
    pore = smoothstep(2.3, 3.0, po / (po.std() + 1e-9)) * (0.4 + 0.6 * zone)
    hole = np.clip(pit + pore, 0, 1)
    alb = 0.88 + 0.07 * lay + 0.02 * band(n, rng, 1.5, 5) + 0.015 * band(n, rng, n / 6, n / 2.5)
    alb = alb * (1 - 0.35 * blur(hole, 0.8))
    H = -blur(hole, 1.0) + 0.02 * band(n, rng, n / 6, n / 2.5)
    rough = 0.5 + 0.35 * hole + 0.03 * lay / 3
    ao = 1 - 0.55 * blur(hole, 2.0)
    return dict(albedo=alb, height=H, roughness=rough, ao=ao, ref='median')


def gen_terrazzo(n=2048, seed=56, tile_cm=50):
    """Terrazzo: angular chips of marble in three sizes and many shades, set in a fine sanded matrix,
    ground flat and polished."""
    rng = np.random.default_rng(seed)
    alb = 0.93 + 0.015 * band(n, rng, 1.5, 6) + 0.02 * band(n, rng, n / 6, n / 2.5)
    alb = alb - 0.12 * smoothstep(2.4, 3.2, band(n, rng, n / 8, n / 3) / 0.25)
    chip = np.zeros((n, n), np.float32)
    tones = np.array([0.22, 0.42, 0.58, 0.7, 0.8, 0.92, 1.04, 1.08], np.float32)
    weights = np.array([0.08, 0.1, 0.14, 0.14, 0.14, 0.14, 0.13, 0.13])
    for cells, keep, (g0, g1) in ((12, 0.35, (0.28, 0.42)), (30, 0.45, (0.26, 0.4)), (80, 0.5, (0.24, 0.38))):
        wx, wy = 0.08 * band(n, rng, 4, 16), 0.08 * band(n, rng, 4, 16)
        F1, F2, ID = worley(n, cells, rng, jitter=1.0, dx=wx * cells / 10, dy=wy * cells / 10)
        m = cells * cells
        gap = rng.uniform(g0, g1, m).astype(np.float32)[ID]
        tone = rng.choice(tones, m, p=weights / weights.sum())[ID]
        on = (rng.random(m) < keep)[ID] & ((F2 - F1) > gap) & (chip == 0)
        chip = np.where(on, 1.0, chip)
        alb = np.where(on, tone * (0.97 + 0.03 * band(n, rng, 40, 160)), alb)
    alb = blur(alb, 0.6)
    return dict(albedo=alb, height=None, roughness=0.12 - 0.02 * blur(chip, 1), ao=None, ref='median')


def gen_ceramic(n=2048, seed=57):
    """Matte sintered-stone / ceramic slab: soft cloudy stone look with fine speckle."""
    rng = np.random.default_rng(seed)
    cloud = band(n, rng, 1.2, 6)
    mid = band(n, rng, 6, 30)
    spk = band(n, rng, n / 6, n / 2.2)
    dots = smoothstep(0.55, 0.8, spk) - smoothstep(0.55, 0.8, -spk)
    alb = 0.82 + 0.05 * cloud + 0.02 * mid + 0.05 * dots
    H = 0.6 * band(n, rng, n / 8, n / 3) + 0.4 * mid
    return dict(albedo=alb, height=norm01(H), roughness=0.5 + 0.03 * mid, ao=None, ref='median')


def gen_concrete(n=2048, seed=58):
    """Concrete / micro-cement: trowelled clouds, fine sand and small air pores."""
    rng = np.random.default_rng(seed)
    cloud = band(n, rng, 1.2, 6)
    trowel = warp(band(n, rng, 3, 12, ex=3), 40 * band(n, rng, 1.5, 5), 40 * band(n, rng, 1.5, 5))
    sand = band(n, rng, n / 6, n / 2.2)
    pore = smoothstep(0.7, 0.9, band(n, rng, n / 14, n / 6))
    alb = 0.72 + 0.07 * cloud + 0.04 * trowel + 0.03 * sand - 0.25 * pore
    H = 0.3 * sand + 0.2 * trowel - 1.2 * pore
    rough = 0.7 + 0.05 * cloud + 0.15 * pore
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=1 - 0.3 * pore, ref='median')


# ---------------------------------------------------------------- wood

def gen_wood(n=2048, seed=61, tile=(120, 45), boards=3, ring=3.0, ring_var=0.5, contrast=0.12,
             late=(0.3, 0.95), porous='ring', pore=(4.0, 0.3), pore_k=1.0, pore_dark=0.35, rays=0.0,
             quarter=False, rotary=False, d0=(120, 280), cycles=(4, 9), wobble=1.0, streaks=0.0,
             board_tone=0.05, fingers=0, rough=0.5, seam=0.04):
    """Growth rings of a log cut by a board. x runs along the grain (tile[0] cm), y across (tile[1] cm).
    Flat-sawn: rings are cylinders round the pith at depth D under the face, so they show as nested
    arches ("cathedrals") where D changes along the board. Quarter-sawn: the face runs out from the
    pith, so rings are near-straight lines. Rotary (plywood face): the knife follows the rings, which
    show only where the log is uneven. Ring-porous woods (oak, ash) have a band of big pores at the
    start of each ring; diffuse-porous ones have small pores everywhere. Each board, or each stave
    piece between finger joints, is its own cut with its own tone."""
    rng = np.random.default_rng(seed)
    Lx, Ly = tile[0] * 10.0, tile[1] * 10.0
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    X, Y = (xs + 0.5) / n * Lx, (ys + 0.5) / n * Ly
    bw = Ly / boards
    b = np.minimum((Y // bw).astype(np.int32), boards - 1)
    yl = Y - (b + 0.5) * bw
    joint = None
    if fingers:
        # finger joints across each stave (pieces glued end to end): a zig-zag glue line
        pitch, depth = 3.8, 11.0
        zig = depth * (np.abs(((Y / pitch) % 1.0) - 0.5) - 0.25) * 2
        cuts = np.sort(rng.uniform(depth, Lx - depth, (boards, fingers)), axis=1)
        seg = np.zeros_like(b)
        joint = np.zeros_like(X)
        for k in range(fingers):
            xb = cuts[b, k] + zig
            seg = seg + (X > xb).astype(np.int32)
            joint = np.maximum(joint, np.exp(-((X - xb) / 0.25) ** 2))
        seg = seg % fingers
    else:
        seg = np.zeros_like(b)
    P = boards * max(1, fingers)
    pid = b * max(1, fingers) + seg

    def per(lo, hi):
        return rng.uniform(lo, hi, P).astype(np.float32)[pid]

    # Flat-sawn: a ring at radius r meets the face where D(x) + (y - y0)^2 / 2D0 = r (D = depth of the
    # pith under the face). The log tapers, so D grows along the board and the rings close into nested
    # arches ("cathedrals"). D grows by a whole number of rings over the tile, so the pattern repeats
    # without a seam; a slow wave in D spaces the arch tips unevenly.
    m = rng.integers(*cycles, P).astype(np.float32)[pid]
    sgn = np.where(rng.random(P) < 0.5, -1.0, 1.0).astype(np.float32)[pid]
    wav = per(0.1, 0.35) * Lx / (2 * np.pi)
    th = 2 * np.pi * (X / Lx + per(0, 1))
    taper = sgn * (m * ring * X / Lx + (m * ring / Lx) * wav * np.sin(th))
    drift = per(5, 20) * np.sin(2 * np.pi * (X / Lx + per(0, 1)))
    if rotary:
        # contour lines of a gently uneven log surface, stretched along the grain
        field = band(n, rng, 1.2, 4, ex=7.0) + 0.3 * band(n, rng, 3, 10, ex=6.0)
        r = d0[0] * field
    elif quarter:
        R0 = per(140, 260)
        beta = per(0, 0.25)
        r = (R0 + yl * np.cos(beta)) + (yl * np.sin(beta)) ** 2 / (2 * R0) + 0.15 * drift
    else:
        D0 = per(*d0)
        y0 = per(-0.4, 0.4) * bw + drift
        r = taper + (yl - y0) ** 2 / (2 * D0)
    # the log is not round: rings wander slowly along the grain, a little faster across it
    r = r + wobble * ring * (band(n, rng, 2, 10, ex=3.0) + 0.3 * band(n, rng, 10, 40, ex=3.0))
    # wider and narrower years, periodic over the m rings the tile spans
    pa, pb = rng.random(2) * 2 * np.pi
    kk = np.maximum(1, np.round(m / 6.0))
    ph = r / ring + ring_var * (0.5 * np.sin(2 * np.pi * r * kk / (m * ring) + pa) / (2 * np.pi * kk / m)
                                * 0.6 + 0.12 * np.sin(2 * np.pi * r * 3 * kk / (m * ring) + pb))
    k = np.floor(ph).astype(np.int32)
    t = ph - k
    rt = rng.standard_normal(4096).astype(np.float32)[(np.mod(k, m.astype(np.int32)) + 977 * pid) % 4096]
    # latewood: denser, darker towards the year's end; the ring boundary ramps over a few percent of
    # the ring so it does not stair-step
    lw = smoothstep(late[0], late[1], t) ** 1.4 * (1 - smoothstep(0.965, 1.0, t))
    alb = 1 - contrast * lw * (1 + 0.35 * rt) - 0.02 * rt
    # pores: dashes along the grain
    plen, pwid = pore
    fy, fx = Ly / (2 * pwid), Lx / (2 * plen)
    pn = band(n, rng, 0.7 * fy, 1.4 * fy, ex=fy / fx)
    pn = pn / (pn.std() + 1e-9)
    if porous == 'ring':
        ew = 1 - smoothstep(0.04, 0.3, t)
        pores = smoothstep(1.6 - 1.2 * ew, 2.4 - 1.0 * ew, pn) * (0.25 + 0.75 * ew)
    elif porous == 'semi':
        ew = 1 - smoothstep(0.1, 0.6, t)
        pores = smoothstep(1.5 - 0.6 * ew, 2.4 - 0.6 * ew, pn) * 0.85
    else:
        pores = smoothstep(1.5, 2.5, pn) * 0.7
    pores = pores * pore_k
    alb = alb * (1 - pore_dark * pores)
    H = -pores + 0.15 * lw
    R = rough + 0.12 * pores - 0.03 * lw
    if rays:
        if quarter:
            # ray flakes ("tiger stripes"): ribbons 1-6 cm long, slightly across the grain, lighter
            # and glossier than the wood round them
            fy2, fx2 = Ly / 16, Lx / 90
            fl = band(n, rng, 0.6 * fy2, 1.6 * fy2, ex=fy2 / fx2)
            fl = warp(fl, n / Lx * 12 * band(n, rng, 3, 12), n / Ly * 4 * band(n, rng, 3, 12))
            fl = fl / (fl.std() + 1e-9)
            ray = smoothstep(0.9, 1.6, fl) * smoothstep(-0.3, 0.6, band(n, rng, 2, 8))
            ray = blur(ray, 0.8)
            alb = alb * (1 + 0.3 * rays * ray)
            R = R - 0.12 * rays * ray
            H = H + 0.25 * ray
        else:
            # ray flecks: thin dark lines 5-25 mm along the grain
            fy2, fx2 = Ly / 1.0, Lx / 24
            rf = band(n, rng, 0.7 * fy2, 1.4 * fy2, ex=fy2 / fx2)
            ray = smoothstep(2.0, 3.0, rf / (rf.std() + 1e-9))
            alb = alb * (1 - 0.3 * rays * ray)
    if streaks:
        fy3, fx3 = Ly / 30, Lx / 800
        st = band(n, rng, 0.6 * fy3, 2.0 * fy3, ex=fy3 / fx3)
        alb = alb * (1 - streaks * smoothstep(0.1, 0.8, st))
    alb = alb * (1 + 0.035 * band(n, rng, 1.5, 6, ex=3.0))
    # fibres: faint fine streaks along the grain
    fy4, fx4 = Ly / 0.6, Lx / 30
    alb = alb * (1 + 0.025 * band(n, rng, 0.5 * fy4, 1.5 * fy4, ex=fy4 / fx4))
    alb = alb * (1 + board_tone * rng.standard_normal(P).astype(np.float32)[pid])
    if boards > 1 and seam:
        e = np.abs(Y / bw - np.round(Y / bw)) * bw
        alb = alb * (1 - seam * np.exp(-(e / 0.15) ** 2))
    if joint is not None:
        alb = alb * (1 - 0.45 * joint)
        H = H - 0.6 * joint
    return dict(albedo=alb.astype(np.float32), height=H.astype(np.float32), roughness=R.astype(np.float32),
                ao=None, ref='mean')


# ---------------------------------------------------------------- paint and metal

def gen_powder(n=1024, seed=71):
    """Powder coat: gentle orange-peel waviness."""
    rng = np.random.default_rng(seed)
    H = band(n, rng, 10, 40) + 0.3 * band(n, rng, 40, 120)
    return dict(albedo=None, height=norm01(H), roughness=0.42 + 0.03 * band(n, rng, 10, 40), ao=None)


def gen_sand_paint(n=1024, seed=72):
    """Fine-texture paint: sharp little grains of sand under the coat."""
    rng = np.random.default_rng(seed)
    g = band(n, rng, n / 8, n / 2.5)
    grains = smoothstep(0.2, 0.7, g)
    H = grains + 0.4 * band(n, rng, 30, 100)
    return dict(albedo=1 - 0.03 * grains, height=norm01(H), roughness=0.72 - 0.06 * grains, ao=1 - 0.08 * (1 - grains))


def gen_hairline(n=2048, seed=73):
    """Hairline stainless: unbroken fine lines along x, a little uneven in depth."""
    rng = np.random.default_rng(seed)
    lines = rng.standard_normal((n, 1)).astype(np.float32)
    lines = blur(np.repeat(lines, n, 1), 0.0, 0.7)
    lines = lines / (np.abs(lines).max() + 1e-9)
    along = 1 + 0.3 * band(n, rng, 2, 10, ex=0.2)
    scratch = band(n, rng, n / 4, n / 2, ex=40.0)
    H = lines * along + 0.25 * scratch
    rough = 0.24 + 0.05 * np.abs(lines)
    return dict(albedo=1 + 0.03 * lines, height=norm01(H), roughness=rough, ao=None, metal=1.0)


def gen_blast(n=1024, seed=74):
    """Bead-blasted metal: an even satin of tiny dents; reads as a soft matte sheen."""
    rng = np.random.default_rng(seed)
    H = band(n, rng, n / 6, n / 2.2) + 0.2 * band(n, rng, n / 16, n / 6)
    return dict(albedo=1 + 0.01 * band(n, rng, n / 6, n / 2.2), height=H,
                roughness=0.44 + 0.02 * band(n, rng, 2, 8), ao=None, metal=1.0)


def gen_hammered(n=2048, seed=75):
    """Hand-hammered metal: overlapping round dents (spherical caps) meeting in soft ridges."""
    rng = np.random.default_rng(seed)
    wx, wy = 0.12 * band(n, rng, 3, 10), 0.12 * band(n, rng, 3, 10)
    F1, F2, ID = worley(n, 15, rng, jitter=0.95, dx=wx, dy=wy)
    rad = 0.8 * (1 + 0.2 * rng.standard_normal(225).astype(np.float32)[ID])
    dent = -np.sqrt(np.clip(rad ** 2 - F1 ** 2, 0, None))
    H = blur(dent, 1.5) + 0.01 * band(n, rng, n / 8, n / 3)
    rough = 0.22 + 0.03 * band(n, rng, 4, 20) + 0.04 * smoothstep(0.0, 0.12, 0.12 - (F2 - F1))
    return dict(albedo=1 + 0.012 * band(n, rng, 2, 10), height=H, roughness=rough, ao=None, metal=1.0)


def gen_antique(n=2048, seed=76):
    """Aged (antique) metal: a dark patina gathered in patches and soft blotches, the raised
    surface rubbed brighter, a faint brushing underneath."""
    rng = np.random.default_rng(seed)
    pat = fbm(n, rng, 2, 5, 0.55)
    pat = warp(pat, 20 * band(n, rng, 2, 8), 20 * band(n, rng, 2, 8))
    spots = smoothstep(1.2, 2.2, fbm(n, rng, 12, 3, 0.5))
    dark = np.clip(smoothstep(-0.2, 1.0, pat) * 0.85 + 0.5 * spots, 0, 1)
    lines = blur(np.repeat(rng.standard_normal((n, 1)).astype(np.float32), n, 1), 0, 0.8)
    lines = lines / (np.abs(lines).max() + 1e-9)
    H = 0.1 * lines + 0.2 * band(n, rng, n / 8, n / 3) + 0.5 * dark
    alb = 1 - 0.42 * dark + 0.01 * lines
    rough = 0.3 + 0.32 * dark
    metal = 1 - 0.3 * dark
    return dict(albedo=alb, height=H, roughness=rough, ao=None, metal=metal)


def gen_cast_iron(n=1024, seed=77):
    """Cast iron: a coarse sand-cast skin."""
    rng = np.random.default_rng(seed)
    H = band(n, rng, n / 10, n / 3) + 0.6 * band(n, rng, 20, 80) + 0.3 * band(n, rng, 4, 16)
    alb = 1 + 0.05 * band(n, rng, 20, 80)
    return dict(albedo=alb, height=norm01(H), roughness=0.62 + 0.08 * band(n, rng, n / 10, n / 3), ao=None, metal=1.0)


# ---------------------------------------------------------------- other

def gen_cane(n=2048, seed=81, cell=12.0, tile_cm=6.0):
    """Cane webbing (the classic open rattan weave): pairs of flat strands across and along, two
    diagonals crossing at every knot, and the octagonal holes between them."""
    rng = np.random.default_rng(seed)
    ss = 2
    N = n * ss
    L = tile_cm * 10.0
    ys, xs = np.mgrid[0:N, 0:N].astype(np.float32)
    X, Y = xs / N * L, ys / N * L
    w = 1.05                   # strand half-width, mm
    g = 1.25                   # half distance between the two strands of a pair
    # local coordinates round the nearest knot (knots sit on the cell corners)
    u = np.mod(X, cell) - cell / 2
    v = np.mod(Y, cell) - cell / 2
    ku = np.where(u < 0, u + cell / 2, u - cell / 2)
    kv = np.where(v < 0, v + cell / 2, v - cell / 2)
    ci = np.floor(X / cell).astype(np.int32)
    cj = np.floor(Y / cell).astype(np.int32)
    H = np.full((N, N), -2.0, np.float32)
    alb = np.full((N, N), 0.08, np.float32)
    fib_h = band(N, rng, N / 30, N / 8, ex=6)
    fib_v = band(N, rng, N / 30, N / 8, ey=6)
    fib_d = band(N, rng, N / 30, N / 8)

    def lay(p, z, fib, tone):
        nonlocal H, alb
        h = np.where(p > 0, p * 0.8 + z, -9)
        top = h > H
        H = np.where(top, h, H)
        alb = np.where(top, (0.82 + 0.18 * p) * (1 + 0.06 * fib) * tone, alb)

    def prof(e):
        return np.clip(1 - (e / w) ** 2, 0, 1) ** 0.35

    for side in (-1, 1):
        # horizontal pair strands (along x) at kv = side*g, vertical pair at ku = side*g; they swap
        # over and under from knot to knot
        ph = prof(kv - side * g)
        pv = prof(ku - side * g)
        over = ((ci + cj) % 2 == 0)
        lay(ph, np.where(over, 0.25, -0.25), fib_h, 1.0)
        lay(pv, np.where(over, -0.25, 0.25), fib_v, 0.97)
    # diagonals cross at the knot and run out to the hole corners: they are cut back to the knot
    # region so the holes stay open octagons
    reach = (g + w) * np.sqrt(2) + 1.8
    for sgn, tone in ((1, 1.02), (-1, 0.95)):
        e = (ku - sgn * kv) / np.sqrt(2)
        along = np.abs(ku + sgn * kv) / np.sqrt(2)
        p = prof(e) * smoothstep(reach, reach - 0.8, along)
        lay(p, 0.45 if sgn > 0 else 0.35, fib_d, tone)
    H, alb = downsample(H, ss), downsample(alb, ss)
    hole = H < -1.0
    rough = np.where(hole, 0.9, 0.38 + 0.05 * band(n, rng, 20, 80))
    ao = np.where(hole, 0.3, 1 - 0.35 * cavity(H, 6))
    return dict(albedo=alb, height=H, roughness=rough, ao=ao)


def gen_pp(n=1024, seed=82):
    """Moulded matte plastic (PP chairs): fine even stipple."""
    rng = np.random.default_rng(seed)
    H = band(n, rng, n / 8, n / 2.5) + 0.2 * band(n, rng, 20, 60)
    return dict(albedo=None, height=norm01(H), roughness=0.55 + 0.03 * band(n, rng, n / 8, n / 2.5), ao=None)


def gen_cork(n=2048, seed=83):
    """Agglomerated cork: pressed granules 1-4 mm of many shades, with dark specks and fine gaps."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32)
    H = np.zeros((n, n), np.float32)
    for cells, wgt in ((60, 0.5), (28, 0.5)):
        F1, F2, ID = worley(n, cells, rng, dx=0.25 * band(n, rng, 4, 16), dy=0.25 * band(n, rng, 4, 16))
        tone = 0.7 + 0.45 * rng.random(cells * cells).astype(np.float32)[ID]
        edge = smoothstep(0.0, 0.1, F2 - F1)
        out += wgt * tone * (0.75 + 0.25 * edge)
        H += wgt * (0.6 + 0.4 * edge) * (0.8 + 0.4 * rng.random(cells * cells).astype(np.float32)[ID])
    grain = band(n, rng, n / 6, n / 2.5)
    specks = smoothstep(2.0, 2.8, band(n, rng, n / 10, n / 4) / 0.25)
    out = out * (1 + 0.06 * grain) * (1 - 0.5 * specks)
    H = H + 0.15 * grain - 0.5 * specks
    return dict(albedo=out, height=H, roughness=0.78 - 0.05 * norm01(H), ao=1 - 0.2 * (1 - norm01(H)))


# ---------------------------------------------------------------- Clione sofa collection

def gen_clione_woven(n=2048, seed=91, tile_cm=10):
    """Clione woven fabric (직조): a close weave of thick nubby yarns (about 3.5 mm), plied from
    light and dark fibres, whose slubs and knots gather into soft lumps 5-10 mm across; up close it
    reads knobbly and crisp, from a step away as a lively heathered colour on a bumpy surface."""
    rng = np.random.default_rng(seed)
    px = tile_cm * 10 / n
    W, alb, w = weave(n, rng, plain, 28, 26, yarn=(0.98, 0.97), amp=0.3, thick=0.72, wobble=0.28, slub=0.45,
                      fibre=0.16, hair=0.08, tone=(0.8, 1.0), tone_var=0.12, fleck=0.5, twist=(2.0, 0.9),
                      melange=0.4)
    # the yarns' slubs and knots gather in lumps: raise the cloth there and stamp loops on top
    lump = band(n, rng, 9, 20)
    lump = smoothstep(-1.2, 1.6, lump / (lump.std() + 1e-9))
    base = 0.45 * norm01(W) + 0.9 * lump - 0.2
    H, T = _stamp_loops(n, rng, 1500, 1.1, 0.55, px, base, lift_map=lump, arc_range=(0.4, 0.9), asp_range=(0.45, 0.9))
    H = np.maximum(H, base)
    top = norm01(H)
    # colour in linear light, kept in the range a tinted chip can show: mostly mid tones from the
    # plied yarns, light flecks on the lumps, darker where the cloth sinks; the heather makes
    # patches with more light or more dark fibres
    z = np.log(np.clip(alb, 1e-3, None) * (1 + 2.0 * (T - 1)))
    z = (z - z.mean()) / (z.std() + 1e-9)
    heather = warp(band(n, rng, 4, 16), 20 * band(n, rng, 2, 6), 20 * band(n, rng, 2, 6))
    heather = heather / (heather.std() + 1e-9)
    streak = band(n, rng, 6, 30, ey=4.0)
    heather = heather + 0.5 * streak / (streak.std() + 1e-9)
    L = 0.62 * np.exp(0.17 * z + 0.18 * heather) * (0.72 + 0.4 * smoothstep(0.15, 0.85, top))
    rough = 0.93 - 0.04 * top
    ao = 1 - 0.45 * cavity(H, 14) - 0.3 * cavity(H, 90)
    return dict(albedo=srgb(L), height=norm01(H), roughness=rough, ao=ao)


def gen_clione_flock(n=2048, seed=92):
    """Clione flocked fabric (플로킹): short fibres flocked onto a pebbled ground, so the surface
    stands up in soft rounded nubs 2-4 mm across, packed close, while the touch stays velvety;
    the short pile softens every edge and lies a little differently from patch to patch."""
    rng = np.random.default_rng(seed)
    H = np.full((n, n), 0.0, np.float32)
    for cells, wgt in ((30, 1.0), (46, 0.6)):
        F1, F2, ID = worley(n, cells, rng, jitter=0.9, dx=0.25 * band(n, rng, 3, 12), dy=0.25 * band(n, rng, 3, 12))
        r = (0.5 + 0.2 * rng.random(cells * cells).astype(np.float32))[ID]
        dome = np.clip(1 - (F1 / r) ** 2, 0, 1) ** 0.6
        H = np.maximum(H, wgt * dome * (0.75 + 0.25 * rng.random(cells * cells).astype(np.float32))[ID])
    H = blur(H, 7)
    pile = band(n, rng, n / 6, n / 2.2)
    crush = warp(band(n, rng, 2, 8), 20 * band(n, rng, 2, 6), 20 * band(n, rng, 2, 6))
    t = norm01(H)
    H = H + 0.04 * pile + 0.06 * crush
    alb = (0.88 + 0.12 * t) * (1 + 0.03 * crush) * (1 + 0.02 * pile)
    rough = 0.88 - 0.04 * t
    return fabric_maps(H, alb, rough, 0.38, 14)


def gen_clione_leather(n=2048, seed=93):
    """Clione full natural leather (전체 천연가죽): a soft full-grain hide with little coating, so
    the natural grain stays: fine irregular grain cells over a gently tumbled, pebbled surface,
    growth lines and soft creases, a cloudy depth of tone and a low, even sheen."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 140, rng, jitter=1.0, aniso=1.2, dx=0.6 * band(n, rng, 3, 12), dy=0.6 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.8
    G1, G2, _ = worley(n, 36, rng, jitter=1.0, dx=0.35 * band(n, rng, 3, 10), dy=0.35 * band(n, rng, 3, 10))
    pebble = smoothstep(0.0, 0.6, G2 - G1) ** 0.5
    gl = band(n, rng, 3, 12, ex=3.0)
    gl = warp(gl, 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    lines = np.exp(-(gl / 0.06) ** 2)
    cloud = band(n, rng, 1.5, 8)
    H = 0.14 * blur(cell, 0.8) + 0.3 * blur(pebble, 1.5) - 0.3 * blur(lines, 2.0) + 0.25 * band(n, rng, 1.5, 6)
    alb = 1 + 0.06 * cloud - 0.03 * blur(lines, 1.5) - 0.02 * (1 - cell) - 0.025 * (1 - pebble)
    rough = 0.47 + 0.05 * (1 - cell) + 0.06 * (1 - pebble) + 0.04 * blur(lines, 1.5) + 0.02 * cloud
    ao = 1 - 0.1 * (1 - pebble) - 0.05 * (1 - cell) - 0.1 * blur(lines, 1.5)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


def gen_clione_biosil(n=2048, seed=94):
    """Clione BIO-SIL (신소재 바이오실): a silicone-coated performance cloth made to look like
    leather: a fine, shallow, even grain pressed into the coating, a soft two-tone mottle like
    pull-up leather and a restrained satin sheen; no pores or scars, as the coating is uniform."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 200, rng, jitter=0.85, aniso=1.1, dx=0.5 * band(n, rng, 3, 12), dy=0.5 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.45, F2 - F1) ** 0.7
    mottle = warp(band(n, rng, 1.5, 6), 40 * band(n, rng, 2, 6), 40 * band(n, rng, 2, 6))
    fine = band(n, rng, n / 6, n / 2.5)
    # soft broad dents where the padded cover gives (no sharp creases: the coating is supple)
    dent = blur(band(n, rng, 2, 7), 12)
    H = blur(cell, 1.0) + 0.06 * fine + 0.25 * dent
    alb = 1 + 0.09 * mottle - 0.02 * (1 - cell)
    rough = 0.46 + 0.05 * (1 - cell) - 0.04 * mottle
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=1 - 0.05 * (1 - cell))


def gen_clione_hermosa(n=2048, seed=97):
    """Clione HERMOSA GOOSE leather (에르모사 구스 천연가죽): a soft aniline-dyed full-grain hide as on
    the brand's colour chart: an almost smooth face with a very fine, shallow natural grain (tiny cells
    under 1 mm), a few faint growth lines, and the open, cloudy depth of tone of an aniline dye (darker
    and lighter clouds a few centimetres across); a soft, low satin sheen."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 260, rng, jitter=1.0, aniso=1.15, dx=0.5 * band(n, rng, 3, 12), dy=0.5 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.7
    G1, G2, _ = worley(n, 70, rng, jitter=1.0, dx=0.4 * band(n, rng, 3, 10), dy=0.4 * band(n, rng, 3, 10))
    soft = smoothstep(0.0, 0.7, G2 - G1) ** 0.5
    gl = warp(band(n, rng, 3, 10, ex=3.0), 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    lines = np.exp(-(gl / 0.04) ** 2)
    cloud = warp(band(n, rng, 1.5, 6), 40 * band(n, rng, 2, 6), 40 * band(n, rng, 2, 6))
    cloud2 = band(n, rng, 4, 14)
    H = 0.3 * blur(cell, 0.7) + 0.15 * blur(soft, 1.5) - 0.12 * blur(lines, 2.0) + 0.2 * blur(band(n, rng, 1.5, 6), 4)
    alb = 1 + 0.035 * cloud + 0.015 * cloud2 - 0.02 * (1 - cell) - 0.015 * blur(lines, 1.5)
    rough = 0.5 + 0.04 * (1 - cell) + 0.03 * (1 - soft) - 0.03 * cloud
    ao = 1 - 0.05 * (1 - cell) - 0.04 * (1 - soft) - 0.05 * blur(lines, 1.5)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


def gen_clione_fjord(n=2048, seed=98):
    """Clione FJORD swing sofa leather (피오르 밀드 가죽): a heavily drum-milled cowhide as on the
    brand's 14-colour chart: a bold, irregular, rounded pebble (about 3-6 mm) with wavy folds between
    the pebbles, finer cells on each one, an even, pigmented colour and a soft sheen."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 170, rng, jitter=1.0, aniso=1.2, dx=0.6 * band(n, rng, 3, 12), dy=0.6 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.8
    G1, G2, GID = worley(n, 34, rng, jitter=1.0, aniso=1.2, dx=0.75 * band(n, rng, 3, 12), dy=0.75 * band(n, rng, 3, 12))
    pebble = smoothstep(0.0, 0.9, G2 - G1) ** 0.5
    P1, P2, _ = worley(n, 72, rng, jitter=1.0, dx=0.6 * band(n, rng, 3, 12), dy=0.6 * band(n, rng, 3, 12))
    small = smoothstep(0.0, 0.8, P2 - P1) ** 0.6
    lift = (0.7 + 0.6 * rng.random(34 * 34).astype(np.float32))[GID]
    cloud = band(n, rng, 1.5, 7)
    peb = 0.7 * blur(pebble * lift, 2.2) + 0.3 * blur(small, 1.6)
    H = 0.1 * blur(cell, 0.8) + 0.5 * peb + 0.12 * band(n, rng, 1.5, 6)
    fold = 1 - norm01(peb)
    alb = 1 + 0.02 * cloud - 0.02 * fold ** 2 - 0.015 * (1 - cell)
    rough = 0.47 + 0.04 * (1 - cell) + 0.05 * fold + 0.02 * cloud
    ao = 1 - 0.15 * fold ** 1.5 - 0.05 * (1 - cell)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


# ---------------------------------------------------------------- Jakomo leather sofas

def gen_jakomo_ople(n=2048, seed=95):
    """Jakomo OPLE (오플 천연면피 소가죽): Korean top-grain cowhide with only a light surface
    finish, so the natural grain shows: a fine, even pebble of small rounded cells (about 1-1.5 mm)
    with a slightly bigger, softer pebble under it, a little cloudy depth of tone and a moist,
    soft satin look (no lacquer gloss)."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 120, rng, jitter=0.95, aniso=1.1, dx=0.5 * band(n, rng, 3, 12), dy=0.5 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.6
    G1, G2, _ = worley(n, 46, rng, jitter=1.0, dx=0.4 * band(n, rng, 3, 10), dy=0.4 * band(n, rng, 3, 10))
    pebble = smoothstep(0.0, 0.7, G2 - G1) ** 0.5
    cloud = band(n, rng, 1.5, 8)
    # soft growth lines, few and shallow (the hide is selected and evenly finished)
    gl = warp(band(n, rng, 3, 10, ex=3.0), 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    lines = np.exp(-(gl / 0.05) ** 2)
    H = 0.22 * blur(cell, 0.9) + 0.2 * blur(pebble, 1.5) - 0.15 * blur(lines, 2.0) + 0.15 * band(n, rng, 1.5, 6)
    # an even, finished hide: only a faint cloudiness (light colours showed it as blotches)
    alb = 1 + 0.015 * cloud - 0.025 * (1 - cell) - 0.01 * (1 - pebble) - 0.012 * blur(lines, 1.5)
    rough = 0.5 + 0.06 * (1 - cell) + 0.04 * (1 - pebble) + 0.02 * cloud
    ao = 1 - 0.08 * (1 - cell) - 0.06 * (1 - pebble) - 0.06 * blur(lines, 1.5)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


def gen_jakomo_lecce(n=2048, seed=96):
    """Jakomo LECCE (레체 이태리 천연면피 소가죽): Italian full-grain cowhide, drum-milled so the
    grain rises into a soft, pronounced pebble (about 2-4 mm) over the fine natural cells; a
    semi-aniline finish gives a gentle two-tone depth and a soft, slightly richer sheen."""
    rng = np.random.default_rng(seed)
    F1, F2, _ = worley(n, 150, rng, jitter=1.0, aniso=1.2, dx=0.6 * band(n, rng, 3, 12), dy=0.6 * band(n, rng, 3, 12))
    cell = smoothstep(0.0, 0.5, F2 - F1) ** 0.8
    G1, G2, GID = worley(n, 30, rng, jitter=1.0, dx=0.35 * band(n, rng, 3, 10), dy=0.35 * band(n, rng, 3, 10))
    pebble = smoothstep(0.0, 0.8, G2 - G1) ** 0.45
    lift = (0.8 + 0.4 * rng.random(30 * 30).astype(np.float32))[GID]
    cloud = warp(band(n, rng, 1.5, 7), 30 * band(n, rng, 2, 6), 30 * band(n, rng, 2, 6))
    H = 0.12 * blur(cell, 0.8) + 0.38 * blur(pebble * lift, 1.8) + 0.18 * band(n, rng, 1.5, 6)
    # semi-aniline: the pebble tops a touch lighter, the folds between them a touch deeper
    alb = 1 + 0.03 * cloud + 0.025 * (norm01(blur(pebble, 1.5)) - 0.5) - 0.02 * (1 - cell)
    rough = 0.44 + 0.05 * (1 - cell) + 0.06 * (1 - pebble) + 0.02 * cloud
    ao = 1 - 0.14 * (1 - pebble) - 0.05 * (1 - cell)
    return dict(albedo=alb, height=norm01(H), roughness=rough, ao=ao)


# ---------------------------------------------------------------- the library

def M(id, name, cat, palette, gen, tile, **kw):
    return dict(id=id, name=name, category=cat, palette=palette, gen=gen, tile=tile, **kw)


MATERIALS = [
    # leather (adds to the 7 existing)
    M('leather-semianiline', '세미아닐린 가죽', '가죽', 'leather', gen_semi_aniline, 14, relief=0.06),
    M('leather-pu', '인조가죽 (PU)', '가죽', 'leather', gen_pu, 10, relief=0.04),
    M('leather-croc', '크로커 엠보 가죽', '가죽', 'leather', lambda: gen_croc(tile_cm=32), 32, size=2048, nsize=2048, relief=0.7, clearcoat=(0.3, 0.3)),
    # fabric
    M('fabric-boucle', '부클레', '패브릭', 'fabric', gen_boucle, 10, relief=1.0, sheen=(0.35, 0.8)),
    M('fabric-velvet', '벨벳', '패브릭', 'fabric', gen_velvet, 30, relief=0.12, sheen=(1.0, 0.35)),
    M('fabric-chenille', '셔닐', '패브릭', 'fabric', gen_chenille, 8, relief=0.45, sheen=(0.6, 0.45)),
    M('fabric-corduroy', '코듀로이', '패브릭', 'fabric', gen_corduroy, 7, relief=1.0, sheen=(0.7, 0.4)),
    M('fabric-cotton', '코튼', '패브릭', 'fabric', gen_canvas, 5, relief=0.18, sheen=(0.3, 0.6)),
    M('fabric-herringbone', '헤링본', '패브릭', 'fabric', gen_herringbone, 7, relief=0.25, sheen=(0.35, 0.6)),
    M('fabric-tweed', '트위드', '패브릭', 'fabric', gen_tweed, 8, relief=0.35, sheen=(0.3, 0.7)),
    M('fabric-teddy', '테디 (양털)', '패브릭', 'fabric', gen_teddy, 10, relief=1.4, sheen=(0.6, 0.6)),
    M('fabric-microfiber', '기능성 패브릭', '패브릭', 'fabric', gen_microfiber, 18, relief=0.08, sheen=(0.7, 0.45)),
    # Clione sofa collection: the four covers of the Clione modular sofa (fabric palettes first
    # show the colour in the brand's photo)
    M('clione-woven', '직조 패브릭', '클리오네', 'clione-fabric', gen_clione_woven, 10, relief=1.6, sheen=(0.35, 0.65), minMean=0.72, swatchHex='#29495C'),
    M('clione-flocking', '플로킹 패브릭', '클리오네', 'clione-fabric', gen_clione_flock, 9, relief=0.9, sheen=(0.8, 0.45), swatchHex='#E0DDD3'),
    M('clione-leather', '전체 천연가죽', '클리오네', 'clione-leather', gen_clione_leather, 16, relief=0.14, swatchHex='#2C2C2D'),
    M('clione-biosil', '신소재 바이오실 패브릭', '클리오네', 'clione-leather', gen_clione_biosil, 24, relief=0.05, swatchHex='#8C5C3A'),
    # the hides of two Clione sofas, each with its own colour chart (2026-11-11)
    M('clione-hermosa', '에르모사 구스 천연가죽', '클리오네', 'clione-hermosa', gen_clione_hermosa, 20, relief=0.12, swatchHex='#4A4E48'),
    M('clione-fjord', '피오르 밀드 천연가죽', '클리오네', 'clione-fjord', gen_clione_fjord, 16, relief=0.2, swatchHex='#A97855'),
    # Jakomo leather sofas: the two hides of the Jakomo pages (colours from the pages' colour charts)
    M('jakomo-ople', '오플 천연면피 소가죽', '자코모', 'jakomo-ople', gen_jakomo_ople, 12, relief=0.1, swatchHex='#615346'),
    M('jakomo-lecce', '레체 이태리 천연면피 소가죽', '자코모', 'jakomo-lecce', gen_jakomo_lecce, 16, relief=0.16, swatchHex='#505337'),
    # stone
    M('stone-carrara', '카라라 대리석', '대리석', 'stone', gen_marble_carrara, 150, size=2048, swatchHex='#E6E3DD', swatchCm=60),
    M('stone-carrara-honed', '카라라 무광 (혼드)', '대리석', 'stone', 'stone-carrara', 150, roughness=0.42, swatchHex='#E6E3DD', swatchCm=60),
    M('stone-calacatta', '칼라카타 대리석', '대리석', 'stone', gen_marble_calacatta, 160, size=2048, swatchHex='#EEECE8', swatchCm=70),
    M('stone-nero', '네로 마르퀴나', '대리석', 'stone-dark', gen_marble_nero, 120, size=2048, minMean=0, swatchHex='#1C1C1E', swatchCm=50),
    M('stone-emperador', '에퍼라도 (브라운)', '대리석', 'stone', gen_marble_emperador, 100, size=2048, minMean=0, swatchHex='#5E4535', swatchCm=40),
    M('stone-travertine', '트래버틴', '대리석', 'stone', gen_travertine, 60, size=2048, relief=1.5, swatchHex='#D6C6AA', swatchCm=30),
    M('stone-terrazzo', '테라조', '대리석', 'stone', gen_terrazzo, 50, size=2048, swatchHex='#E4E0D8', swatchCm=25),
    M('stone-ceramic', '세라믹 (무광)', '대리석', 'stone', gen_ceramic, 120, relief=0.02, swatchHex='#B9B4AC', swatchCm=40),
    # wood: x along the grain
    M('wood-oak', '오크', '나무', 'wood', lambda: gen_wood(seed=61, tile=(120, 45), ring=3.2, ring_var=0.6, contrast=0.13, porous='ring', pore=(4.0, 0.26), pore_dark=0.3, rays=0.3, rough=0.55),
      (120, 45), size=2048, relief=0.08, swatchHex='#C29A6B', swatchCm=30),
    M('wood-oak-quarter', '오크 (곧은결)', '나무', 'wood', lambda: gen_wood(seed=62, tile=(100, 40), ring=2.6, ring_var=0.6, contrast=0.11, porous='ring', pore=(4.0, 0.3), pore_dark=0.35, rays=0.7, quarter=True, rough=0.5),
      (100, 40), size=2048, relief=0.08, swatchHex='#C29A6B', swatchCm=30),
    M('wood-walnut', '월넛', '나무', 'wood', lambda: gen_wood(seed=63, tile=(100, 45), ring=4.0, ring_var=0.7, contrast=0.17, porous='semi', pore=(3.0, 0.25), pore_dark=0.3, streaks=0.16, wobble=1.6, d0=(90, 220), cycles=(5, 10), board_tone=0.08, rough=0.5),
      (100, 45), size=2048, relief=0.06, swatchHex='#5B3E2B', swatchCm=30),
    M('wood-ash', '애쉬', '나무', 'wood', lambda: gen_wood(seed=64, tile=(120, 45), ring=3.8, ring_var=0.6, contrast=0.2, porous='ring', pore=(4.0, 0.32), pore_dark=0.45, pore_k=1.1, d0=(120, 260), cycles=(4, 8), rough=0.55),
      (120, 45), size=2048, relief=0.09, swatchHex='#D2BA94', swatchCm=30),
    M('wood-birch', '자작나무 (합판)', '나무', 'wood', lambda: gen_wood(seed=65, tile=(80, 80), boards=1, ring=2.6, ring_var=0.4, contrast=0.06, porous='diffuse', pore=(1.2, 0.12), pore_dark=0.12, rotary=True, d0=(16, 0), cycles=(1, 2), board_tone=0.0, rough=0.45, seam=0),
      (80, 80), size=2048, relief=0.03, swatchHex='#DCC6A2', swatchCm=30),
    M('wood-teak', '티크', '나무', 'wood', lambda: gen_wood(seed=66, tile=(100, 45), ring=4.5, ring_var=0.6, contrast=0.09, porous='semi', pore=(3.0, 0.28), pore_dark=0.3, streaks=0.2, d0=(150, 320), cycles=(3, 6), rough=0.45),
      (100, 45), size=2048, relief=0.06, swatchHex='#A06F42', swatchCm=30),
    M('wood-rubber', '고무나무 (집성)', '나무', 'wood', lambda: gen_wood(seed=67, tile=(120, 32), boards=8, ring=3.0, ring_var=0.5, contrast=0.08, porous='diffuse', pore=(2.0, 0.2), pore_dark=0.22, fingers=2, d0=(300, 700), cycles=(6, 12), board_tone=0.07, rough=0.42),
      (120, 32), size=2048, relief=0.05, swatchHex='#D1B48C', swatchCm=30),
    # painted finishes
    M('paint-satin', '반광 도장', '도장', 'paint', None, None, roughness=0.34, clearcoat=(0.35, 0.25)),
    M('paint-supermatte', '초무광 (슈퍼매트)', '도장', 'paint', None, None, roughness=0.9),
    M('paint-highgloss', '하이그로시', '도장', 'paint', None, None, roughness=0.1, clearcoat=(1.0, 0.03)),
    M('paint-powder', '분체도장', '도장', 'paint', gen_powder, 6, relief=0.04),
    M('paint-sand', '샌드 텍스처 도장', '도장', 'paint', gen_sand_paint, 5, relief=0.12),
    # metal
    M('metal-hairline', '헤어라인', '메탈', 'metal', gen_hairline, 5, relief=0.004, metallic=1, anisotropy=(0.7, 90)),
    M('metal-mirror', '미러 (경면)', '메탈', 'metal', None, None, roughness=0.04, metallic=1),
    M('metal-blast', '샌드블라스트', '메탈', 'metal', gen_blast, 3, relief=0.002, metallic=1),
    M('metal-hammered', '해머드', '메탈', 'metal', gen_hammered, 16, relief=0.6, metallic=1),
    M('metal-antique', '앤틱 메탈', '메탈', 'metal', gen_antique, 30, relief=0.01, metallic=1, swatchHex='#B08D57'),
    M('metal-cast', '주물 (무쇠)', '메탈', 'metal', gen_cast_iron, 8, relief=0.15, metallic=1, swatchHex='#3A3A3B'),
    # other
    M('glass-clear', '투명 유리', '기타', 'glass', None, None, roughness=0.03, alpha=0.22, swatchHex='#D9E3E1'),
    M('glass-frosted', '샌드 유리 (반투명)', '기타', 'glass', None, None, roughness=0.45, alpha=0.62, swatchHex='#E6ECEA'),
    M('rattan-cane', '라탄 짜임', '기타', 'rattan', gen_cane, 6, relief=1.2, minMean=0, swatchHex='#C8A26E', swatchCm=6),
    M('rattan-wicker', '라탄 바스켓', '기타', 'rattan', gen_basket_rattan, 12, relief=3.0, minMean=0, swatchHex='#B38A55', swatchCm=12),
    M('other-concrete', '콘크리트', '기타', 'stone', gen_concrete, 80, relief=0.25, swatchHex='#A19D97', swatchCm=30),
    M('other-pp', '플라스틱 (PP)', '기타', 'paint', gen_pp, 2, relief=0.012),
    M('other-cork', '코르크', '기타', 'wood', gen_cork, 10, relief=0.25, swatchHex='#B48A5E', swatchCm=10),
]

PALETTES = {
    'stone': [
        {'id': 'white', 'name': '화이트', 'hex': '#ECEAE6'}, {'id': 'cream', 'name': '크림', 'hex': '#E3DACB'},
        {'id': 'beige', 'name': '베이지', 'hex': '#D6C6AA'}, {'id': 'grey', 'name': '그레이', 'hex': '#9C9A96'},
        {'id': 'dark-grey', 'name': '다크 그레이', 'hex': '#55534F'}, {'id': 'black', 'name': '블랙', 'hex': '#1C1C1E'},
        {'id': 'brown', 'name': '브라운', 'hex': '#5E4535'}, {'id': 'green', 'name': '그린', 'hex': '#3F5145'},
    ],
    'stone-dark': [
        {'id': 'black', 'name': '블랙', 'hex': '#1C1C1E'}, {'id': 'warm-black', 'name': '웜 블랙', 'hex': '#221E1C'},
        {'id': 'charcoal', 'name': '차콜', 'hex': '#262728'}, {'id': 'dark-green', 'name': '다크 그린', 'hex': '#1B2620'},
        {'id': 'dark-brown', 'name': '다크 브라운', 'hex': '#261D18'}, {'id': 'navy', 'name': '네이비', 'hex': '#1A1E26'},
    ],
    'wood': [
        {'id': 'natural-oak', 'name': '내추럴 오크', 'hex': '#C29A6B'}, {'id': 'light-oak', 'name': '라이트 오크', 'hex': '#D8BF98'},
        {'id': 'white-wash', 'name': '화이트 워시', 'hex': '#E2D8C6'}, {'id': 'walnut', 'name': '월넛', 'hex': '#5B3E2B'},
        {'id': 'smoked', 'name': '스모크', 'hex': '#6E5442'}, {'id': 'teak', 'name': '티크', 'hex': '#A06F42'},
        {'id': 'cherry', 'name': '체리', 'hex': '#8A4B2E'}, {'id': 'black-stain', 'name': '블랙 스테인', 'hex': '#2B2622'},
    ],
    'glass': [
        {'id': 'clear', 'name': '투명', 'hex': '#D9E3E1'}, {'id': 'bronze', 'name': '브론즈', 'hex': '#8C6E52'},
        {'id': 'smoke', 'name': '스모크', 'hex': '#5E6163'}, {'id': 'green', 'name': '그린', 'hex': '#9DB5A6'},
    ],
    'rattan': [
        {'id': 'natural', 'name': '내추럴', 'hex': '#C8A26E'}, {'id': 'honey', 'name': '허니', 'hex': '#B07F45'},
        {'id': 'brown', 'name': '브라운', 'hex': '#6E4B2E'}, {'id': 'black', 'name': '블랙', 'hex': '#2A2622'},
        {'id': 'white', 'name': '화이트', 'hex': '#E4DCCB'},
    ],
}
SHOW_ORDER = ['paint-supermatte', 'paint-matte', 'paint-satin', 'paint-gloss', 'paint-highgloss', 'paint-powder', 'paint-sand']
# the Clione covers' colours as in the brand's photo, ahead of the usual fabric / leather colours
CLIONE_COLORS = {
    'clione-fabric': ('fabric', [{'id': 'clione-blue', 'name': '클리오네 블루', 'hex': '#29495C'},
                                 {'id': 'clione-ivory', 'name': '클리오네 아이보리', 'hex': '#E0DDD3'}]),
    'clione-leather': ('leather', [{'id': 'clione-black', 'name': '클리오네 블랙', 'hex': '#2C2C2D'},
                                   {'id': 'clione-cognac', 'name': '클리오네 코냑', 'hex': '#8C5C3A'}]),
    # Hermosa Goose (6) and Fjord swing sofa (14) colour charts sent by sunny 2026-11-11: each chip is the
    # chart's median colour taken down 1.2x with 10% more saturation (as the Jakomo charts), so a lit seat
    # looks like the chip
    'clione-hermosa': ('leather', [{'id': 'clh-' + i, 'name': '에르모사 ' + n, 'hex': h} for i, n, h in (
        ('ice', '아이스', '#908577'), ('orange', '오렌지', '#8E5D35'), ('moss-green', '모스 그린', '#3E413C'), ('cognac', '코냑', '#7E4924'), ('gold-brown', '골드 브라운', '#66523C'), ('black', '블랙', '#2B2B2C'))]),
    'clione-fjord': ('leather', [{'id': 'clf-' + i, 'name': '피오르 ' + n, 'hex': h} for i, n, h in (
        ('ice', '아이스', '#AFA99E'), ('beige', '베이지', '#AFA697'), ('lucky-gray', '럭키 그레이', '#959593'), ('lotus', '로투스', '#A6A8A5'), ('light-gray', '라이트 그레이', '#5E5E60'), ('grey', '그레이', '#7E6F5E'), ('cognac', '코냑', '#906343'), ('aqua-blue', '아쿠아 블루', '#596472'), ('peacock', '피콕', '#3D505E'), ('deep-green', '딥 그린', '#4A5757'), ('choco', '초코', '#2F2D29'), ('deep-gray', '딥 그레이', '#4D4C48'), ('navy', '네이비', '#303136'), ('black', '블랙', '#373739'))]),
}
# the Jakomo colour charts (OPLE: 15 colours; LECCE: 13), ahead of the usual leather colours. Each chip
# is the chart photo's mid-lit colour taken down by the viewer's brightness on a lit seat (about 1.2x)
# with 10% more saturation, so a rendered seat looks like the chart chip.
JAKOMO_COLORS = {
    'jakomo-ople': ('leather', [{'id': 'jk-' + i, 'name': n, 'hex': h} for i, n, h in (
        ('cream-white', '크림화이트', '#ABA79E'), ('cream-ivory', '크림아이보리', '#9E9487'), ('light-gray', '라이트그레이', '#A4A29F'),
        ('gray', '그레이', '#696866'), ('latte', '라떼', '#7A6D5F'), ('camel', '카멜', '#615346'),
        ('indie-pink', '인디핑크', '#8E7471'), ('orange', '오렌지', '#815438'), ('moca', '모카', '#433A35'),
        ('light-mint', '라이트민트', '#AEB7B5'), ('misty-blue', '미스티블루', '#627379'), ('navy', '네이비', '#353742'),
        ('khaki-green', '카키그린', '#7A8065'), ('green', '그린', '#334A3D'), ('black', '블랙', '#2F2F2F'))]),
    'jakomo-lecce': ('leather', [{'id': 'jk-lecce-' + i, 'name': n, 'hex': h} for i, n, h in (
        ('white', '레체화이트', '#BEBDBB'), ('white-sand', '레체화이트샌드', '#ABA69F'), ('beige', '레체베이지', '#908278'),
        ('gray', '레체그레이', '#8C8782'), ('blue', '레체블루', '#576873'), ('charcoal', '레체차콜', '#494949'),
        ('pink', '레체핑크', '#735655'), ('brown', '레체브라운', '#946948'), ('amber-orange', '레체앰버오렌지', '#7B5235'),
        ('green', '레체그린', '#40524D'), ('khaki-green', '레체카키그린', '#505337'), ('dark-brown', '레체다크브라운', '#2D1D1B'),
        ('black', '레체블랙', '#262626'))]),
}
METAL_EXTRA = [
    {'id': 'stainless', 'name': '스테인리스', 'hex': '#C9CACB'}, {'id': 'white', 'name': '화이트 스테인', 'hex': '#E4E4E1'},
    {'id': 'black-steel', 'name': '블랙 스테인', 'hex': '#1D1C1B'}, {'id': 'gold', 'name': '골드', 'hex': '#D4AF6A'},
    {'id': 'rose-gold', 'name': '로즈골드', 'hex': '#C9937F'}, {'id': 'copper', 'name': '코퍼', 'hex': '#B8734D'},
    {'id': 'bronze', 'name': '브론즈', 'hex': '#7A5A3A'},
]
PAINT_EXTRA = [
    {'id': 'ivory', 'name': '아이보리', 'hex': '#E8E2D4'}, {'id': 'grey', 'name': '그레이', 'hex': '#8E8E8C'},
    {'id': 'charcoal', 'name': '차콜', 'hex': '#3A3B3C'}, {'id': 'sage', 'name': '세이지', 'hex': '#9AA58E'},
    {'id': 'butter', 'name': '버터', 'hex': '#EBD9A6'}, {'id': 'terracotta', 'name': '테라코타', 'hex': '#B5603F'},
]


# ---------------------------------------------------------------- output

def lin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055).astype(np.float32)


# lowest reference brightness (linear) per category, so light chips still come out light
MIN_MEAN = {'가죽': 0.82, '패브릭': 0.82, '클리오네': 0.82, '자코모': 0.82, '대리석': 0.8, '나무': 0.6, '도장': 0.85, '메탈': 0.85, '기타': 0.75}


def normal_from_height(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nrm = np.stack([-dx * strength, dy * strength, np.ones_like(h)], -1)
    return nrm / np.linalg.norm(nrm, axis=-1, keepdims=True)


def normal_from_height2(h, sx, sy):
    """Tangent-space normals (glTF: +X right, +Y up) from a height field; sx, sy turn a height
    step per pixel into a slope along x and y."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * sx
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * sy
    nrm = np.stack([-dx, dy, np.ones_like(h)], -1)
    return nrm / np.linalg.norm(nrm, axis=-1, keepdims=True)


def resize(a, size, mode=Image.LANCZOS):
    if a.shape[0] == size:
        return a
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((size, size), mode), np.float32)
    return np.stack([resize(a[..., k], size, mode) for k in range(a.shape[-1])], -1)


def build(m, out_dir=None, preview=False):
    """Generate one material: write its maps and return its library entry."""
    entry = {k: v for k, v in m.items() if k not in ('gen', 'tile', 'size', 'normal', 'sheen', 'clearcoat',
                                                       'anisotropy', 'alpha', 'roughness', 'metallic', 'relief', 'nsize',
                                                       'minMean')}
    entry.update(builtin=True, source='procedural v3')
    if m.get('tile'):
        t = m['tile']
        entry['tileCm'] = t[0] if isinstance(t, tuple) else t
        if isinstance(t, tuple):
            entry['tileHeightCm'] = t[1]
    entry['roughness'] = m.get('roughness', 1)
    entry['metallic'] = m.get('metallic', 0)
    if m.get('sheen'):
        entry['sheen'] = {'intensity': m['sheen'][0], 'roughness': m['sheen'][1]}
    if m.get('clearcoat'):
        entry['clearcoat'] = {'factor': m['clearcoat'][0], 'roughness': m['clearcoat'][1]}
    if m.get('anisotropy'):
        entry['anisotropy'] = {'strength': m['anisotropy'][0], 'rotation': m['anisotropy'][1]}
    if m.get('alpha') is not None:
        entry['alpha'] = m['alpha']
    gen = m['gen']
    if gen is None:
        return entry
    if isinstance(gen, str):  # same maps as another material, other finish
        return entry
    maps = gen()
    n_out = m.get('size', 1024)
    folder = m['id']
    files = {}
    ref = maps.get('ref', 'mean')
    alb = maps.get('albedo')
    if alb is not None and np.ptp(alb) > 0.02:
        alb = np.clip(alb / np.percentile(alb, 99.9), 0, 1)
        a = resize(alb.astype(np.float32), n_out)
        L = lin(a)
        refv = float(np.median(L) if ref == 'median' else L.mean())
        # The chip colour is divided by this brightness and glTF caps the result at 1, so a dark
        # texture could never show a light chip: lift the shadows (keeping the brightest at 1) until
        # the reference brightness reaches minMean.
        lo = m.get('minMean', MIN_MEAN.get(m['category'], 0.8))
        if refv < lo:
            L = 1 - (1 - L) * (1 - lo) / (1 - refv)
            a = srgb(L)
            refv = float(np.median(L) if ref == 'median' else L.mean())
        entry['albedoMean'] = round(refv, 4)
        files['albedo'] = np.repeat(np.clip(a, 0, 1)[..., None], 3, -1)
    h = maps.get('height')
    if h is not None and m.get('relief'):
        # height range = relief (mm) over the tile's real size, so slopes are physical
        nsize = min(n_out, m.get('nsize', 1024))
        hn = resize(norm01(h, 0.2, 99.8), nsize)
        t = m['tile']
        tx, ty = (t if isinstance(t, tuple) else (t, t))
        sx, sy = m['relief'] / (tx * 10 / nsize), m['relief'] / (ty * 10 / nsize)
        files['normal'] = normal_from_height2(hn, sx, sy) * 0.5 + 0.5
        entry['normalScale'] = 1
    rough = maps.get('roughness')
    ao = maps.get('ao')
    metal = maps.get('metal')
    rough = np.broadcast_to(np.asarray(rough if rough is not None else entry['roughness'], np.float32), (alb if alb is not None else h).shape) if rough is not None else None
    if rough is not None:
        base_shape = rough.shape
        ao_a = np.broadcast_to(np.asarray(ao if ao is not None else 1.0, np.float32), base_shape)
        met = np.broadcast_to(np.asarray(metal if metal is not None else entry['metallic'], np.float32), base_shape)
        if np.ptp(rough) < 0.015 and np.ptp(ao_a) < 0.015 and np.ptp(met) < 0.015:
            entry['roughness'] = round(float(rough.mean()), 3)
        else:
            orm_size = min(n_out, 1024)
            files['orm'] = np.stack([resize(np.clip(ao_a, 0, 1), orm_size), resize(np.clip(rough, 0.02, 1), orm_size),
                                     resize(np.clip(met, 0, 1), orm_size)], -1)
            entry['roughness'] = 1
            entry['roughnessMean'] = round(float(rough.mean()), 3)  # for the card's gloss word
            entry['metallic'] = 1 if met.max() > 0.5 else 0
            if ao is None:
                entry['occlusion'] = False
    entry['maps'] = {}
    for name, arr in files.items():
        slot = {'albedo': 'baseColor', 'normal': 'normal', 'orm': 'orm'}[name]
        entry['maps'][slot] = f'{folder}/{name}.webp'
        img = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
        if preview:
            os.makedirs(out_dir, exist_ok=True)
            img.save(os.path.join(out_dir, f'{folder}_{name}.png'))
        else:
            d = os.path.join(ROOT, 'materials', folder)
            os.makedirs(d, exist_ok=True)
            q = {'albedo': 90, 'normal': 82, 'orm': 80}[name]
            img.save(os.path.join(d, f'{name}.webp'), 'WEBP', quality=q, method=6)
    if not entry['maps']:
        del entry['maps']
    return entry


def main(argv):
    preview = '--preview' in argv
    args = [a for a in argv if not a.startswith('--')]
    out_dir = args.pop(0) if preview and args else None
    only = set(args)
    lib_path = os.path.join(ROOT, 'materials', 'library.json')
    lib = json.load(open(lib_path, encoding='utf-8'))
    entries = {}
    for m in MATERIALS:
        if only and m['id'] not in only:
            continue
        e = build(m, out_dir, preview)
        entries[m['id']] = e
        print(m['id'], {k: v for k, v in e.items() if k in ('albedoMean', 'roughness', 'maps')}, flush=True)
    # finishes that share another material's maps
    for m in MATERIALS:
        if isinstance(m['gen'], str) and m['id'] in entries:
            src = entries.get(m['gen']) or next((x for x in lib['materials'] if x['id'] == m['gen']), None)
            if src:
                for k in ('maps', 'albedoMean', 'tileCm', 'tileHeightCm', 'normalScale', 'occlusion'):
                    if k in src:
                        entries[m['id']][k] = dict(src[k]) if k == 'maps' else src[k]
                # its own finish: the roughness factor would multiply the source's roughness map,
                # so leave that map out and use the plain roughness
                if 'roughness' in m and 'orm' in entries[m['id']].get('maps', {}):
                    del entries[m['id']]['maps']['orm']
                    entries[m['id']].pop('occlusion', None)
    if preview:
        return
    order = {m['id']: k for k, m in enumerate(MATERIALS)}
    mine = {x['id']: x for x in lib['materials'] if x['id'] in order}
    mine.update(entries)
    mats = [x for x in lib['materials'] if x['id'] not in order] + sorted(mine.values(), key=lambda e: order[e['id']])
    # cards show in library order: put these in the order given (from matte to high gloss)
    ids = [e['id'] for e in mats]
    pos = [k for k, x in enumerate(ids) if x in SHOW_ORDER]
    seq = [x for x in SHOW_ORDER if x in ids]
    by = {e['id']: e for e in mats}
    for k, x in zip(pos, seq):
        mats[k] = by[x]
    lib['materials'] = mats
    for k, v in PALETTES.items():
        lib['palettes'][k] = v
    for k, (base, first) in {**CLIONE_COLORS, **JAKOMO_COLORS}.items():
        have = {c['hex'] for c in first}
        lib['palettes'][k] = first + [c for c in lib['palettes'][base] if c['hex'] not in have]
    have = {c['hex'] for c in lib['palettes']['metal']}
    lib['palettes']['metal'] += [c for c in METAL_EXTRA if c['hex'] not in have]
    have = {c['hex'] for c in lib['palettes']['paint']}
    lib['palettes']['paint'] += [c for c in PAINT_EXTRA if c['hex'] not in have]
    with open(lib_path, 'w', encoding='utf-8') as f:
        json.dump(lib, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main(sys.argv[1:])
