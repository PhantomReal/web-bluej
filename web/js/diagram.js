// Klassendiagramm: verschiebbare Klassenkästen mit Pfeilen (Vererbung, Implementierung, Benutzt).

const SVGNS = 'http://www.w3.org/2000/svg';
const BOX_W = 130;
const BOX_H = 62;

export class Diagram {
  /**
   * handlers: { onSelect(name), onOpen(name), onMenu(name, x, y), onMoved(name, x, y), onBackground() }
   */
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.classes = new Map(); // name -> {el, x, y, info}
    this.selected = null;
    this.showUses = true;
    root.classList.add('diagram');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'arrows');
    this.svg.innerHTML = `<defs>
      <marker id="m-ext" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M1,1 L11,6 L1,11 Z" fill="var(--bg)" stroke="var(--arrow)" stroke-width="1.3"/></marker>
      <marker id="m-use" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto"><path d="M1,1 L11,6 L1,11" fill="none" stroke="var(--arrow)" stroke-width="1.5"/></marker>
    </defs><g class="arrow-layer"></g>`;
    root.append(this.svg);
    this.layer = this.svg.querySelector('.arrow-layer');
    root.addEventListener('pointerdown', (ev) => {
      if (ev.target === root || ev.target === this.svg) this.select(null);
    });
    root.addEventListener('contextmenu', (ev) => { if (ev.target === root || ev.target === this.svg) ev.preventDefault(); });
  }

  /** model: [{name, kind, compiled, x, y, extends:[], implements:[], uses:[]}] */
  update(model) {
    const names = new Set(model.map((m) => m.name));
    for (const [n, c] of this.classes) {
      if (!names.has(n)) { c.el.remove(); this.classes.delete(n); }
    }
    for (const m of model) {
      let c = this.classes.get(m.name);
      if (!c) {
        c = { el: this._makeBox(m.name), x: m.x, y: m.y };
        this.classes.set(m.name, c);
        this.root.append(c.el);
      }
      c.x = m.x;
      c.y = m.y;
      c.info = m;
      c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      c.el.classList.toggle('uncompiled', !m.compiled);
      c.el.classList.toggle('selected', this.selected === m.name);
      const stereo = { interface: '«interface»', abstract: '«abstract»', enum: '«enum»' }[m.kind] || '';
      c.el.querySelector('.stereo').textContent = stereo;
      c.el.querySelector('.cname').textContent = m.name;
    }
    this._resizeCanvas();
    this.drawArrows();
  }

  _resizeCanvas() {
    let w = 0, h = 0;
    for (const c of this.classes.values()) { w = Math.max(w, c.x + BOX_W + 80); h = Math.max(h, c.y + BOX_H + 80); }
    this.svg.style.width = Math.max(w, this.root.clientWidth) + 'px';
    this.svg.style.height = Math.max(h, this.root.clientHeight) + 'px';
    this.root.style.setProperty('--canvas-w', Math.max(w, 0) + 'px');
    this.root.style.setProperty('--canvas-h', Math.max(h, 0) + 'px');
  }

  select(name) {
    this.selected = name;
    for (const [n, c] of this.classes) c.el.classList.toggle('selected', n === name);
    this.h.onSelect && this.h.onSelect(name);
  }

  setShowUses(v) { this.showUses = v; this.drawArrows(); }

  _makeBox(name) {
    const box = document.createElement('div');
    box.className = 'class-box';
    box.dataset.name = name;
    box.innerHTML = '<div class="stereo"></div><div class="cname"></div>';
    let drag = null;
    let pressTimer = null;
    let lastTap = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };

    box.addEventListener('pointerdown', (ev) => {
      if (ev.button === 2) return;
      ev.preventDefault();
      box.setPointerCapture(ev.pointerId);
      const c = this.classes.get(name);
      drag = { sx: ev.clientX, sy: ev.clientY, ox: c.x, oy: c.y, moved: false, long: false };
      this.select(name);
      cancelPress();
      if (ev.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => {
          if (drag && !drag.moved) { drag.long = true; this.h.onMenu && this.h.onMenu(name, ev.clientX, ev.clientY); }
        }, 550);
      }
    });
    box.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (drag.long) return;
      drag.moved = true;
      cancelPress();
      const c = this.classes.get(name);
      c.x = Math.max(0, Math.round(drag.ox + dx));
      c.y = Math.max(0, Math.round(drag.oy + dy));
      box.style.transform = `translate(${c.x}px, ${c.y}px)`;
      this.drawArrows();
    });
    const end = (ev) => {
      cancelPress();
      if (!drag) return;
      const d = drag;
      drag = null;
      const c = this.classes.get(name);
      if (d.moved) {
        this._resizeCanvas();
        this.h.onMoved && this.h.onMoved(name, c.x, c.y);
      } else if (!d.long && ev.type === 'pointerup') {
        const now = Date.now();
        if (now - lastTap < 400) { lastTap = 0; this.h.onOpen && this.h.onOpen(name); } else lastTap = now;
      }
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.select(name);
      this.h.onMenu && this.h.onMenu(name, ev.clientX, ev.clientY);
    });
    return box;
  }

  _rectOf(c) { return { x: c.x, y: c.y, w: BOX_W, h: BOX_H }; }

  _edgePoint(r, tx, ty) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? (r.w / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (r.h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  drawArrows() {
    this.layer.replaceChildren();
    const mk = (from, to, cls, marker) => {
      const a = this.classes.get(from), b = this.classes.get(to);
      if (!a || !b) return;
      const ra = this._rectOf(a), rb = this._rectOf(b);
      const p1 = this._edgePoint(ra, rb.x + rb.w / 2, rb.y + rb.h / 2);
      const p2 = this._edgePoint(rb, ra.x + ra.w / 2, ra.y + ra.h / 2);
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
      line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
      line.setAttribute('class', 'arrow ' + cls);
      line.setAttribute('marker-end', `url(#${marker})`);
      this.layer.append(line);
    };
    for (const [name, c] of this.classes) {
      const m = c.info;
      if (!m) continue;
      for (const t of m.extends) mk(name, t, 'extends', 'm-ext');
      for (const t of m.implements) mk(name, t, 'implements', 'm-ext');
      if (this.showUses) for (const t of m.uses) mk(name, t, 'uses', 'm-use');
    }
  }

  /** Nächster freier Platz für eine neue Klasse (Raster). */
  freeSpot() {
    const taken = [...this.classes.values()].map((c) => ({ x: c.x, y: c.y }));
    const cols = Math.max(1, Math.floor((this.root.clientWidth - 20) / (BOX_W + 40)));
    for (let i = 0; i < 400; i++) {
      const x = 20 + (i % cols) * (BOX_W + 40);
      const y = 20 + Math.floor(i / cols) * (BOX_H + 40);
      if (!taken.some((t) => Math.abs(t.x - x) < BOX_W && Math.abs(t.y - y) < BOX_H)) return { x, y };
    }
    return { x: 20, y: 20 };
  }
}
