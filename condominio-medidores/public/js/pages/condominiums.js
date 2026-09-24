// Cadastro de condomínios.
import { api } from '../api.js';
import { html, mount, icon, $, $$, openModal, confirmDialog, formData, withBusy, toast, fmtDate, emptyState } from '../util.js';
import { getCondos, invalidateCondos, isAdmin, currentCondo } from '../state.js';
import { typeDot, statusBadge, nextReadingText, frequencyLabel } from '../components.js';
import { openMeterForm, deleteMeter } from './meters.js';
import { go, refresh } from '../app.js';

export async function render(el, ctx) {
  if (ctx.variant === 'detail') return renderDetail(el, Number(ctx.params[0]), ctx);
  const condos = await getCondos(true);
  if (!ctx.isCurrent()) return;
  const admin = isAdmin();

  const card = (c) => html`<div class="card condo-card" data-id="${c.id}" tabindex="0" role="link">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <h3>${c.name}</h3>
      ${c.status === 'active' ? html`<span class="badge b-green">Ativo</span>` : html`<span class="badge b-gray">Inativo</span>`}
    </div>
    <div class="meta">
      ${c.address ? html`<span>${icon('map-pin-house')} ${c.address}</span>` : ''}
      ${c.syndic ? html`<span>${icon('user')} Síndico: ${c.syndic}</span>` : ''}
      <span>${icon('clock')} Última leitura: ${c.last_reading_date ? fmtDate(c.last_reading_date) : 'nenhuma'}</span>
    </div>
    <div class="chips">
      ${(c.utility_types || '').split(',').filter(Boolean).map((t) => typeDot(t))}
      <span class="badge b-gray" style="align-self:center">${c.meters_count} medidor${c.meters_count === 1 ? '' : 'es'}</span>
    </div>
  </div>`;

  mount(el, html`
    <div class="page-head">
      <div><h1>Condomínios</h1><p>Cada condomínio tem seus próprios medidores e histórico.</p></div>
      <div class="page-actions">
        ${admin ? html`<button class="btn btn-primary" id="btn-new-condo">${icon('plus')} Novo condomínio</button>` : ''}
      </div>
    </div>
    ${condos.length > 4 ? html`<div class="section" style="max-width:420px"><input class="input" id="condo-search" type="search" placeholder="Buscar condomínio..." aria-label="Buscar condomínio"></div>` : ''}
    ${condos.length ? html`<div class="grid condo-grid" id="condo-grid">${condos.map(card)}</div>`
      : html`<div class="card">${emptyState('building', 'Nenhum condomínio cadastrado', 'Comece cadastrando o primeiro condomínio.',
        admin ? html`<button class="btn btn-primary" id="btn-new-condo-2">${icon('plus')} Novo condomínio</button>` : '')}</div>`}
  `);

  const openNew = () => openCondoForm(null, (c) => go(`condominios/${c.id}`));
  $('#btn-new-condo', el)?.addEventListener('click', openNew);
  $('#btn-new-condo-2', el)?.addEventListener('click', openNew);
  $$('.condo-card', el).forEach((c) => {
    const open = () => go(`condominios/${c.dataset.id}`);
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  $('#condo-search', el)?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('.condo-card', el).forEach((c) => { c.hidden = q && !c.textContent.toLowerCase().includes(q); });
  });
}

async function renderDetail(el, id, ctx) {
  const [c, meters, dash] = await Promise.all([
    api.get(`/api/condominiums/${id}`),
    api.get('/api/meters', { condominium_id: id }),
    api.get('/api/dashboard', { condominium_id: id }),
  ]);
  if (!ctx.isCurrent()) return;
  currentCondo.set(id);
  const admin = isAdmin();
  const statuses = new Map(((dash.upcoming[0] || {}).items || []).map((s) => [s.meter_id, s]));

  mount(el, html`
    <div class="page-head">
      <div>
        <a href="#/condominios" class="small">${icon('arrow-left')} Condomínios</a>
        <h1 style="margin-top:6px">${c.name}</h1>
        <p>${c.address || ''}</p>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/leituras">${icon('table')} Histórico</a>
        <a class="btn" href="#/relatorios/fechamento">${icon('calculator')} Fechamento</a>
        ${admin ? html`<button class="btn" id="btn-edit">${icon('pencil')} Editar</button>` : ''}
      </div>
    </div>

    <div class="grid two-col">
      <div class="card">
        <div class="card-head"><h2>${icon('gauge')} Medidores</h2>
          ${admin ? html`<button class="btn btn-primary btn-sm" id="btn-new-meter">${icon('plus')} Novo medidor</button>` : ''}</div>
        ${meters.length ? html`<ul class="list">${meters.map((m) => {
          const st = statuses.get(m.id);
          return html`<li class="list-item">
            ${typeDot(m.utility_type)}
            <div class="grow">
              <div class="title">${m.name} ${m.active ? '' : html`<span class="badge b-gray">Inativo</span>`}</div>
              <div class="sub">${m.type_name} · ${m.unit} · ${m.kind === 'area' ? 'Área específica' : 'Principal'} · ${frequencyLabel(m.frequency_days)}${m.identifier ? ` · Nº ${m.identifier}` : ''}</div>
              ${st ? html`<div class="sub">${nextReadingText(st)}</div>` : ''}
            </div>
            <div class="li-actions">${st ? statusBadge(st.status) : ''}
            ${m.active ? html`<a class="icon-btn" href="#/leituras/nova?meter=${m.id}" title="Registrar leitura" aria-label="Registrar leitura">${icon('plus')}</a>` : ''}
            ${admin ? html`<button class="icon-btn" data-edit-meter="${m.id}" title="Editar medidor" aria-label="Editar medidor">${icon('pencil')}</button>
              <button class="icon-btn danger" data-del-meter="${m.id}" title="Excluir medidor" aria-label="Excluir medidor">${icon('trash')}</button>` : ''}</div>
          </li>`;
        })}</ul>`
        : emptyState('gauge', 'Nenhum medidor', 'Cadastre os medidores de água, gás e energia deste condomínio.',
          admin ? html`<button class="btn btn-primary" id="btn-new-meter-2">${icon('plus')} Novo medidor</button>` : '')}
      </div>

      <div class="card">
        <div class="card-head"><h2>${icon('building')} Dados do condomínio</h2>${c.status === 'active' ? html`<span class="badge b-green">Ativo</span>` : html`<span class="badge b-gray">Inativo</span>`}</div>
        <div class="card-body">
          <dl class="kv">
            <dt>CNPJ</dt><dd>${c.cnpj || '—'}</dd>
            <dt>Síndico</dt><dd>${c.syndic || '—'}</dd>
            <dt>Administrador</dt><dd>${c.manager || '—'}</dd>
            <dt>Telefone</dt><dd>${c.phone || '—'}</dd>
            <dt>E-mail</dt><dd>${c.email || '—'}</dd>
            <dt>Endereço</dt><dd>${c.address || '—'}</dd>
          </dl>
          ${admin ? html`<div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
            <button class="btn btn-ghost btn-sm" id="btn-del" style="color:var(--danger)">${icon('trash')} Excluir condomínio</button></div>` : ''}
        </div>
      </div>
    </div>
  `);

  $('#btn-edit', el)?.addEventListener('click', () => openCondoForm(c, () => refresh()));
  const newMeter = () => openMeterForm(null, { condominiumId: id, onSaved: refresh });
  $('#btn-new-meter', el)?.addEventListener('click', newMeter);
  $('#btn-new-meter-2', el)?.addEventListener('click', newMeter);
  $$('[data-edit-meter]', el).forEach((b) => b.addEventListener('click', () => {
    openMeterForm(meters.find((m) => m.id === Number(b.dataset.editMeter)), { onSaved: refresh });
  }));
  $$('[data-del-meter]', el).forEach((b) => b.addEventListener('click', () => {
    deleteMeter(meters.find((m) => m.id === Number(b.dataset.delMeter)), refresh);
  }));
  $('#btn-del', el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Excluir condomínio',
      message: html`Isso vai excluir <b>${c.name}</b> com <b>todos os medidores, leituras e comprovantes</b>. Essa ação não pode ser desfeita.
        Se o condomínio apenas deixou de ser atendido, prefira editar e marcar como <b>Inativo</b>.`,
      confirmText: 'Excluir definitivamente', danger: true, requireText: c.name,
    });
    if (!ok) return;
    try {
      await api.del(`/api/condominiums/${c.id}`);
      invalidateCondos();
      currentCondo.set('');
      toast('Condomínio excluído.');
      go('condominios');
    } catch (err) { toast(err.message, 'error'); }
  });
}

export function openCondoForm(c, onSaved) {
  const v = c || { status: 'active' };
  const m = openModal({
    title: c ? 'Editar condomínio' : 'Novo condomínio',
    body: html`<form class="form" id="condo-form" novalidate>
      <div class="field"><label for="c-name">Nome do condomínio *</label><input class="input" id="c-name" name="name" value="${v.name || ''}" required maxlength="150"></div>
      <div class="field"><label for="c-address">Endereço</label><input class="input" id="c-address" name="address" value="${v.address || ''}" maxlength="300"></div>
      <div class="form-row">
        <div class="field"><label for="c-cnpj">CNPJ</label><input class="input" id="c-cnpj" name="cnpj" value="${v.cnpj || ''}" inputmode="numeric" placeholder="00.000.000/0000-00"></div>
        <div class="field"><label for="c-status">Status</label><select class="select" id="c-status" name="status">
          <option value="active" ${v.status === 'active' ? 'selected' : ''}>Ativo</option>
          <option value="inactive" ${v.status === 'inactive' ? 'selected' : ''}>Inativo</option></select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="c-syndic">Síndico</label><input class="input" id="c-syndic" name="syndic" value="${v.syndic || ''}"></div>
        <div class="field"><label for="c-manager">Administrador responsável</label><input class="input" id="c-manager" name="manager" value="${v.manager || ''}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="c-phone">Telefone</label><input class="input" id="c-phone" name="phone" value="${v.phone || ''}" inputmode="tel" placeholder="(11) 0000-0000"></div>
        <div class="field"><label for="c-email">E-mail</label><input class="input" id="c-email" name="email" type="email" value="${v.email || ''}"></div>
      </div>
      <div id="condo-error"></div>
    </form>`,
    footer: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="condo-save">${icon('save')} Salvar</button>`,
  });
  const form = $('#condo-form', m.el);
  const cnpj = $('#c-cnpj', m.el);
  cnpj.addEventListener('input', () => {
    const d = cnpj.value.replace(/\D/g, '').slice(0, 14);
    cnpj.value = d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  });
  const save = () => withBusy($('#condo-save', m.el), async () => {
    try {
      const d = formData(form);
      const saved = c ? await api.put(`/api/condominiums/${c.id}`, d) : await api.post('/api/condominiums', d);
      invalidateCondos();
      m.close();
      toast(c ? 'Condomínio atualizado.' : 'Condomínio cadastrado com sucesso.');
      onSaved(saved);
    } catch (err) {
      mount($('#condo-error', m.el), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message}</div></div>`);
    }
  });
  $('#condo-save', m.el).addEventListener('click', save);
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
}
