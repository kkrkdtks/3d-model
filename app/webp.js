// Browsers write an sRGB colour profile (ICCP chunk) into WebP files made from a
// canvas. Normal and roughness maps are data, not colour, so a profile there is
// wrong (the glTF validator flags it, and some viewers might colour-convert).
// This rewrites the file without the profile; pixels are untouched.

const ascii = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

export function stripWebPProfile(bytes) {
  if (bytes.length < 20 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP') return bytes;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = ascii(bytes, p), size = dv.getUint32(p + 4, true);
    chunks.push({ id, start: p, end: Math.min(bytes.length, p + 8 + size + (size & 1)) });
    p += 8 + size + (size & 1);
  }
  if (!chunks.some((c) => c.id === 'ICCP')) return bytes;
  const simple = !chunks.some((c) => ['ALPH', 'ANIM', 'ANMF', 'EXIF', 'XMP '].includes(c.id));
  const keep = chunks.filter((c) => c.id !== 'ICCP' && !(simple && c.id === 'VP8X'));
  const body = keep.reduce((n, c) => n + (c.end - c.start), 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  let o = 12;
  for (const c of keep) {
    out.set(bytes.subarray(c.start, c.end), o);
    if (c.id === 'VP8X') out[o + 8] &= ~0x20; // clear the "has ICC profile" flag
    o += c.end - c.start;
  }
  return out;
}
