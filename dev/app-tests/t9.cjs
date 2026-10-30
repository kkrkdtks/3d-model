// Table flow: open, H=750 -> real size, top group, sizes 1800×900 & 2000×1000 (original look),
// then paint on the top, export ZIP, write files for inspection.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
const GLB = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
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
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio && window.__studio.S.parts.length > 0, null, { timeout: 120000 });
  const labels = () => p.evaluate(() => [...document.querySelectorAll('.dim-label')].map((x) => x.textContent));
  console.log('parts', await p.evaluate(() => window.__studio.S.parts.map((x) => x.areaPct.toFixed(1)).join(' ')), 'axes', JSON.stringify(await p.evaluate(() => window.__studio.S.axes)));
  console.log('labels before H', await labels(), 'export disabled', await p.evaluate(() => document.querySelector('[data-action="export-compress"]').disabled));
  await p.screenshot({ path: OUT + '/1_opened.png' });
  await p.fill('#sizeH', '750');
  await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(1200);
  console.log('labels after H=750', await labels(), 'export disabled', await p.evaluate(() => document.querySelector('[data-action="export-compress"]').disabled));
  await p.evaluate(() => window.__studio.newGroup([0]));
  await p.waitForTimeout(500);
  console.log('group', await p.evaluate(() => window.__studio.S.groups[0].name));
  await p.fill('#sizeInput', '1800×900, 2000x1000');
  await p.click('[data-action="size-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0].skinShown, null, { timeout: 60000 });
  await p.waitForTimeout(1200);
  console.log('labels with top 2000x1000', await labels());
  await p.screenshot({ path: OUT + '/2_top_2000.png' });
  // first size chip -> 1800x900
  await p.click('.choice.size >> nth=0');
  await p.waitForTimeout(1200);
  console.log('labels with top 1800x900', await labels());
  await p.screenshot({ path: OUT + '/3_top_1800.png' });
  // a material on the top as well: matte paint, two colours -> 2 sizes × 2 colours = 4 files
  await p.evaluate(async () => {
    const st = window.__studio, g = st.S.groups[0];
    st.addChoice(g, 'paint-matte', { hex: '#5A3A22', name: '#5A3A22' });
    st.addChoice(g, 'paint-matte', { hex: '#D8CFC2', name: '#D8CFC2' });
    await st.updatePreview(g);
  });
  await p.waitForTimeout(2000);
  await p.screenshot({ path: OUT + '/4_top_paint.png' });
  console.log('summary', await p.evaluate(() => document.querySelector('#secExport .summary').innerText.replace(/\s+/g, ' ')));
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 300000 });
  console.log('results', await p.evaluate(() => window.__studio.S.results.map((r) => `${r.name} ${(r.size / 1024).toFixed(0)}KB`).join(' | ')));
  await p.screenshot({ path: OUT + '/5_exported.png' });
  await b.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
