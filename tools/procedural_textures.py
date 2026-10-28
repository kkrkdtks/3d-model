"""Procedural, seamlessly tiling PBR textures (placeholders until real supplier swatches).

Outputs albedo (neutral, colour comes from the hex chip), normal (glTF/OpenGL +Y) and
ORM (R=occlusion, G=roughness, B=metal) PNGs. Then run tools/add-material.mjs to put
them in materials/.

    python tools/procedural_textures.py out/        # regenerates the current set
"""
import sys
import numpy as np
from PIL import Image

def fft_noise(size, rng, f_lo, f_hi, beta=1.0):
    """Periodic band-limited noise in [-1,1]; frequencies in cycles per tile."""
    w = rng.standard_normal((size, size))
    F = np.fft.fft2(w)
    fy = np.fft.fftfreq(size)[:, None] * size; fx = np.fft.fftfreq(size)[None, :] * size
    f = np.sqrt(fx**2 + fy**2) + 1e-9
    band = np.exp(-((np.log(f) - np.log(np.sqrt(f_lo*f_hi)))**2) / (2*(0.5*np.log(f_hi/f_lo)+0.3)**2)) / f**beta
    n = np.real(np.fft.ifft2(F * band))
    n -= n.mean(); n /= (np.abs(n).max() + 1e-12)
    return n.astype(np.float32)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)


def normal_from_height(h, strength):
    """Tangent-space normal map (glTF/OpenGL convention: +X right, +Y up)."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5   # +row = down
    n = np.stack([-dx * strength, dy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def worley_id(size, N, rng, warp=None, jitter=1.0, aniso=1.0):
    """Periodic Worley with cell ids. aniso stretches cells horizontally."""
    pts = 0.5 + (rng.random((N, N, 2)) - 0.5) * jitter
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    x = (xs + 0.5) / size * N; y = (ys + 0.5) / size * N
    if warp is not None: x = x + warp[0]; y = y + warp[1]
    cx = np.floor(x).astype(np.int32); cy = np.floor(y).astype(np.int32)
    F1 = np.full((size, size), 9.0, np.float32); F2 = F1.copy(); ID = np.zeros((size, size), np.int32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nx = cx + dx; ny = cy + dy
            p = pts[ny % N, nx % N]
            d = np.sqrt(((nx + p[..., 0] - x) / aniso)**2 + (ny + p[..., 1] - y)**2)
            closer = d < F1
            F2 = np.where(closer, F1, np.minimum(F2, d)); ID = np.where(closer, (ny % N) * N + (nx % N), ID); F1 = np.minimum(F1, d)
    return F1, F2, ID


def blur(a, r):
    """Periodic gaussian blur via FFT, r in pixels."""
    size = a.shape[0]; f = np.fft.fftfreq(size)
    g = np.exp(-2 * (np.pi * r)**2 * (f[:, None]**2 + f[None, :]**2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g)).astype(np.float32)


def leather(size=2048, seed=1, cells=64, kind="matte"):
    rng = np.random.default_rng(seed)
    warp = (fft_noise(size, rng, 3, 12) * 0.55, fft_noise(size, rng, 3, 12) * 0.55)
    F1, F2, ID = worley_id(size, cells, rng, warp, jitter=1.0, aniso=1.2)
    w = F2 - F1
    amp = 0.8 + 0.2 * rng.random(cells * cells)[ID]
    pebble = amp * smoothstep(0.0, 0.6, w) ** 0.85
    warp2 = (fft_noise(size, rng, 10, 40) * 0.4, fft_noise(size, rng, 10, 40) * 0.4)
    G1, G2, _ = worley_id(size, cells * 3, rng, warp2, jitter=1.0)
    sub = smoothstep(0.0, 0.3, G2 - G1)
    submask = smoothstep(0.0, 0.6, fft_noise(size, rng, 4, 14))
    h = blur(pebble * (1 - 0.25 * submask * (1 - sub)), 1.0)
    macro = fft_noise(size, rng, 1.5, 6)
    skin = fft_noise(size, rng, 200, 500)
    grain = {"matte": 1.0, "gloss": 0.55, "vintage": 0.35}[kind]
    hh = grain * h + 0.5 * macro + 0.03 * skin
    n = normal_from_height(hh, strength=1.5 * size / 1024)
    crease = blur(1 - smoothstep(0.0, 0.25, w), 1.5)
    patch = fft_noise(size, rng, 1.5, 5)
    alb = 1.0 - 0.03 * grain * crease + 0.02 * patch
    rough = {"matte": 0.60, "gloss": 0.26, "vintage": 0.48}[kind] + 0.08 * grain * crease
    if kind == "vintage":
        cloud = fft_noise(size, rng, 2, 10)
        alb = alb + 0.10 * smoothstep(0.0, 0.9, cloud) - 0.06 * smoothstep(0.2, 0.9, -cloud) + 0.04 * blur(h, 3)
        rough = rough + 0.08 * cloud
    alb = np.clip(alb / alb.max(), 0, 1)
    ao = np.clip(1.0 - 0.2 * grain * crease, 0, 1)
    return alb, n, np.clip(rough, 0.05, 1), ao


def linen(size=2048, seed=2, threads=128):
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    X = (xs + 0.5) / size * threads; Y = (ys + 0.5) / size * threads
    X = X + fft_noise(size, rng, 2, 10) * 0.35; Y = Y + fft_noise(size, rng, 2, 10) * 0.35
    i = np.floor(X).astype(np.int32); j = np.floor(Y).astype(np.int32); a = X - i; b = Y - j
    # slubs: thickness varies along each thread, stronger on ~25% of threads
    slw = 0.5 * (fft_noise(size, rng, 6, 30) + 1); slf = 0.5 * (fft_noise(size, rng, 6, 30) + 1)
    sw = (rng.random(threads) < 0.25)[i % threads]; sf = (rng.random(threads) < 0.25)[j % threads]
    tw = 0.78 + 0.22 * np.where(sw, slw, 0.4); tf = 0.78 + 0.22 * np.where(sf, slf, 0.4)
    def prof(t, width):
        u = np.clip(1 - ((2 * t - 1) / width) ** 2, 0, 1); return u ** 0.5
    top = ((i + j) % 2) == 0
    pw = prof(a, tw) * (0.6 + 0.4 * np.sin(np.pi * b) ** 0.5)
    pf = prof(b, tf) * (0.6 + 0.4 * np.sin(np.pi * a) ** 0.5)
    h = np.where(top, 0.45 + 0.55 * pw, 0.45 + 0.55 * pf)
    h = np.maximum(h, np.where(top, 0.4 * pf, 0.4 * pw))
    # fibres: streaks along the thread direction
    fx = blur(rng.standard_normal((size, size)).astype(np.float32), 0.6)
    fib_w = np.roll(fx, 0, 0); fib = np.where(top, blur(fx, 0.5), blur(fx.T, 0.5))
    h = h + 0.05 * fib
    n = normal_from_height(blur(h, 0.6), strength=1.1 * size / 1024)
    heather = 0.5 * (fft_noise(size, rng, 60, 200) + 1)
    tone = 1 + 0.025 * np.where(top, rng.standard_normal(threads)[i % threads], rng.standard_normal(threads)[j % threads])
    alb = (0.84 + 0.16 * np.where(top, pw, pf)) * tone * (0.96 + 0.06 * heather) + 0.02 * fft_noise(size, rng, 1.5, 5)
    alb = np.clip(alb / alb.max(), 0, 1)
    rough = np.clip(0.9 - 0.05 * np.where(top, pw, pf), 0, 1)
    ao = np.clip(0.72 + 0.28 * np.where(top, pw, pf), 0, 1)
    return alb, n, rough, ao


def write_set(name, alb, n, rough, ao, outdir, size_out=None):
    import os
    os.makedirs(outdir, exist_ok=True)
    def rs(img):
        return img.resize((size_out, size_out), Image.LANCZOS) if size_out else img
    a8 = Image.fromarray((np.clip(alb, 0, 1) * 255 + .5).astype(np.uint8)).convert("RGB")
    rs(a8).save(f"{outdir}/{name}_albedo.png")
    rs(Image.fromarray(((n * 0.5 + 0.5) * 255 + .5).astype(np.uint8))).save(f"{outdir}/{name}_normal.png")
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)
    rs(Image.fromarray((orm * 255 + .5).astype(np.uint8))).save(f"{outdir}/{name}_orm.png")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "out"
    write_set("leather_matte", *leather(2048, 1, 64, "matte"), out, 1024)
    write_set("leather_gloss", *leather(2048, 4, 80, "gloss"), out, 1024)
    write_set("leather_vintage", *leather(2048, 5, 56, "vintage"), out, 1024)
    write_set("fabric_linen", *linen(2048, 2), out, 1024)
    print("saved to", out)
