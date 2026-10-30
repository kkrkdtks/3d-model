// v0.5 screens: plinth model parts view, options panel, cut box narrow + dark, table regression.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t21';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const [PLINTH, SOFA, TABLE] = process.argv.slice(2);
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = async (vp, scheme) => {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => log('pageerror:', e));
    await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
    return p;
  };
  const open = async (p, file) => {
    const before = await p.evaluate(() => window.__studio.S.segKey);
    await p.setInputFiles('#fileInput', file);
    await p.waitForFunction((k) => window.__studio?.S.workKey && window.__studio.S.segKey > k, before, { timeout: 300000 });
    await p.waitForTimeout(800);
  };
  // plinth: parts view + options
  let p = await page({ width: 1440, height: 900 }, 'light');
  await open(p, PLINTH);
  log('plinth parts', await p.evaluate(() => window.__studio.S.parts.length));
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.click('[data-action="view"][data-view="parts"]');
  await p.evaluate(() => { const v = window.__studio.viewer; v.controls.target.set(0, 0.25, 0); v.camera.position.set(1.9, 0.75, 2.1); v.controls.update(); v.dirty = true; });
  await p.click('details.more summary');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/1_plinth_parts_options.png` });
  await p.context().close();
  // narrow light: cut box
  p = await page({ width: 420, height: 860 }, 'light');
  await open(p, SOFA);
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.evaluate(() => { window.__studio.S.selection = new Set([0]); window.__studio.refreshAll(); });
  await p.click('[data-action="cut-start"]');
  await p.waitForTimeout(1200);
  await p.locator('.cutbox').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/2_narrow_cut.png` });
  log('narrow horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  // Escape closes the cut with the selection
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  log('after Escape: cut', await p.evaluate(() => window.__studio.S.cut), 'sheet shown', await p.evaluate(() => !!window.__studio.viewer.cut?.sheet.parent));
  await p.context().close();
  // dark: table regression + cut on the biggest part
  p = await page({ width: 1280, height: 860 }, 'dark');
  await open(p, TABLE);
  log('table parts', await p.evaluate(() => window.__studio.S.parts.length), 'hasColor', await p.evaluate(() => window.__studio.S.hasColor), await p.evaluate(() => window.__studio.S.parts.map((q) => q.areaPct.toFixed(1)).join(' ')));
  await p.fill('#sizeH', '750'); await p.press('#sizeH', 'Enter');
  await p.evaluate(() => { window.__studio.S.selection = new Set([0]); window.__studio.refreshAll(); });
  await p.click('[data-action="cut-start"]');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/3_dark_table_cut.png` });
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
