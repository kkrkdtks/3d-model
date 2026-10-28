// 3D view: shows the model, highlights parts under the mouse, picks parts on
// click (GPU id picking, fast even on 2M triangles) and shows re-skinned parts.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const CLICK_SLOP = 5;

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Triangle index reordered so each part's triangles are contiguous; returns index + draw groups. */
function sortByPart(index, faceLabels, partCount) {
  const count = new Uint32Array(partCount + 1);
  for (let f = 0; f < faceLabels.length; f++) count[faceLabels[f] + 1]++;
  for (let p = 0; p < partCount; p++) count[p + 1] += count[p];
  const start = count.slice(0, partCount);
  const fill = start.slice();
  const out = new Uint32Array(faceLabels.length * 3);
  for (let f = 0; f < faceLabels.length; f++) {
    const o = fill[faceLabels[f]]++ * 3;
    out[o] = index[f * 3]; out[o + 1] = index[f * 3 + 1]; out[o + 2] = index[f * 3 + 2];
  }
  const groups = [];
  for (let p = 0; p < partCount; p++) groups.push({ start: start[p] * 3, count: (count[p + 1] - start[p]) * 3, materialIndex: p });
  return { index: out, groups };
}

export class Viewer {
  constructor(host, { onHover = () => {}, onPick = () => {} } = {}) {
    this.host = host;
    this.onHover = onHover;
    this.onPick = onPick;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.toneMapping = THREE.NeutralToneMapping; // keeps hex colours close to what was chosen
    r.toneMappingExposure = 1;
    host.appendChild(r.domElement);
    r.domElement.classList.add('viewport-canvas');

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(1.6, 0.8, 1.6);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.visible = false;
    this.scene.add(this.shadow);

    this.pickScene = new THREE.Scene();
    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);
    this.pickBuf = new Uint8Array(4);
    this.skins = new Map();
    // re-skinned and resized parts, already in the output frame (metres, on the floor)
    this.out = new THREE.Group();
    this.scene.add(this.out);
    // W / D / H dimension lines and their labels
    this.dimGroup = new THREE.Group();
    this.dimGroup.renderOrder = 10;
    this.scene.add(this.dimGroup);
    this.dimLabels = [];
    this.dimsOn = true;
    this.axes = { w: 2, d: 0, front: 1 };
    this.partCount = 0;
    this.dirty = true;

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bindPointer();
    const tick = () => {
      requestAnimationFrame(tick);
      const moved = this.controls.update();
      if (moved || this.dirty) {
        this.dirty = false;
        r.render(this.scene, this.camera);
        this.placeLabels();
        this.frames = (this.frames || 0) + 1;
      }
    };
    tick();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null, raf = 0, last = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > CLICK_SLOP || e.button !== 0) return;
      this.onPick(this.pick(e.clientX, e.clientY), { add: e.shiftKey || e.ctrlKey || e.metaKey });
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const id = this.pick(last.clientX, last.clientY);
        if (id !== this.hoverId) { this.hoverId = id; this.onHover(id, last); }
        else if (id >= 0) this.onHover(id, last, true);
      });
    });
    el.addEventListener('pointerleave', () => { if (this.hoverId !== -1) { this.hoverId = -1; this.onHover(-1, null); } });
  }

  clear() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) {
            if (!m) continue;
            for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'])
              if (m[k] && !m[k].userData.shared) m[k].dispose();
            m.dispose();
          }
        }
      });
    }
    if (this.pickMesh) { this.pickScene.remove(this.pickMesh); this.pickMesh = null; }
    for (const key of [...this.skins.keys()]) this.removeSkin(key);
    this.baseBox = null;
    this.baseBoxKey = '';
    this.clearDimensions();
    this.model = this.base = this.overlay = null;
    this.partCount = 0;
    this.shadow.visible = false;
    this.dirty = true;
  }

  /** Show the original GLB. mainIndexCount picks the mesh the parts belong to. */
  async loadModel(buffer, mainIndexCount) {
    this.clear();
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(buffer, '');
    this.model = gltf.scene;
    const meshes = [];
    this.model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length) throw new Error('이 파일에는 보여줄 메시가 없어요.');
    const count = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count);
    this.base = meshes.find((o) => count(o) === mainIndexCount) || meshes.sort((a, b) => count(b) - count(a))[0];
    this.baseMaterial = this.base.material;
    // triangle order as loaded: every re-split sorts from this, never from an already sorted index
    const g = this.base.geometry;
    this.baseIndex = g.index ? g.index.array.slice() : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    this.framed = false;
    this.clayMaterial = new THREE.MeshStandardMaterial({ color: 0xc9c4bc, roughness: 0.75 });
    this.hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.scene.add(this.model);
    this.model.updateMatrixWorld(true);
    this.frame();
    this.dirty = true;
  }

  /** Which horizontal axis is W and D, and the front side (from core/size furnitureAxes). */
  setAxes(axes) {
    this.axes = axes;
    this.updateDimensions();
  }

  /** Model units -> metres on the floor (core/size outputTransform). Everything shown is then real size. */
  setOutputTransform(xf) {
    if (!this.model) return;
    this.model.scale.fromArray(xf.scale);
    this.model.position.fromArray(xf.offset);
    this.model.updateMatrixWorld(true);
    this.updateDimensions();
    this.dirty = true;
  }

  /** Box (metres) of the original parts still shown; the screen knows which parts are replaced. */
  setBaseBox(b) {
    const key = b ? [...b.min, ...b.max].map((v) => v.toFixed(5)).join(',') : '';
    if (key === this.baseBoxKey) return;
    this.baseBoxKey = key;
    this.baseBox = b ? new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)) : null;
    this.updateDimensions();
  }

  /** Box around everything visible (model + re-skinned parts), in metres. */
  bounds() {
    const box = new THREE.Box3();
    if (this.baseBox) box.union(this.baseBox);
    else if (this.base) box.expandByObject(this.base);
    for (const m of this.out.children) if (m.visible) box.expandByObject(m);
    return box;
  }

  frame() {
    if (!this.model) return;
    const box = this.bounds();
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const f = new THREE.Vector3().setComponent(this.axes.d, this.axes.front);
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), f).normalize();
    const dir = f.multiplyScalar(Math.cos(0.6)).add(side.multiplyScalar(Math.sin(0.6))).normalize();
    dir.y = 0.42;
    dir.normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.placeShadow(box);
    this.framed = true;
    this.dirty = true;
  }

  placeShadow(box = this.bounds()) {
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const foot = Math.max(size.x, size.z) * 1.35;
    this.shadow.scale.set(size.x * 1.25 + foot * 0.1, size.z * 1.25 + foot * 0.1, 1);
    this.shadow.position.set(center.x, box.min.y + 0.0005 * radius, center.z);
    this.shadow.visible = true;
  }

  /** Part data from the worker: welded positions + triangles and a part id per original triangle. */
  setParts(weldedPos, weldedIndex, faceLabels, partCount) {
    const base = this.base;
    this.partCount = partCount;
    // original mesh: triangles grouped by part so parts can be hidden or shown in clay
    const g = base.geometry;
    const sortedBase = sortByPart(this.baseIndex, faceLabels, partCount);
    g.setIndex(new THREE.BufferAttribute(sortedBase.index, 1));
    g.clearGroups();
    for (const gr of sortedBase.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    this.baseMaterials = Array.from({ length: partCount }, () => this.baseMaterial);
    base.material = this.baseMaterials;

    // overlay + picking share one welded geometry
    if (this.overlay) { this.overlay.removeFromParent(); this.overlay.geometry.dispose(); }
    const sorted = sortByPart(weldedIndex, faceLabels, partCount);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(weldedPos, 3));
    geo.setIndex(new THREE.BufferAttribute(sorted.index, 1));
    for (const gr of sorted.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    geo.computeBoundingSphere();
    this.overlayMaterials = Array.from({ length: partCount }, () => new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, visible: false,
    }));
    this.overlay = new THREE.Mesh(geo, this.overlayMaterials);
    this.overlay.renderOrder = 2;
    this.model.add(this.overlay); // welded positions are in scene units, like the model root's children

    const pickMaterials = Array.from({ length: partCount }, (_, i) => {
      const id = i + 1;
      return new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, THREE.LinearSRGBColorSpace), toneMapped: false });
    });
    if (this.pickMesh) this.pickScene.remove(this.pickMesh);
    this.pickMesh = new THREE.Mesh(geo, pickMaterials);
    this.pickMesh.matrixAutoUpdate = false;
    this.pickScene.add(this.pickMesh);
    this.dirty = true;
  }

  /** Id of the part under a screen point, or -1. */
  pick(clientX, clientY) {
    if (!this.pickMesh) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const dpr = this.renderer.getPixelRatio();
    const x = Math.floor((clientX - rect.left) * dpr), y = Math.floor((clientY - rect.top) * dpr);
    const W = Math.floor(rect.width * dpr), H = Math.floor(rect.height * dpr);
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    this.model.updateMatrixWorld();
    this.pickMesh.matrix.copy(this.model.matrixWorld);
    this.pickMesh.matrixWorld.copy(this.model.matrixWorld);
    this.camera.setViewOffset(W, H, x, y, 1, 1);
    const r = this.renderer;
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.pickTarget);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.pickScene, this.camera);
    r.setRenderTarget(null);
    r.toneMapping = prevTone;
    this.camera.clearViewOffset();
    r.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuf);
    const id = this.pickBuf[0] | (this.pickBuf[1] << 8) | (this.pickBuf[2] << 16);
    return id > 0 && id <= this.partCount ? id - 1 : -1;
  }

  /**
   * How each part looks. styles[i] = { base: 'original'|'clay'|'hidden', overlay: null | { color, opacity } }
   */
  setPartStyles(styles) {
    if (!this.base || !this.overlayMaterials) return;
    styles.forEach((s, i) => {
      this.baseMaterials[i] = s.base === 'hidden' ? this.hiddenMaterial : s.base === 'clay' ? this.clayMaterial : this.baseMaterial;
      const m = this.overlayMaterials[i];
      m.visible = !!s.overlay;
      if (s.overlay) { m.color.set(s.overlay.color); m.opacity = s.overlay.opacity; }
    });
    this.dirty = true;
  }

  pickMaterial(id) {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, THREE.LinearSRGBColorSpace), toneMapped: false });
  }

  removeSkin(key) {
    const old = this.skins.get(key);
    if (!old) return;
    this.out.remove(old);
    old.geometry.dispose();
    if (old.userData.ownMaterial) old.material.dispose();
    if (old.userData.pick) { this.pickScene.remove(old.userData.pick); old.userData.pick.material.dispose(); }
    this.skins.delete(key);
    this.updateDimensions();
    this.dirty = true;
  }

  addSkinMesh(key, mesh, pickPart) {
    this.out.add(mesh);
    this.skins.set(key, mesh);
    this.updateDimensions();
    if (pickPart >= 0) {
      // clicks on the re-skinned surface (which may be bigger than the original part) pick its group
      const pick = new THREE.Mesh(mesh.geometry, this.pickMaterial(pickPart + 1));
      this.pickScene.add(pick);
      mesh.userData.pick = pick;
    }
  }

  /**
   * Show (or remove with geo = null) a re-skinned group. geo is in metres in the output frame.
   * pickPart: a part of the group, so clicking the new surface selects the group.
   */
  setSkin(key, geo, material, pickPart = -1) {
    const old = this.skins.get(key);
    if (old && (!geo || old.userData.geo !== geo)) this.removeSkin(key);
    if (!geo) { this.dirty = true; return; }
    let mesh = this.skins.get(key);
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(geo.normal, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.uv.length), 2));
      g.setIndex(new THREE.BufferAttribute(geo.index, 1));
      mesh = new THREE.Mesh(g, material);
      mesh.userData.geo = geo;
      mesh.userData.ownMaterial = true;
      this.addSkinMesh(key, mesh, pickPart);
    }
    if (material && mesh.material !== material) {
      const prev = mesh.material;
      mesh.material = material;
      if (prev && prev !== material) prev.dispose();
    }
    this.dirty = true;
    return mesh;
  }

  /**
   * Original look of some parts, resized: the parts' own triangles and texture, in the output
   * frame, stretched with st (core/size stretchFor). sig identifies the shape so it is rebuilt only when it changes.
   */
  setResizedOriginal(key, parts, stretch, sig, pickPart = -1) {
    const old = this.skins.get(key);
    if (old && old.userData.sig === sig) return old;
    this.removeSkin(key);
    const g = this.base.geometry, idx = g.index.array;
    const ranges = g.groups.filter((gr) => parts.includes(gr.materialIndex));
    const count = ranges.reduce((a, r) => a + r.count, 0);
    const remap = new Int32Array(g.attributes.position.count).fill(-1);
    const index = new Uint32Array(count);
    let n = 0, o = 0;
    for (const r of ranges)
      for (let i = r.start; i < r.start + r.count; i++) {
        const v = idx[i];
        if (remap[v] < 0) remap[v] = n++;
        index[o++] = remap[v];
      }
    this.model.updateMatrixWorld(true);
    const m = this.base.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m);
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    const src = g.attributes, uvSrc = src.uv, U = uvSrc ? new Float32Array(n * 2) : null;
    const v3 = new THREE.Vector3();
    for (let v = 0; v < remap.length; v++) {
      const k = remap[v];
      if (k < 0) continue;
      v3.fromBufferAttribute(src.position, v).applyMatrix4(m);
      P[k * 3] = v3.x; P[k * 3 + 1] = v3.y; P[k * 3 + 2] = v3.z;
      if (src.normal) {
        v3.fromBufferAttribute(src.normal, v).applyMatrix3(nm).normalize();
        N[k * 3] = v3.x; N[k * 3 + 1] = v3.y; N[k * 3 + 2] = v3.z;
      }
      if (U) { U[k * 2] = uvSrc.getX(v); U[k * 2 + 1] = uvSrc.getY(v); }
    }
    stretch(P, src.normal ? N : null);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    if (src.normal) geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    else geo.computeVertexNormals();
    if (U) geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geo, this.baseMaterial.clone()); // own copy so the hover glow stays on this part
    mesh.userData.sig = sig;
    mesh.userData.ownMaterial = true;
    this.addSkinMesh(key, mesh, pickPart);
    this.dirty = true;
    return mesh;
  }

  setSkinUV(key, uv) {
    const mesh = this.skins.get(key);
    if (!mesh) return;
    mesh.geometry.attributes.uv.array.set(uv);
    mesh.geometry.attributes.uv.needsUpdate = true;
    this.dirty = true;
  }

  /** Soft glow on a re-skinned group while the mouse is over it. */
  setSkinHighlight(key, on) {
    const mesh = this.skins.get(key);
    if (!mesh || !mesh.material?.emissive) return;
    const want = on ? 0.07 : 0;
    if (mesh.material.emissive.r !== want) {
      mesh.material.emissive.setRGB(want, want * 0.8, want * 0.6);
      this.dirty = true;
    }
  }

  setSkinVisible(key, visible) {
    const mesh = this.skins.get(key);
    if (mesh && mesh.visible !== visible) {
      mesh.visible = visible;
      if (mesh.userData.pick) mesh.userData.pick.visible = visible;
      this.updateDimensions();
      this.dirty = true;
    }
  }

  // ---------- dimensions ----------

  clearDimensions() {
    for (const c of [...this.dimGroup.children]) { this.dimGroup.remove(c); c.geometry.dispose(); c.material.dispose(); }
    for (const l of this.dimLabels) l.el.remove();
    this.dimLabels = [];
  }

  setDimensionsVisible(on) {
    this.dimsOn = on;
    this.updateDimensions();
  }

  /** W along the front floor edge, D along the right floor edge, H up the back corner, in mm. */
  updateDimensions() {
    this.clearDimensions();
    if (!this.dimsOn || !this.model || !this.base) { this.dirty = true; return; }
    const box = this.bounds();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const { w, d, front } = this.axes;
    const pad = Math.max(size.x, size.z) * 0.06, tick = pad * 0.35;
    const y0 = box.min.y + 0.002;
    const dFront = front > 0 ? box.max.getComponent(d) + pad : box.min.getComponent(d) - pad;
    const dBack = front > 0 ? box.min.getComponent(d) : box.max.getComponent(d);
    const wSide = box.max.getComponent(w) + pad;
    const pt = (wv, y, dv) => new THREE.Vector3().setComponent(w, wv).setComponent(d, dv).setY(y);
    const lines = [
      { a: pt(box.min.getComponent(w), y0, dFront), b: pt(box.max.getComponent(w), y0, dFront), tickDir: pt(0, 0, 1), text: `W ${Math.round(size.getComponent(w) * 1000)}` },
      { a: pt(wSide, y0, box.min.getComponent(d)), b: pt(wSide, y0, box.max.getComponent(d)), tickDir: pt(1, 0, 0), text: `D ${Math.round(size.getComponent(d) * 1000)}` },
      { a: pt(wSide, box.min.y, dBack), b: pt(wSide, box.max.y, dBack), tickDir: pt(1, 0, 0), text: `H ${Math.round(size.y * 1000)}` },
    ];
    const verts = [];
    for (const l of lines) {
      verts.push(...l.a.toArray(), ...l.b.toArray());
      for (const p of [l.a, l.b]) {
        const t = l.tickDir.clone().multiplyScalar(tick);
        verts.push(...p.clone().sub(t).toArray(), ...p.clone().add(t).toArray());
      }
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.textContent = l.text;
      this.host.appendChild(el);
      this.dimLabels.push({ el, at: l.a.clone().add(l.b).multiplyScalar(0.5) });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const color = getComputedStyle(this.host).getPropertyValue('--dim-line').trim() || '#6f665c';
    const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false });
    const seg = new THREE.LineSegments(geo, lineMat);
    seg.renderOrder = 10;
    this.dimGroup.add(seg);
    this.dirty = true;
  }

  placeLabels() {
    if (!this.dimLabels.length) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.dimLabels) {
      v.copy(l.at).project(this.camera);
      const hide = v.z > 1;
      l.el.style.display = hide ? 'none' : '';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  maxAnisotropy() {
    return Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
  }

  /** PNG of the current view (for thumbnails or sharing a look). */
  async snapshot(type = 'image/png') {
    this.renderer.render(this.scene, this.camera);
    return new Promise((res) => this.renderer.domElement.toBlob(res, type));
  }
}
