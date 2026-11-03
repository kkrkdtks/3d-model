// v1.3.1: the floor gap stops at 20 mm (공간무드 STUDIO does not show furniture lifted 30 mm): typing 30 gives
// 20 with a warning, the saved file stands 20 mm up, and a gap of 30 remembered by an older version opens as 20.
// usage: node t34.cjs MODEL.glb H [OUT_NAME]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
const [GLB, H, NAME = 't34'] = process.argv.slice(2);
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  const open = async () => {
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio?.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
    await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
    await p.waitForTimeout(400);
  };
  await open();
  await p.fill('#liftMm', '30'); await p.press('#liftMm', 'Enter');
  await p.waitForTimeout(400);
  const st = await S(() => ({ lift: window.__studio.S.liftMm, box: document.getElementById('liftMm')?.value, warn: document.querySelector('#liftMm')?.closest('.field')?.querySelector('.warn-text')?.textContent || '' }));
  log('typed 30 ->', JSON.stringify(st));
  check(st.lift === 20 && st.box === '20', 'typing 30 mm gives 20 mm');
  check(/20mm까지만/.test(st.warn) && /공간무드/.test(st.warn), 'a warning says why');
  await p.locator('#liftMm >> xpath=ancestor::div[contains(@class,"field")][1]').screenshot({ path: `${OUT}/lift_field.png` });

  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUT}/${fname}`, Buffer.from(b64, 'base64')); saved[fname] = 1; });
  await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('compress')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(800);
  const glb = Object.keys(saved).find((n) => n.endsWith('.glb'));
  check(!!glb, `file saved (${glb})`);
  if (glb) {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const d = await io.read(`${OUT}/${glb}`);
    let lo = Infinity, hi = -Infinity;
    for (const nd of d.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION'), q = [0, 0, 0];
        for (let i = 0; i < A.getCount(); i++) { A.getElement(i, q); const y = M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      }
    }
    log(`bottom ${(lo * 1000).toFixed(2)} mm, height ${((hi - lo) * 1000).toFixed(1)} mm`);
    check(Math.abs(lo * 1000 - 20) < 0.3 && Math.abs((hi - lo) * 1000 - H) < 2, 'saved file stands 20 mm above the floor, H kept');
  }

  // a gap of 30 remembered by an older version opens as 20 (not back to 10)
  await S(async () => { const st = window.__studio; const v = await st.store.getKV('prefs', {}); v.liftMm = 30; await st.store.setKV('prefs', v); });
  await p.reload();
  await p.waitForFunction(() => window.__studio);
  await open();
  const again = await S(() => window.__studio.S.liftMm);
  check(again === 20, `remembered 30 mm opens as 20 mm (${again})`);

  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
