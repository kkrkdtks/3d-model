// v0.5.1 on the green corner sofa: legs split off by shape, option on/off, group name, panel.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t24';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const [GLB] = process.argv.slice(2);
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e));
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  const S = (f, a) => p.evaluate(f, a);
  const before = await S(() => window.__studio.S.segKey);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction((k) => window.__studio?.S.workKey && window.__studio.S.segKey > k, before, { timeout: 300000 });
  await p.fill('#sizeH', '690'); await p.press('#sizeH', 'Enter');
  await p.fill('#sizeW', '2400'); await p.press('#sizeW', 'Enter');
  log('open: parts', await S(() => window.__studio.S.parts.length), 'base', await S(() => window.__studio.S.segBaseUsed));
  const last = await S(() => window.__studio.S.parts.length - 1);
  await S((i) => { window.__studio.S.selection = new Set([i]); window.__studio.refreshAll(); }, last);
  await p.click('[data-action="group-new"]');
  await p.waitForTimeout(400);
  log('group', await S(() => window.__studio.S.groups.map((g) => `${g.name}:${g.parts}`).join(' | ')));
  // black steel on the legs
  await p.click('[data-action="tab"][data-tab="메탈"]');
  await p.waitForTimeout(300);
  const metals = await S(() => [...document.querySelectorAll('.mat[data-id]')].map((m) => m.dataset.id));
  log('metal materials', metals.join(', '));
  await p.click(`.mat[data-id="${metals[0]}"]`);
  await p.waitForTimeout(300);
  if (await p.$('#hexInput')) { await p.fill('#hexInput', '#1D1C1B'); await p.click('[data-action="hex-add"]'); }
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await S(() => window.__studio.viewer.frame());
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/1_black_legs.png` });
  // options: base off -> 7 parts (confirm because a group exists), on again -> 8
  await p.click('details.more summary');
  await p.uncheck('#segBase');
  await p.click('[data-action="resegment"]');
  await p.click('[data-action="resegment"]');
  await p.waitForFunction(() => window.__studio.S.segBaseUsed === false, null, { timeout: 120000 });
  log('base off: parts', await S(() => window.__studio.S.parts.length));
  await p.check('#segBase');
  await p.click('[data-action="resegment"]');
  await p.waitForFunction(() => window.__studio.S.segBaseUsed === true, null, { timeout: 120000 });
  log('base on: parts', await S(() => window.__studio.S.parts.length));
  await p.waitForTimeout(500);
  await p.locator('#secParts').screenshot({ path: `${OUT}/2_options.png` });
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
