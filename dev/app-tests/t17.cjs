// Dark + narrow: new stage buttons, compare badge, resume note, photo checkbox.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname + '/out/t17';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const GLB = process.argv[2];
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [name, vp, scheme] of [['dark_wide', { width: 1440, height: 900 }, 'dark'], ['light_narrow', { width: 420, height: 860 }, 'light']]) {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('pageerror:', e));
    await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio?.S.workKey, null, { timeout: 120000 });
    await p.fill('#sizeH', '750'); await p.press('#sizeH', 'Enter');
    await p.evaluate(() => window.__studio.newGroup([0]));
    await p.click('[data-action="tab"][data-tab="도장"]');
    await p.click('.mat[data-id="paint-matte"]');
    await p.fill('#hexInput', '#2E3A52'); await p.click('[data-action="hex-add"]');
    await p.waitForFunction(() => window.__studio.S.groups[0].skinShown, null, { timeout: 60000 });
    await p.waitForTimeout(800);
    // reopen in the same context: resume note
    await p.evaluate(() => window.__studio.saveWorkNow());
    await p.waitForTimeout(300);
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio.S.resumed && window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
    await p.click('[data-action="compare"]');
    await p.mouse.move(5, vp.height - 5);
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${OUT}/${name}_1.png`, fullPage: true });
    await p.locator('#photos').scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${OUT}/${name}_2_export.png` });
    console.log(name, 'horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
    await ctx.close();
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
