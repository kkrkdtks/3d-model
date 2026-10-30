// v0.5: colour split on open, colour option on/off, height cut with preview, work memory with cuts, v0.4 work compatibility.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t20';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const [PLINTH, SOFA] = process.argv.slice(2);
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e));
  p.on('console', (m) => { const t = m.text(); if (/열기|색을|warn|error/i.test(t)) log('console:', t.slice(0, 300)); });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (expr) => p.evaluate(expr);
  const open = async (file) => {
    const before = await S(() => window.__studio.S.segKey);
    await p.setInputFiles('#fileInput', file);
    await p.waitForFunction((k) => window.__studio?.S.workKey && window.__studio.S.segKey > k, before, { timeout: 300000 });
    await p.waitForTimeout(500);
  };
  const parts = () => S(() => window.__studio.S.parts.map((q) => `${q.areaPct.toFixed(1)}%/${q.faces}`).join(' '));

  if (!process.env.SKIP13) {
  // 1. plinth model: colour split on by default
  await open(PLINTH);
  log('plinth open: parts', await S(() => window.__studio.S.parts.length), 'hasColor', await S(() => window.__studio.S.hasColor), 'segColor', await S(() => window.__studio.S.segColorUsed));
  log('  ', await parts());
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.click('[data-action="view"][data-view="parts"]').catch(() => log('no parts-view button'));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/1_plinth_parts.png` });

  // 2. colour off -> re-split -> geometry only
  await p.click('details.more summary');
  await p.uncheck('#segColor');
  await p.click('[data-action="resegment"]');
  await p.waitForFunction(() => window.__studio.S.segColorUsed === false, null, { timeout: 120000 });
  log('colour off: parts', await S(() => window.__studio.S.parts.length));
  await p.screenshot({ path: `${OUT}/2_colour_off_panel.png` });
  // make a group so the work is worth keeping, then fake a v0.4 record (no colorSplit / cuts)
  await S(() => window.__studio.newGroup([0]));
  await p.waitForTimeout(300);
  await S(() => window.__studio.saveWorkNow());
  await p.waitForTimeout(500);
  await S(() => new Promise((res, rej) => {
    const r = indexedDB.open('furniture-skin-studio', 1);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite'), st = t.objectStore('kv');
      const key = window.__studio.S.workKey;
      const g = st.get(key);
      g.onsuccess = () => { const w = g.result; delete w.colorSplit; delete w.cuts; st.put(w, key); };
      t.oncomplete = res; t.onerror = rej;
    };
    r.onerror = rej;
  }));
  // 3. reopen: an old (v0.4) work is split by shape alone and restored
  await open(PLINTH);
  log('reopen v0.4 work: parts', await S(() => window.__studio.S.parts.length), 'segColor', await S(() => window.__studio.S.segColorUsed), 'resumed', !!(await S(() => window.__studio.S.resumed)), 'groups', await S(() => window.__studio.S.groups.length));

  }
  // 4. original sofa: cut the frame at a height
  await open(SOFA);
  log('sofa open: parts', await S(() => window.__studio.S.parts.length), 'colour', await S(() => window.__studio.S.segColorUsed));
  log('  ', await parts());
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(500);
  await S(() => { window.__studio.S.selection = new Set([0]); window.__studio.refreshAll(); });
  await p.click('[data-action="cut-start"]');
  await p.waitForSelector('#cutRange');
  log('cut range', await p.getAttribute('#cutRange', 'min'), await p.getAttribute('#cutRange', 'max'), 'default', await p.inputValue('#cutMm'));
  await p.fill('#cutMm', '150'); await p.dispatchEvent('#cutMm', 'change');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/4_cut_preview.png` });
  await S(() => { const v = window.__studio.viewer; v.controls.target.set(0, 0.1, 0); v.camera.position.set(1.4, 0.35, 1.6); v.controls.update(); v.dirty = true; });
  await p.waitForTimeout(1500);
  await p.locator('#viewport').screenshot({ path: `${OUT}/4b_cut_preview_low.png` });
  await p.click('[data-action="cut-apply"]');
  await p.waitForFunction(() => window.__studio.S.cuts.length === 1, null, { timeout: 120000 });
  log('after cut: parts', await S(() => window.__studio.S.parts.length), 'selection', await S(() => [...window.__studio.S.selection]), 'cuts', JSON.stringify(await S(() => window.__studio.S.cuts)));
  log('  ', await parts());
  await p.click('[data-action="group-new"]');
  await p.waitForTimeout(500);
  log('new group name', await S(() => window.__studio.S.groups.map((g) => g.name + ':' + g.parts).join(' | ')));
  await p.click('[data-action="tab"][data-tab="도장"]');
  await p.click('.mat[data-id="paint-matte"]');
  await p.fill('#hexInput', '#5A3A22'); await p.click('[data-action="hex-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.waitForTimeout(1200);
  await p.locator('#viewport').screenshot({ path: `${OUT}/5_base_wood.png` });
  await S(() => window.__studio.saveWorkNow());
  await p.waitForTimeout(500);
  // 5. reopen: the cut is replayed and the group comes back
  await open(SOFA);
  log('reopen with cut: parts', await S(() => window.__studio.S.parts.length), 'cuts', await S(() => window.__studio.S.cuts.length), 'resumed', !!(await S(() => window.__studio.S.resumed)), 'groups', await S(() => window.__studio.S.groups.map((g) => g.name + ':' + g.parts).join(' | ')));
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.waitForTimeout(1000);
  await p.screenshot({ path: `${OUT}/6_reopened.png` });
  // 6. export one GLB with the base in wood (validator later)
  const saved = [];
  await p.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(`${OUT}/${name}`, Buffer.from(b64, 'base64')); saved.push(name); });
  await S(() => { window.__testSave = async (name, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(name, btoa(s)); }; });
  await S(() => window.__studio.runExport('zip')).catch((e) => log('export error', e.message));
  await p.waitForTimeout(1000);
  log('saved', saved.join(', '));
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
