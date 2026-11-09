// Part check for the batch maker: opens a model in the real app at its real height, puts every part the
// app found in a group of its own (distinct colours) and saves shots of the parts view and of the original
// from three directions, plus the part list (height range, size share) as JSON.
// usage: node dev/batch/inspect.cjs model.glb H out_dir
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ROOT = path.resolve(__dirname, '../..');
const [GLB, H, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const tmp = path.join(OUT, '_input.glb');
  fs.copyFileSync(GLB, tmp);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.goto('file://' + path.join(ROOT, 'dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', tmp);
  await p.waitForFunction(() => window.__studio?.S.workKey && window.__studio.S.parts.length > 0, null, { timeout: 600000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(500);
  const info = await S(() => {
    const st = window.__studio.S, ps = st.parts;
    const minY = Math.min(...ps.map((q) => q.min[1])), maxY = Math.max(...ps.map((q) => q.max[1])), Hm = maxY - minY;
    const tot = ps.reduce((s, q) => s + q.area, 0);
    return { size: document.querySelector('#stage').innerText.match(/[WDH] [\d,]+/g), parts: ps.map((q) => ({ id: q.id, y0: +((q.min[1] - minY) / Hm).toFixed(3), y1: +((q.max[1] - minY) / Hm).toFixed(3), area: +(q.area / tot * 100).toFixed(1), faces: q.faces, min: q.min.map((v) => +v.toFixed(3)), max: q.max.map((v) => +v.toFixed(3)) })) };
  });
  fs.writeFileSync(path.join(OUT, 'parts.json'), JSON.stringify(info, null, 1));
  console.log(path.basename(GLB), 'size', info.size?.join(' '), 'parts', info.parts.length);
  for (const q of info.parts) console.log(`  ${q.id}: h ${q.y0}-${q.y1}  area ${q.area}%  faces ${q.faces}`);
  const dirs = { front: [0, 0.25, 1], quarter: [0.8, 0.5, 1], below: [0.6, -0.45, 1] };
  const shoot = async (tag) => {
    const files = [];
    for (const [n, dir] of Object.entries(dirs)) {
      await S((dir) => { const v = window.__studio.viewer, t = v.controls.target, d = v.camera.position.distanceTo(t); const k = v.camera.position.clone().set(...dir).normalize(); v.camera.position.copy(t).addScaledVector(k, d); v.controls.update(); v.dirty = true; }, dir);
      await p.waitForTimeout(700);
      const f = path.join(OUT, `${tag}_${n}.png`); await p.locator('#stage').screenshot({ path: f }); files.push(f);
    }
    return files;
  };
  const orig = await shoot('orig');
  await S(() => { const st = window.__studio; for (const q of st.S.parts) { st.newGroup([q.id]); st.S.groups.at(-1).name = `부위 ${q.id}`; } st.S.view = 'parts'; st.refreshAll(); });
  await p.waitForTimeout(600);
  const colors = await S(() => window.__studio.S.groups.map((g) => g.color));
  const parts = await shoot('parts');
  // one sheet: originals on top, parts below, with a colour legend
  const tiles = [...orig, ...parts].map((f) => ({ input: f }));
  const w = 600, h = 450;
  const comp = [];
  for (let i = 0; i < tiles.length; i++) comp.push({ input: await sharp(tiles[i].input).resize(w, h, { fit: 'contain', background: '#ffffff' }).toBuffer(), left: (i % 3) * w, top: Math.floor(i / 3) * h });
  const legend = info.parts.map((q, i) => `<rect x="${10 + (i % 6) * 300}" y="${10 + Math.floor(i / 6) * 34}" width="26" height="26" fill="${colors[i]}"/><text x="${44 + (i % 6) * 300}" y="${30 + Math.floor(i / 6) * 34}" font-size="20" font-family="sans-serif">${q.id}: h ${q.y0}-${q.y1}, ${q.area}%</text>`).join('');
  const lh = 20 + Math.ceil(info.parts.length / 6) * 34;
  comp.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${3 * w}" height="${lh}"><rect width="100%" height="100%" fill="#fff"/>${legend}</svg>`), left: 0, top: 2 * h });
  await sharp({ create: { width: 3 * w, height: 2 * h + lh, channels: 3, background: '#ffffff' } }).composite(comp).png().toFile(path.join(OUT, 'sheet.png'));
  fs.rmSync(tmp, { force: true });
  await b.close();
})();
