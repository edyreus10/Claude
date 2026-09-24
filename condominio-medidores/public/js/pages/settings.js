// Configurações: minha conta, usuários, configurações gerais e auditoria.
import { api } from '../api.js';
import { html, mount, icon, $, $$, openModal, confirmDialog, formData, withBusy, toast, fmtDateTime, initials, emptyState } from '../util.js';
import { state, isAdmin } from '../state.js';
import { go, reloadMeta, refresh } from '../app.js';

function tabs(active) {
  const t = [['conta', 'Minha conta', 'user']];
  if (isAdmin()) t.push(['usuarios', 'Usuários', 'users'], ['geral', 'Geral', 'settings'], ['auditoria', 'Auditoria', 'file-clock']);
  return html`<div class="tabs">${t.map(([k, l, i]) => html`<a href="#/configuracoes/${k}" class="${k === active ? 'active' : ''}">${icon(i)} ${l}</a>`)}</div>`;
}
const head = () => html`<div class="page-head"><div><h1>Configurações</h1><p>Usuários, permissões e preferências do sistema.</p></div></div>`;
const errBox = (m) => html`<div class="alert alert-danger">${icon('circle-alert')}<div>${m}</div></div>`;

export async function render(el, ctx) {
  let tab = ctx.params[0] || (isAdmin() ? 'usuarios' : 'conta');
  if (!isAdmin() && tab !== 'conta') tab = 'conta';
  if (tab === 'usuarios') return renderUsers(el, ctx);
  if (tab === 'geral') return renderGeneral(el, ctx);
  if (tab === 'auditoria') return renderAudit(el, ctx);
  return renderAccount(el);
}

function renderAccount(el) {
  const u = state.user;
  mount(el, html`${head()}${tabs('conta')}
    <div class="grid two-col">
      <div class="card"><div class="card-head"><h2>${icon('lock')} Alterar senha</h2></div><div class="card-body">
        <form class="form" id="pw" novalidate>
          <div class="field"><label for="a-cur">Senha atual</label><input class="input" type="password" id="a-cur" name="current_password" autocomplete="current-password"></div>
          <div class="field"><label for="a-new">Nova senha</label><input class="input" type="password" id="a-new" name="new_password" autocomplete="new-password"><span class="hint">Mínimo de 6 caracteres.</span></div>
          <div class="field"><label for="a-new2">Repita a nova senha</label><input class="input" type="password" id="a-new2" name="new_password2" autocomplete="new-password"></div>
          <div id="pw-err"></div>
          <div><button class="btn btn-primary" type="submit">${icon('save')} Salvar nova senha</button></div>
        </form></div></div>
      <div class="card"><div class="card-head"><h2>${icon('user')} Meus dados</h2></div><div class="card-body">
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px"><span class="avatar">${initials(u.name)}</span><div><b>${u.name}</b><div class="muted small">${u.email}</div></div></div>
        <dl class="kv"><dt>Perfil</dt><dd>${u.role === 'admin' ? 'Administrador' : 'Operador'}</dd></dl>
        <div class="alert alert-info" style="margin-top:14px">${icon('info')}<div>${u.role === 'admin'
          ? 'Administradores podem cadastrar, editar e excluir registros, gerenciar usuários e configurações.'
          : 'Operadores podem registrar leituras, consultar o histórico e gerar relatórios.'}</div></div>
      </div></div>
    </div>`);
  const form = $('#pw', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(form);
    if (d.new_password !== d.new_password2) return mount($('#pw-err', el), errBox('As senhas digitadas não são iguais.'));
    withBusy($('button[type=submit]', form), async () => {
      try { await api.post('/api/auth/change-password', d); form.reset(); mount($('#pw-err', el), ''); toast('Senha alterada com sucesso.'); } catch (err) { mount($('#pw-err', el), errBox(err.message)); }
    });
  });
}

// ---------------------------------------------------------------- Usuários
async function renderUsers(el, ctx) {
  const users = await api.get('/api/users');
  if (!ctx.isCurrent()) return;
  mount(el, html`${head()}${tabs('usuarios')}
    <div class="card">
      <div class="card-head"><h2>${icon('users')} Usuários</h2><button class="btn btn-primary btn-sm" id="u-new">${icon('plus')} Novo usuário</button></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Nome</th><th class="hide-mobile">E-mail</th><th>Perfil</th><th class="hide-mobile">Último acesso</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td><div style="display:flex;gap:10px;align-items:center"><span class="avatar">${initials(u.name)}</span><div><b>${u.name}</b>${u.id === state.user.id ? html` <span class="badge b-gray">você</span>` : ''}
            ${u.active ? '' : html` <span class="badge b-red">Inativo</span>`}<div class="small muted show-mobile">${u.email}</div></div></div></td>
          <td class="hide-mobile">${u.email}</td>
          <td>${u.role === 'admin' ? html`<span class="badge b-blue">${icon('shield')} Administrador</span>` : html`<span class="badge b-gray">Operador</span>`}</td>
          <td class="hide-mobile small">${u.last_login ? fmtDateTime(u.last_login) : 'nunca'}</td>
          <td class="actions"><button class="icon-btn" data-edit="${u.id}" aria-label="Editar" title="Editar">${icon('pencil')}</button>
            ${u.id !== state.user.id ? html`<button class="icon-btn danger" data-del="${u.id}" aria-label="Excluir" title="Excluir">${icon('trash')}</button>` : ''}</td>
        </tr>`)}</tbody></table></div>
    </div>
    <div class="grid stats-3" style="margin-top:16px;grid-template-columns:1fr 1fr">
      <div class="card card-pad"><b>${icon('shield')} Administrador</b><p class="small muted" style="margin:6px 0 0">Cadastra condomínios e medidores, registra, edita e exclui leituras, gera relatórios, gerencia usuários e configurações.</p></div>
      <div class="card card-pad"><b>${icon('user')} Operador</b><p class="small muted" style="margin:6px 0 0">Registra leituras, consulta o histórico e gera relatórios. Não exclui registros nem altera configurações.</p></div>
    </div>`);
  $('#u-new', el).addEventListener('click', () => userForm(null));
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => userForm(users.find((u) => u.id === Number(b.dataset.edit)))));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const u = users.find((x) => x.id === Number(b.dataset.del));
    const ok = await confirmDialog({ title: 'Excluir usuário', danger: true, confirmText: 'Excluir',
      message: html`Excluir o usuário <b>${u.name}</b>? O histórico de auditoria dele será mantido. Se preferir, apenas desative o acesso.` });
    if (!ok) return;
    try { await api.del(`/api/users/${u.id}`); toast('Usuário excluído.'); refresh(); } catch (err) { toast(err.message, 'error'); }
  }));
}

function userForm(u) {
  const v = u || { role: 'operator', active: 1 };
  const m = openModal({
    title: u ? 'Editar usuário' : 'Novo usuário',
    body: html`<form class="form" id="uf" novalidate>
      <div class="field"><label for="us-name">Nome</label><input class="input" id="us-name" name="name" value="${v.name || ''}"></div>
      <div class="field"><label for="us-email">E-mail (usado para entrar)</label><input class="input" id="us-email" name="email" type="email" value="${v.email || ''}" autocomplete="off"></div>
      <div class="field"><label for="us-role">Perfil</label><select class="select" id="us-role" name="role">
        <option value="operator" ${v.role === 'operator' ? 'selected' : ''}>Operador</option>
        <option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Administrador</option></select></div>
      <div class="field"><label for="us-pass">${u ? 'Redefinir senha (deixe em branco para manter)' : 'Senha inicial'}</label>
        <input class="input" id="us-pass" name="password" type="text" autocomplete="new-password"><span class="hint">O usuário deverá trocar a senha no primeiro acesso.</span></div>
      ${u ? html`<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''} ${u.id === state.user.id ? 'disabled' : ''}> Acesso ativo</label>` : ''}
      <div id="us-err"></div>
    </form>`,
    footer: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="us-save">${icon('save')} Salvar</button>`,
  });
  $('#us-save', m.el).addEventListener('click', () => withBusy($('#us-save', m.el), async () => {
    const d = formData($('#uf', m.el));
    if (u) d.active = u.id === state.user.id ? true : !!d.active;
    try {
      if (u) await api.put(`/api/users/${u.id}`, d); else await api.post('/api/users', d);
      m.close(); toast(u ? 'Usuário atualizado.' : 'Usuário cadastrado.'); refresh();
    } catch (err) { mount($('#us-err', m.el), errBox(err.message)); }
  }));
}

// ---------------------------------------------------------------- Geral
async function renderGeneral(el) {
  const meta = state.meta;
  mount(el, html`${head()}${tabs('geral')}
    <div class="grid two-col">
      <div class="card"><div class="card-head"><h2>${icon('settings')} Preferências</h2></div><div class="card-body">
        <form class="form" id="sf" novalidate>
          <div class="field"><label for="s-org">Nome da administradora (aparece no sistema e nos relatórios)</label><input class="input" id="s-org" name="org_name" value="${meta.org_name}"></div>
          <div class="form-row-3">
            <div class="field"><label for="s-pct">Alerta de consumo acima da média (%)</label><input class="input" id="s-pct" name="alert_threshold_pct" inputmode="numeric" value="${meta.alert_threshold_pct}"></div>
            <div class="field"><label for="s-up">Avisar leitura próxima (dias antes)</label><input class="input" id="s-up" name="upcoming_days" inputmode="numeric" value="${meta.upcoming_days}"></div>
            <div class="field"><label for="s-uup">Avisar leitura da concessionária (dias antes)</label><input class="input" id="s-uup" name="utility_upcoming_days" inputmode="numeric" value="${meta.utility_upcoming_days}"></div>
          </div>
          <div id="s-err"></div>
          <div><button class="btn btn-primary" type="submit">${icon('save')} Salvar</button></div>
        </form></div></div>
      <div class="card"><div class="card-head"><h2>${icon('image')} Logo</h2></div><div class="card-body">
        <p class="small muted" style="margin-top:0">Usado no menu e no PDF dos relatórios. PNG ou JPG, até 2 MB.</p>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          ${meta.has_logo ? html`<img src="/api/settings/logo?v=${meta.logo_v || 0}" alt="Logo atual" style="max-height:64px;max-width:180px;border:1px solid var(--border);border-radius:8px;padding:4px;background:#fff">` : html`<span class="muted">Nenhum logo enviado (usando o padrão).</span>`}
        </div>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
          <label class="btn">${icon('file-up')} Enviar logo<input type="file" id="s-logo" accept="image/png,image/jpeg" hidden></label>
          ${meta.has_logo ? html`<button class="btn btn-ghost" id="s-logo-del" style="color:var(--danger)">${icon('trash')} Remover</button>` : ''}
        </div></div></div>
    </div>
    <div class="card section" style="margin-top:16px"><div class="card-head"><h2>${icon('gauge')} Tipos de medidor</h2></div>
      <div class="card-body"><p class="small muted" style="margin-top:0">Ative novos tipos quando precisar controlar outros medidores.</p>
      <ul class="list">${meta.utility_types.map((t) => html`<li class="list-item" style="padding-left:0;padding-right:0">
        <span class="type-dot t-${t.code}">${icon(t.icon)}</span><div class="grow"><div class="title">${t.name}</div><div class="sub">Unidade: ${t.unit}</div></div>
        <label class="check"><input type="checkbox" data-type="${t.code}" ${t.active ? 'checked' : ''}> Ativo</label></li>`)}</ul></div></div>`);

  const form = $('#sf', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('button[type=submit]', form), async () => {
      try { await api.put('/api/settings', formData(form)); toast('Configurações salvas.'); await reloadMeta(); } catch (err) { mount($('#s-err', el), errBox(err.message)); }
    });
  });
  $('#s-logo', el).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('logo', f);
    try { await api.post('/api/settings/logo', fd); toast('Logo atualizado.'); await reloadMeta(); } catch (err) { toast(err.message, 'error'); }
  });
  $('#s-logo-del', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Remover logo', message: 'Remover o logo e voltar ao padrão?', confirmText: 'Remover', danger: true }))) return;
    try { await api.del('/api/settings/logo'); toast('Logo removido.'); await reloadMeta(); } catch (err) { toast(err.message, 'error'); }
  });
  $$('[data-type]', el).forEach((cb) => cb.addEventListener('change', async () => {
    try { await api.put(`/api/utility-types/${cb.dataset.type}`, { active: cb.checked }); toast('Tipo de medidor atualizado.'); await reloadMeta(); } catch (err) { cb.checked = !cb.checked; toast(err.message, 'error'); }
  }));
}

// ---------------------------------------------------------------- Auditoria
const ACTIONS = { create: ['Cadastro', 'b-green'], update: ['Alteração', 'b-yellow'], delete: ['Exclusão', 'b-red'], login: ['Acesso', 'b-gray'], export: ['Relatório', 'b-blue'] };

async function renderAudit(el, ctx) {
  const q = ctx.query.q || '';
  const action = ctx.query.acao || '';
  const page = Number(ctx.query.pagina) || 1;
  const d = await api.get('/api/audit', { q, action, page });
  if (!ctx.isCurrent()) return;
  const link = (p) => `configuracoes/auditoria?${new URLSearchParams({ q, acao: action, pagina: p })}`;
  mount(el, html`${head()}${tabs('auditoria')}
    <div class="card section"><div class="card-body"><form class="filters" id="af">
      <div class="field wide"><label for="a-q">Buscar</label><input class="input" id="a-q" type="search" value="${q}" placeholder="Nome, condomínio, data..."></div>
      <div class="field"><label for="a-act">Ação</label><select class="select" id="a-act"><option value="">Todas</option>
        ${Object.entries(ACTIONS).map(([k, [l]]) => html`<option value="${k}" ${k === action ? 'selected' : ''}>${l}</option>`)}</select></div>
      <button class="btn" type="submit">${icon('search')} Filtrar</button>
    </form></div></div>
    <div class="card">
      ${d.rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Descrição</th></tr></thead>
        <tbody>${d.rows.map((r) => html`<tr>
          <td class="nowrap small">${fmtDateTime(r.created_at)}</td><td class="nowrap">${r.user_name || '—'}</td>
          <td><span class="badge ${(ACTIONS[r.action] || ['', 'b-gray'])[1]}">${(ACTIONS[r.action] || [r.action])[0]}</span></td>
          <td>${r.description}</td></tr>`)}</tbody></table></div>
        <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="small muted">${d.total} registro(s) · página ${d.page} de ${d.pages}</span>
          <div style="display:flex;gap:8px">
            ${d.page > 1 ? html`<a class="btn btn-sm" href="#/${link(d.page - 1)}">${icon('chevron-left')} Anterior</a>` : ''}
            ${d.page < d.pages ? html`<a class="btn btn-sm" href="#/${link(d.page + 1)}">Próxima ${icon('chevron-right')}</a>` : ''}
          </div></div>`
      : emptyState('file-clock', 'Nenhum registro encontrado', 'Ajuste os filtros da busca.')}
    </div>`);
  $('#af', el).addEventListener('submit', (e) => {
    e.preventDefault();
    go(`configuracoes/auditoria?${new URLSearchParams({ q: $('#a-q', el).value, acao: $('#a-act', el).value })}`);
  });
}
