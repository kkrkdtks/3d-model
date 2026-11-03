// v1.2: real size keeps the model's own proportions by default (one of W / D / H drives one uniform
// scale), the lock can be turned off with a stretch warning, work saved before the lock with stretched
// W / D reopens in proportion with a note, and sizes are remembered per file (name and byte size), so
// another model with the same name (Untitled.glb) does not inherit them.
// usage: node t32.cjs MODEL.glb H OTHER_DIR_A/Untitled.glb OTHER_DIR_B/Untitled.glb [OUT_NAME]
//   MODEL.glb and A/Untitled.glb: the same model (an ASCII path); B/Untitled.glb: a different model.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
const [GLB, H, SAME_NAME_A, SAME_NAME_B, NAME = 't32'] = process.argv.slice(2);
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  p.on('console', (m) => { if (/error|오류/i.test(m.text())) log('console:', m.text().slice(0, 300)); });
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  const open = async (file) => {
    const name = path.basename(file), size = fs.statSync(file).size;
    await p.setInputFiles('#fileInput', file);
    await p.waitForFunction(({ name, size }) => { const st = window.__studio?.S; return st?.file?.name === name && st.file.size === size && st.parts.length > 0 && st.workKey; }, { name, size }, { timeout: 300000 });
    await p.waitForTimeout(400);
  };
  const type = async (id, v) => { await p.fill(`#${id}`, String(v)); await p.press(`#${id}`, 'Enter'); await p.waitForTimeout(400); };
  const state = () => S(() => {
    const st = window.__studio, xf = st.currentXf(), bb = st.S.info.bbox;
    const ext = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
    return {
      size: { ...st.S.size }, lock: st.S.sizeLock, anchor: st.S.sizeAnchor, scale: xf.scale, ext, axes: st.S.axes,
      boxes: ['sizeW', 'sizeD', 'sizeH'].map((id) => document.getElementById(id)?.value),
      checked: document.getElementById('sizeLock')?.checked, warn: document.getElementById('sizeWarn')?.hidden === false ? document.getElementById('sizeWarn').textContent : '',
      note: document.querySelector('.size-note')?.textContent || '',
    };
  });
  const uniform = (sc) => Math.max(...sc) / Math.min(...sc) - 1 < 1e-9;

  await open(GLB);
  let st = await state();
  const ratio = { w: st.ext[st.axes.w] / st.ext[1], d: st.ext[st.axes.d] / st.ext[1] };
  log('model proportions W/H', ratio.w.toFixed(3), 'D/H', ratio.d.toFixed(3));
  check(st.lock === true && st.checked === true, 'proportion lock on by default');
  check(!st.size.h && !st.size.w, 'a model never opened has no size');

  await type('sizeH', H);
  st = await state();
  log('H', H, '->', JSON.stringify(st.size), 'boxes', st.boxes.join(' / '));
  check(near(st.size.w, H * ratio.w, 1) && near(st.size.d, H * ratio.d, 1), 'H fills W and D in proportion');
  check(st.boxes[0] === String(st.size.w) && st.boxes[1] === String(st.size.d), 'W and D boxes show them');
  check(uniform(st.scale), `one uniform scale (${st.scale.map((v) => v.toFixed(6)).join(', ')})`);

  await type('sizeW', 1600);
  st = await state();
  log('W 1600 ->', JSON.stringify(st.size), 'anchor', st.anchor);
  check(st.anchor === 'w' && st.size.w === 1600 && near(st.size.h, 1600 / ratio.w, 1) && uniform(st.scale), 'typing W drives the scale, H follows');

  await type('sizeH', H);
  st = await state();
  check(st.anchor === 'h' && st.size.h === +H && near(st.size.w, H * ratio.w, 1), 'typing H again brings W back');
  await p.locator('#secInfo').screenshot({ path: `${OUT}/info_locked.png` });

  // lock off: W and D on their own stretch the model, with a warning
  await p.click('#sizeLock');
  await p.waitForTimeout(400);
  await type('sizeW', 1600);
  await type('sizeD', 800);
  st = await state();
  log('unlocked', JSON.stringify(st.size), 'scale', st.scale.map((v) => v.toFixed(6)).join(', '), 'warn:', st.warn);
  check(st.lock === false && !uniform(st.scale), 'unlocked W / D stretch the model');
  check(/W -\d+%/.test(st.warn) && /D -\d+%/.test(st.warn), 'stretch warning says by how much');
  await p.locator('#secInfo').screenshot({ path: `${OUT}/info_unlocked.png` });
  await p.screenshot({ path: `${OUT}/view_stretched.png` });

  // lock on again: H stays, W and D follow it
  await p.click('#sizeLock');
  await p.waitForTimeout(500);
  st = await state();
  check(st.lock && st.size.h === +H && near(st.size.w, H * ratio.w, 1) && uniform(st.scale) && !st.warn, 'locking again restores the proportions from H');
  await p.screenshot({ path: `${OUT}/view_locked.png` });

  // the saved file has the model's own proportions
  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = 1; }
    else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = 1; }
  });
  const hook = () => S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await hook();
  await S(() => window.__studio.runExport('compress')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  const glb = Object.keys(saved).find((n) => n.endsWith('.glb'));
  check(!!glb, `compressed file saved (${glb})`);
  if (glb) {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const d = await io.read(`${OUT}/${glb}`);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const nd of d.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION'), q = [0, 0, 0];
        for (let i = 0; i < A.getCount(); i++) {
          A.getElement(i, q);
          const w = [0, 1, 2].map((r) => M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r]);
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
        }
      }
    }
    const e = [0, 1, 2].map((k) => (hi[k] - lo[k]) * 1000);
    const wF = e[st.axes.w], dF = e[st.axes.d], hF = e[1];
    log(`file: W ${wF.toFixed(1)} × D ${dF.toFixed(1)} × H ${hF.toFixed(1)} mm, bottom ${(lo[1] * 1000).toFixed(1)} mm`);
    check(near(hF, +H, 2) && near(wF / hF, ratio.w, ratio.w * 0.004) && near(dF / hF, ratio.d, ratio.d * 0.004), 'saved file keeps the model proportions at the real height');
  }

  // work saved before v1.2 with stretched W / D: reopens in proportion, with a note
  await S(async () => {
    const st = window.__studio;
    st.saveWorkNow();
    await new Promise((r) => setTimeout(r, 300));
    const w = await st.store.getKV(st.S.workKey, null);
    delete w.sizeLock; delete w.sizeAnchor;
    w.size = { w: 1600, d: 800, h: 740 };
    await st.store.setKV(st.S.workKey, w);
  });
  await p.reload();
  await p.waitForFunction(() => window.__studio);
  await open(GLB);
  st = await state();
  log('old stretched work reopened:', JSON.stringify(st.size), 'note:', st.note);
  check(st.lock && st.size.h === 740 && near(st.size.w, 740 * ratio.w, 1) && uniform(st.scale), 'old stretched work opens in the model proportions');
  check(/W 1,600/.test(st.note) && /D 800/.test(st.note), 'a note says what was changed');
  await p.locator('#secInfo').screenshot({ path: `${OUT}/info_migrated.png` });

  // sizes belong to a file (name + byte size): another model called Untitled.glb starts empty
  await open(SAME_NAME_A);
  await type('sizeH', 740);
  st = await state();
  check(st.size.h === 740, 'Untitled.glb (A) sized');
  await open(SAME_NAME_B);
  st = await state();
  log('other Untitled.glb:', JSON.stringify(st.size));
  check(!st.size.h && !st.size.w && !st.size.d, 'a different model with the same name does not inherit the size');
  await open(SAME_NAME_A);
  st = await state();
  check(st.size.h === 740 && st.lock, 'reopening A remembers its own size and the lock');

  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
