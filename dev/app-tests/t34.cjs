// v1.3.2: every saved file carries a note on how it was made (asset.extras) and never has the byte size of a
// file saved before from the same model. 공간무드 STUDIO took a re-saved table (only the floor gap changed,
// 20 -> 30 mm, identical size) for the old upload and did not show it; the same file one memo line longer
// showed fine. Also: 30 mm is saved as asked (the 20 mm limit of v1.3.1 is gone).
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
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const S = (f, a) => p.evaluate(f, a);
  let tag = '';
  const files = [];
  await p.exposeFunction('saveOut', (fname, b64) => {
    if (!fname.endsWith('.glb')) return;
    const f = `${OUT}/${tag}.glb`;
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    files.push({ tag, file: f, size: fs.statSync(f).size });
  });
  const start = async () => {
    await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
    await p.waitForFunction(() => window.__studio);
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio?.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
    await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
    await p.waitForTimeout(400);
    await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  };
  const save = async (mm, name) => {
    tag = name;
    await p.fill('#liftMm', String(mm)); await p.press('#liftMm', 'Enter');
    await p.waitForTimeout(300);
    const qc = await S(async () => { await window.__studio.runExport('compress'); return window.__studio.S.results.map((r) => r.qc?.check || null); });
    await p.waitForTimeout(600);
    return qc;
  };
  const read = async (f) => {
    const buf = fs.readFileSync(f), json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    const d = await io.read(f);
    let lo = Infinity, hi = -Infinity;
    for (const nd of d.getRoot().listNodes()) {
      if (!nd.getMesh()) continue;
      const M = nd.getWorldMatrix();
      for (const pr of nd.getMesh().listPrimitives()) {
        const A = pr.getAttribute('POSITION'), q = [0, 0, 0];
        for (let i = 0; i < A.getCount(); i++) { A.getElement(i, q); const y = M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      }
    }
    return { extras: json.asset.extras, bottom: lo * 1000, height: (hi - lo) * 1000 };
  };

  await start();
  const qcs = [];
  qcs.push(await save(20, 'gap20'));
  qcs.push(await save(30, 'gap30'));
  qcs.push(await save(30, 'gap30again'));
  // a new session on the same model still avoids the sizes saved before
  await start();
  qcs.push(await save(20, 'gap20later'));
  log('saved:', files.map((f) => `${f.tag} ${f.size}`).join(', '));
  check(files.length === 4, 'four files saved');
  check(new Set(files.map((f) => f.size)).size === files.length, 'every file has its own byte size');
  for (const [i, f] of files.entries()) {
    const r = await read(f.file);
    const mm = /20/.test(f.tag) ? 20 : 30;
    log(`${f.tag}: bottom ${r.bottom.toFixed(2)} mm, height ${r.height.toFixed(1)} mm, extras ${JSON.stringify(r.extras)}`);
    check(Math.abs(r.bottom - mm) < 0.3 && Math.abs(r.height - H) < 2, `${f.tag}: stands ${mm} mm above the floor, H kept`);
    check(r.extras?.floorGapMm === mm && /가구 스킨 스튜디오/.test(r.extras?.app || '') && !Number.isNaN(Date.parse(r.extras?.savedAt)), `${f.tag}: note says how it was made`);
    const v = qcs[i]?.[0];
    check(v && v.errors === 0, `${f.tag}: Khronos validator without errors (${v?.errors} errors)`);
  }

  await b.close();
  log(failures ? `FAILURES ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
