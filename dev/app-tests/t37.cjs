// v1.4.1: fixes found in the final review, through the app.
// - a file this program saved, opened again with its top re-skinned: the replaced material's textures
//   are not carried along unused;
// - the same in compatibility mode: no meshopt compression and no WebP demanded (JPEG textures only);
// - "1,800×900" is a size of 1800 × 900 (thousands comma), not 800 × 900;
// - a colour pasted with its RGB numbers ("#191970 RGB(25, 25, 112)") adds only #191970;
// - a file that is not a GLB, or a Draco-compressed one, is refused in plain words;
// - a .zip that is not a materials-and-colours export is refused in plain words.
// usage: node t37.cjs MADE.glb H [OUT_NAME]   (MADE.glb: a file saved by this program, its top with a textured material)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { zipSync, unzipSync } = require('fflate');
const [GLB, H, NAME = 't37'] = process.argv.slice(2);
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

/** GLB JSON chunk. */
const glbJson = (buf) => JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
/** Images no texture uses, materials no primitive uses. */
function unused(j) {
  const img = new Set((j.textures || []).map((t) => t.source ?? t.extensions?.EXT_texture_webp?.source));
  const mat = new Set(j.meshes.flatMap((m) => m.primitives.map((p) => p.material)));
  return {
    images: (j.images || []).map((im, i) => (img.has(i) ? null : im.name || i)).filter((x) => x !== null),
    materials: (j.materials || []).map((m, i) => (mat.has(i) ? null : m.name)).filter((x) => x !== null),
  };
}

/** A GLB that needs Draco (a JSON chunk only; enough for the check before reading). */
function dracoGlb() {
  const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'], meshes: [] };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + j.length, 8);
  head.writeUInt32LE(j.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, j]);
}

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  const toast = async () => { await p.waitForTimeout(500); return S(() => document.getElementById('toast').textContent); };
  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${saved.dir}/${n}`, data); saved[n] = Buffer.from(data); }
    else { fs.writeFileSync(`${OUT}/${saved.dir}/${fname}`, buf); saved[fname] = buf; }
  });
  const exportAll = async (dir, compat) => {
    for (const k of Object.keys(saved)) delete saved[k];
    saved.dir = dir;
    fs.mkdirSync(`${OUT}/${dir}`, { recursive: true });
    await S((c) => { const st = window.__studio; st.S.photos = false; st.S.compat = c; window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; }, compat);
    await S(() => window.__studio.runExport('folder'));
    await p.waitForTimeout(800);
    const name = Object.keys(saved).find((n) => n.endsWith('.glb'));
    return { name, buf: saved[name] };
  };

  // 1. refused files, in plain words (before a model is open)
  fs.writeFileSync(`${OUT}/notglb.glb`, 'this is not a 3D model at all, only some text');
  await p.setInputFiles('#fileInput', `${OUT}/notglb.glb`);
  let t = await toast();
  log('not a GLB ->', t);
  check(/GLB 파일이 아니거나/.test(t), 'a file that is not a GLB is refused in plain words');
  fs.writeFileSync(`${OUT}/draco.glb`, dracoGlb());
  await p.setInputFiles('#fileInput', `${OUT}/draco.glb`);
  t = await toast();
  log('Draco ->', t);
  check(/Draco로 압축된 GLB/.test(t), 'a Draco-compressed GLB is refused in plain words');
  check(await S(() => !window.__studio.S.file), 'nothing is open after the refused files');

  // 2. a .zip that is not a library export
  fs.writeFileSync(`${OUT}/other.zip`, Buffer.from(zipSync({ 'readme.txt': new Uint8Array(Buffer.from('hello')) })));
  await p.setInputFiles('#libInput', `${OUT}/other.zip`);
  t = await toast();
  log('other zip ->', t);
  check(/재질과 색이 든 \.zip이 아니에요/.test(t), 'a zip without materials is refused in plain words');
  fs.writeFileSync(`${OUT}/broken.zip`, 'PK not really a zip');
  await p.setInputFiles('#libInput', `${OUT}/broken.zip`);
  t = await toast();
  log('broken zip ->', t);
  check(/ZIP 파일을 읽지 못했어요/.test(t), 'a broken zip is refused in plain words');

  // 3. the made file, its top re-skinned
  const inJson = glbJson(fs.readFileSync(GLB));
  log('input: materials', inJson.materials.map((m) => m.name).join(' | '), '· images', inJson.images.length, '· required', inJson.extensionsRequired.join(' '));
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(400);
  const top = await S(() => {
    const ps = window.__studio.S.parts, maxY = Math.max(...ps.map((q) => q.max[1]));
    return ps.filter((q) => q.max[1] > maxY - 1e-6 * Math.abs(maxY) - 1e-6).sort((a, c) => c.area - a.area)[0].id;
  });
  await S((top) => { const st = window.__studio; st.newGroup([top]); const g = st.S.groups[0]; g.name = '상판'; st.addChoice(g, 'wood-oak', { hex: '#D8BF98', name: '오크' }); g.pick = 'wood-oak'; st.updatePreview(g); st.refreshAll(); }, top);
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });

  // 4. sizes and colours typed in the panel
  await p.fill('#sizeInput', '1,800×900, 2,000×1,000');
  await p.press('#sizeInput', 'Enter');
  await p.waitForTimeout(300);
  const sizes = await S(() => window.__studio.S.groups[0].sizes.map((z) => `${z.w}x${z.d}`));
  log('sizes from "1,800×900, 2,000×1,000":', sizes.join(', '));
  check(sizes.join(',') === '1800x900,2000x1000', 'thousands commas are read as part of the number');
  await S(() => { const g = window.__studio.S.groups[0]; g.sizes = []; g.activeSize = null; window.__studio.updatePreview(g); window.__studio.refreshAll(); });
  await p.waitForTimeout(300);
  await p.fill('#hexInput', 'Midnight Blue #191970 RGB(25, 25, 112)');
  await p.press('#hexInput', 'Enter');
  await p.waitForTimeout(300);
  const hexes = await S(() => window.__studio.S.groups[0].choices.map((c) => c.color?.hex));
  log('colours after pasting "Midnight Blue #191970 RGB(25, 25, 112)":', hexes.join(', '));
  check(hexes.includes('#191970') && !hexes.includes('#111122') && hexes.length === 2, 'only the hex code is taken, not the RGB numbers');
  await S(() => { const st = window.__studio, g = st.S.groups[0]; g.choices = g.choices.filter((c) => c.color?.hex === '#D8BF98'); g.active = g.choices[0].id; st.updatePreview(g); st.refreshAll(); });

  // 5. normal export: nothing carried along unused
  const normal = await exportAll('normal', false);
  const nj = glbJson(normal.buf), nu = unused(nj);
  log('saved', normal.name, (normal.buf.length / 1048576).toFixed(2), 'MB · materials', nj.materials.map((m) => m.name).join(' | '), '· images', nj.images.length, '· unused images', JSON.stringify(nu.images), '· unused materials', JSON.stringify(nu.materials));
  check(!nu.images.length && !nu.materials.length, 'no texture or material of the replaced finish is left in the file');
  check(nj.extensionsRequired.includes('EXT_meshopt_compression'), 'normal mode still compresses with meshopt');

  // 6. compatibility mode
  const compat = await exportAll('compat', true);
  const cj = glbJson(compat.buf), cu = unused(cj);
  const meshoptViews = (cj.bufferViews || []).filter((v) => v.extensions?.EXT_meshopt_compression).length;
  log('compat', compat.name, (compat.buf.length / 1048576).toFixed(2), 'MB · used', cj.extensionsUsed.join(' '), '· required', cj.extensionsRequired.join(' '), '· images', cj.images.map((im) => im.mimeType).join(','), '· meshopt views', meshoptViews);
  check(!cj.extensionsUsed.includes('EXT_meshopt_compression') && !meshoptViews, 'compatibility mode writes no meshopt compression');
  check(!cj.extensionsUsed.includes('EXT_texture_webp') && cj.images.every((im) => im.mimeType === 'image/jpeg'), 'compatibility mode has JPEG textures only and does not demand WebP');
  check(!cu.images.length && !cu.materials.length, 'compatibility file carries nothing unused');
  const qc = await S(() => window.__studio.S.results.map((r) => ({ name: r.name, errors: r.qc?.check?.errors, warnings: r.qc?.check?.warnings, failed: r.qc?.check?.failed || r.qc?.failed })));
  log('checks', JSON.stringify(qc));
  check(qc.length && qc.every((r) => r.errors === 0), 'Khronos validator finds no errors');

  await b.close();
  log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
