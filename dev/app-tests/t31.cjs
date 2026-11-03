// v1.1: pattern direction. Per part: the 무늬 방향 slider / number / quick buttons turn the pattern by any
// degree and the 3D view follows; a photo material carries its own correction (무늬 바로잡기) that adds up
// with the part's angle; both reach the saved GLB, the JSON and the CSV, and the work memory keeps the angle.
// usage: node t31.cjs MODEL.glb H [OUT_NAME]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { unzipSync } = require('fflate');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [GLB, H, NAME = 't31'] = args;
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Median signed angle (degrees) from uv a to uv b over the same vertices, and the largest length change,
 * measured in metres (the tile of the material undone, since a non-square tile scales u and v differently).
 */
function turnBetween(a, b, def = {}) {
  const tu = (def.tileCm || 25) / 100, tv = (def.tileHeightCm || def.tileCm || 25) / 100;
  const angles = [];
  let maxLen = 0;
  for (let i = 0; i < a.length; i += 2) {
    const au = a[i] * tu, av = a[i + 1] * tv, bu = b[i] * tu, bv = b[i + 1] * tv;
    const la = Math.hypot(au, av), lb = Math.hypot(bu, bv);
    if (la < 0.05) continue;
    maxLen = Math.max(maxLen, Math.abs(lb - la) / la);
    const cross = au * bv - av * bu, dot = au * bu + av * bv;
    angles.push((Math.atan2(cross, dot) * 180) / Math.PI);
  }
  angles.sort((x, y) => x - y);
  return { deg: angles[Math.floor(angles.length / 2)] ?? NaN, maxLen, n: angles.length };
}

(async () => {
  // a "photo" of wood with horizontal grain lines, so the turned pattern is easy to see
  const stripes = Array.from({ length: 40 }, (_, i) => `<rect x="0" y="${i * 12.8}" width="512" height="${4 + (i % 3) * 2}" fill="rgb(${120 + (i % 5) * 8},${80 + (i % 4) * 6},${45 + (i % 3) * 5})"/>`).join('');
  const photoPng = `${OUT}/grain.png`;
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#B48A5A"/>${stripes}</svg>`)).png().toFile(photoPng);

  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류|warn/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  const openModel = async () => {
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio?.S.workKey && window.__studio.S.parts.length > 0, null, { timeout: 300000 });
  };
  await openModel();
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(300);
  // one group of every part, with a built-in wood (tinted) material
  await S(() => { const st = window.__studio; st.S.selection = new Set(st.S.parts.map((q) => q.id)); st.refreshAll(); });
  await p.click('[data-action="group-new"]');
  await S(() => { const st = window.__studio, g = st.S.groups[0]; g.name = '상판'; st.addChoice(g, 'wood-oak', { hex: '#A67C52', name: '오크' }); g.pick = 'wood-oak'; st.updatePreview(g); st.refreshAll(); });
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.waitForTimeout(300);
  const uvOf = () => S(() => { const st = window.__studio, g = st.S.groups[0]; const m = st.viewer.skins.get(g.key); return Array.from(m.geometry.attributes.uv.array.subarray(0, Math.min(m.geometry.attributes.uv.array.length, 20000))); });
  const uv0 = await uvOf();
  const oak = await S(() => window.__studio.materialById('wood-oak'));
  log('wood-oak tile', oak.tileCm, oak.tileHeightCm);
  check(await S(() => !!document.querySelector('#rotRange') && !!document.querySelector('#rotNum')), 'direction slider and number shown for a patterned material');
  await p.locator('#rotRange').scrollIntoViewIfNeeded();
  await p.locator('.rot-row').locator('..').screenshot({ path: `${OUT}/direction_field.png` }).catch((e) => log('shot', e.message));

  // slider: 35°
  await p.$eval('#rotRange', (el) => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(600);
  const uv35 = await uvOf();
  const t35 = turnBetween(uv0, uv35, oak);
  log('slider 35:', JSON.stringify(t35));
  check(await S(() => window.__studio.S.groups[0].rotate) === 35, 'group angle is 35');
  check(await S(() => document.querySelector('#rotNum').value) === '35', 'number box follows the slider');
  check(await S(() => ![...document.querySelectorAll('[data-action="rotate"]')].some((b) => b.classList.contains('on'))), 'quick buttons off at 35°');
  check(near(Math.abs(t35.deg), 35, 0.6) && t35.maxLen < 0.01, `view UVs turned by 35° with lengths kept (${t35.deg.toFixed(2)}°, len dev ${t35.maxLen.toExponential(1)})`);
  await p.screenshot({ path: `${OUT}/view_35.png` });
  await p.locator('.rot-row').locator('..').screenshot({ path: `${OUT}/direction_field_35.png` }).catch((e) => log('shot', e.message));

  // quick button 90°
  await p.click('[data-action="rotate"][data-rot="90"]');
  await p.waitForTimeout(600);
  const t90 = turnBetween(uv0, await uvOf(), oak);
  log('button 90:', JSON.stringify(t90));
  check(near(Math.abs(t90.deg), 90, 0.6) && t90.maxLen < 0.01, `90° button turns the pattern a quarter (${t90.deg.toFixed(2)}°)`);
  check(await S(() => document.querySelector('#rotRange').value === '90' && document.querySelector('#rotNum').value === '90'), 'slider and number follow the button');

  // number box: -20
  await p.fill('#rotNum', '-20');
  await p.waitForTimeout(600);
  const tm20 = turnBetween(uv0, await uvOf(), oak);
  log('number -20:', JSON.stringify(tm20));
  check(await S(() => window.__studio.S.groups[0].rotate) === -20 && near(Math.abs(tm20.deg), 20, 0.6) && Math.sign(tm20.deg) === -Math.sign(t35.deg), 'typing -20 turns the other way');
  check(await S(() => document.querySelector('#rotRange').value) === '-20', 'slider follows the number box');

  // a photo material with its own correction
  await p.click('[data-action="tab"][data-tab="나무"]');
  await p.click('[data-action="photo-open"][data-kind="wood"]');
  await p.setInputFiles('#photoInput', photoPng);
  await p.waitForTimeout(2000);
  check(await S(() => !!document.querySelector('#pRotate')), 'photo dialog has 무늬 바로잡기');
  const canvasPng = () => S(() => document.querySelector('#photoCanvas').toDataURL('image/png'));
  const c0 = await canvasPng();
  await p.$eval('#pRotate', (el) => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(900);
  const c30 = await canvasPng();
  check(c0 !== c30, 'preview tiles redrawn for the turned pattern');
  check(await S(() => document.querySelector('#pRotateVal').textContent) === '30°', 'angle shown next to the slider');
  await p.locator('#photoDialog').screenshot({ path: `${OUT}/photo_dialog_30.png` });
  await p.click('#photoSave');
  await p.waitForFunction(() => !document.getElementById('photoDialog').open, null, { timeout: 120000 });
  const photoId = await S(() => window.__studio.S.groups[0].pick);
  const def30 = await S((id) => window.__studio.materialById(id), photoId);
  log('photo material', photoId, 'rotate', def30?.rotate, 'tile', def30?.tileCm);
  check(def30?.rotate === 30 && def30.source === 'photo', 'material saved with rotate 30');
  await p.waitForFunction(() => { const g = window.__studio.S.groups[0]; return g.skinShown && g.choices.find((c) => c.id === g.active)?.materialId === g.pick; }, null, { timeout: 120000 });
  await S(() => { const st = window.__studio; st.setPatternAngle(st.S.groups[0], 0); });
  await p.waitForTimeout(700);
  const uvPhoto30 = await uvOf();
  // the same material straightened to 0 through the edit dialog: the view turns back by 30°
  await S((id) => window.__studio.openEditDialog(id), photoId);
  await p.waitForFunction(() => document.getElementById('photoDialog').open && document.querySelector('#pRotate'), null, { timeout: 60000 });
  await p.waitForTimeout(1200);
  check(await S(() => document.querySelector('#pRotate').value) === '30', 'edit dialog shows the saved angle');
  await p.$eval('#pRotate', (el) => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(400);
  await p.click('#photoSave');
  await p.waitForFunction(() => !document.getElementById('photoDialog').open, null, { timeout: 120000 });
  await p.waitForTimeout(2500);
  const uvPhoto0 = await uvOf();
  const tp = turnBetween(uvPhoto0, uvPhoto30, def30);
  log('material 30 vs 0:', JSON.stringify(tp));
  check(uvPhoto0.length === uvPhoto30.length && near(Math.abs(tp.deg), 30, 0.6) && tp.maxLen < 0.01, `material correction turns the view by 30° (${tp.deg.toFixed(2)}°)`);
  check(await S((id) => (window.__studio.materialById(id).rotate || 0), photoId) === 0, 'edit saved rotate 0 (field dropped)');

  // back to 30 in the material, 35 on the part: export carries both
  await S((id) => window.__studio.openEditDialog(id), photoId);
  await p.waitForFunction(() => document.getElementById('photoDialog').open && document.querySelector('#pRotate'), null, { timeout: 60000 });
  await p.waitForTimeout(800);
  await p.$eval('#pRotate', (el) => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(400);
  await p.click('#photoSave');
  await p.waitForFunction(() => !document.getElementById('photoDialog').open, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  await S(() => { const st = window.__studio; st.setPatternAngle(st.S.groups[0], 35); st.S.photos = false; st.S.naming = 'ko'; st.S.prefix = '테이블'; st.renderExport(); });
  await p.waitForTimeout(500);
  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) {
      for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = data.length; }
    } else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = buf.length; }
  });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  log('files:', Object.keys(saved).sort().join(', '));
  const glbs = Object.keys(saved).filter((n) => n.endsWith('.glb'));
  const photoGlb = glbs.find((n) => n.includes(photoId.slice(0, 6)) || n.includes('나무'));
  check(glbs.length === 2 && !!photoGlb, `two variants saved (${glbs.join(', ')})`);
  const jsonName = Object.keys(saved).find((n) => n.endsWith('.json'));
  const csvName = Object.keys(saved).find((n) => n.endsWith('.csv'));
  const json = JSON.parse(fs.readFileSync(`${OUT}/${jsonName}`, 'utf8'));
  const vPhoto = json.variants.find((v) => v.file === photoGlb), vOak = json.variants.find((v) => v.file !== photoGlb);
  check(vPhoto?.groups[0].patternDeg === 35 && vPhoto.groups[0].material.rotate === 30, 'JSON records the part angle and the material correction');
  check(vOak?.groups[0].patternDeg === 35 && vOak.groups[0].material.rotate === undefined, 'JSON: built-in material has no correction');
  const csv = fs.readFileSync(`${OUT}/${csvName}`, 'utf8');
  check(csv.split('\r\n').filter((l) => /무늬 35°/.test(l)).length === 2, 'CSV 참고 says 무늬 35° on both rows');
  check(json.floorGapMm === 10, `JSON floorGapMm 10 by default (${json.floorGapMm})`);

  // in the file: on the top face (normal +Y) u,v are x,z turned by 65° (35 + 30) and scaled by the tile
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(`${OUT}/${photoGlb}`);
  const prim = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).find((q) => q.getMaterial()?.getExtras()?.material === photoId);
  check(!!prim, 'saved file has the photo-material primitive');
  if (prim) {
    const P = prim.getAttribute('POSITION'), T = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
    const pos = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], uv = [[0, 0], [0, 0], [0, 0]];
    // quantized positions sit under a node scale/offset: back to metres with the node's world matrix
    const node = doc.getRoot().listNodes().find((nd) => nd.getMesh()?.listPrimitives().includes(prim));
    const M = node ? node.getWorldMatrix() : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const world = (q) => { const [x, y, z] = q; q[0] = M[0] * x + M[4] * y + M[8] * z + M[12]; q[1] = M[1] * x + M[5] * y + M[9] * z + M[13]; q[2] = M[2] * x + M[6] * y + M[10] * z + M[14]; };
    // every up-facing face (by area) should carry the box projection of the top (u = x, v = z, metres)
    // turned by 65° (35 part + 30 material) and divided by the material tile; tiny faces on the rounded
    // rim can belong to a side projection, so the check is by area
    const c65 = Math.cos((65 * Math.PI) / 180), s65 = Math.sin((65 * Math.PI) / 180), tu = def30.tileCm / 100, tv = (def30.tileHeightCm || def30.tileCm) / 100;
    let area = 0, areaOk = 0, areaNeg = 0, faces = 0;
    for (let f = 0; f < I.getCount(); f += 3) {
      for (let c = 0; c < 3; c++) { const vi = I.getScalar(f + c); P.getElement(vi, pos[c]); world(pos[c]); T.getElement(vi, uv[c]); }
      const e1 = pos[1].map((v, k) => v - pos[0][k]), e2 = pos[2].map((v, k) => v - pos[0][k]);
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12 || ny / nl < 0.95) continue;
      faces++; area += nl / 2;
      const err = (sg) => Math.max(...[0, 1, 2].map((c) => Math.hypot((c65 * pos[c][0] + sg * s65 * pos[c][2]) / tu - uv[c][0], (-sg * s65 * pos[c][0] + c65 * pos[c][2]) / tv - uv[c][1])));
      if (err(1) < 0.01) areaOk += nl / 2;
      if (err(-1) < 0.01) areaNeg += nl / 2;
    }
    log(`top faces ${faces}: ${(100 * areaOk / area).toFixed(1)}% of the area turned 65° at ${def30.tileCm} cm (the other way: ${(100 * areaNeg / area).toFixed(1)}%)`);
    check(faces > 0 && areaOk / area > 0.95 && areaNeg / area < 0.05, 'saved UVs: pattern turned 65° on the top at the material tile size');
  }

  // every file stands 10 mm above the floor (the default), with its height unchanged
  for (const n of glbs) {
    const d = await io.read(`${OUT}/${n}`);
    let lo = Infinity, hi = -Infinity;
    for (const nd of d.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION'), q = [0, 0, 0];
        for (let i = 0; i < A.getCount(); i++) { A.getElement(i, q); const y = M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      }
    }
    const v = json.variants.find((x) => x.file === n);
    log(`${n}: bottom ${(lo * 1000).toFixed(2)} mm, top ${(hi * 1000).toFixed(1)} mm, H ${v?.sizeMm?.h}`);
    check(near(lo * 1000, 10, 0.3) && near((hi - lo) * 1000, +H, 2) && v?.sizeMm?.h === +H, `${n} stands 10 mm above the floor, H ${H} kept`);
  }

  // work memory keeps the angle
  await p.reload();
  await p.waitForFunction(() => window.__studio);
  await openModel();
  await p.waitForTimeout(800);
  const restored = await S(() => ({ n: window.__studio.S.groups.length, rotate: window.__studio.S.groups[0]?.rotate, pick: window.__studio.S.groups[0]?.pick }));
  log('restored:', JSON.stringify(restored));
  check(restored.n === 1 && restored.rotate === 35, 'reopening the model restores the 35° angle');

  // a lifted file made by this program, opened again and saved as it is: still 10 mm, not 20
  const before = new Set(Object.keys(saved));
  await p.reload();
  await p.waitForFunction(() => window.__studio);
  // Playwright hands files with Korean paths to the page empty: open an ASCII-named copy
  fs.copyFileSync(`${OUT}/${photoGlb}`, `${OUT}/reopen.glb`);
  await p.setInputFiles('#fileInput', `${OUT}/reopen.glb`);
  await p.waitForFunction(() => window.__studio?.S.file?.name === 'reopen.glb' && window.__studio.S.parts.length > 0, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(500);
  await S(() => { const st = window.__studio; st.S.groups = []; st.S.active = null; st.refreshAll(); });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('compress')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  const again = Object.keys(saved).filter((n) => !before.has(n) && n.endsWith('.glb'));
  log('saved again:', again.join(', '));
  for (const n of again) {
    const d = await io.read(`${OUT}/${n}`);
    let lo = Infinity, hi = -Infinity;
    for (const nd of d.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION'), q = [0, 0, 0];
        for (let i = 0; i < A.getCount(); i++) { A.getElement(i, q); const y = M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      }
    }
    log(`${n}: bottom ${(lo * 1000).toFixed(2)} mm, height ${((hi - lo) * 1000).toFixed(1)} mm`);
    check(near(lo * 1000, 10, 0.3) && near((hi - lo) * 1000, +H, 2), `${n} reopened and saved: still 10 mm above the floor`);
  }
  check(again.length >= 1, 'reopened file saved again');

  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
