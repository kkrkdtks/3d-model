// Open timings (twice) for a model.
const { chromium } = require('playwright');
const [GLB] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e));
  p.on('console', (m) => { const t = m.text(); if (/열기 시간|색을/.test(t)) console.log(t.slice(0, 300)); });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  for (let i = 0; i < 2; i++) {
    const before = await p.evaluate(() => window.__studio.S.segKey);
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction((k) => window.__studio?.S.workKey && window.__studio.S.segKey > k, before, { timeout: 300000 });
    console.log('parts', await p.evaluate(() => window.__studio.S.parts.length), 'hasColor', await p.evaluate(() => window.__studio.S.hasColor));
  }
  await b.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
