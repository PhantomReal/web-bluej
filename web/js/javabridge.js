// Verbindung zur Java-Laufzeit: CheerpJ (JVM in WebAssembly) im Browser.
// Zum Entwickeln gibt es zusätzlich ?dev=<URL> (siehe java/dev/DevServer.java).

const CHEERPJ_LOADER = 'https://cjrtnc.leaningtech.com/4.3/loader.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden (Internetverbindung?)'));
    document.head.appendChild(s);
  });
}

export class JavaVM {
  constructor() {
    this.ready = false;
    this.mode = null;
    this._call = null;
    this.javaVersion = '';
  }

  async init(status = () => {}) {
    const dev = new URLSearchParams(location.search).get('dev');
    if (dev) {
      const url = dev === '1' ? 'http://localhost:8099' : dev;
      this._call = async (m, ...a) => {
        const r = await fetch(url, { method: 'POST', body: JSON.stringify({ m, a }) });
        return r.text();
      };
      this.mode = 'dev';
      this.javaVersion = await this._call('version');
      await this._call('setLevel', '16');
      this.ready = true;
      return;
    }
    status('Lade Java-Laufzeit (CheerpJ) …');
    await loadScript(CHEERPJ_LOADER);
    let level = '16';
    try {
      await cheerpjInit({ version: 17 });
    } catch (e) {
      console.warn('Java 17 nicht verfügbar, weiche auf Java 8 aus', e);
      await cheerpjInit({ version: 8 });
      level = '1.8';
    }
    status('Lade Compiler …');
    const base = location.pathname.replace(/[^/]*$/, '');
    const cp = `/app${base}jars/bluejweb.jar:/app${base}jars/ecj.jar`;
    const lib = await cheerpjRunLibrary(cp);
    const Bridge = await lib.bluej.web.Bridge;
    this._call = async (m, ...a) => String(await Bridge[m](...a));
    this.mode = 'cheerpj';
    this.javaVersion = await this._call('version');
    await this._call('setLevel', level);
    this.ready = true;
  }

  async _json(m, ...a) {
    const r = await this._call(m, ...a);
    try { return JSON.parse(r); } catch (e) { return { kind: 'exception', type: 'Bridge', message: String(r) }; }
  }

  /** files: { 'Name.java': 'text' } */
  compile(files) {
    const payload = Object.entries(files).map(([n, t]) => n + '\u0000' + t).join('\u0001');
    return this._json('compile', payload);
  }
  classInfo(name) { return this._json('classInfo', name); }
  create(cls, key, args, name) { return this._json('create', cls, key, JSON.stringify(args), name); }
  callMethod(target, cls, key, args) { return this._json('call', target, cls, key, JSON.stringify(args)); }
  toBench(ref, name) { return this._json('toBench', ref, name); }
  removeObject(name) { return this._call('removeObject', name); }
  clearBench() { return this._call('clearBench'); }
  inspect(ref) { return this._json('inspect', ref); }
  bench() { return this._json('benchJson'); }
  eval(code) { return this._json('eval', code); }
  drain() { return this._call('drain'); }
  feedInput(text) { return this._call('feedInput', text); }
}
