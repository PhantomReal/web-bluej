// Quelltext-Editor (CodeMirror 5) mit Reitern pro Klasse, Fehleranzeige und Schriftgröße.
import { el } from './dialogs.js';
import { getPref, setPref } from './store.js';

export class EditorPanel {
  /** hooks: { getSource(name), setSource(name, text), onCompile(), onHide(), onActive(name) } */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.docs = new Map(); // name -> CodeMirror.Doc
    this.active = null;
    this.problems = [];
    this.problemIdx = 0;
    this.fontSize = getPref('editorFont', 15);

    this.tabs = el('div', { class: 'ed-tabs' });
    const btn = (label, title, fn, cls = '') => el('button', { class: 'btn small ' + cls, type: 'button', title, onclick: fn, text: label });
    this.compileBtn = btn('Übersetzen', 'Übersetzen (Strg+K)', () => this.hooks.onCompile(), 'primary');
    this.toolbar = el('div', { class: 'ed-toolbar' },
      this.compileBtn,
      btn('↶', 'Rückgängig', () => this.cm.undo()),
      btn('↷', 'Wiederholen', () => this.cm.redo()),
      btn('Suchen', 'Suchen (Strg+F)', () => this.cm.execCommand('findPersistent')),
      btn('?', 'Erklärung zum Wort am Cursor (Java-Lexikon)', () => this.hooks.onHelp(this.wordAtCursor()), 'help'),
      btn('A−', 'Schrift kleiner', () => this.setFont(this.fontSize - 1)),
      btn('A+', 'Schrift größer', () => this.setFont(this.fontSize + 1)),
      el('span', { class: 'spacer' }),
      btn('✕', 'Editor ausblenden', () => this.hooks.onHide(), 'close'));
    this.host = el('div', { class: 'ed-host' });
    this.msg = el('div', { class: 'ed-msg', hidden: true, onclick: () => this.nextProblem() });
    root.append(el('div', { class: 'ed-head' }, this.tabs, this.toolbar), this.host, this.msg);

    this.cm = CodeMirror(this.host, {
      value: '',
      mode: 'text/x-java',
      lineNumbers: true,
      gutters: ['CodeMirror-linenumbers', 'ed-problems'],
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      smartIndent: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      lineWrapping: false,
      spellcheck: false,
      autocorrect: false,
      autocapitalize: false,
      extraKeys: {
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
        'Ctrl-K': () => this.hooks.onCompile(),
        'Cmd-K': () => this.hooks.onCompile(),
      },
    });
    this.setFont(this.fontSize);
    let timer = null;
    this.cm.on('change', () => {
      if (!this.active || this._loading) return;
      clearTimeout(timer);
      const name = this.active;
      this.hooks.onEdit(name);
      timer = setTimeout(() => this.hooks.setSource(name, this.docs.get(name).getValue()), 400);
    });
  }

  wordAtCursor() {
    if (this.cm.somethingSelected()) return this.cm.getSelection().trim();
    const w = this.cm.findWordAt(this.cm.getCursor());
    return this.cm.getRange(w.anchor, w.head).trim();
  }

  insertText(text) {
    this.cm.replaceSelection(text, 'end');
    this.cm.focus();
  }

  setFont(px) {
    this.fontSize = Math.max(10, Math.min(32, px));
    setPref('editorFont', this.fontSize);
    this.host.style.setProperty('--ed-font', this.fontSize + 'px');
    this.cm.refresh();
  }

  _doc(name) {
    let d = this.docs.get(name);
    if (!d) {
      d = CodeMirror.Doc(this.hooks.getSource(name), 'text/x-java');
      this.docs.set(name, d);
    }
    return d;
  }

  open(name, line) {
    this._doc(name);
    this._activate(name);
    if (line) this.goto(line);
    setTimeout(() => this.cm.refresh(), 0);
  }

  _activate(name) {
    this._flush();
    this.active = name;
    this._loading = true;
    this.cm.swapDoc(this.docs.get(name));
    this._loading = false;
    this._renderTabs();
    this._renderProblems();
    this.hooks.onActive && this.hooks.onActive(name);
    this.cm.focus();
  }

  _flush() {
    if (this.active && this.docs.has(this.active)) this.hooks.setSource(this.active, this.docs.get(this.active).getValue());
  }

  _renderTabs() {
    this.tabs.replaceChildren();
    for (const name of this.docs.keys()) {
      const hasErr = this.problems.some((p) => p.file === name + '.java' && p.error);
      const tab = el('div', { class: 'ed-tab' + (name === this.active ? ' active' : '') + (hasErr ? ' err' : '') },
        el('span', { class: 'tab-name', text: name, onclick: () => this._activate(name) }),
        el('span', { class: 'tab-x', text: '×', title: 'Reiter schließen', onclick: (e) => { e.stopPropagation(); this.close(name); } }));
      this.tabs.append(tab);
    }
  }

  close(name) {
    if (!this.docs.has(name)) return;
    if (this.active === name) this._flush();
    const names = [...this.docs.keys()];
    const i = names.indexOf(name);
    this.docs.delete(name);
    if (this.active === name) {
      this.active = null;
      const next = names[i + 1] || names[i - 1];
      if (next) this._activate(next);
      else { this._renderTabs(); this.msg.hidden = true; this.hooks.onHide(); this.hooks.onActive && this.hooks.onActive(null); }
    } else this._renderTabs();
  }

  /** Datei wurde extern verändert (z. B. Umbenennen). */
  reload(name) {
    const d = this.docs.get(name);
    if (!d) return;
    const text = this.hooks.getSource(name);
    if (d.getValue() !== text) {
      this._loading = true;
      d.setValue(text);
      this._loading = false;
    }
  }

  rename(oldName, newName) {
    if (!this.docs.has(oldName)) return;
    const entries = [...this.docs.entries()].map(([k, v]) => [k === oldName ? newName : k, v]);
    this.docs = new Map(entries);
    if (this.active === oldName) this.active = newName;
    this.reloadAll();
    this._renderTabs();
  }

  reloadAll() { for (const n of this.docs.keys()) this.reload(n); }

  hasOpen() { return this.docs.size > 0; }

  goto(line) {
    const l = Math.max(0, line - 1);
    this.cm.setCursor({ line: l, ch: 0 });
    this.cm.scrollIntoView({ line: l, ch: 0 }, 80);
  }

  /** problems: [{file, line, message, error}] */
  setProblems(problems) {
    this.problems = problems;
    this.problemIdx = 0;
    this._renderTabs();
    this._renderProblems();
  }

  _renderProblems() {
    for (const [name, d] of this.docs) {
      d.eachLine((h) => { d.removeLineClass(h, 'background', 'line-error'); d.removeLineClass(h, 'background', 'line-warn'); });
    }
    this.cm.clearGutter('ed-problems');
    const mine = this.problems.filter((p) => p.file === this.active + '.java');
    for (const p of mine) {
      const line = Math.max(0, p.line - 1);
      if (line >= this.cm.lineCount()) continue;
      this.cm.addLineClass(line, 'background', p.error ? 'line-error' : 'line-warn');
      const mark = el('div', { class: 'gutter-mark' + (p.error ? '' : ' warn'), title: p.message, text: p.error ? '●' : '▲' });
      this.cm.setGutterMarker(line, 'ed-problems', mark);
    }
    if (!this.active) { this.msg.hidden = true; return; }
    this.msg.hidden = false;
    if (!this.problems.length) {
      this.msg.className = 'ed-msg ok';
      this.msg.textContent = this.compiledOk ? 'Klasse wurde ohne Fehler übersetzt.' : '';
      this.msg.hidden = !this.compiledOk;
      return;
    }
    const errs = mine.filter((p) => p.error);
    const first = errs[0] || mine[0];
    if (!first) {
      this.msg.className = 'ed-msg warn';
      this.msg.textContent = `Fehler in anderer Klasse: ${this.problems[0].file}:${this.problems[0].line} – ${this.problems[0].message}`;
      return;
    }
    this.msg.className = 'ed-msg ' + (first.error ? 'err' : 'warn');
    this.msg.textContent = `Zeile ${first.line}: ${first.message}` + (mine.length > 1 ? `   (${mine.length} Meldungen, tippen für nächste)` : '');
    this._current = first;
  }

  nextProblem() {
    const mine = this.problems.filter((p) => p.file === this.active + '.java');
    if (!mine.length) {
      const other = this.problems[0];
      if (other) this.open(other.file.replace(/\.java$/, ''), other.line);
      return;
    }
    this.problemIdx = (this.problemIdx + 1) % mine.length;
    const p = mine[this.problemIdx];
    this.goto(p.line);
    this.msg.className = 'ed-msg ' + (p.error ? 'err' : 'warn');
    this.msg.textContent = `Zeile ${p.line}: ${p.message}` + (mine.length > 1 ? `   (${this.problemIdx + 1}/${mine.length})` : '');
  }

  setCompiledOk(v) { this.compiledOk = v; this._renderProblems(); }

  refresh() { this.cm.refresh(); }
}
