// Inicialização, layout e navegação.
import { api, setUnauthorizedHandler } from './api.js';
import { html, mount, icon, $, $$, formData, withBusy, toast, initials } from './util.js';
import { state, loadMeta, isAdmin } from './state.js';

import * as dashboard from './pages/dashboard.js';
import * as condominiums from './pages/condominiums.js';
import * as meters from './pages/meters.js';
import * as readings from './pages/readings.js';
import * as newReading from './pages/new-reading.js';
import * as utility from './pages/utility.js';
import * as calendar from './pages/calendar.js';
import * as reports from './pages/reports.js';
import * as settings from './pages/settings.js';

const app = document.getElementById('app');

const NAV = [
  ['dashboard', 'Dashboard', 'layout-dashboard'],
  ['condominios', 'Condomínios', 'building'],
  ['medidores', 'Medidores', 'gauge'],
  ['leituras', 'Leituras', 'clipboard-list'],
  ['calendario', 'Calendário', 'calendar-days'],
  ['relatorios', 'Relatórios', 'chart-column'],
  ['configuracoes', 'Configurações', 'settings'],
];

/** Rotas: padrão → [módulo, título] */
const ROUTES = [
  [/^dashboard$/, dashboard, 'Dashboard'],
  [/^condominios$/, condominiums, 'Condomínios'],
  [/^condominios\/(\d+)$/, condominiums, 'Condomínio', 'detail'],
  [/^medidores$/, meters, 'Medidores'],
  [/^leituras$/, readings, 'Leituras'],
  [/^leituras\/nova$/, newReading, 'Registrar leitura'],
  [/^leituras\/concessionaria$/, utility, 'Leituras da concessionária'],
  [/^calendario$/, calendar, 'Calendário'],
  [/^relatorios(?:\/(fechamento|graficos|relatorio))?$/, reports, 'Relatórios'],
  [/^configuracoes(?:\/(conta|usuarios|geral|auditoria))?$/, settings, 'Configurações'],
];

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, q] = h.split('?');
  return { path: path || 'dashboard', query: Object.fromEntries(new URLSearchParams(q || '')) };
}

export function go(path) {
  if (location.hash === `#/${path}`) route();
  else location.hash = `#/${path}`;
}

// ---------------------------------------------------------------- Login
function renderLogin() {
  document.title = 'Entrar — Controle de Medidores';
  mount(app, html`<div class="login-page"><div class="card login-card">
    <div class="brand">${logo()}<div><h1>${state.meta?.org_name || 'Controle de Medidores'}</h1>
      <div class="brand-sub">Controle de leituras e consumo</div></div></div>
    <form class="form" id="login-form" novalidate>
      <div class="field"><label for="l-email">E-mail</label>
        <input class="input" id="l-email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="l-pass">Senha</label>
        <input class="input" id="l-pass" name="password" type="password" autocomplete="current-password" required></div>
      <div id="login-error"></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('lock')} Entrar</button>
    </form></div></div>`);
  const form = $('#login-form');
  $('#l-email').focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('button[type=submit]', form), async () => {
      try {
        const { user } = await api.post('/api/auth/login', formData(form));
        state.user = user;
        await loadMeta();
        start();
      } catch (err) {
        mount($('#login-error'), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message}</div></div>`);
      }
    });
  });
}

function renderForcePassword() {
  mount(app, html`<div class="login-page"><div class="card login-card">
    <div class="brand">${logo()}<div><h1>Crie uma nova senha</h1>
      <div class="brand-sub">Por segurança, troque a senha inicial antes de continuar.</div></div></div>
    <form class="form" id="pw-form">
      <div class="field"><label for="p-cur">Senha atual</label><input class="input" id="p-cur" name="current_password" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="p-new">Nova senha</label><input class="input" id="p-new" name="new_password" type="password" autocomplete="new-password" minlength="6" required>
        <span class="hint">Mínimo de 6 caracteres.</span></div>
      <div class="field"><label for="p-new2">Repita a nova senha</label><input class="input" id="p-new2" name="new_password2" type="password" autocomplete="new-password" required></div>
      <div id="pw-error"></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Salvar nova senha</button>
      <button class="btn btn-ghost btn-block" type="button" id="pw-logout">Sair</button>
    </form></div></div>`);
  const form = $('#pw-form');
  $('#pw-logout').addEventListener('click', logout);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(form);
    const showErr = (m) => mount($('#pw-error'), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${m}</div></div>`);
    if (d.new_password !== d.new_password2) return showErr('As senhas digitadas não são iguais.');
    withBusy($('button[type=submit]', form), async () => {
      try {
        await api.post('/api/auth/change-password', d);
        state.user.must_change_password = 0;
        toast('Senha alterada com sucesso.');
        start();
      } catch (err) { showErr(err.message); }
    });
  });
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* ignora */ }
  state.user = null;
  location.hash = '';
  renderLogin();
}

// ---------------------------------------------------------------- Layout
export function logo() {
  return state.meta?.has_logo
    ? html`<span class="brand-logo"><img src="/api/settings/logo?v=${state.meta.logo_v || 0}" alt="Logo"></span>`
    : html`<span class="brand-logo">${icon('gauge')}</span>`;
}

function renderLayout() {
  const u = state.user;
  mount(app, html`<div class="layout" id="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand">${logo()}<div><div class="brand-name">${state.meta.org_name}</div><div class="brand-sub">Controle de medidores</div></div></div>
      <a class="btn btn-primary btn-new" href="#/leituras/nova">${icon('plus')} Registrar leitura</a>
      <nav class="nav" aria-label="Menu principal">
        ${NAV.map(([p, label, ic]) => html`<a href="#/${p}" data-nav="${p}">${icon(ic)} ${label}</a>`)}
      </nav>
      <div class="sidebar-user">
        <span class="avatar">${initials(u.name)}</span>
        <div class="who"><b>${u.name}</b><span>${u.role === 'admin' ? 'Administrador' : 'Operador'}</span></div>
        <button class="icon-btn" id="btn-logout" title="Sair" aria-label="Sair">${icon('log-out')}</button>
      </div>
    </aside>
    <div class="backdrop" id="backdrop"></div>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn" id="btn-menu" aria-label="Abrir menu">${icon('menu')}</button>
        <div class="title" id="top-title"></div>
        <a class="icon-btn" href="#/leituras/nova" aria-label="Registrar leitura">${icon('plus')}</a>
      </header>
      <main class="content" id="page"></main>
    </div>
    <a class="fab" id="fab" href="#/leituras/nova">${icon('plus')} Registrar leitura</a>
  </div>`);
  const layout = $('#layout');
  $('#btn-menu').addEventListener('click', () => layout.classList.add('menu-open'));
  $('#backdrop').addEventListener('click', () => layout.classList.remove('menu-open'));
  $$('.nav a, .btn-new', layout).forEach((a) => a.addEventListener('click', () => layout.classList.remove('menu-open')));
  $('#btn-logout').addEventListener('click', logout);
}

let renderSeq = 0;
async function route() {
  if (!state.user) return renderLogin();
  if (state.user.must_change_password) return renderForcePassword();
  if (!$('#layout')) renderLayout();
  const { path, query } = parseHash();
  let match = null;
  for (const [re, mod, title, variant] of ROUTES) {
    const m = path.match(re);
    if (m) { match = { mod, title, variant, params: m.slice(1) }; break; }
  }
  if (!match) { go('dashboard'); return; }

  const top = path.split('/')[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === top));
  $('#top-title').textContent = match.title;
  document.title = `${match.title} — ${state.meta.org_name}`;
  $('#fab').hidden = !['dashboard', 'leituras', 'calendario'].includes(path);

  const page = $('#page');
  const seq = ++renderSeq;
  page.innerHTML = '<div class="loading"><span class="spinner"></span> Carregando...</div>';
  window.scrollTo(0, 0);
  try {
    await match.mod.render(page, { params: match.params, query, variant: match.variant, isCurrent: () => seq === renderSeq });
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    mount(page, html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message || 'Erro ao carregar a página.'}</div></div>`);
  }
}

/** Recarrega a tela atual (ex.: após salvar). */
export const refresh = () => route();

function start() {
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/dashboard';
  route();
}

export async function reloadMeta() {
  await loadMeta();
  state.meta.logo_v = Date.now();
  if ($('#layout')) { $('#layout').remove(); }
  route();
}

setUnauthorizedHandler(() => {
  if (state.user) { state.user = null; toast('Sua sessão expirou. Entre novamente.', 'error'); renderLogin(); }
});

window.addEventListener('hashchange', route);

(async function boot() {
  try {
    const { user, org_name: orgName } = await api.get('/api/auth/me');
    state.user = user;
    state.meta = { org_name: orgName };
    if (user) await loadMeta();
  } catch { state.user = null; }
  if (state.user) start(); else renderLogin();
})();

export { isAdmin };
