// Render GLB files the way a placement viewer would (three.js, RoomEnvironment light, no app
// involved), each scaled to the same height, from the same cameras: a whole view and close-ups.
// usage: node dev/inspect/render.cjs OUTDIR a.glb b.glb ...   -> OUTDIR/<i>_<view>.png + sheet.png
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const [OUT, ...FILES] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const W = +(process.env.RW || 900), H = +(process.env.RH || 600);
// [name, camera offset from target (in model heights), target (fraction of the box, 0..1 per axis), fov]
const VIEWS = JSON.parse(process.env.VIEWS || JSON.stringify([
  ['whole', [1.2, 0.7, 2.6], [0.5, 0.45, 0.5], 30],
  ['seat', [0.25, 0.35, 0.55], [0.5, 0.42, 0.6], 30],
  ['arm', [0.35, 0.2, 0.45], [0.95, 0.4, 0.55], 30],
]));
(async () => {
  const bundle = path.join(OUT, '_viewer.js');
  require('esbuild').buildSync({
    stdin: { contents: `
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
      import { MeshoptDecoder } from 'meshoptimizer';
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      r.setSize(${W}, ${H}); r.toneMapping = THREE.ACESFilmicToneMapping; document.body.appendChild(r.domElement);
      const pm = new THREE.PMREMGenerator(r);
      const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      let scene;
      window.load = async (url) => {
        const buf = await (await fetch(url)).arrayBuffer();
        const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, '');
        scene = new THREE.Scene(); scene.background = new THREE.Color('#f2f0ec'); scene.environment = env;
        const box0 = new THREE.Box3().setFromObject(gltf.scene), s = 1 / (box0.max.y - box0.min.y);
        gltf.scene.scale.setScalar(s); gltf.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        gltf.scene.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
        scene.add(gltf.scene);
        const sun = new THREE.DirectionalLight('#ffffff', 1.5); sun.position.set(1, 3, 2); scene.add(sun);
        window.box = new THREE.Box3().setFromObject(gltf.scene);
        return true;
      };
      window.shoot = (off, tf, fov) => {
        const b = window.box, t = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * tf[0], b.min.y + (b.max.y - b.min.y) * tf[1], b.min.z + (b.max.z - b.min.z) * tf[2]);
        const cam = new THREE.PerspectiveCamera(fov, ${W} / ${H}, 0.01, 100);
        cam.position.set(t.x + off[0], t.y + off[1], t.z + off[2]); cam.lookAt(t);
        r.render(scene, cam);
        return r.domElement.toDataURL('image/png');
      };` , resolveDir: path.resolve(__dirname, '../..'), loader: 'js' },
    bundle: true, format: 'iife', outfile: bundle, logLevel: 'error',
  });
  fs.writeFileSync(path.join(OUT, '_view.html'), '<!doctype html><body style="margin:0"><script src="_viewer.js"></script></body>');
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
  const p = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  const files = {};
  await p.route('http://render.local/**', (route) => {
    const n = route.request().url().split('/').pop();
    const f = n === 'v.html' ? path.join(OUT, '_view.html') : n === '_viewer.js' ? bundle : files[n];
    route.fulfill({ body: fs.readFileSync(f), contentType: n.endsWith('.html') ? 'text/html' : n.endsWith('.js') ? 'text/javascript' : 'model/gltf-binary' });
  });
  await p.goto('http://render.local/v.html');
  const rows = [];
  for (const [i, f] of FILES.entries()) {
    files[`in${i}.glb`] = path.resolve(f);
    await p.evaluate((u) => window.load(u), `http://render.local/in${i}.glb`);
    const row = [];
    for (const [name, off, tf, fov] of VIEWS) {
      const url = await p.evaluate(({ off, tf, fov }) => window.shoot(off, tf, fov), { off, tf, fov });
      const out = path.join(OUT, `${i}_${name}.png`);
      fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
      row.push(out);
    }
    rows.push(row);
    console.log(`${i}: ${path.basename(f)}`);
  }
  await b.close();
  const comp = [];
  rows.forEach((row, i) => row.forEach((f, j) => comp.push({ input: f, top: i * H, left: j * W })));
  await sharp({ create: { width: W * VIEWS.length, height: H * rows.length, channels: 3, background: '#ffffff' } }).composite(comp).png().toFile(path.join(OUT, 'sheet.png'));
})();
