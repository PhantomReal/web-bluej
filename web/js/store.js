// Projekt-Speicher im Browser (IndexedDB, Fallback localStorage).
const DB = 'webbluej';
const STORE = 'projects';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no idb'));
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'name' });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  }));
}

const LS = 'webbluej:project:';
function lsAll() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith(LS)) out.push(JSON.parse(localStorage.getItem(k)));
  }
  return out;
}

export async function listProjects() {
  try { return (await tx('readonly', (s) => s.getAll())) || []; } catch (e) { return lsAll(); }
}
export async function saveProject(p) {
  p.updated = Date.now();
  try { await tx('readwrite', (s) => s.put(p)); } catch (e) { localStorage.setItem(LS + p.name, JSON.stringify(p)); }
}
export async function loadProject(name) {
  try { return (await tx('readonly', (s) => s.get(name))) || null; } catch (e) {
    const v = localStorage.getItem(LS + name);
    return v ? JSON.parse(v) : null;
  }
}
export async function deleteProject(name) {
  try { await tx('readwrite', (s) => s.delete(name)); } catch (e) { localStorage.removeItem(LS + name); }
}
export function getPref(k, d) { try { const v = localStorage.getItem('webbluej:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
export function setPref(k, v) { try { localStorage.setItem('webbluej:' + k, JSON.stringify(v)); } catch (e) { /* ignorieren */ } }
