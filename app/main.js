// 가구 스킨 스튜디오 — screen logic.
// Open a 3DAISTUDIO GLB, click the parts to change, pick textures and hex
// colours, and save one compressed GLB per combination. Runs offline.
import { deflateSync, inflateSync, zipSync } from 'fflate';
import { Viewer } from './viewer.js';
import { forgetSwatches, forgetTextures, makeThreeMaterial, swatch } from './materials.js';
import { canvasBlob, drawLitTiles, glossToSurface, KINDS, processPhoto, rulerFor } from './photo.js';
import * as store from './store.js';
import { colorLabel, tileUV } from '../core/skin.js';
import {
  bboxWith, extentOf, outputTransform, parseSizes, sizeLabel, sizeWith, stretchFor, stretchGeometry, swapAxes,
} from '../core/size.js';

/* global __VERSION__ */
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMB = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)}MB`;
const fmtInt = (n) => Math.round(n).toLocaleString('ko-KR');
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- material library ----------

const EMBED = JSON.parse($('#library-data').textContent);
const files = new Map();
for (const [path, b64] of Object.entries(EMBED.files)) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  files.set(path, new Blob([bytes], { type: 'image/webp' }));
}
const builtin = EMBED.library.materials.map((m) => ({ ...m, builtin: true }));
const palettes = EMBED.library.palettes;
let userMaterials = [];
const allMaterials = () => [...builtin, ...userMaterials];
const materialById = (id) => allMaterials().find((m) => m.id === id);
const getBlob = async (path) => {
  const b = files.get(path);
  if (!b) throw new Error(`텍스처 파일이 없어요: ${path}`);
  return b;
};

const CATEGORIES = ['가죽', '패브릭', '대리석', '나무', '도장', '메탈', '기타'];
const PHOTO_TABS = { 가죽: 'leather', 패브릭: 'fabric', 대리석: 'marble', 나무: 'wood', 기타: 'other' };
const NEUTRAL = '#A89F94';
const SWATCH_TINT = { leather: '#8E5B3A', fabric: '#A39A8C', paint: '#B7B1A8', metal: '#9EA0A3' };
const GROUP_COLORS = ['#e07a2f', '#3b7dd8', '#2e9e6e', '#c9487a', '#8c6bd6', '#c9a227', '#3fa3a8', '#b35f3b'];
const SEL_COLOR = '#ff8a3d';
// the piece below a height cut, shown while choosing the height
const CUT_COLOR = '#2f7ee0';
const QUALITY = {
  high: { label: '고품질', simplify: 0.4, keepSimplify: 0.5, note: '아주 가까이 봐도 원본과 같아요. 파일이 조금 커요.' },
  standard: { label: '표준', simplify: 0.25, keepSimplify: 0.35, note: '보통 거리에서는 원본과 구별이 안 돼요. 추천해요.' },
  light: { label: '가볍게', simplify: 0.12, keepSimplify: 0.2, note: '가장 작아요. 아주 가까이 보면 둥근 곳이 조금 단순해져요.' },
};
// boundary sensitivity the worker splits with when a file opens (threshold 165 − 105 = 60)
const DEFAULT_SENSITIVITY = 105;
// product photos: 4:3, big enough for a catalogue page
const PHOTO = { width: 1600, height: 1200 };

// ---------- state ----------

const S = {
  file: null, info: null, parts: [], faceLabels: null, welded: null, dims: null, segKey: 0,
  size: { w: null, d: null, h: null }, axes: { w: 2, d: 0, front: 1 }, axesSwapped: false, dimsOn: true,
  sensitivity: DEFAULT_SENSITIVITY, segSensitivity: DEFAULT_SENSITIVITY,
  // also split where the colour changes (a wooden base on fabric); height cuts made by hand
  segColor: true, segColorUsed: true, hasColor: false, cuts: [], cut: null,
  selection: new Set(), groups: [], active: null, view: 'material', hover: -1, compare: false,
  tab: '가죽', quality: 'standard', keptTex: 4096, compat: false, prefix: '', photos: true,
  colors: [], results: [], resultNote: '', exporting: false, confirmReseg: false, moreOpen: false,
  workKey: null, resumed: null,
};
const activeGroup = () => S.groups.find((g) => g.key === S.active) || null;
const groupOfPart = (i) => S.groups.find((g) => g.parts.includes(i)) || null;

// ---------- when the program cannot run here ----------

// Opened inside another page (e.g. the file preview in the Claude app) instead of by double-click.
const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
// Why the program cannot run here ('worker' | 'webgl'), shown on screen instead of failing silently.
const blocked = { reason: null, detail: '' };

const BLOCKED_TEXT = {
  worker: {
    title: '이 창에서는 프로그램이 실행되지 않아요',
    why: () => (embedded
      ? 'Claude 앱 미리보기처럼 다른 화면 안에 열린 창에서는 보안 때문에 막혀요.'
      : '이 브라우저에서 백그라운드 처리가 막혀 있어요.'),
    steps: () => (embedded
      ? ['이 파일을 내려받으세요. 미리보기 창이라면 오른쪽 위의 ⤓ (다운로드) 버튼을 누르면 돼요.', '내려받은 파일을 더블클릭하면 크롬이나 엣지에서 열려요.']
      : ['크롬이나 엣지 최신 버전으로 이 파일을 열어 보세요.', '그래도 안 되면 회사 보안 설정 때문일 수 있어요. 다른 PC에서 열어 보세요.']),
  },
  webgl: {
    title: '이 브라우저에서는 3D 화면을 켤 수 없어요',
    why: () => '그래픽 기능(WebGL)을 쓸 수 없는 상태예요.',
    steps: () => ['크롬이나 엣지 최신 버전으로 이 파일을 열어 보세요.', '그래도 안 되면 브라우저 설정 → 시스템에서 ‘그래픽 가속 사용’을 켜고 브라우저를 다시 시작하세요.'],
  },
};

function block(reason, detail = '') {
  if (blocked.reason) return;
  Object.assign(blocked, { reason, detail: String(detail || '') });
  const t = BLOCKED_TEXT[reason];
  const card = $('#drop .drop-card');
  card.classList.add('blocked');
  card.innerHTML = `<div class="drop-icon warn" aria-hidden="true"></div>
    <h1>${t.title}</h1>
    <p>${t.why()}</p>
    <ol class="steps">${t.steps().map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    ${blocked.detail ? `<p class="detail">${esc(blocked.detail)}</p>` : ''}`;
  $('#drop').hidden = false;
  for (const b of document.querySelectorAll('[data-action="open-file"]')) b.disabled = true;
}

// ---------- worker ----------

let worker = null, workerHello = false;
try {
  worker = new Worker(URL.createObjectURL(new Blob([$('#worker-src').textContent], { type: 'text/javascript' })));
} catch (e) {
  console.error(e);
  block('worker', e.message);
}
let seq = 0;
const pending = new Map();
if (worker) worker.onmessage = (e) => {
  if ('hello' in e.data) {
    workerHello = e.data.hello;
    if (!e.data.hello) block('worker', e.data.error);
    return;
  }
  const { id, ok, result, error, progress, file } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress) { p.onProgress?.(progress); return; }
  if (file) { p.onFile?.(file); return; }
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error));
};
if (worker) worker.onerror = (e) => {
  if (!workerHello) block('worker', e.message);
  for (const p of pending.values()) p.reject(new Error(e.message || '처리 중에 문제가 생겼어요.'));
  pending.clear();
};
function call(cmd, args, opts = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    if (blocked.reason) { reject(new Error(BLOCKED_TEXT[blocked.reason].title)); return; }
    pending.set(id, { resolve, reject, ...opts });
    worker.postMessage({ id, cmd, args }, opts.transfer || []);
  });
}

// ---------- small UI helpers ----------

function busy(text, frac) {
  $('#busy').hidden = false;
  $('#busyText').textContent = text;
  $('#busyBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}
const idle = () => { $('#busy').hidden = true; };
let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const head = (n, title, extra = '') => `<div class="card-head"><span class="step">${n}</span><h2>${title}</h2>${extra}</div>`;
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function parseHexes(text) {
  const out = [];
  for (const m of String(text).matchAll(/[#＃]?\b([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    let h = m[1].toUpperCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!out.includes(`#${h}`)) out.push(`#${h}`);
  }
  return out;
}
const colorName = (hex) => S.colors.find((c) => c.hex === hex)?.name || Object.values(palettes).flat().find((c) => c.hex.toUpperCase() === hex)?.name || hex;
const choiceLabel = (c) => {
  const def = materialById(c.materialId);
  if (!c.color) return def?.name || c.materialId;
  const name = c.color.name && c.color.name !== c.color.hex ? `${c.color.name} ` : '';
  return `${def?.name || c.materialId} · ${name}${c.color.hex}`;
};

// ---------- 3D view ----------

// without WebGL nothing can be shown; a do-nothing stand-in keeps the rest of the page working
let viewer;
try {
  viewer = new Viewer($('#viewport'), { onHover, onPick });
} catch (e) {
  console.error(e);
  block('webgl', e.message);
  viewer = new Proxy({}, { get: () => () => undefined });
}

function onHover(id, ev, moveOnly) {
  const tip = $('#tip');
  if (id >= 0 && ev) {
    const r = $('#stage').getBoundingClientRect();
    tip.style.left = `${ev.clientX - r.left}px`;
    tip.style.top = `${ev.clientY - r.top}px`;
  }
  if (moveOnly) return;
  S.hover = id;
  $('#stage').classList.toggle('hovering', id >= 0);
  if (id < 0) tip.hidden = true;
  else {
    const g = groupOfPart(id);
    tip.textContent = g ? `${g.name} · 부분 ${id + 1}` : `부분 ${id + 1} · 겉면의 ${S.parts[id].areaPct.toFixed(1)}%`;
    tip.hidden = false;
  }
  refreshStyles();
}

function onPick(id, { add }) {
  if (!S.parts.length) return;
  if (id < 0) {
    if (!add && S.selection.size) { S.selection.clear(); refreshAll(); }
    return;
  }
  const g = groupOfPart(id);
  if (g && !add) {
    S.selection.clear();
    setActive(g.key);
    return;
  }
  if (add) {
    if (S.selection.has(id)) S.selection.delete(id);
    else S.selection.add(id);
  } else {
    const only = S.selection.size === 1 && S.selection.has(id);
    S.selection.clear();
    if (!only) S.selection.add(id);
  }
  refreshAll();
}

function refreshStyles() {
  if (!S.parts.length) return;
  const hoverGroup = S.hover >= 0 ? groupOfPart(S.hover) : null;
  // '원본 보기': the model as it came, to compare with the chosen materials and sizes
  const compare = S.compare && S.view === 'material';
  $('#compareBadge').hidden = !compare;
  const styles = S.parts.map((_, i) => {
    const g = groupOfPart(i);
    const sel = S.selection.has(i);
    const hov = S.hover === i || (hoverGroup && g === hoverGroup);
    if (S.view === 'parts') {
      let overlay = g ? { color: g.color, opacity: 0.6 } : null;
      if (sel) overlay = { color: SEL_COLOR, opacity: 0.72 };
      if (hov) overlay = overlay ? { color: overlay.color, opacity: 0.88 } : { color: '#ffffff', opacity: 0.5 };
      return { base: 'clay', overlay };
    }
    const skinned = !!(g && g.skinShown) && !compare;
    let overlay = null;
    if (sel) overlay = { color: SEL_COLOR, opacity: 0.5 };
    else if (hov && !skinned) overlay = { color: '#ffffff', opacity: 0.3 };
    return { base: skinned ? 'hidden' : 'original', overlay };
  });
  viewer.setPartStyles(styles);
  for (const g of S.groups) {
    viewer.setSkinVisible(g.key, S.view === 'material' && g.skinShown && !compare);
    viewer.setSkinHighlight(g.key, S.view === 'material' && !compare && hoverGroup === g);
  }
  // the dimension lines measure what is shown: original parts that are not replaced + the replacements
  const shown = styles.map((st, i) => (st.base === 'hidden' ? -1 : i)).filter((i) => i >= 0);
  if (shown.length) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of shown) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], S.parts[p].min[k]); max[k] = Math.max(max[k], S.parts[p].max[k]); }
    viewer.setBaseBox(bboxWith({ min, max }, currentXf()));
  } else viewer.setBaseBox(null);
  renderLegend();
}

function setCompare(on) {
  S.compare = !!on;
  const b = $('[data-action="compare"]');
  b?.classList.toggle('on', S.compare);
  b?.setAttribute('aria-pressed', S.compare);
  refreshStyles();
}

function renderLegend() {
  const el = $('#legend');
  if (S.view !== 'parts' || !S.parts.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = S.groups.map((g) => `<span><i style="background:${g.color}"></i>${esc(g.name)}</span>`).join('')
    + (S.selection.size ? `<span><i style="background:${SEL_COLOR}"></i>선택한 부분</span>` : '')
    + `<span><i style="background:#c9c4bc"></i>그룹 없음 (원본 그대로)</span>`;
}

// ---------- opening a file ----------

async function openFile(file) {
  if (!file) return;
  if (blocked.reason) { toast(BLOCKED_TEXT[blocked.reason].title, 6000); return; }
  if (!/\.glb$/i.test(file.name)) { toast('GLB 파일(.glb)만 열 수 있어요.'); return; }
  const tOpen = performance.now();
  busy('파일 읽는 중', 0.02);
  let prev = null;
  try {
    // the model open until now keeps its latest changes; nothing is remembered until this one is ready
    saveWorkNow();
    prev = { file: S.file, key: S.workKey };
    S.workKey = null;
    // the work saved for this model last time: split it the same way so its groups fit again
    const key = workKey(file);
    const work = await store.getKV(key, null).catch(() => null);
    const sensitivity = work?.sensitivity ?? DEFAULT_SENSITIVITY;
    // work saved before colours were used (v0.4) was split by shape alone
    const segColor = work?.colorSplit ?? !work?.groups?.length;
    const buf = await file.arrayBuffer();
    const copy = buf.slice(0);
    const tRead = performance.now();
    const labels = unpackSplit(work?.split);
    const segment = { threshold: 165 - sensitivity, color: segColor, cuts: Array.isArray(work?.cuts) ? work.cuts : [], labels };
    const res = await call('open', { bytes: copy, segment }, { transfer: labels ? [copy, labels.buffer] : [copy], onProgress: (p) => busy(p.text, p.frac * 0.85) });
    const tWork = performance.now();
    const seg = { parts: res.parts, faceLabels: res.faceLabels };
    busy('화면 준비 중', 0.9);
    const tView = performance.now();
    await viewer.loadModel(buf, res.info.indexCount);
    console.info('열기 시간(ms)', JSON.stringify(res.timings), '화면', Math.round(performance.now() - tView));
    for (const g of S.groups) viewer.setSkin(g.key, null);
    Object.assign(S, {
      file: { name: file.name, size: file.size, base: file.name.replace(/\.glb$/i, '') },
      info: res.info, parts: seg.parts, faceLabels: seg.faceLabels, welded: res.welded, sensitivity, segSensitivity: sensitivity,
      segColor, segColorUsed: segColor, hasColor: res.hasColor, cuts: res.cuts, cut: null,
      dims: { x: res.info.bbox.max[0] - res.info.bbox.min[0], y: res.info.bbox.max[1] - res.info.bbox.min[1], z: res.info.bbox.max[2] - res.info.bbox.min[2] },
      selection: new Set(), groups: [], active: null, hover: -1, results: [], resultNote: '', segKey: S.segKey + 1, confirmReseg: false,
      resumed: null,
    });
    setCompare(false);
    S.prefix = S.file.base;
    const saved = work?.size ? { ...work.size, swapped: work.swapped } : await store.getKV(`size:${file.name}`, null);
    const legacyW = saved ? null : await store.getKV(`width:${file.name}`, null);
    S.size = { w: saved?.w ?? legacyW ?? null, d: saved?.d ?? null, h: saved?.h ?? null };
    S.axesSwapped = !!saved?.swapped;
    S.axes = S.axesSwapped ? swapAxes(res.axes) : res.axes;
    previewCache.clear();
    const tParts = performance.now();
    viewer.setParts(res.welded.pos, res.welded.index, seg.faceLabels, seg.parts.length);
    viewer.setAxes(S.axes);
    viewer.setOutputTransform(currentXf());
    const resumed = restoreWork(work);
    viewer.frame();
    console.info('열기 단계(ms)', JSON.stringify({ read: Math.round(tRead - tOpen), worker: Math.round(tWork - tRead), view: Math.round(tParts - tWork), parts: Math.round(performance.now() - tParts) }));
    $('#drop').hidden = true;
    $('#stageTools').hidden = false;
    $('#fileMeta').innerHTML = `<b>${esc(file.name)}</b> · ${fmtMB(file.size)}`;
    S.workKey = key;
    refreshAll();
    renderInfo();
    if (resumed?.groups) {
      toast(`지난번 작업을 이어서 열었어요. 그룹 ${resumed.groups}개${resumed.variants ? ` · 변형 ${resumed.variants}개` : ''}${resumed.dropped ? ` (지운 재질로 고른 ${resumed.dropped}개는 뺐어요)` : ''}`, 6000);
    } else if (resumed?.mismatch) {
      toast('지난번 작업이 있지만 부분이 다르게 나뉘어서 불러오지 못했어요. 바꿀 부분을 다시 골라 주세요.', 7000);
    } else toast(`부분 ${seg.parts.length}개로 나눴어요. 바꿀 부분을 클릭해 보세요.`);
    console.info('열기 전체(ms)', Math.round(performance.now() - tOpen));
  } catch (e) {
    console.error(e);
    // the model still on screen keeps being remembered
    if (prev && S.file === prev.file) S.workKey = prev.key;
    toast(`파일을 열지 못했어요: ${e.message}`, 7000);
  } finally {
    idle();
  }
}

async function resegment() {
  busy('부분 다시 나누는 중', 0.3);
  try {
    const threshold = 165 - S.sensitivity;
    const res = await call('segment', { threshold, color: S.segColor });
    for (const g of S.groups) viewer.setSkin(g.key, null);
    Object.assign(S, {
      parts: res.parts, faceLabels: res.faceLabels, selection: new Set(), groups: [], active: null, segKey: S.segKey + 1, confirmReseg: false,
      segSensitivity: S.sensitivity, segColorUsed: S.segColor, cuts: [], cut: null, resumed: null,
    });
    viewer.setCutPreview(-1);
    previewCache.clear();
    viewer.setParts(S.welded.pos, S.welded.index, res.faceLabels, res.parts.length);
    refreshAll();
    renderInfo();
    toast(`부분 ${res.parts.length}개로 다시 나눴어요.`);
  } catch (e) {
    toast(`다시 나누지 못했어요: ${e.message}`, 6000);
  } finally {
    idle();
  }
}

// ---------- cutting a part at a height ----------

// height from the floor in mm <-> model y, at the current real size
const yToMm = (y) => { const xf = currentXf(); return (y * xf.scale[1] + xf.offset[1]) * 1000; };
const mmToY = (mm) => { const xf = currentXf(); return (mm / 1000 - xf.offset[1]) / xf.scale[1]; };

/** Heights (mm) a part can be cut at: just inside its bottom and top. */
function cutRange(part) {
  const p = S.parts[part];
  return { lo: Math.ceil(yToMm(p.min[1])) + 1, hi: Math.floor(yToMm(p.max[1])) - 1 };
}

function startCut(part) {
  const { lo, hi } = cutRange(part);
  if (hi <= lo) { toast('이 부분은 너무 얇아서 높이로 나눌 수 없어요.'); return; }
  // a base is often about a tenth of the furniture's height; a thin part starts in its middle
  const mm = Math.round(Math.min(lo + 0.1 * realSize().h, (lo + hi) / 2));
  S.cut = { part, y: mmToY(mm) };
  refreshAll();
  showCut();
  $('#cutRange')?.focus();
}

function showCut() {
  if (!S.cut) { viewer.setCutPreview(-1); return; }
  const p = S.parts[S.cut.part];
  viewer.setCutPreview(S.cut.part, yToMm(S.cut.y) / 1000, bboxWith({ min: p.min, max: p.max }, currentXf()));
}

/** Slider or box moved: keep the other in step without redrawing the panel. */
function setCutMm(mm, from) {
  if (!S.cut || !Number.isFinite(mm)) return;
  const { lo, hi } = cutRange(S.cut.part);
  const v = Math.min(hi, Math.max(lo, Math.round(mm)));
  S.cut.y = mmToY(v);
  if (from !== 'range' && $('#cutRange')) $('#cutRange').value = v;
  if (from !== 'box' && $('#cutMm')) $('#cutMm').value = v;
  showCut();
}

function endCut() {
  if (!S.cut) return;
  S.cut = null;
  viewer.setCutPreview(-1);
}

async function applyCut() {
  const c = S.cut;
  if (!c) return;
  busy('부분 나누는 중', 0.4);
  try {
    const res = await call('cut', { part: c.part, y: c.y });
    const piece = res.parts.length - 1;
    endCut();
    Object.assign(S, { parts: res.parts, faceLabels: res.faceLabels, segKey: S.segKey + 1, cuts: [...S.cuts, { part: c.part, y: c.y }], selection: new Set([piece]) });
    previewCache.clear();
    viewer.setParts(S.welded.pos, S.welded.index, res.faceLabels, res.parts.length);
    // a group that had the whole part keeps the upper piece; its preview is rebuilt
    for (const g of S.groups) if (g.parts.includes(c.part)) updatePreview(g);
    refreshAll();
    renderInfo();
    saveWorkSoon();
    toast('아래쪽을 새 부분으로 나눴어요. ‘새 그룹으로’를 누르면 따로 재질을 입힐 수 있어요.', 6000);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    idle();
  }
}

// ---------- groups ----------

function suggestName(parts) {
  const b = S.info.bbox;
  const H = S.dims.y;
  let minY = Infinity, maxY = -Infinity, area = 0, sx = 0, sz = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const id of parts) {
    const p = S.parts[id];
    area += p.areaPct;
    minY = Math.min(minY, p.min[1]); maxY = Math.max(maxY, p.max[1]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.min[k]); hi[k] = Math.max(hi[k], p.max[k]); }
  }
  sx = hi[0] - lo[0]; sz = hi[2] - lo[2];
  // one low piece under the whole footprint (on the floor or on legs): a base
  if (parts.length === 1 && minY < b.min[1] + 0.2 * H && maxY < b.min[1] + 0.4 * H && sx > 0.7 * S.dims.x && sz > 0.7 * S.dims.z) return '받침대';
  if (minY < b.min[1] + 0.03 * H && area < 8) return '다리';
  // a thin slab across the very top: a table top (checked before 몸체, it is often the biggest part)
  if (maxY > b.max[1] - 0.05 * H && hi[1] - lo[1] < 0.25 * Math.max(sx, sz) && Math.max(sx, sz) > 0.6 * Math.max(S.dims.x, S.dims.z)) return '상판';
  if (parts.includes(0)) return '몸체';
  return null;
}

function uniqueName(name) {
  let n = name, i = 2;
  while (S.groups.some((g) => g.name === n)) n = `${name} ${i++}`;
  return n;
}

function detach(parts) {
  for (const g of S.groups) g.parts = g.parts.filter((p) => !parts.includes(p));
  for (const g of S.groups.filter((x) => !x.parts.length)) viewer.setSkin(g.key, null);
  S.groups = S.groups.filter((g) => g.parts.length);
  if (!activeGroup()) S.active = S.groups[0]?.key || null;
}

function newGroup(parts) {
  detach(parts);
  const used = new Set(S.groups.map((g) => g.color));
  const color = GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[S.groups.length % GROUP_COLORS.length];
  const g = {
    key: uid('g'), name: uniqueName(suggestName(parts) || `그룹 ${S.groups.length + 1}`), parts: [...parts].sort((a, b) => a - b), color,
    choices: [], active: null, rotate: 0, skinShown: false, token: 0, pick: null, sizes: [], activeSize: null,
  };
  S.groups.push(g);
  S.selection.clear();
  setActive(g.key);
  for (const other of S.groups) if (other !== g) updatePreview(other);
}

function addToGroup(key, parts) {
  const g = S.groups.find((x) => x.key === key);
  if (!g) return;
  detach(parts);
  if (!S.groups.includes(g)) S.groups.push(g);
  g.parts = [...new Set([...g.parts, ...parts])].sort((a, b) => a - b);
  S.selection.clear();
  setActive(g.key);
  for (const other of S.groups) updatePreview(other);
}

function deleteGroup(key) {
  viewer.setSkin(key, null);
  S.groups = S.groups.filter((g) => g.key !== key);
  if (S.active === key) S.active = S.groups[0]?.key || null;
  refreshAll();
}

function setActive(key) {
  S.active = key;
  const g = activeGroup();
  if (g?.pick) S.tab = materialById(g.pick)?.category || S.tab;
  refreshAll();
}

// ---------- remembering the work on each model ----------

// Saved per model file (same name and size): opening it again continues with the same groups,
// materials, colours and sizes. Lives in this PC's browser; the library .zip carries it to another PC.
const workKey = (f) => `work:${f.name}|${f.size}`;
// the split the groups were made on: part face counts are exact, so any other split is noticed
const partSig = () => S.parts.map((p) => p.faces).join(',');
let workTimer = 0;

// The split itself (a part id per triangle, about 200 KB packed) is kept with the work, so it
// comes back exactly, whatever the browser, the PC or a later version of the splitting does.
let packed = { key: -1, split: null };
function packSplit() {
  if (packed.key !== S.segKey) {
    const ids = S.parts.length <= 256 ? Uint8Array.from(S.faceLabels) : Uint16Array.from(S.faceLabels);
    const bytes = deflateSync(new Uint8Array(ids.buffer), { level: 6 });
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    packed = { key: S.segKey, split: { bits: ids.BYTES_PER_ELEMENT * 8, faces: ids.length, data: btoa(bin) } };
  }
  return packed.split;
}

function unpackSplit(split) {
  if (!split?.data) return null;
  try {
    const bin = atob(split.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const raw = inflateSync(bytes);
    const ids = split.bits === 16 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1) : raw;
    return ids.length === split.faces ? Int32Array.from(ids) : null;
  } catch (e) {
    console.warn('저장한 부분 나누기를 읽지 못했어요', e);
    return null;
  }
}

function workSnapshot() {
  return {
    v: 1, saved: Date.now(),
    sensitivity: S.segSensitivity, colorSplit: S.segColorUsed, cuts: S.cuts, partCount: S.parts.length, partSig: partSig(),
    split: S.groups.length || S.cuts.length ? packSplit() : null,
    size: { ...S.size }, swapped: S.axesSwapped,
    groups: S.groups.map((g) => ({
      name: g.name, parts: g.parts, color: g.color, rotate: g.rotate, pick: g.pick,
      choices: g.choices.map((c) => ({ materialId: c.materialId, color: c.color || null })),
      active: g.choices.findIndex((c) => c.id === g.active),
      sizes: g.sizes.map((z) => ({ w: z.w ?? null, d: z.d ?? null })),
      activeSize: g.sizes.findIndex((z) => z.id === g.activeSize),
    })),
    active: S.groups.findIndex((g) => g.key === S.active),
    quality: S.quality, keptTex: S.keptTex, compat: S.compat, prefix: S.prefix,
  };
}

function saveWorkSoon() {
  if (!S.workKey) return;
  clearTimeout(workTimer);
  workTimer = setTimeout(saveWorkNow, 400);
}

function saveWorkNow() {
  clearTimeout(workTimer);
  if (!S.workKey || !S.parts.length) return;
  store.setKV(S.workKey, workSnapshot()).catch((e) => console.warn('작업을 기억하지 못했어요', e));
}

/**
 * Continue the work saved for this model, when it is split into the same parts as then.
 * Returns { groups, variants, dropped } | { mismatch: true } | null (nothing saved).
 */
function restoreWork(work) {
  if (!work?.groups?.length) return null;
  if (work.partCount !== S.parts.length || work.partSig !== partSig()) return { mismatch: true };
  let dropped = 0;
  for (const w of work.groups) {
    const parts = (w.parts || []).filter((p) => Number.isInteger(p) && p >= 0 && p < S.parts.length && !groupOfPart(p));
    if (!parts.length) continue;
    const choices = [];
    let active = null;
    (w.choices || []).forEach((c, i) => {
      if (!materialById(c.materialId)) { dropped++; return; } // a material deleted since
      const choice = { id: uid('c'), materialId: c.materialId, color: c.color || null };
      choices.push(choice);
      if (i === w.active) active = choice.id;
    });
    const sizes = (w.sizes || []).filter((z) => z.w > 0).map((z) => ({ id: uid('z'), w: z.w, d: z.d ?? null }));
    S.groups.push({
      key: uid('g'), name: w.name || `그룹 ${S.groups.length + 1}`, parts: parts.sort((a, b) => a - b),
      color: w.color || GROUP_COLORS[S.groups.length % GROUP_COLORS.length],
      choices, active: active || choices[choices.length - 1]?.id || null, rotate: w.rotate === 90 ? 90 : 0,
      skinShown: false, token: 0, pick: materialById(w.pick) ? w.pick : null, sizes, activeSize: sizes[w.activeSize]?.id || null,
    });
  }
  if (!S.groups.length) return null;
  S.active = S.groups[work.active]?.key || S.groups[0].key;
  if (QUALITY[work.quality]) S.quality = work.quality;
  if (work.keptTex === 2048 || work.keptTex === 4096) S.keptTex = work.keptTex;
  S.compat = !!work.compat;
  if (work.prefix) S.prefix = work.prefix;
  const pick = activeGroup()?.pick;
  if (pick) S.tab = materialById(pick).category;
  for (const g of S.groups) updatePreview(g);
  S.resumed = { saved: work.saved };
  return { groups: S.groups.length, variants: variantPlan().count, dropped };
}

/** '처음부터 하기': drop the groups and choices of this model (materials and colours stay). */
async function resetWork() {
  const ok = await confirmBox('이 모델을 처음부터 다시 할까요?',
    '만든 그룹과 고른 재질·색·크기가 모두 빠져요. 사진으로 만든 재질과 저장한 색은 그대로 남아요.', '처음부터');
  if (!ok) return;
  for (const g of S.groups) viewer.setSkin(g.key, null);
  Object.assign(S, { groups: [], active: null, selection: new Set(), resumed: null, results: [], resultNote: '' });
  refreshAll();
  saveWorkNow();
  toast('처음부터 시작해요. 바꿀 부분을 클릭해 보세요.');
}

function similarParts(ids) {
  const sig = (p) => ({ area: p.areaPct, d: [0, 1, 2].map((k) => p.max[k] - p.min[k]).sort((a, b) => a - b) });
  const close = (x, y, tol) => Math.abs(x - y) <= tol * Math.max(x, y, 1e-9);
  const out = new Set(ids);
  for (const id of ids) {
    const a = sig(S.parts[id]);
    S.parts.forEach((p, j) => {
      const b = sig(p);
      if (close(a.area, b.area, 0.3) && a.d.every((v, k) => close(v, b.d[k], 0.3))) out.add(j);
    });
  }
  return out;
}

// ---------- live preview ----------

// ---------- real size ----------

/** Height assumed for previews until the real one is typed in (mm). */
function provisionalH() {
  const ext = extentOf(S.info.bbox);
  if (S.size.w) return (S.size.w * ext[1]) / ext[S.axes.w];
  if (S.size.d) return (S.size.d * ext[1]) / ext[S.axes.d];
  return 800;
}
/** Model units -> metres on the floor, from W / D / H. Everything on screen and in the files uses it. */
const currentXf = () => outputTransform(S.info.bbox, S.axes, { ...S.size, h: S.size.h || provisionalH() });
const realSize = () => sizeWith(S.info.bbox, S.axes, currentXf());

/** Bounding box of a group's parts in metres, before any resizing. */
function groupBox(g) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of g.parts)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], S.parts[p].min[k]); max[k] = Math.max(max[k], S.parts[p].max[k]); }
  return bboxWith({ min, max }, currentXf());
}
function groupSizeMm(g) {
  const b = groupBox(g);
  return { w: (b.max[S.axes.w] - b.min[S.axes.w]) * 1000, d: (b.max[S.axes.d] - b.min[S.axes.d]) * 1000 };
}

/** W / D / H or the W-D direction changed: show the model at the new size and rebuild the previews. */
function applySize() {
  if (!S.info) return;
  viewer.setAxes(S.axes);
  viewer.setOutputTransform(currentXf());
  for (const g of S.groups) updatePreview(g);
  refreshStyles();
  if (S.cut) { renderParts(); showCut(); }
  viewer.frame();
  if (S.file) store.setKV(`size:${S.file.name}`, { ...S.size, swapped: S.axesSwapped });
}

// ---------- previews ----------

const previewCache = new Map();
function previewGeo(g, size) {
  const q = QUALITY[S.quality];
  const xf = currentXf(), sz = size ? { w: size.w, d: size.d } : null;
  const key = JSON.stringify([S.segKey, g.parts, q.simplify, xf, sz, S.axes]);
  if (!previewCache.has(key)) {
    if (previewCache.size > 16) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(key, call('preview', { parts: g.parts, simplify: q.simplify, xf, size: sz, axes: S.axes }));
  }
  return previewCache.get(key);
}
const activeSize = (g) => g.sizes.find((z) => z.id === g.activeSize) || null;

async function updatePreview(g) {
  const token = ++g.token;
  const choice = g.choices.find((c) => c.id === g.active) || null;
  const size = activeSize(g);
  if ((!choice && !size) || !S.parts.length) {
    viewer.setSkin(g.key, null);
    g.skinShown = false;
    refreshStyles();
    return;
  }
  try {
    if (choice) {
      const def = materialById(choice.materialId);
      const [geo, mat] = await Promise.all([previewGeo(g, size), makeThreeMaterial(def, choice.color, getBlob, viewer.maxAnisotropy())]);
      if (token !== g.token || !S.groups.includes(g)) { mat.dispose(); return; }
      viewer.setSkin(g.key, geo, mat, g.parts[0]);
      viewer.setSkinUV(g.key, tileUV(geo.uv, def, g.rotate));
    } else {
      // original look, resized: done on the screen side from the loaded model
      const st = stretchFor(groupBox(g), S.axes, size);
      viewer.setResizedOriginal(g.key, g.parts, (P, N) => stretchGeometry(P, N, st), JSON.stringify([S.segKey, g.parts, currentXf(), size.w, size.d]), g.parts[0]);
    }
    g.skinShown = true;
    refreshStyles();
  } catch (e) {
    console.error(e);
    toast(`미리보기를 만들지 못했어요: ${e.message}`, 6000);
  }
}

function refreshUVs() {
  for (const g of S.groups) {
    const choice = g.choices.find((c) => c.id === g.active);
    if (!choice || !g.skinShown) continue;
    previewGeo(g, activeSize(g)).then((geo) => viewer.setSkinUV(g.key, tileUV(geo.uv, materialById(choice.materialId), g.rotate)));
  }
}

function addChoice(g, materialId, color) {
  const exists = g.choices.find((c) => c.materialId === materialId && (c.color?.hex || null) === (color?.hex || null));
  if (exists) { g.active = exists.id; return exists; }
  const c = { id: uid('c'), materialId, color };
  g.choices.push(c);
  g.active = c.id;
  return c;
}

function removeChoice(g, id) {
  g.choices = g.choices.filter((c) => c.id !== id);
  if (g.active === id) g.active = g.choices[g.choices.length - 1]?.id || null;
}

// ---------- rendering the panel ----------

function refreshAll() {
  if (S.cut && !(S.selection.size === 1 && S.selection.has(S.cut.part))) endCut();
  renderParts();
  renderMaterial();
  renderExport();
  refreshStyles();
}

function renderInfo() {
  const el = $('#secInfo');
  if (!S.info) {
    el.innerHTML = `${head(1, '가구 정보')}<p class="hint">GLB 파일을 열면 크기와 부분 정보가 여기에 나와요.</p>`;
    return;
  }
  const tex = S.info.textures.map((t) => (t.width ? `${Math.max(1, Math.round(t.width / 1024))}K` : '?')).join(' · ') || '없음';
  el.innerHTML = `${head(1, '가구 정보')}
    <dl class="kv">
      <dt>파일</dt><dd>${esc(S.file.name)} · ${fmtMB(S.file.size)}</dd>
      <dt>모양</dt><dd>삼각형 ${fmtInt(S.info.triangles)}개 · 부분 ${S.parts.length}개</dd>
      <dt>텍스처</dt><dd>${esc(tex)}</dd>
    </dl>
    <div class="field">
      <span class="label">실제 크기 <span class="note">mm</span></span>
      <div class="size-row">
        <label class="size-in"><span>W 가로</span><input class="input num" id="sizeW" inputmode="numeric" autocomplete="off" value="${S.size.w ?? ''}"></label>
        <label class="size-in"><span>D 깊이</span><input class="input num" id="sizeD" inputmode="numeric" autocomplete="off" value="${S.size.d ?? ''}"></label>
        <label class="size-in req ${S.size.h ? '' : 'missing'}"><span>H 높이 <b>필수</b></span><input class="input num" id="sizeH" inputmode="numeric" autocomplete="off" value="${S.size.h ?? ''}"></label>
      </div>
      <p class="hint">H만 넣으면 비율 그대로 키우고, W·D까지 넣으면 그 치수에 맞게 늘이거나 줄여요. 저장하는 GLB가 이 크기(미터 단위)가 돼요.</p>
      <button class="link" type="button" data-action="swap-axes">W와 D 방향이 반대인가요? 서로 바꾸기</button>
    </div>`;
  updateSizeHints();
}

/** Empty W / D / H boxes show what they will be with the current proportions. */
function updateSizeHints() {
  if (!S.info) return;
  const r = realSize();
  for (const [id, k] of [['sizeW', 'w'], ['sizeD', 'd'], ['sizeH', 'h']]) {
    const el = $(`#${id}`);
    if (el) el.placeholder = k === 'h' && !S.size.h ? '예: 800' : `약 ${fmtInt(r[k])}`;
  }
  $('#sizeH')?.closest('.size-in')?.classList.toggle('missing', !S.size.h);
}

function renderParts() {
  const el = $('#secParts');
  if (!S.parts.length) {
    el.innerHTML = `${head(2, '바꿀 부분')}<p class="hint">파일을 열면 경계선을 따라 자동으로 부분을 나눠요.</p>`;
    el.classList.add('dim');
    return;
  }
  el.classList.remove('dim');
  const sel = [...S.selection];
  const when = S.resumed?.saved ? new Date(S.resumed.saved).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  el.innerHTML = `${head(2, '바꿀 부분')}
    ${S.resumed ? `<div class="resume"><span><b>지난번 작업을 이어서 열었어요</b>${when ? `<small>${esc(when)}에 저장한 작업</small>` : ''}</span>
      <button class="link" type="button" data-action="work-reset">처음부터 하기</button></div>` : ''}
    <p class="hint">3D 화면에서 바꿀 부분을 클릭하세요. <b>Shift</b>를 누른 채 클릭하면 여러 개를 고를 수 있어요.</p>
    ${sel.length ? `<div class="selbar"><strong>선택 ${sel.length}개</strong>
      <button class="btn small" type="button" data-action="group-new">새 그룹으로</button>
      ${S.groups.map((g) => `<button class="btn ghost small" type="button" data-action="group-add" data-key="${g.key}">＋ ${esc(g.name)}</button>`).join('')}
      <button class="btn ghost small" type="button" data-action="select-similar">비슷한 부분도</button>
      ${sel.length === 1 && !S.cut ? '<button class="btn ghost small" type="button" data-action="cut-start">높이로 나누기</button>' : ''}
      <button class="btn ghost small" type="button" data-action="select-clear">해제</button></div>` : ''}
    ${S.cut ? cutBox() : ''}
    <div class="groups">${S.groups.map((g) => `
      <div class="group ${g.key === S.active ? 'on' : ''}" data-action="group-activate" data-key="${g.key}">
        <span class="dot" style="background:${g.color}"></span>
        <span class="name">${esc(g.name)} <span class="sub">· 부분 ${g.parts.length}개 · 변형 ${g.choices.length || g.sizes.length ? optionsOf(g).length : 0}개</span></span>
        <button class="icon-btn" type="button" data-action="group-delete" data-key="${g.key}" title="그룹 지우기" aria-label="${esc(g.name)} 그룹 지우기">×</button>
      </div>`).join('') || '<p class="empty">아직 그룹이 없어요. 부분을 클릭한 뒤 ‘새 그룹으로’를 누르세요.</p>'}</div>
    <details class="more" ${S.confirmReseg || S.moreOpen ? 'open' : ''}><summary>부분이 잘 안 나뉘었나요?</summary><div class="more-body">
      <div class="field">
        <label for="sensitivity">경계 민감도</label>
        <div class="range-row"><span class="note">덜 나눔</span><input type="range" id="sensitivity" min="25" max="140" step="5" value="${S.sensitivity}"><span class="note">더 나눔</span></div>
      </div>
      <label class="check"><input type="checkbox" id="segColor" ${S.segColor && S.hasColor ? 'checked' : ''} ${S.hasColor ? '' : 'disabled'}>
        <span>색이 다른 곳도 나누기<small>${S.hasColor ? '나무 받침대나 금속 다리처럼 몸체와 색이 다르면 홈이 없어도 따로 나눠요.' : '이 모델은 텍스처가 없어서 모양으로만 나눠요.'}</small></span></label>
      <div><button class="btn ghost small" type="button" data-action="resegment">${S.confirmReseg ? '만든 그룹이 지워져요. 다시 나눌까요?' : '이 설정으로 다시 나누기'}</button></div>
      <p class="hint">받침대가 몸체나 방석에 붙어 있으면 그 부분을 클릭하고 <b>높이로 나누기</b>를 누르세요.${S.cuts.length ? ` 높이로 나눈 곳 ${S.cuts.length}개는 다시 나누면 없어져요.` : ''}</p>
    </div></details>`;
}

/** Choosing the height to cut the selected part at: the piece below turns blue on the model. */
function cutBox() {
  const { lo, hi } = cutRange(S.cut.part), mm = Math.round(yToMm(S.cut.y));
  return `<div class="cutbox">
    <span class="label">높이로 나누기 · 부분 ${S.cut.part + 1}</span>
    <p class="hint"><i class="swatch" style="background:${CUT_COLOR}"></i>파란색으로 칠해진 아래쪽이 새 부분이 돼요. 받침대 윗선에 맞춰 보세요.</p>
    <div class="range-row"><span class="note mono">${fmtInt(lo)}</span><input type="range" id="cutRange" min="${lo}" max="${hi}" step="1" value="${mm}" aria-label="나눌 높이"><span class="note mono">${fmtInt(hi)}</span></div>
    <div class="cut-row"><label>바닥에서 <input class="input num" id="cutMm" inputmode="numeric" autocomplete="off" value="${mm}"> mm 아래</label>
      <span class="cut-actions"><button class="btn small" type="button" data-action="cut-apply">나누기</button>
      <button class="btn ghost small" type="button" data-action="cut-cancel">취소</button></span></div>
  </div>`;
}

function matCard(m, g) {
  const count = g.choices.filter((c) => c.materialId === m.id).length;
  const first = g.choices.find((c) => c.materialId === m.id && c.color);
  const hex = m.colorMode === 'photo' ? '' : first?.color.hex || SWATCH_TINT[m.palette] || NEUTRAL;
  const meta = m.maps ? `결 ${m.tileCm}cm` : m.metallic ? '금속' : (m.roughness ?? 1) < 0.3 ? '광택' : '매트';
  return `<div class="mat-cell"><button class="mat ${g.pick === m.id ? 'on' : ''}" type="button" data-action="mat-pick" data-id="${esc(m.id)}" title="${esc(m.name)}">
    <img data-swatch="${esc(m.id)}|${hex}" alt="">
    <span class="cap"><b>${esc(m.name)}</b><small>${meta}</small></span>
    ${m.colorMode === 'photo' ? '<span class="badge">사진 색</span>' : m.source === 'photo' ? '<span class="badge">사진</span>' : ''}
    ${count ? `<span class="count">${count}</span>` : ''}
  </button>${m.builtin ? '' : `<button class="mat-edit" type="button" data-action="mat-edit" data-id="${esc(m.id)}" title="수정" aria-label="‘${esc(m.name)}’ 수정">✎</button><button class="mat-del" type="button" data-action="mat-delete" data-id="${esc(m.id)}" title="삭제" aria-label="‘${esc(m.name)}’ 삭제">×</button>`}</div>`;
}

function colorChip(c, on) {
  const named = c.name && c.name !== c.hex;
  return `<button class="chip ${on ? 'on' : ''}" type="button" data-action="color-toggle" data-hex="${c.hex}" data-name="${esc(named ? c.name : '')}">
    <i style="background:${c.hex}"></i>${named ? `${esc(c.name)} ` : ''}<span class="mono">${c.hex}</span></button>`;
}

function colorArea(m, g) {
  const edit = m.builtin ? '' : `<button class="link" type="button" data-action="mat-edit" data-id="${esc(m.id)}">재질 수정</button>`;
  if (m.colorMode === 'photo') {
    const on = g.choices.some((c) => c.materialId === m.id);
    return `<div class="sub-head"><span class="label">${esc(m.name)}</span>${edit}</div>
      <p class="hint">사진의 색과 무늬를 그대로 써요.</p>
      <div><button class="btn small ${on ? 'ghost' : ''}" type="button" data-action="photo-toggle" data-id="${esc(m.id)}">${on ? '변형에서 빼기' : '변형에 넣기'}</button></div>`;
  }
  const isOn = (hex) => g.choices.some((c) => c.materialId === m.id && c.color?.hex === hex);
  const pal = palettes[m.palette] || [];
  return `<div class="sub-head"><span class="label">${esc(m.name)}의 색 · 여러 개 고를 수 있어요</span>${edit}
      <a class="note" href="https://encycolorpedia.com/" target="_blank" rel="noopener">encycolorpedia ↗</a></div>
    <div class="input-row"><input class="input mono" id="hexInput" placeholder="#8B4A22, #1D1C1B" autocomplete="off" spellcheck="false">
      <button class="btn small" type="button" data-action="hex-add">추가</button></div>
    ${S.colors.length ? `<span class="label">저장한 색</span><div class="colors">${S.colors.map((c) => colorChip(c, isOn(c.hex))).join('')}</div>` : ''}
    ${pal.length ? `<span class="label">기본 색</span><div class="colors">${pal.map((c) => colorChip(c, isOn(c.hex))).join('')}</div>` : ''}`;
}

function renderMaterial() {
  const el = $('#secMaterial');
  const g = activeGroup();
  if (!g) {
    el.innerHTML = `${head(3, '질감과 색')}<p class="hint">바꿀 부분을 그룹으로 만들면 질감과 색을 고를 수 있어요.</p>`;
    el.classList.add('dim');
    return;
  }
  el.classList.remove('dim');
  const tabs = CATEGORIES.filter((c) => PHOTO_TABS[c] || allMaterials().some((m) => m.category === c));
  if (!tabs.includes(S.tab)) S.tab = tabs[0];
  const mats = allMaterials().filter((m) => m.category === S.tab);
  const picked = g.pick ? materialById(g.pick) : null;
  const photoKind = PHOTO_TABS[S.tab];
  el.innerHTML = `${head(3, '질감과 색', `<span class="dot-badge" style="background:${g.color}"></span>`)}
    <div class="field"><label for="groupName">그룹 이름 <span class="note">(파일 이름에 들어가요)</span></label>
      <input class="input" id="groupName" value="${esc(g.name)}" maxlength="24"></div>
    <div class="tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" aria-selected="${t === S.tab}" data-action="tab" data-tab="${t}" class="${t === S.tab ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="mats">${mats.map((m) => matCard(m, g)).join('')}${photoKind ? `
      <button class="mat add" type="button" data-action="photo-open" data-kind="${photoKind}"><span class="plus">＋</span>사진으로<br>${S.tab} 만들기</button>` : ''}</div>
    ${picked ? colorArea(picked, g) : '<p class="hint">질감을 고르면 색을 고를 수 있어요.</p>'}
    <div class="sub-head"><span class="label">‘${esc(g.name)}’ 변형 ${g.choices.length}개 · 누르면 미리보기</span>
      ${g.choices.length ? '<button class="link" type="button" data-action="choices-clear">모두 빼기</button>' : ''}</div>
    <div class="choice-list">${g.choices.map((c) => `
      <span class="choice ${c.id === g.active ? 'on' : ''}" data-action="choice-preview" data-id="${c.id}" title="${esc(choiceLabel(c))}">
        <img data-swatch="${esc(c.materialId)}|${c.color?.hex || ''}" alt=""><span>${esc(choiceLabel(c))}</span>
        <button class="x" type="button" data-action="choice-remove" data-id="${c.id}" aria-label="빼기">×</button></span>`).join('') || '<span class="note">아직 없어요. 질감과 색을 고르면 여기에 쌓여요.</span>'}</div>
    <div class="field"><span class="label">무늬 방향</span>
      <div class="seg flat" role="group">
        <button type="button" data-action="rotate" data-rot="0" class="${g.rotate === 0 ? 'on' : ''}">기본</button>
        <button type="button" data-action="rotate" data-rot="90" class="${g.rotate === 90 ? 'on' : ''}">90° 돌리기</button>
      </div></div>
    ${sizeArea(g)}`;
  hydrateSwatches(el);
  saveWorkSoon();
}

/** Order sizes for one part (a table top in 1600, 1800, 2000 ...): each size is a variant. */
function sizeArea(g) {
  const cur = groupSizeMm(g);
  return `<div class="sub-head sizes-head"><span class="label">‘${esc(g.name)}’ 크기 바꾸기 <span class="note">(선택)</span></span>
      ${g.sizes.length ? '<button class="link" type="button" data-action="sizes-clear">모두 빼기</button>' : ''}</div>
    <p class="hint">지금 W ${fmtInt(cur.w)} × D ${fmtInt(cur.d)}mm. 상판처럼 주문 사이즈가 있는 부분에 써요. 테두리와 모서리 모양은 그대로 두고 가운데만 늘이거나 줄여요. 크기마다 변형이 하나씩 생겨요.</p>
    <div class="input-row"><input class="input mono" id="sizeInput" placeholder="1800×900, 2000×1000" autocomplete="off" spellcheck="false">
      <button class="btn small" type="button" data-action="size-add">추가</button></div>
    <div class="choice-list">${g.sizes.map((z) => `
      <span class="choice size ${z.id === g.activeSize ? 'on' : ''}" data-action="size-preview" data-id="${z.id}" title="누르면 미리보기">
        <span class="mono">${esc(sizeLabel(z, cur))}</span>
        <button class="x" type="button" data-action="size-remove" data-id="${z.id}" aria-label="빼기">×</button></span>`).join('')}
      ${g.sizes.some((z) => Math.round(z.w) === Math.round(cur.w) && Math.round(z.d ?? cur.d) === Math.round(cur.d)) ? ''
        : `<button class="chip plain" type="button" data-action="size-add-current">＋ 지금 크기 (${fmtInt(cur.w)}×${fmtInt(cur.d)})</button>`}</div>`;
}

function hydrateSwatches(root) {
  for (const img of root.querySelectorAll('img[data-swatch]')) {
    const [id, hex] = img.dataset.swatch.split('|');
    const def = materialById(id);
    if (!def) continue;
    swatch(def, hex ? { hex } : null, getBlob).then((url) => { img.src = url; }).catch(() => {});
  }
}

/** A group's options: each material choice (or the original look) × each size (or its own size). */
function optionsOf(g) {
  const mats = g.choices.length ? g.choices : [null];
  const sizes = g.sizes.length ? g.sizes : [null];
  return mats.flatMap((choice) => sizes.map((size) => ({ choice, size })));
}

function variantPlan() {
  const active = S.groups.filter((g) => g.choices.length || g.sizes.length);
  const count = active.length ? active.reduce((a, g) => a * optionsOf(g).length, 1) : 0;
  return { active, count };
}

function renderExport() {
  const el = $('#secExport');
  if (!S.info) {
    el.innerHTML = `${head(4, '내보내기')}<p class="hint">재질 조합마다 압축된 GLB 파일을 하나씩 만들어요.</p>`;
    el.classList.add('dim');
    return;
  }
  el.classList.remove('dim');
  const { active, count } = variantPlan();
  const q = QUALITY[S.quality];
  const needH = !S.size.h;
  const off = S.exporting || needH ? 'disabled' : '';
  const r = realSize();
  const per = (g) => [g.choices.length ? `재질 ${g.choices.length}` : '', g.sizes.length ? `크기 ${g.sizes.length}` : ''].filter(Boolean).join('·');
  el.innerHTML = `${head(4, '내보내기')}
    <div class="summary">${count ? `변형 ${count}개를 만들어요` : '아직 고른 재질이 없어요'}
      <small>${count ? `${active.map((g) => `${esc(g.name)} ${per(g)}`).join(' × ')}${S.groups.length > active.length ? ' · 고르지 않은 그룹은 원본 그대로' : ''}` : '재질이나 크기를 고르면 조합마다 GLB 파일이 하나씩 만들어져요.'}</small></div>
    ${needH ? '<p class="warn-text">1번에 실제 높이(H)를 넣어야 저장할 수 있어요.</p>'
      : `<p class="note">저장 크기 W ${fmtInt(r.w)} × D ${fmtInt(r.d)} × H ${fmtInt(r.h)}mm${S.groups.some((x) => x.sizes.length) ? ' (크기를 바꾼 부분은 변형마다 그 크기로)' : ''} · 미터 단위, 바닥 가운데 기준</p>`}
    ${count > 40 ? `<p class="warn-text">파일이 ${count}개예요. 시간이 꽤 걸릴 수 있어요.</p>` : ''}
    <div class="field"><span class="label">압축</span>
      <div class="seg flat" role="group">${Object.entries(QUALITY).map(([k, v]) => `<button type="button" data-action="quality" data-q="${k}" class="${k === S.quality ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <p class="note">${q.note}</p></div>
    <div class="field"><span class="label">그대로 두는 부분의 텍스처</span>
      <div class="seg flat" role="group">
        <button type="button" data-action="kept-tex" data-size="4096" class="${S.keptTex === 4096 ? 'on' : ''}">4K (선명)</button>
        <button type="button" data-action="kept-tex" data-size="2048" class="${S.keptTex === 2048 ? 'on' : ''}">2K (가벼움)</button>
      </div></div>
    <label class="check"><input type="checkbox" id="photos" ${S.photos ? 'checked' : ''}>
      <span>제품 사진도 같이 저장<small>변형마다 PNG 한 장을 배경 없이, 지금 3D 화면의 각도로 찍어요. 폴더나 ZIP에는 변형 목록(엑셀에서 여는 CSV)도 같이 들어가요.</small></span></label>
    <label class="check"><input type="checkbox" id="compat" ${S.compat ? 'checked' : ''}>
      <span>호환 모드<small>파일이 공간무드나 다른 프로그램에서 안 열릴 때만 켜세요. 용량이 2~3배 커져요.</small></span></label>
    <div class="field"><label for="prefix">파일 이름 앞부분</label><input class="input" id="prefix" value="${esc(S.prefix)}"></div>
    <div class="actions">
      <button class="btn" type="button" data-action="export-folder" ${count ? off : 'disabled'}>폴더에 저장</button>
      <button class="btn ghost" type="button" data-action="export-zip" ${count ? off : 'disabled'}>ZIP으로 받기</button>
      <button class="btn ghost full" type="button" data-action="export-compress" ${off}>재질은 그대로, 압축만 하기</button>
    </div>
    ${S.results.length ? `<div class="files">${S.results.map((r) => `<div class="file-row"><span class="ok">✓</span><span class="fname" title="${esc(r.name)}">${esc(r.name)}</span><span class="fsize">${fmtMB(r.size)}</span></div>`).join('')}</div>
      <p class="note">${esc(S.resultNote)}</p>` : ''}`;
  saveWorkSoon();
}

// ---------- export ----------

function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap((combo) => list.map((x) => [...combo, x])), [[]]);
}

async function writeFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

const SAVE_TYPES = {
  zip: { description: 'ZIP 파일', accept: { 'application/zip': ['.zip'] } },
  glb: { description: 'GLB 3D 모델', accept: { 'model/gltf-binary': ['.glb'] } },
  png: { description: 'PNG 사진', accept: { 'image/png': ['.png'] } },
};

/**
 * Ask where to save BEFORE the long work starts: browsers only open the save dialog right after a click.
 * Returns { dir } | { file } | { download } (plain browser download) | null when the user cancelled.
 * A page opened from a file (double-click) cannot name plain downloads, so the save dialog is preferred.
 */
async function pickTarget(kind, suggestedName) {
  if (window.__testSave) return { test: true };
  try {
    if (kind === 'folder' && window.showDirectoryPicker) return { dir: await window.showDirectoryPicker({ id: 'skin-studio-out', mode: 'readwrite' }) };
    if (window.showSaveFilePicker) {
      const ext = suggestedName.split('.').pop().toLowerCase();
      const types = [SAVE_TYPES[ext] || SAVE_TYPES.glb];
      return { file: await window.showSaveFilePicker({ id: 'skin-studio-out', suggestedName, types }) };
    }
  } catch (e) {
    if (e.name === 'AbortError') return null;
    console.warn(e);
  }
  return { download: true };
}

async function saveTo(target, name, data) {
  if (target.test) return window.__testSave(name, data);
  if (target.file) {
    const w = await target.file.createWritable();
    await w.write(data);
    await w.close();
    return;
  }
  downloadBlob(data instanceof Blob ? data : new Blob([data]), name);
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|#\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/** File name of a variant, e.g. 소파__쿠션-무광-가죽-코냑-8B4A22.glb */
function variantName(base, combo) {
  if (!combo.length) return `${safeName(base)}_압축.glb`;
  const parts = combo.map((c) => {
    const g = S.groups.find((x) => x.key === c.group);
    const size = c.size && g ? sizeLabel(c.size, groupSizeMm(g)) : '';
    return [g?.name, size, c.def?.name, colorLabel(c.color)].filter(Boolean).map(safeName).join('-');
  });
  return `${safeName(base)}__${parts.join('__')}.glb`;
}

async function runExport(kind) {
  if (S.exporting) return;
  if (!S.size.h) { toast('1번에 실제 높이(H)를 넣어 주세요.'); $('#sizeH')?.focus(); return; }
  const compressOnly = kind === 'compress';
  const { active, count } = variantPlan();
  if (!compressOnly && !count) return;
  const q = QUALITY[S.quality];
  const base = S.prefix || S.file.base;
  const groups = compressOnly ? [] : active.map((g) => ({ key: g.key, name: g.name, parts: g.parts }));
  // every combination: one option (a material or the original look, × a size) per group
  const plan = compressOnly ? [[]] : cartesian(active.map((g) => optionsOf(g).map((o) => ({ g, ...o }))));
  const variants = plan.map((combo) => combo.map(({ g, choice, size }) => {
    let def = null; // null keeps the original look (size-only option)
    if (choice) {
      const { builtin: _b, ...rest } = materialById(choice.materialId);
      def = rest;
    }
    return { group: g.key, def, color: choice?.color || null, rotate: g.rotate, size: size ? { w: size.w, d: size.d } : null };
  }));
  const used = new Set();
  const names = variants.map((v) => {
    let n = variantName(base, v);
    for (let i = 2; used.has(n); i++) n = n.replace(/(-\d+)?\.glb$/, `-${i}.glb`);
    used.add(n);
    return n;
  });
  // a product photo per variant and the list of variants come along (not with the plain compressed copy)
  const photoNames = !compressOnly && S.photos ? names.map((n) => n.replace(/\.glb$/, '.png')) : null;
  const single = names.length === 1 && !photoNames;
  const listName = `${safeName(base)}_변형목록.csv`;
  const zipName = `${safeName(base)}_변형${names.length}개.zip`;
  const target = await pickTarget(kind === 'folder' ? 'folder' : 'file', single ? names[0] : zipName);
  if (!target) return;

  S.exporting = true;
  S.results = [];
  S.resultNote = '';
  renderExport();
  const t0 = performance.now();
  const zipFiles = {}, writes = [], made = [];
  const put = (name, bytes) => {
    if (target.dir) writes.push(writeFile(target.dir, name, bytes));
    else zipFiles[name] = bytes;
  };
  let shots = 0;
  try {
    if (photoNames) {
      shots = await takePhotos(plan, async (i, blob) => put(photoNames[i], new Uint8Array(await blob.arrayBuffer())));
    }
    busy('준비 중', 0);
    const textures = {};
    for (const v of variants)
      for (const c of v)
        for (const p of Object.values(c.def?.maps || {}))
          if (!textures[p]) textures[p] = new Uint8Array(await (await getBlob(p)).arrayBuffer());
    const res = await call('export', {
      names, xf: currentXf(), axes: S.axes,
      quality: { simplify: q.simplify, keepSimplify: q.keepSimplify }, keptTextureSize: S.keptTex,
      meshopt: !S.compat, compat: S.compat, groups, variants, textures,
    }, {
      onProgress: (p) => busy(p.text, p.frac),
      onFile: (f) => {
        S.results.push({ name: f.name, size: f.bytes.byteLength });
        made[names.indexOf(f.name)] = { size: f.bytes.byteLength, sizeMm: f.sizeMm };
        renderExport();
        put(f.name, new Uint8Array(f.bytes));
      },
    });
    console.info('내보내기 시간(ms)', JSON.stringify(res.timings));
    if (!single && !compressOnly) put(listName, new TextEncoder().encode(variantCsv(plan, names, photoNames, made)));
    await Promise.all(writes);
    if (!target.dir) {
      busy('파일 저장 중', 1);
      if (single) await saveTo(target, names[0], new Blob([zipFiles[names[0]]], { type: 'model/gltf-binary' }));
      else await saveTo(target, zipName, new Blob([zipSync(zipFiles, { level: 0 })], { type: 'application/zip' }));
    }
    const total = S.results.reduce((a, r) => a + r.size, 0);
    const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
    const where = target.dir ? `‘${target.dir.name}’ 폴더에 저장했어요` : target.file ? `‘${target.file.name}’로 저장했어요` : '다운로드 폴더를 확인하세요';
    const extras = [shots ? `제품 사진 ${shots}장` : '', !single && !compressOnly ? '변형 목록(CSV)' : ''].filter(Boolean).join(', ');
    S.resultNote = `${S.results.length}개 · 모두 ${fmtMB(total)} (원본 ${fmtMB(S.file.size)}) · ${secs}초${extras ? ` · ${extras}도 함께` : ''} · ${where}`;
    toast(where);
  } catch (e) {
    console.error(e);
    toast(`저장하지 못했어요: ${e.message}`, 7000);
  } finally {
    S.exporting = false;
    idle();
    renderExport();
  }
}

/**
 * Product photo of every variant: each combination is put on the 3D view in turn and photographed
 * from the current direction. The panel is locked meanwhile so nothing changes under the camera.
 * Returns how many photos were taken (a failure keeps the GLB export going).
 */
async function takePhotos(plan, onPhoto) {
  const keep = { view: S.view, hover: S.hover, compare: S.compare, picks: S.groups.map((g) => [g, g.active, g.activeSize]) };
  Object.assign(S, { view: 'material', hover: -1, compare: false });
  document.body.classList.add('shooting');
  let n = 0;
  try {
    for (let i = 0; i < plan.length; i++) {
      busy(`제품 사진 찍는 중 ${i + 1}/${plan.length}`, i / plan.length);
      for (const { g, choice, size } of plan[i]) { g.active = choice?.id || null; g.activeSize = size?.id || null; }
      await Promise.all(plan[i].map(({ g }) => updatePreview(g)));
      const blob = await viewer.snapshot(PHOTO);
      if (blob) { await onPhoto(i, blob); n++; }
    }
  } catch (e) {
    console.error(e);
    toast(`제품 사진을 다 찍지 못했어요: ${e.message}`, 6000);
  } finally {
    for (const [g, active, activeSize] of keep.picks) { g.active = active; g.activeSize = activeSize; }
    Object.assign(S, { view: keep.view, hover: keep.hover });
    document.body.classList.remove('shooting');
    await Promise.all(S.groups.map((g) => updatePreview(g)));
    setCompare(keep.compare);
  }
  return n;
}

/** The list of variants for Excel: one row per file with what each group got (UTF-8 with BOM so Excel reads Korean). */
function variantCsv(plan, names, photoNames, made) {
  const groups = plan[0].map(({ g }) => g);
  const head = ['번호', 'GLB 파일', ...(photoNames ? ['사진 파일'] : []), 'W(mm)', 'D(mm)', 'H(mm)'];
  for (const g of groups) head.push(`${g.name} 재질`, `${g.name} 색 이름`, `${g.name} 색 코드`, ...(g.sizes.length ? [`${g.name} 크기(mm)`] : []));
  head.push('용량(MB)');
  const rows = plan.map((combo, i) => {
    const f = made[i];
    const row = [i + 1, names[i], ...(photoNames ? [photoNames[i]] : []), f?.sizeMm?.w ?? '', f?.sizeMm?.d ?? '', f?.sizeMm?.h ?? ''];
    for (const { g, choice, size } of combo) {
      const def = choice ? materialById(choice.materialId) : null;
      const c = choice?.color;
      row.push(def?.name || '원본 그대로', def?.colorMode === 'photo' ? '사진 색' : c?.name && c.name !== c.hex ? c.name : '', c?.hex || '');
      if (g.sizes.length) row.push(size ? sizeLabel(size, groupSizeMm(g)) : '');
    }
    row.push(f ? (f.size / 1048576).toFixed(1) : '');
    return row;
  });
  const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** '사진 저장': the 3D view as it is now (as in 재질 보기), a PNG without background or helper lines. */
async function savePhoto() {
  if (!S.info || S.exporting) return;
  const base = S.prefix || S.file.base;
  const shown = S.groups.filter((g) => g.skinShown).map((g) => {
    const choice = g.choices.find((c) => c.id === g.active);
    return { group: g.key, def: choice ? materialById(choice.materialId) : null, color: choice?.color || null, size: activeSize(g) };
  });
  const name = S.compare ? `${safeName(base)}_원본.png` : shown.length ? variantName(base, shown).replace(/\.glb$/, '.png') : `${safeName(base)}.png`;
  const target = await pickTarget('file', name);
  if (!target) return;
  const keep = { view: S.view, hover: S.hover };
  Object.assign(S, { view: 'material', hover: -1 });
  refreshStyles();
  try {
    await saveTo(target, name, await viewer.snapshot(PHOTO));
    toast(target.file ? `‘${target.file.name}’로 저장했어요.` : '사진을 저장했어요. 다운로드 폴더를 확인하세요.');
  } catch (e) {
    console.error(e);
    toast(`사진을 저장하지 못했어요: ${e.message}`, 6000);
  } finally {
    Object.assign(S, keep);
    refreshStyles();
  }
}

// ---------- photo materials ----------

// editId: the material being edited (null = a new one). legacyOut: its saved textures, when it was
// made before the photo itself was kept; then only size, bump, gloss and name can change.
const photo = {
  bitmap: null, kind: 'marble', colorMode: 'photo', widthCm: 60, overlap: 0.2, flatten: true, bump: 0.2, gloss: 0.85,
  contrast: 1, res: 2048, name: '', size: null, editId: null, legacyOut: null,
};
let photoTimer = 0, photoSeq = 0;
let photoProcessed = null; // last processed preview: bump and gloss changes only re-light it
const EXAMPLE_TINT = { fabric: '#8C8B88', leather: '#8B4A22' };

function resetPhotoSource() {
  photo.bitmap?.close?.();
  Object.assign(photo, { bitmap: null, size: null, legacyOut: null });
  photoProcessed = null;
}

function openPhotoDialog(kind) {
  const k = KINDS[kind] || KINDS.other;
  resetPhotoSource();
  Object.assign(photo, { editId: null, kind, colorMode: k.colorMode, widthCm: k.widthCm, bump: k.bump, gloss: k.gloss, contrast: k.contrast, overlap: 0.2, flatten: true, res: k.colorMode === 'photo' ? 2048 : 1024 });
  photo.name = `${k.label} ${userMaterials.filter((m) => m.kind === kind).length + 1}`;
  showPhotoDialog();
}

/** Open a material made from a photo with the values it was made with. */
async function openEditDialog(id) {
  const def = materialById(id);
  if (!def || def.builtin) return;
  const k = KINDS[def.kind] || KINDS.other;
  const made = def.photo || {}; // the values used to make it (materials from v0.3 on)
  resetPhotoSource();
  Object.assign(photo, {
    editId: id, kind: KINDS[def.kind] ? def.kind : 'other', colorMode: def.colorMode === 'photo' ? 'photo' : 'tint',
    widthCm: def.tileCm, name: def.name,
    bump: made.bump ?? def.normalScale ?? k.bump,
    gloss: made.gloss ?? +Math.min(1, Math.max(0, (0.92 - (def.roughness ?? 0.6)) / 0.8)).toFixed(2),
    contrast: made.contrast ?? k.contrast, overlap: made.overlap ?? 0.2, flatten: made.flatten ?? true,
    res: made.res ?? (def.colorMode === 'photo' ? 2048 : 1024),
  });
  try {
    const src = files.get(`${id}/source.jpg`);
    if (src) {
      photo.bitmap = await createImageBitmap(src);
      photo.size = { w: photo.bitmap.width, h: photo.bitmap.height };
    } else {
      photo.legacyOut = await savedTiles(def);
      photo.size = { w: photo.legacyOut.width, h: photo.legacyOut.height };
    }
  } catch (e) {
    console.error(e);
    toast('저장된 재질 이미지를 읽지 못했어요. 사진을 다시 넣으면 고칠 수 있어요.', 6000);
  }
  showPhotoDialog();
}

/** The saved colour and bump maps of a material, in the form processPhoto returns (for the preview). */
async function savedTiles(def) {
  const canvasOf = async (path) => {
    const bmp = await createImageBitmap(await getBlob(path), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  };
  const [albedo, normal] = await Promise.all([canvasOf(def.maps.baseColor), canvasOf(def.maps.normal)]);
  return { albedo, normal, width: albedo.width, height: albedo.height, albedoMean: def.albedoMean || 1 };
}

function showPhotoDialog() {
  const editing = !!photo.editId;
  $('#photoTitle').textContent = editing ? '재질 수정하기' : '사진으로 재질 만들기';
  $('#photoSave').textContent = editing ? '수정 저장' : '저장하고 쓰기';
  $('#photoSaveCopy').hidden = !editing;
  renderPhotoFields();
  drawPhotoPreview();
  if (!$('#photoDialog').open) $('#photoDialog').showModal();
}

function renderPhotoFields() {
  const editing = !!photo.editId;
  // without the original photo, only what the material itself says can change
  const noPhoto = !photo.bitmap && !!photo.legacyOut;
  const lockKind = editing ? 'disabled' : '', lockPhoto = noPhoto ? 'disabled' : '';
  const kinds = Object.entries(KINDS).map(([k, v]) => `<button type="button" data-action="photo-kind" data-kind="${k}" class="${photo.kind === k ? 'on' : ''}" ${lockKind}>${v.label}</button>`).join('');
  const dims = photo.size ? `사진 비율대로 세로 ${(photo.widthCm * photo.size.h / photo.size.w).toFixed(0)}cm` : '';
  const notes = [
    editing ? '수정할 때는 종류와 색 방식은 바꿀 수 없어요. 다르게 쓰려면 같은 사진으로 새로 만들어 주세요.' : '',
    noPhoto ? '원본 사진을 저장하기 전에 만든 재질이라 크기·요철·광택·이름만 바꿀 수 있어요. 같은 사진을 다시 넣으면 모든 값을 바꿀 수 있어요.' : '',
  ].filter(Boolean);
  $('#photoFields').innerHTML = `
    ${notes.map((n) => `<p class="lock">${n}</p>`).join('')}
    <div class="field"><span class="label">종류</span><div class="seg flat" role="group">${kinds}</div></div>
    <div class="field"><span class="label">색</span>
      <label class="check"><input type="radio" name="pcolor" value="photo" ${photo.colorMode === 'photo' ? 'checked' : ''} ${lockKind}><span>사진 색 그대로<small>대리석·나무처럼 무늬에 색이 있는 재질</small></span></label>
      <label class="check"><input type="radio" name="pcolor" value="tint" ${photo.colorMode === 'tint' ? 'checked' : ''} ${lockKind}><span>질감만 쓰고 색은 hex로<small>거래처 원단·가죽 사진을 여러 색으로 쓸 때</small></span></label></div>
    <div class="field"><label for="pWidth">사진 가로의 실제 크기</label>
      <div class="input-row"><input class="input num" id="pWidth" inputmode="decimal" value="${photo.widthCm}"><span class="unit">cm</span><span class="note">${dims}</span></div></div>
    <div class="field"><label for="pContrast">무늬 진하기</label>
      <div class="range-row"><span class="note">연하게</span><input type="range" id="pContrast" min="0.1" max="1.5" step="0.05" value="${photo.contrast}" ${lockPhoto}><span class="note">진하게</span></div>
      <span class="note">사진 속 얼룩과 명암을 얼마나 살릴지예요. 가죽·원단은 연하게 시작해요.</span></div>
    <div class="field"><label for="pOverlap">이음매 부드럽게</label>
      <div class="range-row"><input type="range" id="pOverlap" min="0" max="0.4" step="0.02" value="${photo.overlap}" ${lockPhoto}><span class="note mono">${Math.round(photo.overlap * 100)}%</span></div></div>
    <label class="check"><input type="checkbox" id="pFlatten" ${photo.flatten ? 'checked' : ''} ${lockPhoto}><span>조명 얼룩 지우기<small>사진 한쪽이 어둡거나 반사가 있을 때</small></span></label>
    <div class="field"><label for="pBump">요철</label>
      <div class="range-row"><span class="note">매끈</span><input type="range" id="pBump" min="0" max="2" step="0.05" value="${photo.bump}"><span class="note">울퉁불퉁</span></div></div>
    <div class="field"><label for="pGloss">광택</label>
      <div class="range-row"><span class="note">무광</span><input type="range" id="pGloss" min="0" max="1" step="0.05" value="${photo.gloss}"><span class="note">유광</span></div></div>
    <div class="field"><span class="label">선명도</span><div class="seg flat" role="group">
      <button type="button" data-action="photo-res" data-res="1024" class="${photo.res === 1024 ? 'on' : ''}" ${lockPhoto}>1K (가벼움)</button>
      <button type="button" data-action="photo-res" data-res="2048" class="${photo.res === 2048 ? 'on' : ''}" ${lockPhoto}>2K (선명)</button></div></div>
    <div class="field"><label for="pName">이름</label><input class="input" id="pName" value="${esc(photo.name)}" maxlength="24"></div>`;
}

function schedulePhotoPreview() {
  clearTimeout(photoTimer);
  photoTimer = setTimeout(drawPhotoPreview, 180);
}

/** 2×2 tiles under a raking light (so bump and gloss show), with a ruler for the real size. */
async function drawPhotoPreview() {
  const canvas = $('#photoCanvas'), g = canvas.getContext('2d');
  const ready = !!(photo.bitmap || photo.legacyOut);
  $('#photoEmpty').hidden = ready;
  $('#photoTools').hidden = !ready;
  $('#photoSave').disabled = !ready;
  $('#photoSaveCopy').disabled = !ready;
  if (!ready) { g.clearRect(0, 0, canvas.width, canvas.height); return; }
  const seq = ++photoSeq;
  let out = photo.legacyOut;
  if (photo.bitmap) {
    const key = JSON.stringify([photo.kind, photo.colorMode, photo.overlap, photo.flatten, photo.contrast]);
    if (photoProcessed?.bitmap !== photo.bitmap || photoProcessed.key !== key) {
      const fresh = await processPhoto(photo.bitmap, photo, 384);
      if (seq !== photoSeq) return;
      photoProcessed = { bitmap: photo.bitmap, key, out: fresh };
    }
    out = photoProcessed.out;
  }
  const tw = out.width, th = out.height;
  const s = Math.min(canvas.width / (2 * tw), canvas.height / (2 * th));
  const w = tw * s, h = th * s, ox = (canvas.width - 2 * w) / 2, oy = (canvas.height - 2 * h) / 2;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const tint = photo.colorMode === 'tint' ? EXAMPLE_TINT[photo.kind] || EXAMPLE_TINT.fabric : null;
  drawLitTiles(g, out, { tint, bump: photo.bump, gloss: photo.gloss }, ox, oy, 2 * w, 2 * h);
  drawRuler(g, rulerFor(w, +photo.widthCm || KINDS[photo.kind].widthCm), ox + 14, oy + 2 * h - 14);
  $('#photoStatus').textContent = photo.colorMode === 'tint' ? '미리보기는 예시 색으로 칠했어요. 실제 색은 hex로 골라요.' : '';
}

function drawRuler(g, r, x, y) {
  const bar = () => { g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x, y); g.lineTo(x + r.px, y); g.lineTo(x + r.px, y - 9); };
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,.45)'; bar(); g.stroke();
  g.lineWidth = 3; g.strokeStyle = '#fff'; bar(); g.stroke();
  g.font = '600 21px system-ui, sans-serif'; g.textBaseline = 'bottom';
  g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.45)'; g.strokeText(`${r.cm}cm`, x + 7, y - 9);
  g.fillStyle = '#fff'; g.fillText(`${r.cm}cm`, x + 7, y - 9);
  g.restore();
}

async function loadPhoto(file) {
  if (!file || !file.type.startsWith('image/')) { toast('사진 파일(JPG, PNG, WebP)을 골라 주세요.'); return; }
  try {
    const bmp = await createImageBitmap(file);
    resetPhotoSource();
    photo.bitmap = bmp;
    photo.size = { w: bmp.width, h: bmp.height };
    renderPhotoFields();
    drawPhotoPreview();
  } catch {
    toast('이 사진은 열 수 없어요. JPG나 PNG로 저장해서 다시 해 보세요.');
  }
}

/** The photo itself, kept with the material so every value can be changed later (≤ 3072 px JPEG). */
async function sourceJpeg(bmp, max = 3072) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

/**
 * Save the dialog as a material. A new one, or (editing) the same material with new values:
 * its variants keep pointing at it and the 3D view updates. asCopy saves an edit as a new material.
 */
async function savePhotoMaterial(asCopy = false) {
  if (!photo.bitmap && !photo.legacyOut) return;
  const before = photo.editId ? materialById(photo.editId) : null;
  const replacing = before && !asCopy ? before : null;
  for (const b of [$('#photoSave'), $('#photoSaveCopy')]) b.disabled = true;
  $('#photoStatus').textContent = replacing ? '재질 고치는 중…' : '재질 만드는 중…';
  try {
    const id = replacing ? replacing.id : uid('photo-');
    const k = KINDS[photo.kind] || KINDS.other;
    const surf = glossToSurface(photo.gloss);
    const widthCm = +photo.widthCm || k.widthCm;
    let blobs, albedoMean, aspect;
    if (photo.bitmap) {
      const out = await processPhoto(photo.bitmap, photo, photo.res);
      blobs = {
        'albedo.webp': await canvasBlob(out.albedo, 'image/webp', 0.92),
        'normal.webp': await canvasBlob(out.normal, 'image/webp', 0.95),
        'orm.webp': await canvasBlob(out.orm, 'image/webp', 0.9),
        'source.jpg': await sourceJpeg(photo.bitmap),
      };
      albedoMean = out.albedoMean;
      aspect = out.height / out.width;
    } else {
      // no original photo: the textures stay, only the material's own values change
      blobs = {};
      for (const n of ['albedo.webp', 'normal.webp', 'orm.webp']) if (files.has(`${before.id}/${n}`)) blobs[n] = files.get(`${before.id}/${n}`);
      albedoMean = before.albedoMean;
      aspect = (before.tileHeightCm || before.tileCm) / before.tileCm;
    }
    let name = photo.name.trim() || k.label;
    if (asCopy && before && name === before.name) name = `${name} 사본`;
    const def = {
      id, name, category: k.category, kind: photo.kind,
      ...(photo.colorMode === 'tint' ? { palette: photo.kind === 'leather' ? 'leather' : 'fabric' } : {}),
      colorMode: photo.colorMode, tileCm: widthCm, tileHeightCm: +(widthCm * aspect).toFixed(2),
      roughness: surf.roughness, metallic: 0, normalScale: +photo.bump.toFixed(2),
      ...(surf.clearcoat ? { clearcoat: surf.clearcoat } : {}),
      ...(k.sheen ? { sheen: { intensity: 0.5, roughness: 0.55 } } : {}),
      maps: { baseColor: `${id}/albedo.webp`, normal: `${id}/normal.webp`, orm: `${id}/orm.webp` },
      albedoMean, source: 'photo', created: replacing?.created || new Date().toISOString().slice(0, 10),
      rev: replacing ? (replacing.rev || 0) + 1 : 0,
      photo: { contrast: photo.contrast, overlap: photo.overlap, flatten: photo.flatten, bump: photo.bump, gloss: photo.gloss, res: photo.res },
    };
    const record = { id, def, files: blobs, thumb: null, created: Date.now() };
    await store.saveMaterial(record);
    if (replacing) {
      forgetSwatches(id);
      forgetTextures(`${id}/`);
    }
    addUserMaterial(record);
    const g = activeGroup();
    if (replacing) {
      for (const x of S.groups) if (x.choices.some((c) => c.materialId === id)) updatePreview(x);
    } else if (g) {
      g.pick = id;
      S.tab = def.category;
      if (def.colorMode === 'photo') { addChoice(g, id, null); updatePreview(g); }
    }
    $('#photoDialog').close();
    if ($('#libraryDialog').open) renderLibrary();
    refreshAll();
    toast(replacing ? `‘${def.name}’ 재질을 고쳤어요. 이 재질을 쓰는 변형에도 바로 반영돼요.`
      : `‘${def.name}’ 재질을 저장했어요.${def.colorMode === 'tint' ? ' 이제 색을 골라 주세요.' : ''}`);
  } catch (e) {
    console.error(e);
    toast(`재질을 ${replacing ? '고치지' : '만들지'} 못했어요: ${e.message}`, 6000);
  } finally {
    for (const b of [$('#photoSave'), $('#photoSaveCopy')]) b.disabled = false;
    $('#photoStatus').textContent = '';
  }
}

function addUserMaterial(record) {
  for (const [name, blob] of Object.entries(record.files)) files.set(`${record.id}/${name}`, blob);
  const i = userMaterials.findIndex((m) => m.id === record.id);
  userMaterials = i < 0 ? [...userMaterials, record.def] : userMaterials.map((m, k) => (k === i ? record.def : m));
}

/** In-page "are you sure?" (the program runs as a local file, so no browser pop-ups). Resolves true on 삭제. */
function confirmBox(title, text, ok = '삭제') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = ok;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

/** Ask, then delete a material made from a photo (and drop the variants that use it). */
async function askDeleteMaterial(id) {
  const m = materialById(id);
  if (!m || m.builtin) return false;
  const used = S.groups.reduce((a, g) => a + g.choices.filter((c) => c.materialId === id).length, 0);
  const ok = await confirmBox(`‘${m.name}’ 재질을 정말 삭제할까요?`,
    `삭제하면 되돌릴 수 없어요.${used ? ` 이 재질로 고른 변형 ${used}개도 함께 빠져요.` : ''} 다른 PC로 옮겨 둔 .zip이 있다면 거기서 다시 가져올 수 있어요.`);
  if (!ok) return false;
  await deleteUserMaterial(id);
  toast(`‘${m.name}’ 재질을 삭제했어요.`);
  return true;
}

async function deleteUserMaterial(id) {
  await store.deleteMaterial(id);
  userMaterials = userMaterials.filter((m) => m.id !== id);
  for (const g of S.groups) {
    const before = g.choices.length;
    g.choices = g.choices.filter((c) => c.materialId !== id);
    if (g.pick === id) g.pick = null;
    if (!g.choices.some((c) => c.id === g.active)) g.active = g.choices[0]?.id || null;
    if (before !== g.choices.length) updatePreview(g);
  }
  forgetSwatches(id);
  forgetTextures(`${id}/`);
  for (const k of [...files.keys()]) if (k.startsWith(`${id}/`)) files.delete(k);
}

// ---------- library dialog ----------

function renderLibrary() {
  const mats = userMaterials;
  $('#libraryBody').innerHTML = `
    <section class="field"><span class="label">사진으로 만든 재질 (${mats.length})</span>
      <div class="lib-list">${mats.map((m) => `<div class="lib-row"><img data-swatch="${esc(m.id)}|${m.colorMode === 'photo' ? '' : NEUTRAL}" alt="">
        <div class="meta"><b>${esc(m.name)}</b><small>${esc(m.category)} · 가로 ${m.tileCm}cm · ${m.colorMode === 'photo' ? '사진 색' : 'hex로 색칠'}</small></div>
        <div class="row-btns"><button class="btn ghost small" type="button" data-action="mat-edit" data-id="${esc(m.id)}">수정</button>
        <button class="btn ghost small danger" type="button" data-action="lib-del-mat" data-id="${esc(m.id)}">삭제</button></div></div>`).join('') || '<p class="empty">아직 없어요. 3번 질감 목록의 ‘사진으로 만들기’로 만들 수 있어요.</p>'}</div></section>
    <section class="field"><span class="label">저장한 색 (${S.colors.length})</span>
      <div class="lib-list">${S.colors.map((c, i) => `<div class="lib-row"><i style="background:${c.hex}"></i>
        <div class="meta"><input class="input" data-color-name="${i}" value="${esc(c.name === c.hex ? '' : c.name)}" placeholder="이름 (예: 코냑)"><small class="mono">${c.hex}</small></div>
        <button class="btn ghost small danger" type="button" data-action="lib-del-color" data-index="${i}">삭제</button></div>`).join('') || '<p class="empty">아직 없어요. 3번에서 hex 코드를 추가하면 여기에 저장돼요.</p>'}</div>
      <div class="input-row"><input class="input" id="newColorName" placeholder="이름 (예: 코냑)"><input class="input mono" id="newColorHex" placeholder="#8B4A22"><button class="btn small" type="button" data-action="lib-add-color">색 추가</button></div>
    </section>`;
  hydrateSwatches($('#libraryBody'));
}

async function saveColors() {
  await store.setKV('colors', S.colors);
}

function rememberColors(hexes) {
  let changed = false;
  for (const hex of hexes) if (!S.colors.some((c) => c.hex === hex)) { S.colors.push({ name: colorName(hex), hex }); changed = true; }
  if (changed) saveColors();
}

// ---------- events ----------

const SHOW_CHOICE = new Set(['mat-pick', 'photo-toggle', 'color-toggle', 'hex-add', 'choice-preview', 'size-add', 'size-add-current', 'size-preview', 'rotate']);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const g = activeGroup();
  // picking a material or a size means wanting to see it, not the original
  if (S.compare && SHOW_CHOICE.has(a)) setCompare(false);
  switch (a) {
    case 'open-file': $('#fileInput').click(); break;
    case 'compare': setCompare(!S.compare); break;
    case 'save-photo': savePhoto(); break;
    case 'work-reset': resetWork(); break;
    case 'open-library': renderLibrary(); $('#libraryDialog').showModal(); break;
    case 'view':
      S.view = t.dataset.view;
      for (const b of document.querySelectorAll('[data-action="view"]')) b.classList.toggle('on', b.dataset.view === S.view);
      refreshStyles();
      break;
    case 'reset-view': viewer.frame(); break;
    case 'dims':
      S.dimsOn = !S.dimsOn;
      t.classList.toggle('on', S.dimsOn);
      t.setAttribute('aria-pressed', S.dimsOn);
      viewer.setDimensionsVisible(S.dimsOn);
      break;
    case 'swap-axes':
      S.axesSwapped = !S.axesSwapped;
      S.axes = swapAxes(S.axes);
      applySize();
      renderInfo();
      renderMaterial();
      renderExport();
      toast('W와 D 방향을 바꿨어요. 3D 화면의 치수선을 확인하세요.');
      break;
    case 'size-add': {
      const input = $('#sizeInput');
      const list = parseSizes(input?.value || '');
      if (!g || !list.length) { toast('1800×900처럼 가로×깊이(mm)로 넣어 주세요. 가로만 넣어도 돼요.'); break; }
      let last = null;
      for (const z of list) {
        const same = g.sizes.find((x) => x.w === z.w && x.d === z.d);
        last = same || { id: uid('z'), ...z };
        if (!same) g.sizes.push(last);
      }
      g.activeSize = last.id;
      updatePreview(g);
      refreshAll();
      break;
    }
    case 'size-add-current': {
      if (!g) break;
      const cur = groupSizeMm(g);
      const z = { id: uid('z'), w: Math.round(cur.w), d: Math.round(cur.d) };
      g.sizes.push(z);
      g.activeSize = z.id;
      updatePreview(g);
      refreshAll();
      break;
    }
    case 'size-preview': if (g) { g.activeSize = g.activeSize === t.dataset.id ? null : t.dataset.id; updatePreview(g); renderMaterial(); } break;
    case 'size-remove':
      e.stopPropagation();
      if (g) {
        g.sizes = g.sizes.filter((z) => z.id !== t.dataset.id);
        if (g.activeSize === t.dataset.id) g.activeSize = null;
        updatePreview(g);
        refreshAll();
      }
      break;
    case 'sizes-clear': if (g) { g.sizes = []; g.activeSize = null; updatePreview(g); refreshAll(); } break;
    case 'group-new': if (S.selection.size) newGroup([...S.selection]); break;
    case 'group-add': addToGroup(t.dataset.key, [...S.selection]); break;
    case 'group-activate': setActive(t.dataset.key); break;
    case 'group-delete': e.stopPropagation(); deleteGroup(t.dataset.key); break;
    case 'select-similar': S.selection = similarParts([...S.selection]); refreshAll(); break;
    case 'select-clear': S.selection.clear(); refreshAll(); break;
    case 'resegment':
      if (!S.groups.length || S.confirmReseg) resegment();
      else { S.confirmReseg = true; renderParts(); }
      break;
    case 'cut-start': if (S.selection.size === 1) startCut([...S.selection][0]); break;
    case 'cut-apply': applyCut(); break;
    case 'cut-cancel': endCut(); renderParts(); break;
    case 'tab': S.tab = t.dataset.tab; renderMaterial(); break;
    case 'mat-pick': {
      if (!g) break;
      const def = materialById(t.dataset.id);
      g.pick = def.id;
      if (def.colorMode === 'photo' && !g.choices.some((c) => c.materialId === def.id)) { addChoice(g, def.id, null); updatePreview(g); }
      else {
        const existing = g.choices.find((c) => c.materialId === def.id);
        if (existing && g.active !== existing.id) { g.active = existing.id; updatePreview(g); }
      }
      refreshAll();
      break;
    }
    case 'photo-toggle': {
      if (!g) break;
      const c = g.choices.find((x) => x.materialId === t.dataset.id);
      if (c) removeChoice(g, c.id);
      else addChoice(g, t.dataset.id, null);
      updatePreview(g);
      refreshAll();
      break;
    }
    case 'color-toggle': {
      if (!g || !g.pick) break;
      const hex = t.dataset.hex;
      const c = g.choices.find((x) => x.materialId === g.pick && x.color?.hex === hex);
      if (c) removeChoice(g, c.id);
      else addChoice(g, g.pick, { name: t.dataset.name || colorName(hex), hex });
      updatePreview(g);
      refreshAll();
      break;
    }
    case 'hex-add': {
      if (!g || !g.pick) break;
      const hexes = parseHexes($('#hexInput').value);
      if (!hexes.length) { toast('hex 코드를 찾지 못했어요. 예: #8B4A22'); break; }
      for (const hex of hexes) addChoice(g, g.pick, { name: colorName(hex), hex });
      rememberColors(hexes);
      updatePreview(g);
      refreshAll();
      toast(`${hexes.length}개 색을 넣었어요.`);
      break;
    }
    case 'choice-preview': if (g) { g.active = t.dataset.id; updatePreview(g); renderMaterial(); } break;
    case 'choice-remove': e.stopPropagation(); if (g) { removeChoice(g, t.dataset.id); updatePreview(g); refreshAll(); } break;
    case 'choices-clear': if (g) { g.choices = []; g.active = null; updatePreview(g); refreshAll(); } break;
    case 'rotate': if (g) { g.rotate = +t.dataset.rot; refreshUVs(); renderMaterial(); } break;
    case 'quality':
      S.quality = t.dataset.q;
      renderExport();
      for (const x of S.groups) updatePreview(x);
      break;
    case 'kept-tex': S.keptTex = +t.dataset.size; renderExport(); break;
    case 'export-folder': runExport('folder'); break;
    case 'export-zip': runExport('zip'); break;
    case 'export-compress': runExport('compress'); break;
    case 'photo-open': openPhotoDialog(t.dataset.kind); break;
    case 'photo-pick': $('#photoInput').click(); break;
    case 'photo-kind': {
      const k = KINDS[t.dataset.kind];
      Object.assign(photo, { kind: t.dataset.kind, colorMode: k.colorMode, widthCm: k.widthCm, bump: k.bump, gloss: k.gloss, contrast: k.contrast });
      if (/^(대리석|나무|원단|가죽|기타) \d+$/.test(photo.name)) photo.name = `${k.label} ${userMaterials.filter((m) => m.kind === t.dataset.kind).length + 1}`;
      renderPhotoFields();
      schedulePhotoPreview();
      break;
    }
    case 'photo-res': photo.res = +t.dataset.res; renderPhotoFields(); break;
    case 'photo-save': savePhotoMaterial(); break;
    case 'photo-save-copy': savePhotoMaterial(true); break;
    case 'mat-edit': e.stopPropagation(); openEditDialog(t.dataset.id); break;
    case 'mat-delete': e.stopPropagation(); if (await askDeleteMaterial(t.dataset.id)) refreshAll(); break;
    case 'lib-del-mat': if (await askDeleteMaterial(t.dataset.id)) { renderLibrary(); refreshAll(); } break;
    case 'lib-del-color': {
      const c = S.colors[+t.dataset.index];
      if (!c || !(await confirmBox(`저장한 색 ‘${c.name && c.name !== c.hex ? `${c.name} ` : ''}${c.hex}’을 정말 삭제할까요?`, '저장한 색 목록에서만 빠져요. 이미 고른 변형은 그대로 남아요.'))) break;
      S.colors.splice(+t.dataset.index, 1);
      await saveColors();
      renderLibrary();
      renderMaterial();
      break;
    }
    case 'lib-add-color': {
      const hex = parseHexes($('#newColorHex').value)[0];
      if (!hex) { toast('hex 코드를 넣어 주세요. 예: #8B4A22'); break; }
      const name = $('#newColorName').value.trim() || hex;
      const i = S.colors.findIndex((c) => c.hex === hex);
      if (i >= 0) S.colors[i].name = name;
      else S.colors.push({ name, hex });
      await saveColors();
      renderLibrary();
      renderMaterial();
      break;
    }
    case 'lib-export': {
      const name = `가구스킨_재질과색_${new Date().toISOString().slice(0, 10)}.zip`;
      const target = await pickTarget('file', name);
      if (!target) break;
      await saveTo(target, name, await store.exportLibrary());
      toast('재질과 색을 .zip 파일로 저장했어요.');
      break;
    }
    case 'lib-import': $('#libInput').click(); break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'sizeW' || t.id === 'sizeD' || t.id === 'sizeH') {
    const v = parseFloat(t.value.replace(/[^0-9.]/g, ''));
    S.size[t.id.slice(-1).toLowerCase()] = v >= 50 ? Math.round(v) : null;
    updateSizeHints();
    clearTimeout(t._t);
    t._t = setTimeout(renderExport, 300);
  } else if (t.id === 'groupName') {
    const g = activeGroup();
    if (g) {
      g.name = t.value.trim() || g.name;
      for (const el of document.querySelectorAll(`.group[data-key="${g.key}"] .name`)) el.firstChild.textContent = `${g.name} `;
      clearTimeout(t._t);
      t._t = setTimeout(() => { renderExport(); renderLegend(); }, 300);
    }
  } else if (t.id === 'prefix') { S.prefix = t.value.trim(); saveWorkSoon(); }
  else if (t.id === 'sensitivity') { S.sensitivity = +t.value; S.confirmReseg = false; }
  else if (t.id === 'cutRange') setCutMm(+t.value, 'range');
  else if (t.id === 'cutMm') { const v = parseFloat(t.value); if (v > 0) { clearTimeout(t._t); t._t = setTimeout(() => setCutMm(v, 'box'), 250); } }
  else if (t.dataset.colorName !== undefined) {
    const c = S.colors[+t.dataset.colorName];
    if (c) { c.name = t.value.trim() || c.hex; clearTimeout(t._t); t._t = setTimeout(() => { saveColors(); renderMaterial(); }, 400); }
  } else if (t.id === 'pWidth') { photo.widthCm = parseFloat(t.value) || photo.widthCm; schedulePhotoPreview(); }
  else if (t.id === 'pOverlap') { photo.overlap = +t.value; t.nextElementSibling.textContent = `${Math.round(photo.overlap * 100)}%`; schedulePhotoPreview(); }
  else if (t.id === 'pContrast') { photo.contrast = +t.value; schedulePhotoPreview(); }
  else if (t.id === 'pBump') { photo.bump = +t.value; schedulePhotoPreview(); }
  else if (t.id === 'pGloss') { photo.gloss = +t.value; schedulePhotoPreview(); }
  else if (t.id === 'pName') photo.name = t.value;
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'fileInput') { openFile(t.files[0]); t.value = ''; }
  else if (t.id === 'sizeW' || t.id === 'sizeD' || t.id === 'sizeH') { applySize(); renderMaterial(); renderExport(); }
  else if (t.id === 'compat') { S.compat = t.checked; saveWorkSoon(); }
  else if (t.id === 'segColor') { S.segColor = t.checked; S.confirmReseg = false; renderParts(); }
  else if (t.id === 'cutMm') setCutMm(parseFloat(t.value), 'change');
  else if (t.id === 'photos') { S.photos = t.checked; store.setKV('prefs', { photos: S.photos }); }
  else if (t.id === 'photoInput') { loadPhoto(t.files[0]); t.value = ''; }
  else if (t.id === 'pFlatten') { photo.flatten = t.checked; schedulePhotoPreview(); }
  else if (t.name === 'pcolor') { photo.colorMode = t.value; schedulePhotoPreview(); }
  else if (t.id === 'pWidth') renderPhotoFields();
  else if (t.id === 'libInput') {
    const f = t.files[0];
    t.value = '';
    if (!f) return;
    store.importLibrary(await f.arrayBuffer()).then(async (r) => {
      for (const m of await store.listMaterials()) addUserMaterial(m);
      S.colors = await store.getKV('colors', []);
      renderLibrary();
      refreshAll();
      toast(`재질 ${r.materials}개, 색 ${r.colors}개${r.works ? `, 모델 작업 기록 ${r.works}개` : ''}를 가져왔어요.`);
    }).catch((err) => toast(`가져오지 못했어요: ${err.message}`, 6000));
  }
});

// the debounced save may not get to run once the window closes
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveWorkNow(); });
window.addEventListener('pagehide', saveWorkNow);

// keep "부분이 잘 안 나뉘었나요?" open while trying several sensitivities ('toggle' does not bubble)
document.addEventListener('toggle', (e) => { if (e.target.matches?.('details.more')) S.moreOpen = e.target.open; }, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]') && S.selection.size) { S.selection.clear(); refreshAll(); }
  if (e.key === 'Enter' && e.target.id === 'hexInput') { e.preventDefault(); $('[data-action="hex-add"]')?.click(); }
  if (e.key === 'Enter' && e.target.id === 'sizeInput') { e.preventDefault(); $('[data-action="size-add"]')?.click(); }
  if (e.key === 'Enter' && /^size[WDH]$/.test(e.target.id)) e.target.blur();
  if (e.key === 'Enter' && e.target.id === 'cutMm') { e.preventDefault(); setCutMm(parseFloat(e.target.value), 'box'); applyCut(); }
});

// drag and drop: GLB anywhere on the page, photos onto the photo dialog
function bindDrop(target, onFile, hoverEl = target) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); hoverEl.classList.add('dragging'); });
  target.addEventListener('dragleave', () => hoverEl.classList.remove('dragging'));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hoverEl.classList.remove('dragging');
    onFile(e.dataTransfer.files[0]);
  });
}
bindDrop(document.body, (f) => { if (!document.querySelector('dialog[open]')) openFile(f); }, $('#drop'));
bindDrop($('#photoDrop'), loadPhoto);

// ---------- start ----------

(async () => {
  $('#version').textContent = VERSION;
  if (embedded && !blocked.reason) {
    const note = document.createElement('p');
    note.className = 'detail';
    note.textContent = '지금은 다른 화면 안에 열려 있어서 저장이 안 될 수 있어요. 파일을 내려받아 더블클릭해서 쓰는 걸 추천해요.';
    $('#drop .drop-card').append(note);
  }
  try {
    S.colors = await store.getKV('colors', []);
    S.photos = (await store.getKV('prefs', {}))?.photos ?? true;
    for (const m of await store.listMaterials()) addUserMaterial(m);
  } catch (e) {
    console.warn('저장된 재질을 읽지 못했어요', e);
  }
  renderInfo();
  refreshAll();
})();

window.__studio = { S, openFile, runExport, viewer, newGroup, addChoice, updatePreview, setActive, call, saveWorkNow, setCompare, refreshAll };
