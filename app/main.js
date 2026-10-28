// 가구 스킨 스튜디오 — screen logic.
// Open a 3DAISTUDIO GLB, click the parts to change, pick textures and hex
// colours, and save one compressed GLB per combination. Runs offline.
import { zipSync } from 'fflate';
import { Viewer } from './viewer.js';
import { forgetSwatches, forgetTextures, makeThreeMaterial, swatch } from './materials.js';
import { canvasBlob, glossToSurface, KINDS, processPhoto } from './photo.js';
import * as store from './store.js';
import { colorLabel, tileUV } from '../core/skin.js';

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
const QUALITY = {
  high: { label: '고품질', simplify: 0.4, keepSimplify: 0.5, note: '아주 가까이 봐도 원본과 같아요. 파일이 조금 커요.' },
  standard: { label: '표준', simplify: 0.25, keepSimplify: 0.35, note: '보통 거리에서는 원본과 구별이 안 돼요. 추천해요.' },
  light: { label: '가볍게', simplify: 0.12, keepSimplify: 0.2, note: '가장 작아요. 아주 가까이 보면 둥근 곳이 조금 단순해져요.' },
};

// ---------- state ----------

const S = {
  file: null, info: null, parts: [], faceLabels: null, welded: null, dims: null, segKey: 0,
  widthMm: null, sensitivity: 105,
  selection: new Set(), groups: [], active: null, view: 'material', hover: -1,
  tab: '가죽', quality: 'standard', keptTex: 4096, compat: false, prefix: '',
  colors: [], results: [], resultNote: '', exporting: false, confirmReseg: false, moreOpen: false,
};
const activeGroup = () => S.groups.find((g) => g.key === S.active) || null;
const groupOfPart = (i) => S.groups.find((g) => g.parts.includes(i)) || null;

// ---------- worker ----------

const worker = new Worker(URL.createObjectURL(new Blob([$('#worker-src').textContent], { type: 'text/javascript' })));
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error, progress, file } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress) { p.onProgress?.(progress); return; }
  if (file) { p.onFile?.(file); return; }
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || '처리 중에 문제가 생겼어요.'));
  pending.clear();
};
function call(cmd, args, opts = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
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

const viewer = new Viewer($('#viewport'), { onHover, onPick });

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
    const skinned = !!(g && g.skinShown);
    let overlay = null;
    if (sel) overlay = { color: SEL_COLOR, opacity: 0.5 };
    else if (hov && !skinned) overlay = { color: '#ffffff', opacity: 0.3 };
    return { base: skinned ? 'hidden' : 'original', overlay };
  });
  viewer.setPartStyles(styles);
  for (const g of S.groups) {
    viewer.setSkinVisible(g.key, S.view === 'material' && g.skinShown);
    viewer.setSkinHighlight(g.key, S.view === 'material' && hoverGroup === g);
  }
  renderLegend();
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
  if (!/\.glb$/i.test(file.name)) { toast('GLB 파일(.glb)만 열 수 있어요.'); return; }
  const tOpen = performance.now();
  busy('파일 읽는 중', 0.02);
  try {
    const buf = await file.arrayBuffer();
    const copy = buf.slice(0);
    const tRead = performance.now();
    const analysis = call('open', { bytes: copy }, { transfer: [copy], onProgress: (p) => busy(p.text, p.frac * 0.85) });
    const res = await analysis;
    const tWork = performance.now();
    busy('화면 준비 중', 0.9);
    const tView = performance.now();
    await viewer.loadModel(buf, res.info.indexCount);
    console.info('열기 시간(ms)', JSON.stringify(res.timings), '화면', Math.round(performance.now() - tView));
    for (const g of S.groups) viewer.setSkin(g.key, null);
    Object.assign(S, {
      file: { name: file.name, size: file.size, base: file.name.replace(/\.glb$/i, '') },
      info: res.info, parts: res.parts, faceLabels: res.faceLabels, welded: res.welded,
      dims: { x: res.info.bbox.max[0] - res.info.bbox.min[0], y: res.info.bbox.max[1] - res.info.bbox.min[1], z: res.info.bbox.max[2] - res.info.bbox.min[2] },
      selection: new Set(), groups: [], active: null, hover: -1, results: [], resultNote: '', segKey: S.segKey + 1, confirmReseg: false,
    });
    S.prefix = S.file.base;
    S.widthMm = await store.getKV(`width:${file.name}`, null);
    previewCache.clear();
    const tParts = performance.now();
    viewer.setParts(res.welded.pos, res.welded.index, res.faceLabels, res.parts.length);
    console.info('열기 단계(ms)', JSON.stringify({ read: Math.round(tRead - tOpen), worker: Math.round(tWork - tRead), view: Math.round(tParts - tWork), parts: Math.round(performance.now() - tParts) }));
    $('#drop').hidden = true;
    $('#stageTools').hidden = false;
    $('#fileMeta').innerHTML = `<b>${esc(file.name)}</b> · ${fmtMB(file.size)}`;
    refreshAll();
    renderInfo();
    toast(`부분 ${res.parts.length}개로 나눴어요. 바꿀 부분을 클릭해 보세요.`);
    console.info('열기 전체(ms)', Math.round(performance.now() - tOpen));
  } catch (e) {
    console.error(e);
    toast(`파일을 열지 못했어요: ${e.message}`, 7000);
  } finally {
    idle();
  }
}

async function resegment() {
  busy('부분 다시 나누는 중', 0.3);
  try {
    const threshold = 165 - S.sensitivity;
    const res = await call('segment', { threshold });
    for (const g of S.groups) viewer.setSkin(g.key, null);
    Object.assign(S, { parts: res.parts, faceLabels: res.faceLabels, selection: new Set(), groups: [], active: null, segKey: S.segKey + 1, confirmReseg: false });
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
  if (minY < b.min[1] + 0.03 * H && area < 8) return '다리';
  if (parts.includes(0)) return '몸체';
  if (maxY > b.max[1] - 0.05 * H && hi[1] - lo[1] < 0.25 * Math.max(sx, sz) && Math.max(sx, sz) > 0.6 * Math.max(S.dims.x, S.dims.z)) return '상판';
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
    choices: [], active: null, rotate: 0, skinShown: false, token: 0, pick: null,
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

const previewCache = new Map();
function previewGeo(g) {
  const q = QUALITY[S.quality];
  const key = `${S.segKey}|${g.parts.join(',')}|${q.simplify}`;
  if (!previewCache.has(key)) previewCache.set(key, call('preview', { parts: g.parts, simplify: q.simplify }));
  return previewCache.get(key);
}
const m2u = () => (S.widthMm || 1800) / 1000 / Math.max(S.dims.x, S.dims.z);
function metresUV(uv) {
  const k = m2u(), out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i++) out[i] = uv[i] * k;
  return out;
}

async function updatePreview(g) {
  const token = ++g.token;
  const choice = g.choices.find((c) => c.id === g.active);
  if (!choice || !S.parts.length) {
    viewer.setSkin(g.key, null);
    g.skinShown = false;
    refreshStyles();
    return;
  }
  const def = materialById(choice.materialId);
  try {
    const [geo, mat] = await Promise.all([previewGeo(g), makeThreeMaterial(def, choice.color, getBlob, viewer.maxAnisotropy())]);
    if (token !== g.token || !S.groups.includes(g)) { mat.dispose(); return; }
    viewer.setSkin(g.key, geo, mat);
    viewer.setSkinUV(g.key, tileUV(metresUV(geo.uv), def, g.rotate));
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
    previewGeo(g).then((geo) => viewer.setSkinUV(g.key, tileUV(metresUV(geo.uv), materialById(choice.materialId), g.rotate)));
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
      <label for="widthMm">실제 가로 길이</label>
      <div class="input-row"><input class="input num" id="widthMm" inputmode="numeric" placeholder="예: 1800" value="${S.widthMm ?? ''}"><span class="unit">mm</span><span class="note" id="dimsNote"></span></div>
      <p class="hint">가죽 결·원단 짜임을 실제 크기로 맞추는 데 써요. 소파는 팔걸이 끝에서 끝까지 재요.</p>
    </div>`;
  updateDims();
}

function updateDims() {
  const el = $('#dimsNote');
  if (!el || !S.dims) return;
  if (!S.widthMm) { el.textContent = ''; return; }
  const k = S.widthMm / Math.max(S.dims.x, S.dims.z);
  el.textContent = `→ 깊이 약 ${fmtInt(Math.min(S.dims.x, S.dims.z) * k)} · 높이 약 ${fmtInt(S.dims.y * k)}mm`;
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
  el.innerHTML = `${head(2, '바꿀 부분')}
    <p class="hint">3D 화면에서 바꿀 부분을 클릭하세요. <b>Shift</b>를 누른 채 클릭하면 여러 개를 고를 수 있어요.</p>
    ${sel.length ? `<div class="selbar"><strong>선택 ${sel.length}개</strong>
      <button class="btn small" type="button" data-action="group-new">새 그룹으로</button>
      ${S.groups.map((g) => `<button class="btn ghost small" type="button" data-action="group-add" data-key="${g.key}">＋ ${esc(g.name)}</button>`).join('')}
      <button class="btn ghost small" type="button" data-action="select-similar">비슷한 부분도</button>
      <button class="btn ghost small" type="button" data-action="select-clear">해제</button></div>` : ''}
    <div class="groups">${S.groups.map((g) => `
      <div class="group ${g.key === S.active ? 'on' : ''}" data-action="group-activate" data-key="${g.key}">
        <span class="dot" style="background:${g.color}"></span>
        <span class="name">${esc(g.name)} <span class="sub">· 부분 ${g.parts.length}개 · 변형 ${g.choices.length}개</span></span>
        <button class="icon-btn" type="button" data-action="group-delete" data-key="${g.key}" title="그룹 지우기" aria-label="${esc(g.name)} 그룹 지우기">×</button>
      </div>`).join('') || '<p class="empty">아직 그룹이 없어요. 부분을 클릭한 뒤 ‘새 그룹으로’를 누르세요.</p>'}</div>
    <details class="more" ${S.confirmReseg || S.moreOpen ? 'open' : ''}><summary>부분이 잘 안 나뉘었나요?</summary>
      <div class="field">
        <label for="sensitivity">경계 민감도</label>
        <div class="range-row"><span class="note">덜 나눔</span><input type="range" id="sensitivity" min="25" max="140" step="5" value="${S.sensitivity}"><span class="note">더 나눔</span></div>
        <button class="btn ghost small" type="button" data-action="resegment">${S.confirmReseg ? '만든 그룹이 지워져요. 다시 나눌까요?' : '이 민감도로 다시 나누기'}</button>
      </div>
    </details>`;
}

function matCard(m, g) {
  const count = g.choices.filter((c) => c.materialId === m.id).length;
  const first = g.choices.find((c) => c.materialId === m.id && c.color);
  const hex = m.colorMode === 'photo' ? '' : first?.color.hex || SWATCH_TINT[m.palette] || NEUTRAL;
  const meta = m.maps ? `결 ${m.tileCm}cm` : m.metallic ? '금속' : (m.roughness ?? 1) < 0.3 ? '광택' : '매트';
  return `<button class="mat ${g.pick === m.id ? 'on' : ''}" type="button" data-action="mat-pick" data-id="${esc(m.id)}" title="${esc(m.name)}">
    <img data-swatch="${esc(m.id)}|${hex}" alt="">
    <span class="cap"><b>${esc(m.name)}</b><small>${meta}</small></span>
    ${m.colorMode === 'photo' ? '<span class="badge">사진 색</span>' : m.source === 'photo' ? '<span class="badge">사진</span>' : ''}
    ${count ? `<span class="count">${count}</span>` : ''}
  </button>`;
}

function colorChip(c, on) {
  const named = c.name && c.name !== c.hex;
  return `<button class="chip ${on ? 'on' : ''}" type="button" data-action="color-toggle" data-hex="${c.hex}" data-name="${esc(named ? c.name : '')}">
    <i style="background:${c.hex}"></i>${named ? `${esc(c.name)} ` : ''}<span class="mono">${c.hex}</span></button>`;
}

function colorArea(m, g) {
  if (m.colorMode === 'photo') {
    const on = g.choices.some((c) => c.materialId === m.id);
    return `<div class="sub-head"><span class="label">${esc(m.name)}</span></div>
      <p class="hint">사진의 색과 무늬를 그대로 써요.</p>
      <div><button class="btn small ${on ? 'ghost' : ''}" type="button" data-action="photo-toggle" data-id="${esc(m.id)}">${on ? '변형에서 빼기' : '변형에 넣기'}</button></div>`;
  }
  const isOn = (hex) => g.choices.some((c) => c.materialId === m.id && c.color?.hex === hex);
  const pal = palettes[m.palette] || [];
  return `<div class="sub-head"><span class="label">${esc(m.name)}의 색 · 여러 개 고를 수 있어요</span>
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
      </div></div>`;
  hydrateSwatches(el);
}

function hydrateSwatches(root) {
  for (const img of root.querySelectorAll('img[data-swatch]')) {
    const [id, hex] = img.dataset.swatch.split('|');
    const def = materialById(id);
    if (!def) continue;
    swatch(def, hex ? { hex } : null, getBlob).then((url) => { img.src = url; }).catch(() => {});
  }
}

function variantPlan() {
  const active = S.groups.filter((g) => g.choices.length);
  const count = active.length ? active.reduce((a, g) => a * g.choices.length, 1) : 0;
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
  const off = S.exporting ? 'disabled' : '';
  el.innerHTML = `${head(4, '내보내기')}
    <div class="summary">${count ? `변형 ${count}개를 만들어요` : '아직 고른 재질이 없어요'}
      <small>${count ? `${active.map((g) => `${esc(g.name)} ${g.choices.length}개`).join(' × ')}${S.groups.length > active.length ? ' · 재질을 안 고른 그룹은 원본 그대로' : ''}` : '재질을 고르면 조합마다 GLB 파일이 하나씩 만들어져요.'}</small></div>
    ${count && !S.widthMm ? '<p class="warn-text">1번에 실제 가로 길이를 넣어야 결 크기가 실제와 맞아요. 지금은 1800mm로 계산해요.</p>' : ''}
    ${count > 40 ? `<p class="warn-text">파일이 ${count}개예요. 시간이 꽤 걸릴 수 있어요.</p>` : ''}
    <div class="field"><span class="label">압축</span>
      <div class="seg flat" role="group">${Object.entries(QUALITY).map(([k, v]) => `<button type="button" data-action="quality" data-q="${k}" class="${k === S.quality ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <p class="note">${q.note}</p></div>
    <div class="field"><span class="label">그대로 두는 부분의 텍스처</span>
      <div class="seg flat" role="group">
        <button type="button" data-action="kept-tex" data-size="4096" class="${S.keptTex === 4096 ? 'on' : ''}">4K (선명)</button>
        <button type="button" data-action="kept-tex" data-size="2048" class="${S.keptTex === 2048 ? 'on' : ''}">2K (가벼움)</button>
      </div></div>
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
      const zip = suggestedName.endsWith('.zip');
      const types = [zip ? { description: 'ZIP 파일', accept: { 'application/zip': ['.zip'] } } : { description: 'GLB 3D 모델', accept: { 'model/gltf-binary': ['.glb'] } }];
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
    return [g?.name, c.def.name, colorLabel(c.color)].filter(Boolean).map(safeName).join('-');
  });
  return `${safeName(base)}__${parts.join('__')}.glb`;
}

async function runExport(kind) {
  if (S.exporting) return;
  const compressOnly = kind === 'compress';
  const { active, count } = variantPlan();
  if (!compressOnly && !count) return;
  const q = QUALITY[S.quality];
  const base = S.prefix || S.file.base;
  const groups = compressOnly ? [] : active.map((g) => ({ key: g.key, name: g.name, parts: g.parts }));
  const variants = compressOnly ? [[]] : cartesian(active.map((g) => g.choices.map((c) => {
    const { builtin: _b, ...def } = materialById(c.materialId);
    return { group: g.key, def, color: c.color, rotate: g.rotate };
  })));
  const used = new Set();
  const names = variants.map((v) => {
    let n = variantName(base, v);
    for (let i = 2; used.has(n); i++) n = n.replace(/(-\d+)?\.glb$/, `-${i}.glb`);
    used.add(n);
    return n;
  });
  const single = names.length === 1;
  const zipName = `${safeName(base)}_변형${names.length}개.zip`;
  const target = await pickTarget(kind === 'folder' ? 'folder' : 'file', single ? names[0] : zipName);
  if (!target) return;

  S.exporting = true;
  S.results = [];
  S.resultNote = '';
  renderExport();
  const t0 = performance.now();
  const zipFiles = {}, writes = [];
  try {
    busy('준비 중', 0);
    const textures = {};
    for (const v of variants)
      for (const c of v)
        for (const p of Object.values(c.def.maps || {}))
          if (!textures[p]) textures[p] = new Uint8Array(await (await getBlob(p)).arrayBuffer());
    const res = await call('export', {
      names, widthMm: S.widthMm || 1800,
      quality: { simplify: q.simplify, keepSimplify: q.keepSimplify }, keptTextureSize: S.keptTex,
      meshopt: !S.compat, compat: S.compat, groups, variants, textures,
    }, {
      onProgress: (p) => busy(p.text, p.frac),
      onFile: (f) => {
        S.results.push({ name: f.name, size: f.bytes.byteLength });
        renderExport();
        if (target.dir) writes.push(writeFile(target.dir, f.name, f.bytes));
        else zipFiles[f.name] = new Uint8Array(f.bytes);
      },
    });
    console.info('내보내기 시간(ms)', JSON.stringify(res.timings));
    await Promise.all(writes);
    if (!target.dir) {
      busy('파일 저장 중', 1);
      if (single) await saveTo(target, names[0], new Blob([zipFiles[names[0]]], { type: 'model/gltf-binary' }));
      else await saveTo(target, zipName, new Blob([zipSync(zipFiles, { level: 0 })], { type: 'application/zip' }));
    }
    const total = S.results.reduce((a, r) => a + r.size, 0);
    const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
    const where = target.dir ? `‘${target.dir.name}’ 폴더에 저장했어요` : target.file ? `‘${target.file.name}’로 저장했어요` : '다운로드 폴더를 확인하세요';
    S.resultNote = `${S.results.length}개 · 모두 ${fmtMB(total)} (원본 ${fmtMB(S.file.size)}) · ${secs}초 · ${where}`;
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

// ---------- photo materials ----------

const photo = { bitmap: null, kind: 'marble', colorMode: 'photo', widthCm: 60, overlap: 0.2, flatten: true, bump: 0.2, gloss: 0.85, res: 2048, name: '', size: null };
let photoTimer = 0;

function openPhotoDialog(kind) {
  const k = KINDS[kind] || KINDS.other;
  Object.assign(photo, { kind, colorMode: k.colorMode, widthCm: k.widthCm, bump: k.bump, gloss: k.gloss, res: k.colorMode === 'photo' ? 2048 : 1024 });
  photo.name = `${k.label} ${userMaterials.filter((m) => m.kind === kind).length + 1}`;
  renderPhotoFields();
  drawPhotoPreview();
  $('#photoDialog').showModal();
}

function renderPhotoFields() {
  const kinds = Object.entries(KINDS).map(([k, v]) => `<button type="button" data-action="photo-kind" data-kind="${k}" class="${photo.kind === k ? 'on' : ''}">${v.label}</button>`).join('');
  const dims = photo.size ? `사진 비율대로 세로 ${(photo.widthCm * photo.size.h / photo.size.w).toFixed(0)}cm` : '';
  $('#photoFields').innerHTML = `
    <div class="field"><span class="label">종류</span><div class="seg flat" role="group">${kinds}</div></div>
    <div class="field"><span class="label">색</span>
      <label class="check"><input type="radio" name="pcolor" value="photo" ${photo.colorMode === 'photo' ? 'checked' : ''}><span>사진 색 그대로<small>대리석·나무처럼 무늬에 색이 있는 재질</small></span></label>
      <label class="check"><input type="radio" name="pcolor" value="tint" ${photo.colorMode === 'tint' ? 'checked' : ''}><span>질감만 쓰고 색은 hex로<small>거래처 원단·가죽 사진을 여러 색으로 쓸 때</small></span></label></div>
    <div class="field"><label for="pWidth">사진 가로의 실제 크기</label>
      <div class="input-row"><input class="input num" id="pWidth" inputmode="decimal" value="${photo.widthCm}"><span class="unit">cm</span><span class="note">${dims}</span></div></div>
    <div class="field"><label for="pOverlap">이음매 부드럽게</label>
      <div class="range-row"><input type="range" id="pOverlap" min="0" max="0.4" step="0.02" value="${photo.overlap}"><span class="note mono">${Math.round(photo.overlap * 100)}%</span></div></div>
    <label class="check"><input type="checkbox" id="pFlatten" ${photo.flatten ? 'checked' : ''}><span>조명 얼룩 지우기<small>사진 한쪽이 어둡거나 반사가 있을 때</small></span></label>
    <div class="field"><label for="pBump">요철</label>
      <div class="range-row"><span class="note">매끈</span><input type="range" id="pBump" min="0" max="2" step="0.05" value="${photo.bump}"><span class="note">울퉁불퉁</span></div></div>
    <div class="field"><label for="pGloss">광택</label>
      <div class="range-row"><span class="note">무광</span><input type="range" id="pGloss" min="0" max="1" step="0.05" value="${photo.gloss}"><span class="note">유광</span></div></div>
    <div class="field"><span class="label">선명도</span><div class="seg flat" role="group">
      <button type="button" data-action="photo-res" data-res="1024" class="${photo.res === 1024 ? 'on' : ''}">1K (가벼움)</button>
      <button type="button" data-action="photo-res" data-res="2048" class="${photo.res === 2048 ? 'on' : ''}">2K (선명)</button></div></div>
    <div class="field"><label for="pName">이름</label><input class="input" id="pName" value="${esc(photo.name)}" maxlength="24"></div>`;
}

function schedulePhotoPreview() {
  clearTimeout(photoTimer);
  photoTimer = setTimeout(drawPhotoPreview, 180);
}

async function drawPhotoPreview() {
  const canvas = $('#photoCanvas'), g = canvas.getContext('2d');
  $('#photoEmpty').hidden = !!photo.bitmap;
  $('#photoSave').disabled = !photo.bitmap;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!photo.bitmap) return;
  const out = await processPhoto(photo.bitmap, photo, 384);
  const tw = out.width, th = out.height;
  const s = Math.min(canvas.width / (2 * tw), canvas.height / (2 * th));
  const w = tw * s, h = th * s, ox = (canvas.width - 2 * w) / 2, oy = (canvas.height - 2 * h) / 2;
  g.imageSmoothingQuality = 'high';
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) g.drawImage(out.albedo, ox + x * w, oy + y * h, w, h);
  if (photo.colorMode === 'tint') {
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = photo.kind === 'fabric' ? '#8C8B88' : '#8B4A22';
    g.fillRect(ox, oy, 2 * w, 2 * h);
    g.globalCompositeOperation = 'source-over';
  }
  $('#photoStatus').textContent = photo.colorMode === 'tint' ? '미리보기는 예시 색으로 칠했어요. 실제 색은 hex로 골라요.' : '';
}

async function loadPhoto(file) {
  if (!file || !file.type.startsWith('image/')) { toast('사진 파일(JPG, PNG, WebP)을 골라 주세요.'); return; }
  try {
    photo.bitmap?.close?.();
    photo.bitmap = await createImageBitmap(file);
    photo.size = { w: photo.bitmap.width, h: photo.bitmap.height };
    renderPhotoFields();
    drawPhotoPreview();
  } catch {
    toast('이 사진은 열 수 없어요. JPG나 PNG로 저장해서 다시 해 보세요.');
  }
}

async function savePhotoMaterial() {
  if (!photo.bitmap) return;
  $('#photoSave').disabled = true;
  $('#photoStatus').textContent = '재질 만드는 중…';
  try {
    const out = await processPhoto(photo.bitmap, photo, photo.res);
    const id = uid('photo-');
    const surf = glossToSurface(photo.gloss);
    const k = KINDS[photo.kind];
    const def = {
      id, name: photo.name.trim() || k.label, category: k.category, kind: photo.kind,
      ...(photo.colorMode === 'tint' ? { palette: photo.kind === 'leather' ? 'leather' : 'fabric' } : {}),
      colorMode: photo.colorMode, tileCm: +photo.widthCm || k.widthCm,
      tileHeightCm: +((+photo.widthCm || k.widthCm) * out.height / out.width).toFixed(2),
      roughness: surf.roughness, metallic: 0, normalScale: +photo.bump.toFixed(2),
      ...(surf.clearcoat ? { clearcoat: surf.clearcoat } : {}),
      ...(k.sheen ? { sheen: { intensity: 0.5, roughness: 0.55 } } : {}),
      maps: { baseColor: `${id}/albedo.webp`, normal: `${id}/normal.webp`, orm: `${id}/orm.webp` },
      albedoMean: out.albedoMean, source: 'photo', created: new Date().toISOString().slice(0, 10),
    };
    const blobs = {
      'albedo.webp': await canvasBlob(out.albedo, 'image/webp', 0.92),
      'normal.webp': await canvasBlob(out.normal, 'image/webp', 0.95),
      'orm.webp': await canvasBlob(out.orm, 'image/webp', 0.9),
    };
    const record = { id, def, files: blobs, thumb: null, created: Date.now() };
    addUserMaterial(record);
    await store.saveMaterial(record);
    const g = activeGroup();
    if (g) {
      g.pick = id;
      S.tab = def.category;
      if (def.colorMode === 'photo') { addChoice(g, id, null); updatePreview(g); }
    }
    $('#photoDialog').close();
    refreshAll();
    toast(`‘${def.name}’ 재질을 저장했어요.${def.colorMode === 'tint' ? ' 이제 색을 골라 주세요.' : ''}`);
  } catch (e) {
    console.error(e);
    toast(`재질을 만들지 못했어요: ${e.message}`, 6000);
  } finally {
    $('#photoSave').disabled = false;
    $('#photoStatus').textContent = '';
  }
}

function addUserMaterial(record) {
  for (const [name, blob] of Object.entries(record.files)) files.set(`${record.id}/${name}`, blob);
  userMaterials = [...userMaterials.filter((m) => m.id !== record.id), record.def];
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
        <button class="btn ghost small danger" type="button" data-action="lib-del-mat" data-id="${esc(m.id)}">지우기</button></div>`).join('') || '<p class="empty">아직 없어요. 3번 질감 목록의 ‘사진으로 만들기’로 만들 수 있어요.</p>'}</div></section>
    <section class="field"><span class="label">저장한 색 (${S.colors.length})</span>
      <div class="lib-list">${S.colors.map((c, i) => `<div class="lib-row"><i style="background:${c.hex}"></i>
        <div class="meta"><input class="input" data-color-name="${i}" value="${esc(c.name === c.hex ? '' : c.name)}" placeholder="이름 (예: 코냑)"><small class="mono">${c.hex}</small></div>
        <button class="btn ghost small danger" type="button" data-action="lib-del-color" data-index="${i}">지우기</button></div>`).join('') || '<p class="empty">아직 없어요. 3번에서 hex 코드를 추가하면 여기에 저장돼요.</p>'}</div>
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

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const g = activeGroup();
  switch (a) {
    case 'open-file': $('#fileInput').click(); break;
    case 'open-library': renderLibrary(); $('#libraryDialog').showModal(); break;
    case 'view':
      S.view = t.dataset.view;
      for (const b of document.querySelectorAll('[data-action="view"]')) b.classList.toggle('on', b.dataset.view === S.view);
      refreshStyles();
      break;
    case 'reset-view': viewer.frame(); break;
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
      Object.assign(photo, { kind: t.dataset.kind, colorMode: k.colorMode, widthCm: k.widthCm, bump: k.bump, gloss: k.gloss });
      if (/^(대리석|나무|원단|가죽|기타) \d+$/.test(photo.name)) photo.name = `${k.label} ${userMaterials.filter((m) => m.kind === t.dataset.kind).length + 1}`;
      renderPhotoFields();
      schedulePhotoPreview();
      break;
    }
    case 'photo-res': photo.res = +t.dataset.res; renderPhotoFields(); break;
    case 'photo-save': savePhotoMaterial(); break;
    case 'lib-del-mat': await deleteUserMaterial(t.dataset.id); renderLibrary(); refreshAll(); break;
    case 'lib-del-color': S.colors.splice(+t.dataset.index, 1); await saveColors(); renderLibrary(); renderMaterial(); break;
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
  if (t.id === 'widthMm') {
    const v = parseFloat(t.value.replace(/[^0-9.]/g, ''));
    S.widthMm = v > 50 ? v : null;
    updateDims();
    refreshUVs();
    if (S.file) store.setKV(`width:${S.file.name}`, S.widthMm);
    clearTimeout(t._t);
    t._t = setTimeout(renderExport, 400);
  } else if (t.id === 'groupName') {
    const g = activeGroup();
    if (g) {
      g.name = t.value.trim() || g.name;
      for (const el of document.querySelectorAll(`.group[data-key="${g.key}"] .name`)) el.firstChild.textContent = `${g.name} `;
      clearTimeout(t._t);
      t._t = setTimeout(() => { renderExport(); renderLegend(); }, 300);
    }
  } else if (t.id === 'prefix') S.prefix = t.value.trim();
  else if (t.id === 'sensitivity') { S.sensitivity = +t.value; S.confirmReseg = false; }
  else if (t.dataset.colorName !== undefined) {
    const c = S.colors[+t.dataset.colorName];
    if (c) { c.name = t.value.trim() || c.hex; clearTimeout(t._t); t._t = setTimeout(() => { saveColors(); renderMaterial(); }, 400); }
  } else if (t.id === 'pWidth') { photo.widthCm = parseFloat(t.value) || photo.widthCm; }
  else if (t.id === 'pOverlap') { photo.overlap = +t.value; t.nextElementSibling.textContent = `${Math.round(photo.overlap * 100)}%`; schedulePhotoPreview(); }
  else if (t.id === 'pBump') photo.bump = +t.value;
  else if (t.id === 'pGloss') photo.gloss = +t.value;
  else if (t.id === 'pName') photo.name = t.value;
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'fileInput') { openFile(t.files[0]); t.value = ''; }
  else if (t.id === 'compat') S.compat = t.checked;
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
      toast(`재질 ${r.materials}개, 색 ${r.colors}개를 가져왔어요.`);
    }).catch((err) => toast(`가져오지 못했어요: ${err.message}`, 6000));
  }
});

// keep "부분이 잘 안 나뉘었나요?" open while trying several sensitivities ('toggle' does not bubble)
document.addEventListener('toggle', (e) => { if (e.target.matches?.('details.more')) S.moreOpen = e.target.open; }, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]') && S.selection.size) { S.selection.clear(); refreshAll(); }
  if (e.key === 'Enter' && e.target.id === 'hexInput') { e.preventDefault(); $('[data-action="hex-add"]')?.click(); }
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
  try {
    S.colors = await store.getKV('colors', []);
    for (const m of await store.listMaterials()) addUserMaterial(m);
  } catch (e) {
    console.warn('저장된 재질을 읽지 못했어요', e);
  }
  renderInfo();
  refreshAll();
})();

window.__studio = { S, openFile, runExport, viewer, newGroup, addChoice, updatePreview, setActive, call };
