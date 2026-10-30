// 사진 저장 from a turned view on the sofa (the work is already in profile16) + compare photo name.
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = __dirname + '/out', OUT = DIR + '/t16b';
const SAMPLE = process.env.SOFA; // the sample sofa GLB (an ASCII path)
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const ctx = await chromium.launchPersistentContext(DIR + '/profile16', { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64')); return true; });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e));
  await p.goto('file://' + require('path').resolve(__dirname, '../../dist/skin-studio.html'));
  await p.evaluate(() => {
    window.__testSave = async (name, data) => {
      const buf = new Uint8Array(await (data instanceof Blob ? data.arrayBuffer() : data));
      let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
      await window.saveOut(name, btoa(s));
    };
  });
  await p.setInputFiles('#fileInput', SAMPLE);
  await p.waitForFunction(() => window.__studio?.S.groups[0]?.skinShown, null, { timeout: 300000 });
  // pick the first colour, turn the view to the other side and a bit lower
  await p.click('.choice[data-action="choice-preview"] >> nth=0');
  await p.waitForTimeout(2000);
  await p.evaluate(() => {
    const v = window.__studio.viewer, t = v.controls.target, c = v.camera.position;
    const dx = c.x - t.x, dz = c.z - t.z, r = Math.hypot(dx, dz), a = Math.atan2(dz, dx) - 1.1;
    c.set(t.x + r * Math.cos(a), t.y + (c.y - t.y) * 0.5, t.z + r * Math.sin(a));
    v.controls.update(); v.dirty = true;
  });
  await p.waitForTimeout(3000);
  await p.screenshot({ path: OUT + '/1_turned_view.png' });
  await p.click('[data-action="save-photo"]', { timeout: 120000 });
  await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('저장'), null, { timeout: 120000 });
  console.log('toast', await p.evaluate(() => document.querySelector('#toast').textContent));
  await p.click('[data-action="compare"]', { timeout: 120000 });
  await p.waitForTimeout(2000);
  await p.click('[data-action="save-photo"]', { timeout: 120000 });
  await p.waitForTimeout(8000);
  console.log('files', fs.readdirSync(OUT).join(' | '));
  await ctx.close();
})().catch((e) => { console.error('TEST FAILED', e.message.split('\n')[0]); process.exit(1); });
