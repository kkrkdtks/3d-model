// v0.4 on the real sofa: work memory across pages, product photos for 3 leather colours, rotated 사진 저장.
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = __dirname + '/out', OUT = DIR + '/t16';
const SAMPLE = process.env.SOFA; // the sample sofa GLB (an ASCII path)
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DIR + '/profile16', { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
async function page(ctx, tag) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(tag, 'pageerror:', e));
  p.on('console', (m) => { if (m.type() === 'error') console.log(tag, 'console.error:', m.text().slice(0, 300)); });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  await p.evaluate(() => {
    window.__testSave = async (name, data) => {
      const buf = new Uint8Array(await (data instanceof Blob ? data.arrayBuffer() : data));
      let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
      await window.saveOut(name, btoa(s));
    };
  });
  return p;
}
const opened = (p) => p.waitForFunction(() => window.__studio && window.__studio.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
(async () => {
  const ctx = await chromium.launchPersistentContext(DIR + '/profile16', { args: ARGS, viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64')); return true; });
  let p = await page(ctx, '[1]');
  let t = Date.now();
  await p.setInputFiles('#fileInput', SAMPLE);
  await opened(p);
  console.log('[1] opened in', Math.round((Date.now() - t) / 1000), 's');
  await p.fill('#sizeW', '1800'); await p.press('#sizeW', 'Enter');
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.evaluate(() => window.__studio.newGroup([1, 2, 3, 4, 7, 8]));
  await p.fill('#groupName', '쿠션');
  await p.click('[data-action="tab"][data-tab="가죽"]');
  await p.click('.mat[data-id="leather-matte"]');
  await p.fill('#hexInput', '#5C3A21, #1D1C1B, #8E8A84');
  await p.click('[data-action="hex-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  await p.close();

  p = await page(ctx, '[2]');
  t = Date.now();
  await p.setInputFiles('#fileInput', SAMPLE);
  await opened(p);
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  console.log('[2] reopened in', Math.round((Date.now() - t) / 1000), 's ·', await p.evaluate(() => document.querySelector('#toast').textContent));
  console.log('[2] groups', await p.evaluate(() => JSON.stringify(window.__studio.S.groups.map((g) => [g.name, g.parts.join(','), g.choices.map((c) => c.color.hex).join(' ')]))), 'size', await p.evaluate(() => JSON.stringify(window.__studio.S.size)));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + '/1_reopened.png' });
  t = Date.now();
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 900000 });
  console.log('[2] export in', Math.round((Date.now() - t) / 1000), 's ·', await p.evaluate(() => window.__studio.S.resultNote));
  // orbit a little to the left and save the current view
  const box = await p.locator('#viewport canvas').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2 - 40, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(1500);
  await p.click('[data-action="save-photo"]');
  await p.waitForTimeout(4000);
  await p.screenshot({ path: OUT + '/2_rotated.png' });
  console.log('[2] files', fs.readdirSync(OUT).join(' | '));
  await ctx.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
