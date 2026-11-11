"""Catalogue sheet of the built-in materials as they ship (materials/library.json + WebP maps):
each material lit on a gently domed tile at real size, grouped by the app's tabs.
usage: python3 catalog.py OUT.png [id:#hex ...]  (hex overrides the sample colour)"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LIB = json.load(open(os.path.join(ROOT, 'materials', 'library.json'), encoding='utf-8'))
OUT = sys.argv[1]
OVR = dict(a.split(':', 1) for a in sys.argv[2:])
TABS = ['가죽', '패브릭', '클리오네', '자코모', '뮤무', '대리석', '나무', '도장', '메탈', '기타']
VIEW_CM = {'가죽': 12, '패브릭': 10, '클리오네': 10, '자코모': 10, '뮤무': 10, '대리석': 60, '나무': 45, '도장': 10, '메탈': 10, '기타': 14}
SAMPLE = {  # a typical colour per material for the sheet
    'leather-matte': '#6B4A35', 'leather-gloss': '#2A2624', 'leather-vintage': '#8A5A36', 'leather-nappa': '#C9B9A3',
    'leather-milled': '#5B3B2A', 'leather-nubuck': '#9B7A58', 'leather-suede': '#A36B45', 'leather-semianiline': '#8B5A3C',
    'leather-pu': '#2B2B2B', 'leather-croc': '#5A3A28', 'fabric-linen': '#C8BBA6', 'fabric-boucle': '#EDE6D8',
    'fabric-velvet': '#1F3B57', 'fabric-chenille': '#9C8F7E', 'fabric-corduroy': '#B8865B', 'fabric-cotton': '#D9D4C7',
    'fabric-herringbone': '#7D7F82', 'fabric-tweed': '#6E6A60', 'fabric-teddy': '#F1ECE2', 'fabric-microfiber': '#5C6670',
    'paint-supermatte': '#3A3B3C', 'paint-matte': '#E8E2D4', 'paint-satin': '#9AA58E', 'paint-gloss': '#B5603F',
    'paint-highgloss': '#1D1C1B', 'paint-powder': '#1D1C1B', 'paint-sand': '#3A3B3C', 'metal': '#C9CACB',
    'metal-hairline': '#D4AF6A', 'metal-mirror': '#C9CACB', 'metal-blast': '#C9CACB', 'metal-hammered': '#B8734D',
    'metal-antique': '#B08D57', 'metal-cast': '#3A3A3B', 'glass-clear': '#D9E3E1', 'glass-frosted': '#E6ECEA',
    'other-pp': '#E8E2D4',
}
PX = 236


def lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex_lin(h):
    h = h.lstrip('#')
    return lin(np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255)


def load(p):
    return np.asarray(Image.open(os.path.join(ROOT, 'materials', p)).convert('RGB'), np.float32) / 255


def sample(img, cm, tw, th, px):
    h, w = img.shape[:2]
    ys, xs = np.mgrid[0:px, 0:px].astype(np.float32)
    u = (xs / px * cm / tw * w + 0.1 * w) % w
    v = (ys / px * cm / th * h + 0.1 * h) % h
    x0, y0 = np.floor(u).astype(int), np.floor(v).astype(int)
    fx, fy = (u - x0)[..., None], (v - y0)[..., None]
    x1, y1 = (x0 + 1) % w, (y0 + 1) % h
    a = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    b = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return a * (1 - fy) + b * fy


def env(R):
    """Studio surroundings: bright ceiling and a soft box up left, darker floor."""
    up = np.clip(R[..., 1], -1, 1)
    e = 0.12 + 0.55 * np.clip(up * 0.5 + 0.5, 0, 1) ** 1.5
    box = np.exp(-((R[..., 0] + 0.45) ** 2 + (R[..., 1] - 0.55) ** 2) / 0.04) * 2.2
    return (e + box)[..., None]


def shade(m, hexc, cm, px=PX):
    tw = m.get('tileCm') or 10
    th = m.get('tileHeightCm') or tw
    maps = m.get('maps') or {}
    tint = hex_lin(hexc) if m.get('colorMode') != 'photo' else np.ones(3, np.float32)
    factor = np.minimum(tint / (m.get('albedoMean') or 1), 1)
    base = lin(sample(load(maps['baseColor']), cm, tw, th, px)) * factor if 'baseColor' in maps else np.broadcast_to(factor, (px, px, 3)).copy()
    ys, xs = np.mgrid[0:px, 0:px].astype(np.float32)
    u, v = xs / px - 0.5, ys / px - 0.5
    # a gently domed tile, so gloss shows as a highlight
    Np = np.stack([u * 0.55, -v * 0.55, np.ones_like(u)], -1)
    if 'normal' in maps:
        t = sample(load(maps['normal']), cm, tw, th, px) * 2 - 1
        k = m.get('normalScale', 1)
        Np[..., 0] += t[..., 0] * k
        Np[..., 1] += t[..., 1] * k
    N = Np / np.linalg.norm(Np, axis=-1, keepdims=True)
    N = N * np.array([1, 1, 1], np.float32)
    rough = np.full((px, px), m.get('roughness', 1), np.float32)
    met = np.full((px, px), m.get('metallic', 0), np.float32)
    ao = np.ones((px, px), np.float32)
    if 'orm' in maps:
        O = sample(load(maps['orm']), cm, tw, th, px)
        rough = rough * O[..., 1]
        met = met * O[..., 2]
        if m.get('occlusion') is not False:
            ao = O[..., 0]
    V = np.array([0, 0.35, 0.94], np.float32)
    V /= np.linalg.norm(V)
    f0 = 0.04 * (1 - met[..., None]) + base * met[..., None]
    diff = base * (1 - met[..., None])
    r = np.clip(rough, 0.04, 1)
    a2 = r ** 4
    out = np.zeros((px, px, 3), np.float32)
    nv = np.clip((N * V).sum(-1), 1e-3, 1)
    for L, I in ((np.array([-0.5, 0.55, 0.67]), 2.4), (np.array([0.65, 0.1, 0.75]), 0.5)):
        L = L / np.linalg.norm(L)
        H = (L + V) / np.linalg.norm(L + V)
        nl = np.clip((N * L).sum(-1), 0, 1)
        nh = np.clip((N * H).sum(-1), 0, 1)
        D = a2 / (np.pi * (nh * nh * (a2 - 1) + 1) ** 2)
        kk = (r + 1) ** 2 / 8
        G = nl / (nl * (1 - kk) + kk) * nv / (nv * (1 - kk) + kk)
        F = f0 + (1 - f0) * (1 - np.clip((V * H).sum(-1), 0, 1))[..., None] ** 5
        spec = F * (D * G / (4 * nl * nv + 1e-4))[..., None]
        if m.get('clearcoat'):
            cr = max(m['clearcoat'].get('roughness', 0.1), 0.04) ** 4
            Dc = cr / (np.pi * (nh * nh * (cr - 1) + 1) ** 2)
            spec = spec + m['clearcoat'].get('factor', 1) * 0.04 * (Dc * 0.25 / np.maximum(nl * nv, 0.05))[..., None]
        out += I * (diff / np.pi * nl[..., None] + np.minimum(spec, 30) * nl[..., None])
    # surroundings: diffuse light and a blurred reflection that sharpens with gloss
    R = 2 * nv[..., None] * N - V
    sharp = env(R)
    blur = 0.35
    refl = sharp * (1 - r[..., None]) ** 2 + blur * (1 - (1 - r[..., None]) ** 2)
    Fe = f0 + (1 - f0) * (1 - nv)[..., None] ** 5 * (1 - r[..., None]) ** 2
    out += 0.42 * diff * ao[..., None] + Fe * refl * ao[..., None] * 0.9
    if m.get('clearcoat'):
        out += m['clearcoat'].get('factor', 1) * 0.04 * sharp * (1 - m['clearcoat'].get('roughness', 0.1)) ** 2
    if m.get('sheen'):
        s = m['sheen'].get('intensity', 0.5)
        out += (s * 0.25 * (1 - nv) ** 2 * ao)[..., None] * np.minimum(tint * 1.4 + 0.08, 1)
    if m.get('alpha') is not None:
        # glass over a light floor with a dark stripe, so see-through reads
        back = np.where(((xs // 24 + ys // 24) % 2)[..., None] == 0, 0.62, 0.42) * np.ones(3, np.float32)
        if m['roughness'] > 0.2:  # frosted: what is behind is blurred away
            back = np.full_like(back, 0.52)
        out = out * m['alpha'] + back * (1 - m['alpha']) * np.maximum(tint * 1.1, 0.6) + Fe * refl * 0.4
    return srgb(out * 0.82)


def font(sz):
    for f in ('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',):
        if os.path.exists(f):
            return ImageFont.truetype(f, sz)
    return ImageFont.load_default()


mats = LIB['materials']
rows = [(t, [m for m in mats if m['category'] == t]) for t in TABS]
cols = max(len(r[1]) for r in rows)
GAP, LBL, HEAD = 14, 46, 34
W = 40 + cols * (PX + GAP)
Hh = 90 + sum(HEAD + PX + LBL + 18 for _ in rows)
sheet = Image.new('RGB', (W, Hh), (247, 245, 241))
dr = ImageDraw.Draw(sheet)
dr.text((24, 22), f"가구스킨스튜디오 · 기본 재질 {len(mats)}개  (각 칸: 실제 크기, 예시 색)", fill=(30, 28, 26), font=font(30))
y = 90
for tab, ms in rows:
    dr.text((24, y), f"{tab}  {len(ms)}", fill=(150, 80, 40), font=font(24))
    y += HEAD
    for k, m in enumerate(ms):
        hexc = OVR.get(m['id']) or SAMPLE.get(m['id']) or m.get('swatchHex') or '#A89F94'
        cm = VIEW_CM[tab] if m.get('maps') else 10
        if tab == '기타' and m.get('maps'):
            cm = min(max(m.get('tileCm', 10) * 1.5, 10), 30)
        img = shade(m, hexc, cm)
        x = 24 + k * (PX + GAP)
        sheet.paste(Image.fromarray((img * 255 + 0.5).astype(np.uint8)), (x, y))
        dr.text((x, y + PX + 4), m['name'], fill=(25, 25, 25), font=font(17))
        dr.text((x, y + PX + 25), f"{hexc.upper()}  ·  {cm:g} cm 보기", fill=(120, 116, 110), font=font(13))
    y += PX + LBL + 18
sheet.save(OUT, optimize=True)
print(OUT, sheet.size)
