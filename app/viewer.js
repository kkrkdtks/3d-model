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
    this.skins.clear();
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
    this.front = null;
    this.clayMaterial = new THREE.MeshStandardMaterial({ color: 0xc9c4bc, roughness: 0.75 });
    this.hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.scene.add(this.model);
    this.model.updateMatrixWorld(true);
    this.frame();
    this.dirty = true;
  }

  /** Front of a sofa/chair = away from the tall backrest. Returns a unit vector in the ground plane. */
  frontDirection(pos) {
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(pos, 3));
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const depthAxis = size.x < size.z ? 0 : 2;
    const yCut = box.max.y - size.y * 0.15;
    let sum = 0, n = 0;
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > yCut) { sum += pos[i + depthAxis]; n++; }
    const offset = n ? sum / n - (depthAxis === 0 ? c.x : c.z) : 0;
    const sign = Math.abs(offset) < size.getComponent(depthAxis) * 0.05 ? 1 : -Math.sign(offset);
    return depthAxis === 0 ? new THREE.Vector3(sign, 0, 0) : new THREE.Vector3(0, 0, sign);
  }

  frame(front = this.front) {
    if (!this.model) return;
    if (front) this.front = front;
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const f = (this.front || new THREE.Vector3(0, 0, 1)).clone();
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
    const foot = Math.max(size.x, size.z) * 1.35;
    this.shadow.scale.set(size.x * 1.25 + foot * 0.1, size.z * 1.25 + foot * 0.1, 1);
    this.shadow.position.set(center.x, box.min.y + 0.0005 * radius, center.z);
    this.shadow.visible = true;
    this.dirty = true;
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
    if (this.overlay) { base.remove(this.overlay); this.overlay.geometry.dispose(); }
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
    base.add(this.overlay);

    const pickMaterials = Array.from({ length: partCount }, (_, i) => {
      const id = i + 1;
      return new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, THREE.LinearSRGBColorSpace), toneMapped: false });
    });
    if (this.pickMesh) this.pickScene.remove(this.pickMesh);
    this.pickMesh = new THREE.Mesh(geo, pickMaterials);
    this.pickMesh.matrixAutoUpdate = false;
    this.pickScene.add(this.pickMesh);
    if (!this.front) this.frame(this.frontDirection(weldedPos)); // keep the user's view when re-splitting
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
    this.base.updateMatrixWorld();
    this.pickMesh.matrix.copy(this.base.matrixWorld);
    this.pickMesh.matrixWorld.copy(this.base.matrixWorld);
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

  /** Show (or remove with geo = null) a re-skinned group. */
  setSkin(key, geo, material) {
    const old = this.skins.get(key);
    if (old && (!geo || old.userData.geo !== geo)) {
      this.base.remove(old);
      old.geometry.dispose();
      this.skins.delete(key);
    }
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
      this.base.add(mesh);
      this.skins.set(key, mesh);
    }
    if (material && mesh.material !== material) {
      const prev = mesh.material;
      mesh.material = material;
      if (prev && prev !== material) prev.dispose();
    }
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
    if (mesh) { mesh.visible = visible; this.dirty = true; }
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
