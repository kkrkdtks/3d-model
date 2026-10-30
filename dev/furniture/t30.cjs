// Open several kinds of furniture in the app: is the base one part, named 받침대, and can it take black steel?
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t30';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const MODELS = [
  ['table_4legs', 750, 1600, true], ['chair_rungs', 900, 460], ['coffee_shelf', 400, 1200], ['bed_legs', 1120, 1650],
  ['stool_bar', 785, 430], ['desk_drawers', 750, 1400], ['sideboard_legs', 820, 1600], ['tub_chair', 740, 800],
];
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let failed = 0;
  for (const [name, H, W, exportIt] of MODELS) {
    const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    p.on('pageerror', (e) => { log('pageerror:', e.message); failed++; });
    await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
    const S = (f, a) => p.evaluate(f, a);
    await p.setInputFiles('#fileInput', `${__dirname}/models/${name}.glb`);
    await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 300000 });
    await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
    await p.fill('#sizeW', String(W)); await p.press('#sizeW', 'Enter');
    const info = await S(() => {
      const s = window.__studio.S, b = s.info.bbox, Hs = s.dims.y, u = s.info.underside;
      const base = s.parts.filter((q) => u != null && q.min[1] < b.min[1] + 0.03 * Hs && q.max[1] < u + 0.25 * Hs).map((q) => q.id);
      return { parts: s.parts.length, underside: u == null ? null : +((u - b.min[1]) / Hs * 100).toFixed(1), base, areas: s.parts.map((q) => +q.areaPct.toFixed(1)) };
    });
    if (!info.base.length) { log(name, 'NO BASE PART', JSON.stringify(info)); failed++; await p.close(); continue; }
    await S((ids) => { window.__studio.S.selection = new Set(ids); window.__studio.refreshAll(); }, info.base);
    await p.click('[data-action="group-new"]');
    await p.click('[data-action="tab"][data-tab="메탈"]');
    await p.click('.mat[data-id="metal"]');
    await p.fill('#hexInput', '#1D1C1B'); await p.click('[data-action="hex-add"]');
    await p.waitForTimeout(300);
    const group = await S(() => { const g = window.__studio.S.groups[0]; return { name: g.name, parts: g.parts, choices: g.choices.map((c) => `${c.materialId} ${c.color?.hex || ''}`) }; });
    const ok = group.name === '받침대';
    if (!ok) failed++;
    log(`${name.padEnd(16)} parts ${info.parts} underside ${info.underside}% base part(s) ${info.base.join(',')} (${info.base.map((i) => info.areas[i] + '%').join(', ')}) group "${group.name}" ${ok ? 'ok' : 'WRONG NAME'} ${group.choices.join('|')}`);
    await S(() => { window.__studio.S.selection = new Set(); window.__studio.refreshAll(); window.__studio.viewer.frame(); });
    await p.waitForTimeout(1200);
    await p.locator('#stage').screenshot({ path: `${OUT}/${name}.png` });
    if (exportIt) {
      const saved = [];
      await p.exposeFunction('saveOut', (fname, b64) => { fs.writeFileSync(`${OUT}/${fname}`, Buffer.from(b64, 'base64')); saved.push(fname); });
      await S(() => { window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
      await S(() => window.__studio.runExport('folder')).catch((e) => { log('export error', e.message); failed++; });
      await p.waitForTimeout(800);
      log('   saved', saved.join(', '));
    }
    await p.close();
  }
  await b.close();
  log(failed ? `FAILED ${failed}` : 'ALL OK');
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
