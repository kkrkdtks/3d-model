// v1.9: the MUUMU LEATHER COLLECTION hides in the 뮤무 tab, through the app.
// - the tab holds four cards in order: the two MUUMU 09 hides, then 빈티지코어 and 카오스;
// - each card says 결 and its tile; the MUUMU 09 hides still lead with the nine 09 colours, 빈티지코어 with
//   its four colours and 카오스 with its five, in the order of the site;
// - two colours of each new hide export with no Khronos validator errors and carry the material.
// usage: node t40.cjs SOFA.glb H [OUT_NAME]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const [GLB, H, NAME = 't40'] = process.argv.slice(2);
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const CODES = {
  'muumu-grain': ['#74331D', '#A89986', '#82471D', '#112226', '#A59F99', '#AB660A', '#ACAAA0', '#6F3103', '#041617'],
  'muumu-vintagecore': ['#A3A299', '#09191C', '#945512', '#672E12'],
  'muumu-chaos': ['#ACA9A6', '#152428', '#74401A', '#652612', '#AEA293'],
};
const CARDS = [{ id: 'muumu-grain', name: '내추럴 그레인 소가죽' }, { id: 'muumu-pullup', name: '풀업 왁스 소가죽' },
  { id: 'muumu-vintagecore', name: '빈티지코어 풀업 가죽' }, { id: 'muumu-chaos', name: '카오스 투톤 가죽' }];
const WANT = [
  { id: 'muumu-vintagecore', name: '빈티지코어 풀업 가죽', hex: '#945512' }, { id: 'muumu-vintagecore', name: '빈티지코어 풀업 가죽', hex: '#09191C' },
  { id: 'muumu-chaos', name: '카오스 투톤 가죽', hex: '#74401A' }, { id: 'muumu-chaos', name: '카오스 투톤 가죽', hex: '#ACA9A6' },
];
/** GLB JSON chunk. */
const glbJson = (buf) => JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../../dist/skin-studio.html'));
  await p.waitForFunction(() => window.__studio);
  const S = (f, a) => p.evaluate(f, a);
  await p.setInputFiles('#fileInput', GLB);
  await p.waitForFunction(() => window.__studio?.S.parts.length > 0 && window.__studio.S.workKey, null, { timeout: 300000 });
  await p.fill('#sizeH', String(H)); await p.press('#sizeH', 'Enter');
  await p.waitForTimeout(300);
  await S(() => { const st = window.__studio; st.S.selection = new Set(st.S.parts.map((q) => q.id)); st.refreshAll(); });
  await p.click('[data-action="group-new"]');

  // 1. the tab and its cards
  const tabs = await S(() => [...document.querySelectorAll('#secMaterial [data-action="tab"]')].map((t) => t.dataset.tab));
  log('tabs', tabs.join(' '));
  check(tabs.indexOf('뮤무') === tabs.indexOf('자코모') + 1, 'the 뮤무 tab comes right after 자코모');
  await p.click('[data-action="tab"][data-tab="뮤무"]');
  await p.waitForFunction(() => [...document.querySelectorAll('#secMaterial .mats img[data-swatch]')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 }).catch(() => log('swatches slow'));
  await p.locator('#secMaterial .mats').screenshot({ path: `${OUT}/cards.png` });
  const cards = await S(() => [...document.querySelectorAll('#secMaterial .mats .mat[data-id]')].map((c) => {
    const bEl = c.querySelector('.cap b');
    return { id: c.dataset.id, name: bEl.textContent, meta: c.querySelector('.cap small').textContent, whole: bEl.scrollHeight <= bEl.clientHeight + 1 && bEl.scrollWidth <= bEl.clientWidth + 1, img: c.querySelector('img').naturalWidth };
  }));
  log('cards', JSON.stringify(cards));
  check(cards.map((c) => c.id).join() === CARDS.map((w) => w.id).join(), 'the four hides in order');
  check(CARDS.every((w, k) => cards[k]?.name === w.name), 'names');
  check(cards.every((c) => c.meta.startsWith('결')), 'cards say 결');
  check(cards.every((c) => c.whole), 'every name shows whole');
  check(cards.every((c) => c.img > 0), 'every card has its swatch');

  // 2. colours: the photo colour first; pick it for each cover
  for (const id of Object.keys(CODES)) {
    await p.click(`#secMaterial .mat[data-id="${id}"]`);
    await p.waitForTimeout(200);
    const lead = await S(`[...([...document.querySelectorAll('#secMaterial span.label')].find((l) => l.textContent === '기본 색')?.nextElementSibling?.querySelectorAll('.chip') || [])].slice(0, ${CODES[id].length}).map((c) => c.dataset.hex)`);
    check(lead.join() === CODES[id].join(), `${id}: its colours lead the basic colours (${lead.join(' ')})`);
    await p.waitForTimeout(200);
  }
  for (const w of WANT) {
    if (!(await S(`document.querySelector('#secMaterial .mat[data-id="${w.id}"]')?.classList.contains('on')`))) await p.click(`#secMaterial .mat[data-id="${w.id}"]`);
    await p.waitForTimeout(200);
    const basic = () => [...document.querySelectorAll('#secMaterial span.label')].find((l) => l.textContent === '기본 색')?.nextElementSibling;
    await S(`(${basic})()?.querySelector('.chip[data-hex="${w.hex}"]')?.click()`);
    await p.waitForTimeout(200);
  }
  const choices = await S(() => window.__studio.S.groups[0].choices.map((c) => `${c.materialId} ${c.color?.hex}`));
  log('choices', choices.join(' | '));
  check(choices.length === 4, 'four variants');
  await p.waitForFunction(() => window.__studio.S.groups[0]?.skinShown, null, { timeout: 120000 });
  await p.locator('#stage').screenshot({ path: `${OUT}/view.png` });

  // 3. export
  const saved = {};
  await p.exposeFunction('saveOut', (fname, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (fname.endsWith('.zip')) for (const [n, data] of Object.entries(unzipSync(new Uint8Array(buf)))) { fs.writeFileSync(`${OUT}/${n}`, data); saved[n] = Buffer.from(data); }
    else { fs.writeFileSync(`${OUT}/${fname}`, buf); saved[fname] = buf; }
  });
  await S(() => { const st = window.__studio; st.S.photos = false; window.__testSave = async (n, data) => { const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await window.saveOut(n, btoa(s)); }; });
  await S(() => window.__studio.runExport('folder'));
  await p.waitForTimeout(800);
  const glbs = Object.keys(saved).filter((n) => n.endsWith('.glb'));
  log('saved', glbs.map((n) => `${n} ${(saved[n].length / 1048576).toFixed(2)}MB`).join(', '));
  check(glbs.length === 4, 'four files');
  for (const w of WANT) {
    const hx = w.hex.slice(1);
    const n = glbs.find((f) => f.toUpperCase().includes(hx) && (f.includes(w.name.replace(/ /g, '-')) || f.includes(w.id)));
    const j = n && glbJson(saved[n]);
    const mat = j?.materials.find((m) => m.extras?.material === w.id);
    check(!!mat, `${w.name} ${w.hex}: its file has the material (${n})`);
  }
  const qc = await S(() => window.__studio.S.results.map((r) => ({ name: r.name, errors: r.qc?.check?.errors, warnings: r.qc?.check?.warnings })));
  log('checks', JSON.stringify(qc));
  check(qc.length === 4 && qc.every((r) => r.errors === 0), 'Khronos validator finds no errors');

  await b.close();
  log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
