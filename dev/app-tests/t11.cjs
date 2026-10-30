// Dark mode + narrow window: size inputs, photo dialog (lit preview, contrast slider, ruler), confirm dialog.
const { chromium } = require('playwright');
const OUT = __dirname + '/out/' + require('path').basename(__filename, '.cjs');
const GLB = process.argv[2], PHOTO = process.argv[3];
require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [name, vp, scheme] of [['dark_wide', { width: 1440, height: 900 }, 'dark'], ['light_narrow', { width: 420, height: 860 }, 'light']]) {
    const p = await (await b.newContext({ viewport: vp, colorScheme: scheme })).newPage();
    p.on('pageerror', (e) => console.log('pageerror:', e));
    p.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 300)); });
    await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
    await p.setInputFiles('#fileInput', GLB);
    await p.waitForFunction(() => window.__studio && window.__studio.S.parts.length > 0, null, { timeout: 120000 });
    await p.screenshot({ path: `${OUT}/${name}_1_needH.png`, fullPage: true });
    await p.fill('#sizeH', '750'); await p.press('#sizeH', 'Enter');
    await p.evaluate(() => window.__studio.newGroup([0]));
    await p.waitForTimeout(600);
    await p.fill('#sizeInput', '1800×900, 2000x1000, 2200'); await p.click('[data-action="size-add"]');
    await p.waitForFunction(() => window.__studio.S.groups[0].skinShown, null, { timeout: 60000 });
    await p.waitForTimeout(1000);
    await p.screenshot({ path: `${OUT}/${name}_2_sizes.png`, fullPage: true });
    await p.click('[data-action="tab"][data-tab="가죽"]');
    await p.click('[data-action="photo-open"][data-kind="leather"]');
    await p.setInputFiles('#photoInput', PHOTO);
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${OUT}/${name}_3_photo.png` });
    await p.click('#photoSave');
    await p.waitForFunction(() => !document.getElementById('photoDialog').open, null, { timeout: 120000 });
    const id = await p.evaluate(() => window.__studio.S.groups[0].pick);
    await p.$eval(`.mat-del[data-id="${id}"]`, (el) => el.click());
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/${name}_4_confirm.png` });
    const hScroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(name, 'horizontal scroll', hScroll);
    await p.context().close();
  }
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
