// v0.4: work made at another sensitivity, library zip carries the work to another PC,
// compress-only and single-variant exports.
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = __dirname + '/out', OUT = DIR + '/t15';
const GLB = process.argv[2];
for (const d of [OUT, DIR + '/pcA', DIR + '/pcB']) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const APP = 'file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html');
async function page(ctx, tag) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(tag, 'pageerror:', e));
  p.on('console', (m) => { if (m.type() === 'error') console.log(tag, 'console.error:', m.text().slice(0, 300)); });
  await p.goto(APP);
  await p.evaluate(() => {
    window.__testSave = async (name, data) => {
      const buf = new Uint8Array(await (data instanceof Blob ? data.arrayBuffer() : data));
      let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
      await window.saveOut(name, btoa(s));
    };
  });
  return p;
}
const opened = (p) => p.waitForFunction(() => window.__studio && window.__studio.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 120000 });
const brief = (p) => p.evaluate(() => {
  const S = window.__studio.S;
  return { sens: S.sensitivity, segSens: S.segSensitivity, parts: S.parts.length, groups: S.groups.map((g) => `${g.name}[${g.parts}] ${g.choices.length}c`), toast: document.querySelector('#toast').textContent };
});
(async () => {
  // ---- PC A
  let ctx = await chromium.launchPersistentContext(DIR + '/pcA', { args: ARGS, viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64')); return true; });
  let p = await page(ctx, '[A1]');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  console.log('[A1] default split', JSON.stringify(await brief(p)));
  // split more finely, then group
  await p.click('details.more summary');
  await p.$eval('#sensitivity', (el) => { el.value = '140'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.click('[data-action="resegment"]');
  await p.waitForFunction(() => window.__studio.S.segSensitivity === 140, null, { timeout: 60000 });
  await p.fill('#sizeH', '740'); await p.press('#sizeH', 'Enter');
  await p.evaluate(() => window.__studio.newGroup([0]));
  await p.click('[data-action="tab"][data-tab="도장"]');
  await p.click('.mat[data-id="paint-matte"]');
  await p.fill('#hexInput', '#2E3A52');
  await p.click('[data-action="hex-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0].skinShown, null, { timeout: 60000 });
  // slider moved again but not applied: the saved work must keep the split the groups were made on
  await p.$eval('#sensitivity', (el) => { el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(900);
  const a1 = await brief(p);
  console.log('[A1] fine split + group', JSON.stringify(a1));
  // compress only: one GLB, no photo, no list
  await p.click('[data-action="export-compress"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 300000 });
  console.log('[A1] compress →', fs.readdirSync(OUT).join(' | '));
  // single variant, photos off -> a plain .glb
  await p.click('#photos');
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 300000 });
  console.log('[A1] single, no photos →', fs.readdirSync(OUT).join(' | '));
  // single variant, photos on -> zip with glb + png + csv
  await p.click('#photos');
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 300000 });
  console.log('[A1] single, photos →', fs.readdirSync(OUT).join(' | '), '| note:', await p.evaluate(() => window.__studio.S.resultNote));
  // library zip from PC A
  await p.click('[data-action="open-library"]');
  await p.click('[data-action="lib-export"]');
  await p.waitForTimeout(1500);
  await p.close();
  p = await page(ctx, '[A2]');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  await p.waitForTimeout(1000);
  const a2 = await brief(p);
  console.log('[A2] reopen', JSON.stringify(a2));
  console.log('[A2] prefs kept: photos', await p.evaluate(() => document.querySelector('#photos').checked));
  await ctx.close();
  const lib = fs.readdirSync(OUT).find((f) => f.startsWith('가구스킨_재질과색'));
  console.log('library zip', lib);
  // ---- PC B: import the library zip, then open the same model
  ctx = await chromium.launchPersistentContext(DIR + '/pcB', { args: ARGS, viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction('saveOut', () => true);
  p = await page(ctx, '[B]');
  await p.click('[data-action="open-library"]');
  fs.copyFileSync(OUT + '/' + lib, OUT + '/lib_ascii.zip'); // the test driver cannot hand over non-ASCII paths
  await p.setInputFiles('#libInput', OUT + '/lib_ascii.zip');
  await p.waitForTimeout(1500);
  console.log('[B] import toast', await p.evaluate(() => document.querySelector('#toast').textContent));
  await p.click('#libraryDialog .dialog-head .icon-btn');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  await p.waitForTimeout(1000);
  const b = await brief(p);
  console.log('[B] open on PC B', JSON.stringify(b));
  await p.screenshot({ path: OUT + '/B_opened.png' });
  await ctx.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
