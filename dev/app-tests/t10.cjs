// Sofa regression + delete flow: open, W 1800 / H 812, cushions -> photo leather + hex, export one file,
// then delete the photo material: × -> confirm dialog -> 취소 (kept) -> × -> 삭제 (gone, variant dropped).
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
const SAMPLE = process.env.SOFA; // the sample sofa GLB (an ASCII path)
const PHOTO = process.argv[3];
const SCHEME = process.argv[4] || 'light';
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: SCHEME });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ':', m.text().slice(0, 300)); });
  await p.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64')); return true; });
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  await p.evaluate(() => {
    window.__testSave = async (name, data) => {
      const buf = new Uint8Array(await (data instanceof Blob ? data.arrayBuffer() : data));
      let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
      await window.saveOut(name, btoa(s));
    };
  });
  await p.setInputFiles('#fileInput', SAMPLE);
  await p.waitForFunction(() => window.__studio && window.__studio.S.parts.length > 0, null, { timeout: 300000 });
  const labels = () => p.evaluate(() => [...document.querySelectorAll('.dim-label')].map((x) => x.textContent));
  console.log('axes', JSON.stringify(await p.evaluate(() => window.__studio.S.axes)), 'labels', await labels());
  await p.fill('#sizeW', '1800'); await p.press('#sizeW', 'Enter');
  await p.fill('#sizeH', '812'); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(800);
  console.log('labels W1800 H812', await labels());
  await p.screenshot({ path: OUT + '/1_sized.png' });
  await p.evaluate(() => window.__studio.newGroup([1, 2, 3, 4, 7, 8]));
  await p.click('[data-action="tab"][data-tab="가죽"]');
  await p.click('[data-action="photo-open"][data-kind="leather"]');
  await p.setInputFiles('#photoInput', PHOTO);
  await p.waitForTimeout(2500);
  // move the contrast slider to check it re-renders without errors
  await p.$eval('#pContrast', (el) => { el.value = '0.8'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + '/2_photo_contrast08.png' });
  await p.$eval('#pContrast', (el) => { el.value = '0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(1200);
  await p.click('#photoSave');
  await p.waitForFunction(() => !document.getElementById('photoDialog').open, null, { timeout: 120000 });
  await p.fill('#hexInput', '#5C3A21');
  await p.click('[data-action="hex-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.waitForTimeout(2000);
  await p.screenshot({ path: OUT + '/3_leather.png' });
  console.log('summary', await p.evaluate(() => document.querySelector('#secExport .summary')?.innerText.replace(/\s+/g, ' ')));
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 600000 });
  console.log('results', await p.evaluate(() => window.__studio.S.results.map((r) => `${r.name} ${(r.size / 1048576).toFixed(2)}MB`).join(' | ')));
  // delete flow
  const userMatId = await p.evaluate(() => window.__studio.S.groups[0].choices[0].materialId);
  const del = `.mat-del[data-id="${userMatId}"]`;
  await p.hover(`.mat[data-id="${userMatId}"]`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/4_hover_x.png' });
  await p.click(del);
  await p.waitForTimeout(400);
  console.log('dialog open', await p.evaluate(() => document.getElementById('confirmDialog').open), 'title', await p.textContent('#confirmTitle'), '|', await p.textContent('#confirmText'));
  await p.screenshot({ path: OUT + '/5_confirm.png' });
  await p.click('#confirmDialog button[value="cancel"]');
  await p.waitForTimeout(400);
  console.log('after 취소: still there', await p.evaluate((id) => !!document.querySelector(`.mat[data-id="${id}"]`), userMatId), 'choices', await p.evaluate(() => window.__studio.S.groups[0].choices.length));
  await p.hover(`.mat[data-id="${userMatId}"]`);
  await p.click(del);
  await p.waitForTimeout(300);
  await p.click('#confirmOk');
  await p.waitForTimeout(1200);
  console.log('after 삭제: still there', await p.evaluate((id) => !!document.querySelector(`.mat[data-id="${id}"]`), userMatId), 'choices', await p.evaluate(() => window.__studio.S.groups[0].choices.length), 'skinShown', await p.evaluate(() => window.__studio.S.groups[0].skinShown));
  await p.screenshot({ path: OUT + '/6_deleted.png' });
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
