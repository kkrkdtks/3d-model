// Saved things that belong to this PC: materials made from photos (IndexedDB,
// because they hold image files) and saved colours / settings (small JSON).
// Everything can be exported to one .zip and imported on another PC.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const DB_NAME = 'furniture-skin-studio';
let dbPromise = null;
const memory = { materials: new Map(), kv: new Map() };

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('materials', { keyPath: 'id' });
          req.result.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** User materials: { id, def, files: { 'albedo.webp': Blob, ... }, thumb: Blob, created } */
export async function listMaterials() {
  return tx('materials', 'readonly', (s) => (s ? req(s.getAll()) : [...memory.materials.values()]));
}

export async function saveMaterial(m) {
  return tx('materials', 'readwrite', (s) => (s ? req(s.put(m)) : memory.materials.set(m.id, m)));
}

export async function deleteMaterial(id) {
  return tx('materials', 'readwrite', (s) => (s ? req(s.delete(id)) : memory.materials.delete(id)));
}

export async function getKV(key, fallback) {
  const v = await tx('kv', 'readonly', (s) => (s ? req(s.get(key)) : memory.kv.get(key)));
  return v === undefined ? fallback : v;
}

export async function setKV(key, value) {
  return tx('kv', 'readwrite', (s) => (s ? req(s.put(value, key)) : memory.kv.set(key, value)));
}

/** One .zip with the user's materials (same layout as the repo's materials/ folder) and saved colours. */
export async function exportLibrary() {
  const mats = await listMaterials();
  const colors = await getKV('colors', []);
  const files = {};
  const library = { version: 1, materials: [], colors };
  for (const m of mats) {
    library.materials.push(m.def);
    for (const [name, blob] of Object.entries(m.files)) files[`${m.id}/${name}`] = new Uint8Array(await blob.arrayBuffer());
    if (m.thumb) files[`${m.id}/thumb.png`] = new Uint8Array(await m.thumb.arrayBuffer());
  }
  files['library.json'] = strToU8(JSON.stringify(library, null, 2));
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

/** Merge a library .zip into this PC. Returns counts. */
export async function importLibrary(bytes) {
  const files = unzipSync(new Uint8Array(bytes));
  const lib = JSON.parse(strFromU8(files['library.json']));
  let added = 0;
  for (const def of lib.materials || []) {
    const own = {};
    for (const [path, data] of Object.entries(files))
      if (path.startsWith(`${def.id}/`) && path !== `${def.id}/thumb.png`) own[path.slice(def.id.length + 1)] = new Blob([data], { type: path.endsWith('.png') ? 'image/png' : 'image/webp' });
    const thumbData = files[`${def.id}/thumb.png`];
    await saveMaterial({ id: def.id, def, files: own, thumb: thumbData ? new Blob([thumbData], { type: 'image/png' }) : null, created: Date.now() });
    added++;
  }
  const have = await getKV('colors', []);
  const known = new Set(have.map((c) => c.hex));
  const newColors = (lib.colors || []).filter((c) => !known.has(c.hex));
  await setKV('colors', [...have, ...newColors]);
  return { materials: added, colors: newColors.length };
}
