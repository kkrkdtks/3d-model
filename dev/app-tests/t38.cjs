// v1.5: the 클리오네 tab, through the app.
// - the tab sits right after 패브릭 and holds the four covers of the Clione sofa, in order;
// - each card says what repeats (짜임 for the fabrics, 결 for the leather and the leather-look
//   BIO-SIL) and the long name 신소재 바이오실 패브릭 shows whole (two lines, not cut);
// - each cover's basic colours start with the photo colours of its kind (fabric: blue, ivory;
//   leather: black, cognac);
// - the four, one variant each, export with no Khronos validator errors; the fabrics carry sheen.
// usage: node t38.cjs SOFA.glb H [OUT_NAME]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const [GLB, H, NAME = 't38'] = process.argv.slice(2);
const OUT = path.join(__dirname, 'out', NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, what) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const WANT = [
  { id: 'clione-woven', name: '직조 패브릭', meta: '짜임', hex: '#29495C', sheen: true },
  { id: 'clione-flocking', name: '플로킹 패브릭', meta: '짜임', hex: '#E0DDD3', sheen: true },
  { id: 'clione-leather', name: '전체 천연가죽', meta: '결', hex: '#2C2C2D', sheen: false },
  { id: 'clione-biosil', name: '신소재 바이오실 패브릭', meta: '결', hex: '#8C5C3A', sheen: false },
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
  check(tabs.indexOf('클리오네') === tabs.indexOf('패브릭') + 1, 'the 클리오네 tab comes right after 패브릭');
  await p.click('[data-action="tab"][data-tab="클리오네"]');
  await p.waitForFunction(() => [...document.querySelectorAll('#secMaterial .mats img[data-swatch]')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 }).catch(() => log('swatches slow'));
  await p.locator('#secMaterial .mats').screenshot({ path: `${OUT}/cards.png` });
  const cards = await S(() => [...document.querySelectorAll('#secMaterial .mats .mat[data-id]')].map((c) => {
    const bEl = c.querySelector('.cap b');
    return { id: c.dataset.id, name: bEl.textContent, meta: c.querySelector('.cap small').textContent, whole: bEl.scrollHeight <= bEl.clientHeight + 1 && bEl.scrollWidth <= bEl.clientWidth + 1, img: c.querySelector('img').naturalWidth };
  }));
  log('cards', JSON.stringify(cards));
  check(cards.map((c) => c.id).join() === WANT.map((w) => w.id).join(), 'the four covers in order');
  check(cards.every((c, k) => c.name === WANT[k]?.name), 'names as on the brand page');
  check(cards.every((c, k) => WANT[k] && c.meta.startsWith(WANT[k].meta)), 'fabrics say 짜임, leathers say 결');
  check(cards.every((c) => c.whole), 'every name shows whole (신소재 바이오실 패브릭 on two lines)');
  check(cards.every((c) => c.img > 0), 'every card has its swatch');

  // 2. colours: the photo colour first; pick it for each cover
  for (const w of WANT) {
    await p.click(`#secMaterial .mat[data-id="${w.id}"]`);
    await p.waitForTimeout(200);
    // the chips under 기본 색
    const basic = () => [...document.querySelectorAll('#secMaterial span.label')].find((l) => l.textContent === '기본 색')?.nextElementSibling;
    const lead = await S(`[...((${basic})()?.querySelectorAll('.chip') || [])].slice(0, 2).map((c) => c.dataset.hex)`);
    check(lead.includes(w.hex), `${w.name}: the photo's ${w.hex} leads the basic colours (${lead.join(' ')})`);
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
    const n = glbs.find((f) => f.includes(w.name.replace(/ /g, '-')) || f.includes(w.id));
    const j = n && glbJson(saved[n]);
    const mat = j?.materials.find((m) => m.extras?.material === w.id);
    check(!!mat, `${w.name}: its file has the material (${n})`);
    if (mat) check(!!mat.extensions?.KHR_materials_sheen === w.sheen, `${w.name}: sheen ${w.sheen ? 'on' : 'off'}`);
  }
  const qc = await S(() => window.__studio.S.results.map((r) => ({ name: r.name, errors: r.qc?.check?.errors, warnings: r.qc?.check?.warnings })));
  log('checks', JSON.stringify(qc));
  check(qc.length === 4 && qc.every((r) => r.errors === 0), 'Khronos validator finds no errors');

  await b.close();
  log(failures ? `${failures} FAILURES` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
