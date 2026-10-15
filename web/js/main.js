// Web-BlueJ – Hauptprogramm
import { JavaVM } from './javabridge.js';
import { Diagram } from './diagram.js';
import { EditorPanel } from './editor.js';
import { el, modal, alertBox, confirmBox, promptBox, contextMenu, closeMenus } from './dialogs.js';
import { analyze, classTemplate, isValidClassName, renameInSource } from './parser.js';
import * as store from './store.js';
import { writeZip, readZip } from './zip.js';
import { SAMPLE } from './samples.js';

const $ = (s) => document.querySelector(s);
const vm = new JavaVM();

let project = null;
let compiled = new Set();
let problems = [];
let busy = 0;
let benchItems = []; // {name, class, type}
const infoCache = new Map();
let vmError = null;

// ---------------------------------------------------------------- Hilfen

const className = (file) => file.replace(/\.java$/, '');
const classNames = () => Object.keys(project.files).filter((f) => f.endsWith('.java')).map(className);
const fileOf = (name) => name + '.java';

let toastTimer = null;
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setStatus(text, kind = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = kind;
}

function setBusy(delta) {
  busy += delta;
  $('#busy').hidden = busy <= 0;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveProject(project), 500);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function safeFileName(n) { return n.replace(/[^\wäöüÄÖÜß.-]+/g, '_') || 'projekt'; }

function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

function freeInstanceName(cls) {
  const base = lowerFirst(cls.replace(/\$.*/, ''));
  for (let i = 1; i < 1000; i++) {
    const n = base + i;
    if (!benchItems.some((b) => b.name === n)) return n;
  }
  return base;
}

// -------------------------------------------------------------- Diagramm

const diagram = new Diagram($('#diagram'), {
  onSelect: (n) => { selected = n; },
  onOpen: (n) => openEditor(n),
  onMenu: (n, x, y) => showClassMenu(n, x, y),
  onMoved: (n, x, y) => { project.layout[n] = { x, y }; scheduleSave(); },
});
let selected = null;

function refreshDiagram() {
  const names = classNames();
  const model = names.map((n) => {
    const info = analyze(n, project.files[fileOf(n)], names);
    let pos = project.layout[n];
    if (!pos) {
      pos = diagram.freeSpot();
      project.layout[n] = pos;
      // damit mehrere neue Klassen nicht übereinander landen
      diagram.classes.set(n, { x: pos.x, y: pos.y, el: document.createElement('div'), info: null });
    }
    return { name: n, kind: info.kind, compiled: compiled.has(n), x: pos.x, y: pos.y, extends: info.extends, implements: info.implements, uses: info.uses };
  });
  for (const [n, c] of [...diagram.classes]) if (!c.info && !c.el.isConnected) diagram.classes.delete(n);
  diagram.update(model);
  $('#empty-hint').hidden = names.length > 0;
}

// --------------------------------------------------------------- Projekt

function emptyProject(name) { return { name, files: {}, layout: {}, created: Date.now() }; }

async function useProject(p) {
  if (project) { editor.flushAll && editor.flushAll(); await store.saveProject(project); }
  project = p;
  compiled = new Set();
  problems = [];
  infoCache.clear();
  for (const n of [...editor.docs.keys()]) editor.close(n);
  hideEditor();
  benchItems = [];
  renderBench();
  if (vm.ready) vm.clearBench();
  $('#project-name').textContent = project.name;
  document.title = project.name + ' – Web-BlueJ';
  store.setPref('lastProject', project.name);
  refreshDiagram();
  setStatus('Projekt „' + project.name + '“ geöffnet.');
  await store.saveProject(project);
}

async function newProject() {
  const existing = new Set((await store.listProjects()).map((p) => p.name));
  const name = await promptBox('Neues Projekt', 'Name des Projekts:', suggestName(existing), {
    validate: (v) => (!v ? 'Bitte einen Namen eingeben.' : existing.has(v) ? 'Ein Projekt mit diesem Namen existiert bereits.' : ''),
  });
  if (name) await useProject(emptyProject(name));
}

function suggestName(existing) {
  for (let i = 1; i < 1000; i++) { const n = 'projekt' + i; if (!existing.has(n)) return n; }
  return 'projekt';
}

async function openProjectDialog() {
  const list = (await store.listProjects()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const body = el('div', { class: 'proj-list' });
  let dlg;
  if (!list.length) body.append(el('div', { class: 'msg', text: 'Noch keine Projekte gespeichert.' }));
  for (const p of list) {
    const n = Object.keys(p.files).filter((f) => f.endsWith('.java')).length;
    body.append(el('div', { class: 'proj-row' + (p.name === project.name ? ' current' : '') },
      el('button', { class: 'proj-open', type: 'button', onclick: async () => { dlg.close(); if (p.name !== project.name) await useProject(p); } },
        el('b', { text: p.name }), el('small', { text: ` ${n} Klasse${n === 1 ? '' : 'n'}` + (p.updated ? ' · ' + new Date(p.updated).toLocaleString('de-DE') : '') })),
      el('button', {
        class: 'btn small danger', type: 'button', text: 'Löschen', onclick: async (ev) => {
          if (p.name === project.name) { toast('Das geöffnete Projekt kann nicht gelöscht werden.'); return; }
          if (await confirmBox('Projekt löschen', `„${p.name}“ endgültig löschen?`, 'Löschen')) {
            await store.deleteProject(p.name);
            ev.target.closest('.proj-row').remove();
          }
        },
      })));
  }
  dlg = modal({ title: 'Projekt öffnen', body, buttons: [{ label: 'Schließen', cancel: true }] });
}

async function renameProject() {
  const existing = new Set((await store.listProjects()).map((p) => p.name));
  const name = await promptBox('Projekt umbenennen', 'Neuer Name:', project.name, {
    validate: (v) => (!v ? 'Bitte einen Namen eingeben.' : v !== project.name && existing.has(v) ? 'Name bereits vergeben.' : ''),
  });
  if (!name || name === project.name) return;
  await store.deleteProject(project.name);
  project.name = name;
  await store.saveProject(project);
  store.setPref('lastProject', name);
  $('#project-name').textContent = name;
  document.title = name + ' – Web-BlueJ';
}

function buildPackageBluej() {
  const names = classNames();
  const lines = ['#BlueJ package file', 'package.numDependencies=0', `package.numTargets=${names.length}`, 'package.showExtends=true', 'package.showUses=true', 'project.charset=UTF-8'];
  names.forEach((n, i) => {
    const info = analyze(n, project.files[fileOf(n)], names);
    const pos = project.layout[n] || { x: 20, y: 20 };
    const type = info.kind === 'interface' ? 'InterfaceTarget' : info.kind === 'enum' ? 'EnumTarget' : info.kind === 'abstract' ? 'AbstractTarget' : 'ClassTarget';
    lines.push(`target${i + 1}.height=62`, `target${i + 1}.name=${n}`, `target${i + 1}.showInterface=false`, `target${i + 1}.type=${type}`, `target${i + 1}.width=130`, `target${i + 1}.x=${pos.x}`, `target${i + 1}.y=${pos.y}`);
  });
  return lines.join('\n') + '\n';
}

function exportZip() {
  flushEditors();
  const dir = safeFileName(project.name) + '/';
  const files = {};
  for (const [f, t] of Object.entries(project.files)) files[dir + f] = t;
  files[dir + 'package.bluej'] = buildPackageBluej();
  download(writeZip(files), safeFileName(project.name) + '.zip');
  toast('ZIP-Datei erstellt – direkt in BlueJ öffnen möglich.');
}

function parsePackageBluej(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#=][^=]*)=(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  const layout = {};
  for (const k of Object.keys(kv)) {
    const m = /^target(\d+)\.name$/.exec(k);
    if (m) layout[kv[k]] = { x: parseInt(kv['target' + m[1] + '.x'], 10) || 20, y: parseInt(kv['target' + m[1] + '.y'], 10) || 20 };
  }
  return layout;
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  const javas = files.filter((f) => /\.java$/i.test(f.name));
  const jsons = files.filter((f) => /\.json$/i.test(f.name));
  try {
    for (const z of zips) {
      const entries = await readZip(await z.arrayBuffer());
      const javaPaths = Object.keys(entries).filter((p) => /\.java$/i.test(p));
      if (!javaPaths.length) { toast('Keine .java-Dateien in ' + z.name); continue; }
      const prefixes = javaPaths.map((p) => p.split('/').slice(0, -1).join('/'));
      const common = prefixes.sort((a, b) => a.length - b.length)[0];
      const p = emptyProject(z.name.replace(/\.zip$/i, ''));
      for (const path of javaPaths) {
        if (path.split('/').slice(0, -1).join('/') !== common) continue; // nur Standardpaket
        p.files[path.split('/').pop()] = entries[path];
      }
      const pkgPath = Object.keys(entries).find((x) => /(^|\/)package\.bluej$/.test(x) && x.split('/').slice(0, -1).join('/') === common);
      if (pkgPath) p.layout = parsePackageBluej(entries[pkgPath]);
      const existing = new Set((await store.listProjects()).map((x) => x.name));
      let nm = p.name, i = 2;
      while (existing.has(nm)) nm = p.name + ' (' + i++ + ')';
      p.name = nm;
      await useProject(p);
      toast(`Projekt „${p.name}“ importiert (${Object.keys(p.files).length} Dateien).`);
    }
    for (const j of jsons) {
      const p = JSON.parse(await j.text());
      if (!p || !p.files) throw new Error('Keine Web-BlueJ-Projektdatei');
      const existing = new Set((await store.listProjects()).map((x) => x.name));
      let nm = p.name || 'Import', i = 2;
      while (existing.has(nm)) nm = p.name + ' (' + i++ + ')';
      p.name = nm;
      p.layout = p.layout || {};
      await useProject(p);
    }
    if (javas.length) {
      for (const f of javas) {
        let name = f.name;
        if (project.files[name] && !(await confirmBox('Datei ersetzen', `${name} existiert bereits. Ersetzen?`, 'Ersetzen'))) continue;
        project.files[name] = await f.text();
        compiled.delete(className(name));
        if (editor.docs.has(className(name))) editor.reload(className(name));
      }
      refreshDiagram();
      scheduleSave();
      toast(`${javas.length} Datei(en) hinzugefügt.`);
    }
  } catch (e) {
    alertBox('Import fehlgeschlagen', String(e.message || e));
  }
}

// ----------------------------------------------------------------- Klassen

async function newClassDialog() {
  const names = new Set(classNames());
  const input = el('input', { type: 'text', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
  const err = el('div', { class: 'field-error' });
  const kinds = [['class', 'Klasse'], ['abstract', 'Abstrakte Klasse'], ['interface', 'Interface'], ['enum', 'Enumeration']];
  const radios = kinds.map(([v, l], i) => el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'ckind', value: v, checked: i === 0 }), el('span', { text: l })));
  const body = el('div', {}, el('label', { class: 'field' }, el('span', { text: 'Klassenname:' }), input), err, el('div', { class: 'radios' }, radios));
  modal({
    title: 'Neue Klasse', body, buttons: [
      { label: 'Abbrechen', cancel: true },
      {
        label: 'OK', primary: true, onClick: () => {
          const n = input.value.trim();
          if (!isValidClassName(n)) { err.textContent = 'Kein gültiger Klassenname (Buchstaben, Ziffern, _; nicht mit Ziffer beginnen).'; return false; }
          if (names.has(n)) { err.textContent = 'Diese Klasse gibt es schon.'; return false; }
          const kind = body.querySelector('input[name=ckind]:checked').value;
          addClass(n, kind);
        },
      },
    ],
  });
}

function addClass(name, kind) {
  project.files[fileOf(name)] = classTemplate(name, kind);
  project.layout[name] = diagram.freeSpot();
  compiled.delete(name);
  refreshDiagram();
  scheduleSave();
  diagram.select(name);
  setStatus('Klasse ' + name + ' angelegt.');
}

async function removeClass(name) {
  if (!(await confirmBox('Klasse entfernen', `Klasse „${name}“ und ihre Datei ${fileOf(name)} wirklich entfernen?`, 'Entfernen'))) return;
  delete project.files[fileOf(name)];
  delete project.layout[name];
  compiled.delete(name);
  editor.close(name);
  if (selected === name) diagram.select(null);
  refreshDiagram();
  scheduleSave();
}

async function renameClass(name) {
  const names = classNames();
  const nn = await promptBox('Klasse umbenennen', 'Neuer Name:', name, {
    validate: (v) => (!isValidClassName(v) ? 'Kein gültiger Klassenname.' : v !== name && names.includes(v) ? 'Name bereits vergeben.' : ''),
  });
  if (!nn || nn === name) return;
  flushEditors();
  const files = {};
  for (const [f, t] of Object.entries(project.files)) {
    const n = className(f);
    files[n === name ? fileOf(nn) : f] = renameInSource(t, name, nn);
  }
  project.files = files;
  project.layout[nn] = project.layout[name];
  delete project.layout[name];
  compiled = new Set();
  editor.rename(name, nn);
  editor.reloadAll();
  refreshDiagram();
  scheduleSave();
  toast('Umbenannt. Bitte neu übersetzen.');
}

// ------------------------------------------------------------------ Editor

const editor = new EditorPanel($('#editor'), {
  getSource: (n) => project.files[fileOf(n)] || '',
  setSource: (n, t) => {
    if (project && fileOf(n) in project.files && project.files[fileOf(n)] !== t) {
      project.files[fileOf(n)] = t;
      scheduleSave();
      refreshDiagram();
    }
  },
  onEdit: (n) => {
    if (compiled.delete(n)) refreshDiagram();
  },
  onCompile: () => compileAll(),
  onHide: () => hideEditor(),
  onActive: () => {},
});

function flushEditors() {
  for (const [n, d] of editor.docs) project.files[fileOf(n)] = d.getValue();
}
editor.flushAll = flushEditors;

function openEditor(name, line) {
  document.body.classList.add('editor-open');
  $('#editor').hidden = false;
  editor.open(name, line);
  setTimeout(() => { editor.refresh(); }, 50);
}

function hideEditor() {
  document.body.classList.remove('editor-open');
  $('#editor').hidden = true;
}

// ---------------------------------------------------------------- Übersetzen

let compiling = null;

async function ensureVM() {
  if (vm.ready) return true;
  if (vmError) {
    toast('Java-Laufzeit nicht verfügbar: ' + vmError);
    return false;
  }
  setStatus('Warte auf Java-Laufzeit …');
  try { await vmStarting; } catch (e) { return false; }
  return vm.ready;
}

async function compileAll() {
  if (compiling) return compiling;
  compiling = (async () => {
    flushEditors();
    scheduleSave();
    if (!classNames().length) { setStatus('Keine Klassen zum Übersetzen.'); return; }
    if (!(await ensureVM())) return;
    setBusy(1);
    setStatus('Übersetze …');
    try {
      const res = await vm.compile(project.files);
      if (res.internal) { await alertBox('Interner Compiler-Fehler', res.internal, { mono: true }); return; }
      problems = res.problems || [];
      const failed = new Set((res.failed || []).map(className));
      compiled = new Set(classNames().filter((n) => !failed.has(n)));
      infoCache.clear();
      benchItems = [];
      renderBench();
      refreshDiagram();
      editor.setProblems(problems);
      const errs = problems.filter((p) => p.error);
      if (errs.length) {
        setStatus(`${errs.length} Fehler in ${failed.size} Klasse${failed.size === 1 ? '' : 'n'} – ${errs[0].file}:${errs[0].line}: ${errs[0].message}`, 'err');
        const f = className(errs[0].file);
        if (!editor.docs.has(f) || !document.body.classList.contains('editor-open')) openEditor(f, errs[0].line);
        else editor.open(f, errs[0].line);
      } else {
        setStatus('Alle Klassen wurden erfolgreich übersetzt.', 'ok');
        editor.setCompiledOk(true);
      }
    } catch (e) {
      setStatus('Übersetzen fehlgeschlagen: ' + (e.message || e), 'err');
    } finally {
      setBusy(-1);
    }
  })();
  try { await compiling; } finally { compiling = null; }
}

// ---------------------------------------------------- Methoden & Konstruktoren

async function getInfo(name) {
  if (infoCache.has(name)) return infoCache.get(name);
  const info = await vm.classInfo(name);
  if (!info.error) infoCache.set(name, info);
  return info;
}

const sigOf = (m) => `${m.ret ? m.ret + ' ' : ''}${m.name}(${m.params.map((p) => p.type + ' ' + p.name).join(', ')})`;

function methodItems(info, { target, includeStatic = true, instance = true }) {
  const items = [];
  const own = info.methods.filter((m) => m.declaring === info.name);
  const mk = (m) => ({
    label: (m.static ? 'static ' : '') + sigOf(m),
    onClick: () => invokeMethod(info, m, target),
  });
  const sel = (list) => list.filter((m) => (m.static ? includeStatic : instance));
  items.push(...sel(own).sort((a, b) => a.name.localeCompare(b.name)).map(mk));
  const groups = new Map();
  for (const m of info.methods) {
    if (m.declaring === info.name) continue;
    if (!sel([m]).length) continue;
    if (!groups.has(m.declaring)) groups.set(m.declaring, []);
    groups.get(m.declaring).push(m);
  }
  for (const [decl, list] of groups) {
    if (items.length) items.push({ sep: false, label: '' });
    items.pop();
    items.push({
      label: 'Geerbt von ' + decl.replace(/^java\.lang\./, ''),
      submenu: list.sort((a, b) => a.name.localeCompare(b.name)).map(mk),
    });
  }
  return items;
}

async function showClassMenu(name, x, y) {
  const isCompiled = compiled.has(name);
  const items = [];
  if (isCompiled) {
    if (!vm.ready) {
      items.push({ header: 'Java-Laufzeit lädt …' });
    } else {
      const info = await getInfo(name);
      if (info.error) items.push({ header: 'Fehler: ' + info.error });
      else {
        for (const c of info.ctors) {
          items.push({ label: `new ${name}(${c.params.map((p) => p.type + ' ' + p.name).join(', ')})`, onClick: () => invokeConstructor(info, c) });
        }
        if (info.ctors.length) items.push({ sep: true });
        const statics = methodItems(info, { target: '', includeStatic: true, instance: false }).filter((i) => !i.submenu);
        if (statics.length) { items.push(...statics); items.push({ sep: true }); }
      }
    }
  } else {
    items.push({ header: 'Noch nicht übersetzt' });
  }
  items.push(
    { label: 'Quelltext bearbeiten', onClick: () => openEditor(name) },
    { label: 'Übersetzen', onClick: () => compileAll() },
    { sep: true },
    { label: 'Umbenennen …', onClick: () => renameClass(name) },
    { label: 'Entfernen', onClick: () => removeClass(name) },
  );
  contextMenu(x, y, items);
}

function paramDialog({ title, signature, params, instanceName, onOk }) {
  const inputs = [];
  const err = el('div', { class: 'field-error' });
  const rows = [];
  let nameInput = null;
  if (instanceName !== undefined) {
    nameInput = el('input', { type: 'text', value: instanceName, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
    rows.push(el('label', { class: 'field' }, el('span', { text: 'Name der Instanz:' }), nameInput));
  }
  const listId = 'dl' + Math.random().toString(36).slice(2);
  const dl = el('datalist', { id: listId }, benchItems.map((b) => el('option', { value: b.name })));
  for (const p of params) {
    const inp = el('input', {
      type: 'text', list: listId, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      placeholder: placeholderFor(p.type),
    });
    inputs.push(inp);
    rows.push(el('label', { class: 'field' }, el('span', { class: 'mono', text: `${p.type} ${p.name}` }), inp));
  }
  const body = el('div', {}, el('div', { class: 'mono sig', text: signature }), ...rows, dl, err);
  modal({
    title, body, buttons: [
      { label: 'Abbrechen', cancel: true },
      {
        label: 'OK', primary: true, onClick: async () => {
          let n;
          if (nameInput) {
            n = nameInput.value.trim();
            if (!isValidClassName(n)) { err.textContent = 'Ungültiger Instanzname.'; return false; }
            if (benchItems.some((b) => b.name === n)) { err.textContent = 'Name wird schon verwendet.'; return false; }
          }
          const vals = inputs.map((i) => i.value);
          if (vals.some((v) => !v.trim())) { err.textContent = 'Bitte alle Parameter ausfüllen.'; return false; }
          onOk(vals, n);
        },
      },
    ],
  });
}

function placeholderFor(type) {
  if (type === 'String') return '"Text"';
  if (type === 'char') return "'a'";
  if (type === 'boolean') return 'true / false';
  if (type.endsWith('[]')) return '{ … }';
  return '';
}

function invokeConstructor(info, c) {
  const run = async (vals, instName) => {
    setBusy(1);
    try {
      const r = await vm.create(info.name, c.key, vals, instName);
      await afterCall(r);
    } finally { setBusy(-1); }
  };
  const name = freeInstanceName(info.name);
  if (!c.params.length) {
    run([], name);
    return;
  }
  paramDialog({
    title: 'Konstruktor aufrufen',
    signature: `new ${info.name}(${c.params.map((p) => p.type + ' ' + p.name).join(', ')})`,
    params: c.params,
    instanceName: name,
    onOk: run,
  });
}

function invokeMethod(info, m, target) {
  const run = async (vals) => {
    setBusy(1);
    try {
      const r = await vm.callMethod(target, info.name, m.key, vals);
      await afterCall(r, m);
    } finally { setBusy(-1); }
  };
  if (!m.params.length) { run([]); return; }
  paramDialog({ title: 'Methode aufrufen', signature: sigOf(m), params: m.params, onOk: run });
}

async function afterCall(r, method) {
  await refreshBench();
  pollTerminal();
  if (r.kind === 'created' || r.kind === 'void') return;
  if (r.kind === 'exception') { showException(r); return; }
  if (r.kind === 'value') {
    showResult(method, r);
    return;
  }
  if (r.kind === 'object') showResult(method, r);
}

function showException(r) {
  const body = el('div', {}, el('div', { class: 'exc-type', text: r.type }), el('div', { class: 'msg', text: r.message || '' }),
    el('details', {}, el('summary', { text: 'Stack-Trace' }), el('pre', { class: 'mono pre small', text: r.trace || '' })));
  modal({ title: 'Ausnahme (Exception)', body, className: 'danger', buttons: [{ label: 'OK', primary: true }] });
  showTerminal(true);
}

function showResult(method, r) {
  const rows = [];
  rows.push(el('div', { class: 'mono sig', text: method ? sigOf(method) : '' }));
  const buttons = [{ label: 'OK', primary: true }];
  if (r.kind === 'value') {
    rows.push(el('div', { class: 'result-line' }, el('span', { class: 'rtype', text: r.type + ' ' }), el('b', { class: 'mono', text: r.text })));
  } else {
    rows.push(el('div', { class: 'result-line' }, el('span', { class: 'rtype', text: 'Objekt vom Typ ' }), el('b', { class: 'mono', text: r.type })));
    rows.push(el('div', { class: 'mono small muted', text: r.text }));
    buttons.unshift(
      { label: 'Inspizieren', onClick: () => { inspectRef(r.ref, r.type); return false; } },
      { label: 'Auf Bench holen', onClick: async () => { await getToBench(r.ref, r.type); } },
    );
  }
  modal({ title: 'Methodenergebnis', body: el('div', {}, ...rows), buttons });
}

async function getToBench(ref, type) {
  const name = await promptBox('Auf Objekt-Bench holen', 'Name der Instanz:', freeInstanceName(type), {
    validate: (v) => (!isValidClassName(v) ? 'Ungültiger Name.' : benchItems.some((b) => b.name === v) ? 'Name wird schon verwendet.' : ''),
  });
  if (!name) return;
  await vm.toBench(ref, name);
  await refreshBench();
}

// -------------------------------------------------------------- Objekt-Bench

async function refreshBench() {
  if (!vm.ready) return;
  try { benchItems = await vm.bench(); } catch (e) { benchItems = []; }
  renderBench();
}

function renderBench() {
  const host = $('#bench-items');
  host.replaceChildren();
  for (const b of benchItems) {
    const item = el('button', { class: 'bench-obj', type: 'button' },
      el('span', { class: 'bo-name', text: b.name + ':' }), el('span', { class: 'bo-type', text: b.type }));
    item.addEventListener('click', (ev) => { ev.stopPropagation(); showObjectMenu(b, item.getBoundingClientRect()); });
    item.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showObjectMenu(b, item.getBoundingClientRect()); });
    host.append(item);
  }
  $('#bench-hint').hidden = benchItems.length > 0;
  $('#bench-clear').disabled = benchItems.length === 0;
}

async function showObjectMenu(b, rect) {
  const info = await getInfo(b.class);
  const items = [];
  if (info.error) items.push({ header: info.error });
  else items.push(...methodItems(info, { target: b.name, includeStatic: true, instance: true }));
  items.push({ sep: true }, { label: 'Inspizieren', onClick: () => inspectRef(b.name, b.type) },
    { label: 'Entfernen', onClick: async () => { await vm.removeObject(b.name); await refreshBench(); } });
  contextMenu(rect.left, Math.max(8, rect.top - 8 - Math.min(items.length * 40, rect.top - 16)), items);
}

async function inspectRef(ref, typeLabel) {
  const data = await vm.inspect(ref);
  if (data.error) { alertBox('Inspektor', data.error); return; }
  const body = el('div', { class: 'inspector' });
  const instanceFields = data.fields.filter((f) => !f.static);
  const staticFields = data.fields.filter((f) => f.static);
  const table = (fields, title) => {
    const t = el('table', { class: 'fields' });
    if (title) t.append(el('caption', { text: title }));
    if (!fields.length) t.append(el('tr', {}, el('td', { class: 'muted', text: data.array ? '(leeres Array)' : '(keine Felder)' })));
    for (const f of fields) {
      const act = [];
      if (f.ref) {
        act.push(el('button', { class: 'btn small', type: 'button', text: 'Inspizieren', onclick: () => inspectRef(f.ref, f.type) }));
        act.push(el('button', { class: 'btn small', type: 'button', text: 'Holen', onclick: () => getToBench(f.ref, f.type) }));
      }
      t.append(el('tr', {}, el('td', { class: 'mono ftype', text: f.type }), el('td', { class: 'mono fname', text: f.name }),
        el('td', { class: 'mono fval', text: f.text }), el('td', { class: 'fact' }, act)));
    }
    return t;
  };
  body.append(el('div', { class: 'insp-string mono small muted', text: 'toString(): ' + data.string }), table(instanceFields, data.array ? 'Elemente' : ''));
  if (staticFields.length) body.append(table(staticFields, 'Statische Felder'));
  modal({ title: `Inspektor – ${typeLabel || data.type}`, body, className: 'wide', buttons: [{ label: 'Schließen', primary: true }] });
}

// ----------------------------------------------------------------- Terminal

let termVisible = false;
function showTerminal(v) {
  termVisible = v;
  $('#terminal').hidden = !v;
  $('#btn-terminal').classList.toggle('active', v);
  if (v) setTimeout(() => $('#term-input').focus({ preventScroll: true }), 50);
}

function termAppend(text, err) {
  const out = $('#term-out');
  const span = el('span', { class: err ? 'err' : '', text });
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

let polling = false;
async function pollTerminal() {
  if (polling || !vm.ready) return;
  polling = true;
  try {
    const s = await vm.drain();
    if (s) {
      if (!termVisible) showTerminal(true);
      let err = false, buf = '';
      for (const ch of s) {
        if (ch === '\u0001' || ch === '\u0002') {
          if (buf) termAppend(buf, err);
          buf = '';
          err = ch === '\u0002';
        } else buf += ch;
      }
      if (buf) termAppend(buf, err);
    }
  } catch (e) { /* VM noch nicht bereit */ } finally { polling = false; }
}
setInterval(pollTerminal, 400);

$('#term-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const inp = $('#term-input');
  const line = inp.value;
  inp.value = '';
  termAppend(line + '\n', false);
  if (vm.ready) await vm.feedInput(line + '\n');
});
$('#term-clear').addEventListener('click', () => { $('#term-out').replaceChildren(); });
$('#term-close').addEventListener('click', () => showTerminal(false));

// ------------------------------------------------------------------ Codepad

const cpHistory = [];
let cpIdx = 0;

function cpAppend(node) {
  const out = $('#cp-out');
  out.append(node);
  out.scrollTop = out.scrollHeight;
}

async function codepadRun(code) {
  cpAppend(el('div', { class: 'cp-in', text: code }));
  if (!(await ensureVM())) { cpAppend(el('div', { class: 'cp-err', text: 'Java-Laufzeit nicht verfügbar.' })); return; }
  setBusy(1);
  try {
    const r = await vm.eval(code);
    if (r.kind === 'value') cpAppend(el('div', { class: 'cp-val', text: r.text + '   (' + r.type + ')' }));
    else if (r.kind === 'created') cpAppend(el('div', { class: 'cp-val', text: r.name + ' auf Bench gelegt  (' + r.type + ')' }));
    else if (r.kind === 'object') {
      cpAppend(el('div', { class: 'cp-val' }, r.text + '  ', el('button', { class: 'btn small', type: 'button', text: 'Inspizieren', onclick: () => inspectRef(r.ref, r.type) })));
    } else if (r.kind === 'error') cpAppend(el('div', { class: 'cp-err', text: r.message }));
    else if (r.kind === 'exception') cpAppend(el('div', { class: 'cp-err', text: r.type + (r.message ? ': ' + r.message : '') }));
    await refreshBench();
    pollTerminal();
  } finally { setBusy(-1); }
}

$('#cp-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const inp = $('#cp-input');
  const code = inp.value.trim();
  if (!code) return;
  cpHistory.push(code);
  cpIdx = cpHistory.length;
  inp.value = '';
  codepadRun(code);
});
$('#cp-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#cp-form').requestSubmit(); }
  else if (ev.key === 'ArrowUp' && cpIdx > 0) { ev.preventDefault(); $('#cp-input').value = cpHistory[--cpIdx]; }
  else if (ev.key === 'ArrowDown' && cpIdx < cpHistory.length) { ev.preventDefault(); $('#cp-input').value = cpHistory[++cpIdx] || ''; }
});

function showCodepad(v) {
  document.body.classList.toggle('codepad-open', v);
  $('#btn-codepad').classList.toggle('active', v);
  if (v) setTimeout(() => $('#cp-input').focus({ preventScroll: true }), 50);
}

// ----------------------------------------------------------------- Menüleiste

function menu(label, anchor, items) {
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, items);
}

const filePicker = $('#file-picker');
filePicker.addEventListener('change', async () => { await importFiles(filePicker.files); filePicker.value = ''; });

const menus = {
  projekt: () => [
    { label: 'Neues Projekt …', onClick: newProject },
    { label: 'Projekt öffnen …', onClick: openProjectDialog },
    { label: 'Beispielprojekt laden', onClick: loadSample },
    { sep: true },
    { label: 'Projekt umbenennen …', onClick: renameProject },
    { label: 'Als ZIP exportieren (BlueJ-kompatibel)', onClick: exportZip },
    { label: 'Als Web-BlueJ-Datei sichern (.json)', onClick: exportJson },
    { label: 'Importieren (ZIP / .java / .json) …', onClick: () => filePicker.click() },
  ],
  bearbeiten: () => [
    { label: 'Neue Klasse …', onClick: newClassDialog },
    { label: 'Klasse aus Datei hinzufügen …', onClick: () => filePicker.click() },
    { sep: true },
    { label: 'Ausgewählte Klasse bearbeiten', disabled: !selected, onClick: () => openEditor(selected) },
    { label: 'Ausgewählte Klasse entfernen', disabled: !selected, onClick: () => removeClass(selected) },
  ],
  werkzeuge: () => [
    { label: 'Alles übersetzen', onClick: compileAll },
    { label: 'Objekt-Bench leeren', onClick: clearBench },
    { sep: true },
    { label: termVisible ? 'Terminal ausblenden' : 'Terminal anzeigen', onClick: () => showTerminal(!termVisible) },
    { label: document.body.classList.contains('codepad-open') ? 'Codepad ausblenden' : 'Codepad anzeigen', onClick: () => showCodepad(!document.body.classList.contains('codepad-open')) },
  ],
  ansicht: () => [
    { label: diagram.showUses ? '✓ „Benutzt“-Pfeile anzeigen' : '„Benutzt“-Pfeile anzeigen', onClick: () => { diagram.setShowUses(!diagram.showUses); store.setPref('showUses', diagram.showUses); } },
    { label: 'Editor-Schrift größer', onClick: () => editor.setFont(editor.fontSize + 1) },
    { label: 'Editor-Schrift kleiner', onClick: () => editor.setFont(editor.fontSize - 1) },
  ],
  hilfe: () => [
    { label: 'Über Web-BlueJ', onClick: about },
    { label: 'Bedienung auf dem iPad', onClick: helpTouch },
  ],
};

for (const btn of document.querySelectorAll('[data-menu]')) {
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); menu(btn.dataset.menu, btn, menus[btn.dataset.menu]()); });
}

async function clearBench() {
  if (vm.ready) await vm.clearBench();
  benchItems = [];
  renderBench();
}

function exportJson() {
  flushEditors();
  download(new Blob([JSON.stringify({ name: project.name, files: project.files, layout: project.layout }, null, 2)], { type: 'application/json' }), safeFileName(project.name) + '.webbluej.json');
}

async function loadSample() {
  const existing = new Set((await store.listProjects()).map((p) => p.name));
  const p = JSON.parse(JSON.stringify(SAMPLE));
  let n = p.name, i = 2;
  while (existing.has(n)) n = p.name + ' ' + i++;
  p.name = n;
  await useProject(p);
}

function about() {
  modal({
    title: 'Über Web-BlueJ',
    body: el('div', { class: 'msg' },
      el('p', { text: 'Web-BlueJ ist eine eigenständige, im Browser laufende Nachbildung der Bedienung von BlueJ – gedacht zum Lernen und Üben, zum Beispiel auf dem iPad. Java wird direkt im Browser übersetzt und ausgeführt (CheerpJ + Eclipse-Compiler); es gibt keinen Server.' }),
      el('p', { text: 'BlueJ ist ein Projekt von Michael Kölling, John Rosenberg und dem King’s College London. Web-BlueJ ist nicht mit dem BlueJ-Projekt verbunden und ersetzt es nicht.' }),
      el('p', { class: 'muted', text: 'Laufzeit: ' + (vm.ready ? vm.javaVersion + ' (' + vm.mode + ')' : vmError ? 'Fehler: ' + vmError : 'wird geladen …') }),
      el('p', { class: 'muted', text: 'Nicht enthalten: Debugger (Haltepunkte), JUnit-Tests, Pakete, Swing/JavaFX-Fenster.' })),
    buttons: [{ label: 'OK', primary: true }],
  });
}

function helpTouch() {
  modal({
    title: 'Bedienung auf dem iPad',
    body: el('div', { class: 'msg' },
      el('ul', {},
        el('li', { text: 'Klasse antippen = auswählen, zweimal antippen = Quelltext öffnen.' }),
        el('li', { text: 'Klasse lange drücken (oder Rechtsklick) = Menü: Objekt erzeugen, statische Methoden, Bearbeiten …' }),
        el('li', { text: 'Klassen lassen sich mit dem Finger verschieben.' }),
        el('li', { text: 'Rotes Objekt auf der Bench antippen = Methoden aufrufen, Inspizieren, Entfernen.' }),
        el('li', { text: 'Codepad: Java-Ausdrücke direkt auswerten, z. B. „person1.getAge() * 2“.' }),
        el('li', { text: 'Tipp: Seite zum Home-Bildschirm hinzufügen (Teilen → „Zum Home-Bildschirm“) für Vollbild.' }))),
    buttons: [{ label: 'OK', primary: true }],
  });
}

$('#btn-new-class').addEventListener('click', newClassDialog);
$('#btn-compile').addEventListener('click', compileAll);
$('#btn-codepad').addEventListener('click', () => showCodepad(!document.body.classList.contains('codepad-open')));
$('#btn-terminal').addEventListener('click', () => showTerminal(!termVisible));
$('#bench-clear').addEventListener('click', clearBench);
$('#btn-editor').addEventListener('click', () => {
  if (selected) openEditor(selected);
  else if (editor.hasOpen()) { document.body.classList.add('editor-open'); $('#editor').hidden = false; editor.refresh(); } else toast('Erst eine Klasse auswählen.');
});
$('#project-name').addEventListener('click', renameProject);
$('#vm-retry').addEventListener('click', () => location.reload());

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); compileAll(); }
  else if (ev.key === 'Escape') closeMenus();
});

// Dateien per Drag & Drop
document.addEventListener('dragover', (ev) => ev.preventDefault());
document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer && ev.dataTransfer.files.length) importFiles(ev.dataTransfer.files);
});

window.addEventListener('beforeunload', () => { if (project) { flushEditors(); store.saveProject(project); } });
window.addEventListener('pagehide', () => { if (project) { flushEditors(); store.saveProject(project); } });
window.addEventListener('resize', () => editor.refresh());

// ----------------------------------------------------------------------- Start

let vmStarting = null;

function startVM() {
  const bar = $('#vm-status');
  bar.hidden = false;
  $('#vm-retry').hidden = true;
  vmStarting = vm.init((t) => { $('#vm-text').textContent = t; })
    .then(() => {
      bar.hidden = true;
      refreshBench();
      setStatus('Java-Laufzeit bereit (' + vm.javaVersion + ').');
    })
    .catch((e) => {
      vmError = e.message || String(e);
      $('#vm-text').textContent = 'Java-Laufzeit konnte nicht geladen werden: ' + vmError;
      bar.classList.add('error');
      $('#vm-retry').hidden = false;
      throw e;
    });
  vmStarting.catch(() => {});
}

async function boot() {
  diagram.setShowUses(store.getPref('showUses', true));
  startVM();
  const last = store.getPref('lastProject', null);
  let p = last ? await store.loadProject(last) : null;
  if (!p) {
    const all = await store.listProjects();
    p = all.sort((a, b) => (b.updated || 0) - (a.updated || 0))[0] || emptyProject('projekt1');
  }
  project = null;
  await useProject(p);
}

boot();
