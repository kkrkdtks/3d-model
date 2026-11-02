// v1.0: product photo settings (angles, white background, size, thumbnail), English file names,
// the lists (CSV + JSON), the catalogue HTML, the check of every written file (stats + Khronos
// validator), settings remembered across a reload, and the help dialog.
// usage: node t29.cjs MODEL.glb H [OUT_NAME] [--mat=materialId] [--hex=#hex]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [GLB, H, NAME = 't29'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류|warn|내보내기 시간/i.test(m.text())) log('console:', m.text().slice(0, 400)); });
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  // help dialog
  await p.click('[data-action="open-help"]');
  check(await S(() => document.querySelector('#helpDialog').open), 'help dialog opens');
  await p.locator('#helpDialog').screenshot({ path: `${OUT}/help.png` });
  await p.click('#helpDialog .dialog-foot .btn');
  check(!(await S(() => document.querySelector('#helpDialog').open)), 'help dialog closes');
  // open the model, real height, every part in one group with two choices
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(300);
  await S(() => { const st = window.__studio; st.S.selection = new Set(st.S.parts.map((q) => q.id)); st.refreshAll(); });
  await p.click('[data-action="group-new"]');
  const mat = opt.mat || 'leather-matte', hex = (opt.hex || '#8B4A22').toUpperCase();
  await S(async ({ mat, hex }) => {
    const st = window.__studio, g = st.S.groups[0];
    for (const c of [{ materialId: 'original', color: { hex: '#53733C', name: '올리브' } }, { materialId: mat, color: { hex, name: hex } }]) {
      const ch = { id: 'c' + Math.random().toString(36).slice(2, 8), ...c };
      g.choices.push(ch); g.active = ch.id;
    }
    g.pick = mat;
    await st.updatePreview(g); st.refreshAll();
  }, { mat, hex });
  // settings: two angles, white JPG, square, thumbnails, catalogue, English names
  await S(() => {
    const st = window.__studio;
    Object.assign(st.S, { photo: { angles: ['front', 'quarter'], bg: 'white', size: '1200x1200', thumb: true }, catalog: true, naming: 'en', photos: true, prefix: 'chair', exportMoreOpen: true });
    st.savePrefs(); st.renderExport();
  });
  await p.waitForTimeout(400);
  await p.locator('#secExport').screenshot({ path: `${OUT}/export_panel.png` });
  const example = await S(() => document.querySelector('#nameExample')?.textContent || '');
  log('example name:', example);
  const matTag = `${mat}-${hex.slice(1)}`;
  check(example.includes(`chair__g1-${matTag}.glb`) || example.includes('chair__g1-original-53733C.glb'), 'English example name shown');
  // export into the test folder
  // the test save gets one zip; its files are unpacked into OUT as a folder export would write them
  const saved = {};
  const { unzipSync } = require('fflate');
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) {
      for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = data.length; }
    } else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = buf.length; }
  });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  const t1 = Date.now();
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  log('export', `${Date.now() - t1}ms`, 'files:', Object.keys(saved).sort().join(', '));
  const names = Object.keys(saved);
  const glbs = names.filter((n) => n.endsWith('.glb')).sort();
  check(glbs.length === 2 && glbs.every((n) => n === 'chair__g1-original-53733C.glb' || n === `chair__g1-${matTag}.glb`), `English GLB names: ${glbs.join(', ')}`);
  for (const n of glbs) {
    const stem = n.replace(/\.glb$/, '');
    for (const sfx of ['_front.jpg', '_45.jpg', '_thumb.jpg']) check(saved[`${stem}${sfx}`] > 1000, `photo ${stem}${sfx}`);
  }
  check(saved['chair_variants.csv'] > 100 && saved['chair_variants.json'] > 100 && saved['chair_catalog.html'] > 500, 'CSV, JSON and catalogue saved');
  // photo sizes
  try {
    const sharp = require('sharp');
    const big = await sharp(`${OUT}/${glbs[0].replace(/\.glb$/, '_front.jpg')}`).metadata();
    const thumb = await sharp(`${OUT}/${glbs[0].replace(/\.glb$/, '_thumb.jpg')}`).metadata();
    check(big.width === 1200 && big.height === 1200 && big.format === 'jpeg', `photo is 1200×1200 jpeg (${big.width}×${big.height} ${big.format})`);
    check(Math.max(thumb.width, thumb.height) === 480, `thumbnail long side 480 (${thumb.width}×${thumb.height})`);
    // a white background: the top-left pixel is white
    const px = await sharp(`${OUT}/${glbs[0].replace(/\.glb$/, '_front.jpg')}`).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer();
    check(px[0] > 250 && px[1] > 250 && px[2] > 250, `white background (${[...px].join(',')})`);
  } catch (e) { log('sharp not available:', e.message); }
  // the JSON list
  const json = JSON.parse(fs.readFileSync(`${OUT}/chair_variants.json`, 'utf8'));
  log('json:', JSON.stringify({ units: json.units, origin: json.origin, sizeMm: json.sizeMm, groups: json.groups, v0: json.variants[0] }).slice(0, 900));
  check(json.units === 'm' && json.origin === 'floor-center' && json.variants.length === 2, 'JSON has units, origin, 2 variants');
  check(json.variants.every((v) => v.photos && Object.keys(v.photos).length === 2 && v.thumbnail && v.file && v.sizeMm && v.bytes > 0), 'JSON variants list photos, thumbnail, size, bytes');
  check(json.variants.every((v) => v.check && v.check.triangles > 0 && v.check.validator && v.check.validator.errors === 0), `JSON check: validator errors 0 (${json.variants.map((v) => `${v.check?.triangles} tris, ${v.check?.validator?.errors} err, ${v.check?.status}`).join(' / ')})`);
  check(json.variants[0].groups[0].material?.id === 'original' && json.variants[0].groups[0].color?.hex === '#53733C', 'JSON group material and colour');
  // the CSV
  const csv = fs.readFileSync(`${OUT}/chair_variants.csv`, 'utf8');
  const head = csv.split('\r\n')[0];
  log('csv head:', head);
  check(csv.charCodeAt(0) === 0xfeff && /사진 정면/.test(head) && /사진 45°/.test(head) && /썸네일/.test(head) && /삼각형/.test(head) && /검사/.test(head), 'CSV columns: photos per angle, thumbnail, triangles, check');
  check(/통과/.test(csv), 'CSV rows say 통과');
  // the catalogue
  const html = fs.readFileSync(`${OUT}/chair_catalog.html`, 'utf8');
  const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
  check(srcs.length === 4 && srcs.every((f) => saved[f] > 0), `catalogue images exist (${srcs.length})`);
  check(/W \d/.test(html) && /#53733C/.test(html), 'catalogue shows size and colour code');
  // the results panel
  const rows = await S(() => [...document.querySelectorAll('#secExport .file-row')].map((r) => ({ cls: r.className, qc: r.querySelector('.fqc')?.textContent || '' })));
  log('rows:', JSON.stringify(rows));
  check(rows.length === 2 && rows.every((r) => /Khronos 검사 통과/.test(r.qc) && /삼각형/.test(r.qc) && !/경고/.test(r.qc)), 'result rows show the check, no warnings');
  const note = await S(() => document.querySelector('#secExport .files + .note')?.textContent || '');
  log('note:', note);
  check(/검사 2개 모두 통과/.test(note) && /카탈로그 HTML/.test(note), 'result note mentions the check and the catalogue');
  await p.locator('#secExport').screenshot({ path: `${OUT}/export_done.png` });

  // Korean names, one angle, transparent PNG: the names of earlier versions
  await S(() => { const st = window.__studio; Object.assign(st.S, { photo: { angles: ['current'], bg: 'transparent', size: '1600x1200', thumb: false }, naming: 'ko', prefix: '의자' }); st.savePrefs(); st.renderExport(); });
  for (const k of Object.keys(saved)) delete saved[k];
  await S(() => window.__studio.runExport('folder')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(500);
  const ko = Object.keys(saved).sort();
  log('korean files:', ko.join(', '));
  check(ko.includes('의자__몸체-원래-질감-올리브-53733C.glb') || ko.some((n) => /^의자__.+-원래-질감-올리브-53733C\.glb$/.test(n)), 'Korean GLB name as before');
  check(ko.some((n) => /^의자__.+\.png$/.test(n)) && ko.includes('의자_변형목록.csv') && ko.includes('의자_변형목록.json') && ko.includes('의자_카탈로그.html'), 'Korean side files');

  // settings survive a reload
  await p.reload();
  await p.waitForFunction(() => window.__studio);
  await p.waitForTimeout(600);
  const prefs = await S(() => { const s = window.__studio.S; return { naming: s.naming, photo: s.photo, catalog: s.catalog, quality: s.quality }; });
  log('prefs after reload:', JSON.stringify(prefs));
  check(prefs.naming === 'ko' && prefs.photo.angles.join() === 'current' && prefs.photo.bg === 'transparent', 'settings remembered across reload');
  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
