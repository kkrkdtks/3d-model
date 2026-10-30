// v0.4: work memory (reopen continues), compare, export with photos + CSV, 사진 저장, 처음부터 하기.
// One persistent browser profile = the user's PC.
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = __dirname + '/out', OUT = DIR + '/t14';
const GLB = process.argv[2];
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DIR + '/profile14', { recursive: true, force: true });
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
const state = (p) => p.evaluate(() => {
  const S = window.__studio.S;
  return {
    size: S.size, sens: S.sensitivity, groups: S.groups.map((g) => ({ name: g.name, parts: g.parts, choices: g.choices.map((c) => `${c.materialId}${c.color ? ' ' + c.color.hex : ''}`), active: g.choices.findIndex((c) => c.id === g.active), sizes: g.sizes.map((z) => `${z.w}x${z.d}`), activeSize: g.sizes.findIndex((z) => z.id === g.activeSize), shown: g.skinShown })),
    resumeNote: document.querySelector('.resume')?.innerText.replace(/\s+/g, ' ') || null, toast: document.querySelector('#toast').textContent,
  };
});
(async () => {
  const ctx = await chromium.launchPersistentContext(DIR + '/profile14', { args: ARGS, viewport: { width: 1440, height: 900 } });
  await ctx.exposeFunction('saveOut', (name, b64) => { fs.writeFileSync(OUT + '/' + name, Buffer.from(b64, 'base64')); return true; });
  // ---- 1) first session: make the work
  let p = await page(ctx, '[1]');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  console.log('[1] opened', await p.evaluate(() => document.querySelector('#toast').textContent));
  await p.fill('#sizeH', '750'); await p.press('#sizeH', 'Enter');
  await p.evaluate(() => window.__studio.newGroup([0]));
  await p.waitForTimeout(300);
  await p.fill('#sizeInput', '1800×900, 2000x1000');
  await p.click('[data-action="size-add"]');
  await p.click('[data-action="tab"][data-tab="도장"]').catch(() => console.log('no 도장 tab'));
  await p.click('.mat[data-id="paint-matte"]');
  await p.fill('#hexInput', '#5A3A22, #D8CFC2');
  await p.click('[data-action="hex-add"]');
  await p.waitForFunction(() => window.__studio.S.groups[0].skinShown, null, { timeout: 60000 });
  await p.click('.choice[data-action="choice-preview"] >> nth=0');
  await p.click('.choice.size >> nth=1');
  await p.fill('#groupName', '상판 A');
  await p.waitForTimeout(1500);
  const s1 = await state(p);
  console.log('[1] state', JSON.stringify(s1.groups), JSON.stringify(s1.size));
  await p.screenshot({ path: OUT + '/1_work.png' });
  await p.close();

  // ---- 2) reopen in a new page: the work continues
  p = await page(ctx, '[2]');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const s2 = await state(p);
  console.log('[2] toast', s2.toast);
  console.log('[2] note', s2.resumeNote);
  console.log('[2] state', JSON.stringify(s2.groups), JSON.stringify(s2.size));
  console.log('[2] same as before:', JSON.stringify(s1.groups.map(({ shown, ...g }) => g)) === JSON.stringify(s2.groups.map(({ shown, ...g }) => g)) && JSON.stringify(s1.size) === JSON.stringify(s2.size));
  await p.screenshot({ path: OUT + '/2_reopened.png' });

  // ---- compare
  const skinVis = () => p.evaluate(() => [...window.__studio.viewer.skins.values()].map((m) => m.visible).join(','));
  await p.click('[data-action="compare"]');
  await p.waitForTimeout(600);
  console.log('[2] compare on: S.compare', await p.evaluate(() => window.__studio.S.compare), 'skins visible', await skinVis(), 'badge', await p.evaluate(() => !document.querySelector('#compareBadge').hidden), 'dims', await p.evaluate(() => [...document.querySelectorAll('.dim-label')].map((x) => x.textContent).join(' ')));
  await p.screenshot({ path: OUT + '/3_compare.png' });
  await p.click('.choice[data-action="choice-preview"] >> nth=1');
  await p.waitForTimeout(800);
  console.log('[2] after picking a colour: compare', await p.evaluate(() => window.__studio.S.compare), 'skins visible', await skinVis(), 'badge hidden', await p.evaluate(() => document.querySelector('#compareBadge').hidden));

  // ---- 사진 저장 (current view)
  await p.click('[data-action="save-photo"]');
  await p.waitForTimeout(3000);
  console.log('[2] photo files', fs.readdirSync(OUT).filter((f) => f.endsWith('.png') && !/^\d_/.test(f)));

  // ---- export ZIP with photos + CSV (parts view + compare on, to check they are restored)
  await p.click('[data-action="view"][data-view="parts"]');
  await p.click('[data-action="compare"]');
  console.log('[2] photos checkbox', await p.evaluate(() => document.querySelector('#photos').checked));
  await p.click('[data-action="export-zip"]');
  await p.waitForFunction(() => document.body.classList.contains('shooting'), null, { timeout: 30000 }).then(() => console.log('[2] panel locked while shooting')).catch(() => console.log('[2] no shooting class seen'));
  await p.waitForFunction(() => !window.__studio.S.exporting && window.__studio.S.results.length > 0, null, { timeout: 600000 });
  console.log('[2] results', await p.evaluate(() => window.__studio.S.results.map((r) => r.name).join(' | ')));
  console.log('[2] note', await p.evaluate(() => window.__studio.S.resultNote));
  console.log('[2] after export: view', await p.evaluate(() => window.__studio.S.view), 'compare', await p.evaluate(() => window.__studio.S.compare), 'active', JSON.stringify((await state(p)).groups.map((g) => [g.active, g.activeSize])), 'shooting', await p.evaluate(() => document.body.classList.contains('shooting')));
  await p.screenshot({ path: OUT + '/4_after_export.png' });

  // ---- 처음부터 하기
  await p.click('[data-action="view"][data-view="material"]');
  await p.click('[data-action="work-reset"]');
  await p.click('#confirmOk');
  await p.waitForTimeout(1000);
  console.log('[2] after reset', JSON.stringify((await state(p)).groups), 'note', (await state(p)).resumeNote);
  await p.close();
  p = await page(ctx, '[3]');
  await p.setInputFiles('#fileInput', GLB);
  await opened(p);
  await p.waitForTimeout(800);
  const s3 = await state(p);
  console.log('[3] after reset + reopen: groups', s3.groups.length, 'note', s3.resumeNote, 'toast', s3.toast, 'size', JSON.stringify(s3.size));
  await ctx.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
