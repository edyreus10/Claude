// Utilitários da interface: HTML seguro, formatação pt-BR, modais, avisos.

// ---------------------------------------------------------------- HTML seguro
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
function renderVal(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
}
/** Template que escapa automaticamente os valores interpolados. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += renderVal(vals[i]); });
  return new Raw(out);
}
export function mount(el, tpl) {
  el.innerHTML = tpl instanceof Raw ? tpl.s : String(tpl);
  icons(el);
  return el;
}
export function icons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root, attrs: { 'aria-hidden': 'true' } });
}
export const icon = (name, cls = '') => raw(`<i data-lucide="${esc(name)}" class="${esc(cls)}"></i>`);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------- Formatação
export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const pad = (n) => String(n).padStart(2, '0');
const nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function fmtNum(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : nf.format(v); }
export function fmtInt(v) { return v === null || v === undefined ? '—' : nf0.format(v); }
export function fmtUnit(v, unit) { return v === null || v === undefined ? '—' : `${nf.format(v)} ${unit}`; }
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDateTime(s) { return s ? `${fmtDate(s)} ${s.slice(11, 16)}` : '—'; }
export function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function nowTime() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function parseISO(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
export function weekday(iso) { return WEEKDAYS[parseISO(iso).getDay()]; }
export function diffDays(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
export function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
export function initials(name) { return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(''); }

/** Número digitado no padrão brasileiro ("2.740,5" ou "498,0"). */
export function parseNumber(v) {
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
/** Valor numérico no formato de edição ("498,5"). */
export function numInput(v) { return v === null || v === undefined ? '' : String(v).replace('.', ','); }

export function pct(v) {
  if (v === null || v === undefined) return '';
  return `${v > 0 ? '+' : ''}${v}%`;
}

// ---------------------------------------------------------------- Armazenamento local (preferências)
export const pref = {
  get(k, d = null) { try { const v = localStorage.getItem(`cm.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`cm.${k}`, JSON.stringify(v)); } catch { /* ignora */ } },
};

// ---------------------------------------------------------------- Avisos (toast)
export function toast(message, type = 'success') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  mount(el, html`${icon(type === 'error' ? 'circle-x' : 'circle-check')}<span>${message}</span>`);
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

// ---------------------------------------------------------------- Modal
/**
 * Abre um modal. `body` e `footer` são templates html``.
 * Retorna { el, close }.
 */
export function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  mount(root, html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? html`<div class="modal-foot">${footer}</div>` : ''}
  </div>`);
  const prevFocus = document.activeElement;
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  document.body.appendChild(root);
  const first = $('input:not([type=hidden]):not([disabled]), select, textarea', root);
  if (first && window.matchMedia('(min-width: 641px)').matches) first.focus();
  return { el: root, close };
}

/** Pede confirmação antes de uma ação (ex.: excluir). */
export function confirmDialog({ title = 'Confirmar', message, confirmText = 'Confirmar', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title,
      body: html`<p style="margin:0 0 ${requireText ? '14px' : '0'}">${message}</p>
        ${requireText ? html`<div class="field"><label for="confirm-text">Para confirmar, digite <b>${requireText}</b></label>
          <input id="confirm-text" class="input" autocomplete="off"></div>` : ''}`,
      footer: html`<button class="btn" data-close>Cancelar</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok ${requireText ? 'disabled' : ''}>${confirmText}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    const ok = $('[data-ok]', m.el);
    if (requireText) {
      const inp = $('#confirm-text', m.el);
      inp.addEventListener('input', () => { ok.disabled = inp.value.trim().toLowerCase() !== requireText.trim().toLowerCase(); });
      inp.focus();
    }
    ok.addEventListener('click', () => { done = true; m.close(); resolve(true); });
  });
}

/** Lê os campos de um formulário como objeto. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type !== 'file') out[el.name] = el.value;
  }
  return out;
}

/** Executa uma ação com o botão em estado "salvando". */
export async function withBusy(btn, fn) {
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Aguarde...'; }
  try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

export const loading = () => html`<div class="loading"><span class="spinner"></span> Carregando...</div>`;

export function emptyState(iconName, title, text, action = '') {
  return html`<div class="empty">${icon(iconName)}<h3>${title}</h3><p>${text}</p>${action}</div>`;
}

export function monthOptions(selected) {
  return MONTHS.map((m, i) => html`<option value="${i + 1}" ${i + 1 === Number(selected) ? 'selected' : ''}>${capital(m)}</option>`);
}
export function yearOptions(selected, from = 2020) {
  const to = new Date().getFullYear() + 1;
  const out = [];
  for (let y = to; y >= from; y--) out.push(html`<option value="${y}" ${y === Number(selected) ? 'selected' : ''}>${y}</option>`);
  return out;
}
