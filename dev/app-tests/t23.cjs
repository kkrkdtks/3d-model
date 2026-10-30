// The split saved with the work comes back exactly (even if the other split settings say otherwise).
const { chromium } = require('playwright');
const [SOFA] = process.argv.slice(2);
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e));
  p.on('console', (m) => { const t = m.text(); if (/열기 시간|저장한 부분/.test(t)) log(t.slice(0, 250)); });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  const open = async () => {
    const before = await S(() => window.__studio.S.segKey);
    await p.setInputFiles('#fileInput', SOFA);
    await p.waitForFunction((k) => window.__studio?.S.workKey && window.__studio.S.segKey > k, before, { timeout: 300000 });
    await p.waitForTimeout(500);
  };
  const kv = (fn) => S((src) => new Promise((res, rej) => {
    const r = indexedDB.open('furniture-skin-studio', 1);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite'), st = t.objectStore('kv'), key = window.__key || window.__studio.S.workKey;
      const g = st.get(key);
      let out;
      g.onsuccess = () => { const w = g.result; out = (0, eval)(src)(w); st.put(w, key); };
      t.oncomplete = () => res(out); t.onerror = rej;
    };
  }), fn.toString());
  await open();
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await S(() => { window.__studio.S.selection = new Set([0]); window.__studio.refreshAll(); });
  await p.click('[data-action="cut-start"]');
  await p.fill('#cutMm', '150'); await p.dispatchEvent('#cutMm', 'change');
  await p.click('[data-action="cut-apply"]');
  await p.waitForFunction(() => window.__studio.S.cuts.length === 1, null, { timeout: 120000 });
  await p.click('[data-action="group-new"]');
  await S(() => window.__studio.newGroup([1, 2]));
  await p.waitForTimeout(300);
  const sig = await S(() => window.__studio.S.parts.map((q) => q.faces).join(','));
  await S(() => window.__studio.saveWorkNow());
  await p.waitForTimeout(800);
  log('saved split', JSON.stringify(await kv((w) => ({ bits: w.split?.bits, faces: w.split?.faces, chars: w.split?.data.length, colorSplit: w.colorSplit, cuts: w.cuts.length }))));
  // make the other settings disagree: only the saved split can bring the cut back
  // (the model on screen must not save over it when the file is opened again)
  await S(() => { window.__key = window.__studio.S.workKey; window.__studio.S.workKey = null; });
  await kv((w) => { w.colorSplit = false; w.cuts = []; w.sensitivity = 60; });
  await open();
  const sig2 = await S(() => window.__studio.S.parts.map((q) => q.faces).join(','));
  log('reopened: parts', await S(() => window.__studio.S.parts.length), 'same split', sig === sig2, 'resumed', !!(await S(() => window.__studio.S.resumed)), 'groups', await S(() => window.__studio.S.groups.map((g) => `${g.name}:${g.parts}`).join(' | ')));
  // a damaged split falls back to splitting again (with the settings saved: colour on, the cut)
  await S(() => { window.__studio.S.workKey = null; });
  await kv((w) => { w.split.data = '!!' + w.split.data.slice(2); w.colorSplit = true; w.cuts = [{ part: 0, y: 0.08631790686270287 }]; w.sensitivity = 105; });
  await open();
  log('damaged split: parts', await S(() => window.__studio.S.parts.length), 'resumed', !!(await S(() => window.__studio.S.resumed)));
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
