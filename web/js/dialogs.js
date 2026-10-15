// Einfache modale Dialoge (touch-freundlich).

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

const layer = () => document.getElementById('dialog-layer');

/**
 * modal({ title, body: Node, buttons: [{label, primary, cancel, onClick -> false = offen lassen}], width })
 * Gibt { close } zurück.
 */
export function modal({ title, body, buttons = [], width, onClose, className = '' }) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal ' + className, role: 'dialog', 'aria-modal': 'true' });
  if (width) box.style.maxWidth = width + 'px';
  const head = el('div', { class: 'modal-title', text: title || '' });
  const content = el('div', { class: 'modal-body' }, body);
  const foot = el('div', { class: 'modal-buttons' });
  const api = {
    close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (onClose) onClose();
    },
  };
  for (const b of buttons) {
    const btn = el('button', { class: 'btn' + (b.primary ? ' primary' : ''), type: 'button', text: b.label });
    btn.addEventListener('click', async () => {
      const r = b.onClick ? await b.onClick(api) : undefined;
      if (r !== false) api.close();
    });
    b._el = btn;
    foot.append(btn);
  }
  function onKey(ev) {
    if (!overlay.isConnected) return;
    const topmost = layer().lastElementChild === overlay;
    if (!topmost) return;
    if (ev.key === 'Escape') {
      const c = buttons.find((b) => b.cancel);
      ev.preventDefault();
      if (c && c.onClick) c.onClick(api);
      api.close();
    } else if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement) && !(ev.target instanceof HTMLButtonElement)) {
      const p = buttons.find((b) => b.primary);
      if (p) { ev.preventDefault(); p._el.click(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  box.append(head, content, foot);
  overlay.append(box);
  layer().append(overlay);
  const first = box.querySelector('input,textarea,select');
  if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
  else if (foot.lastElementChild) setTimeout(() => foot.lastElementChild.focus(), 30);
  return api;
}

export function alertBox(title, message, { mono = false } = {}) {
  return new Promise((resolve) => {
    const body = el('div', { class: mono ? 'mono pre' : 'msg', text: message });
    modal({ title, body, buttons: [{ label: 'OK', primary: true, onClick: () => resolve() }], onClose: resolve });
  });
}

export function confirmBox(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title,
      body: el('div', { class: 'msg', text: message }),
      buttons: [
        { label: 'Abbrechen', cancel: true, onClick: () => fin(false) },
        { label: okLabel, primary: true, onClick: () => fin(true) },
      ],
      onClose: () => fin(false),
    });
  });
}

export function promptBox(title, label, value = '', { validate, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const input = el('input', { type: 'text', value, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
    const err = el('div', { class: 'field-error' });
    const body = el('div', {}, el('label', { class: 'field' }, el('span', { text: label }), input), err);
    modal({
      title,
      body,
      buttons: [
        { label: 'Abbrechen', cancel: true, onClick: () => fin(null) },
        {
          label: okLabel,
          primary: true,
          onClick: () => {
            const v = input.value.trim();
            const msg = validate ? validate(v) : '';
            if (msg) { err.textContent = msg; return false; }
            fin(v);
          },
        },
      ],
      onClose: () => fin(null),
    });
  });
}

/** Kontextmenü an Position (x, y). items: [{label, onClick, disabled, sep, header, submenu:[...]}] */
export function contextMenu(x, y, items) {
  closeMenus();
  const menu = el('div', { class: 'ctx-menu', role: 'menu' });
  const build = (list, host) => {
    for (const it of list) {
      if (it.sep) { host.append(el('div', { class: 'ctx-sep' })); continue; }
      if (it.header) { host.append(el('div', { class: 'ctx-header', text: it.header })); continue; }
      const row = el('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : ''), role: 'menuitem' });
      row.append(el('span', { class: 'ctx-label', text: it.label }));
      if (it.submenu) {
        row.classList.add('has-sub');
        const sub = el('div', { class: 'ctx-menu ctx-sub' });
        build(it.submenu, sub);
        row.append(el('span', { class: 'ctx-arrow', text: '▸' }), sub);
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const open = row.classList.toggle('open');
          if (open) {
            sub.style.left = '';
            sub.style.right = '';
            const r = sub.getBoundingClientRect();
            if (r.right > window.innerWidth) { sub.style.left = 'auto'; sub.style.right = '100%'; }
            const over = r.bottom - window.innerHeight;
            if (over > 0) sub.style.top = -over - 4 + 'px';
          }
        });
      } else if (!it.disabled) {
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeMenus();
          it.onClick && it.onClick();
        });
      }
      host.append(row);
    }
  };
  build(items, menu);
  const holder = document.getElementById('menu-layer');
  const backdrop = el('div', { class: 'menu-backdrop' });
  backdrop.addEventListener('pointerdown', (ev) => { ev.preventDefault(); closeMenus(); });
  backdrop.addEventListener('contextmenu', (ev) => { ev.preventDefault(); closeMenus(); });
  holder.append(backdrop, menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  menu.style.maxHeight = window.innerHeight - 8 + 'px';
  return menu;
}

export function closeMenus() {
  const h = document.getElementById('menu-layer');
  if (h) h.replaceChildren();
}
