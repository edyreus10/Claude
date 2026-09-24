// Cadastro de medidores.
import { api } from '../api.js';
import { html, mount, icon, $, $$, openModal, confirmDialog, formData, withBusy, toast, emptyState } from '../util.js';
import { state, getCondos, isAdmin, currentCondo, typeInfo, invalidateCondos } from '../state.js';
import { condoSelect, typeDot, FREQUENCIES, frequencyLabel } from '../components.js';
import { go, refresh } from '../app.js';

export async function render(el, ctx) {
  const condos = await getCondos();
  let condoId = currentCondo.get();
  if (condoId && !condos.some((c) => c.id === condoId)) condoId = '';
  const meters = await api.get('/api/meters', { condominium_id: condoId });
  if (!ctx.isCurrent()) return;
  const admin = isAdmin();

  const groups = [];
  for (const m of meters) {
    let g = groups.find((x) => x.id === m.condominium_id);
    if (!g) { g = { id: m.condominium_id, name: m.condominium_name, items: [] }; groups.push(g); }
    g.items.push(m);
  }

  mount(el, html`
    <div class="page-head">
      <div><h1>Medidores</h1><p>Água, gás, energia e outros medidores de cada condomínio.</p></div>
      <div class="page-actions">
        <div style="min-width:240px">${condoSelect(condos, { value: condoId, all: true, id: 'm-condo' })}</div>
        ${admin ? html`<button class="btn btn-primary" id="btn-new-meter">${icon('plus')} Novo medidor</button>` : ''}
      </div>
    </div>
    ${groups.length ? groups.map((g) => html`<div class="card section">
      <div class="card-head"><h2>${icon('building')} <a href="#/condominios/${g.id}">${g.name}</a></h2><span class="badge b-gray">${g.items.length} medidor(es)</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Medidor</th><th class="hide-mobile">Identificação</th><th class="hide-mobile">Localização</th><th class="hide-mobile">Concessionária</th><th class="hide-mobile">Frequência</th><th class="num hide-mobile">Leituras</th><th></th></tr></thead>
        <tbody>${g.items.map((m) => html`<tr>
          <td><div style="display:flex;gap:10px;align-items:center">${typeDot(m.utility_type)}<div>
            <div style="font-weight:600">${m.name} ${m.active ? '' : html`<span class="badge b-gray">Inativo</span>`}</div>
            <div class="small muted">${m.type_name} · ${m.unit} · ${m.kind === 'area' ? 'Área específica' : 'Principal'}</div></div></div></td>
          <td class="hide-mobile">${m.identifier || '—'}</td>
          <td class="hide-mobile">${m.location || '—'}</td>
          <td class="hide-mobile">${m.utility_company || '—'}</td>
          <td class="hide-mobile">${frequencyLabel(m.frequency_days)}</td>
          <td class="num hide-mobile">${m.readings_count}</td>
          <td class="actions">
            ${m.active ? html`<a class="icon-btn hide-mobile" href="#/leituras/nova?meter=${m.id}" title="Registrar leitura" aria-label="Registrar leitura">${icon('plus')}</a>` : ''}
            ${admin ? html`<button class="icon-btn" data-edit="${m.id}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
              <button class="icon-btn danger" data-del="${m.id}" title="Excluir" aria-label="Excluir">${icon('trash')}</button>` : ''}
          </td></tr>`)}</tbody></table></div></div>`)
    : html`<div class="card">${emptyState('gauge', 'Nenhum medidor cadastrado', condos.length ? 'Cadastre os medidores de água, gás e energia.' : 'Cadastre primeiro um condomínio.',
      admin ? (condos.length ? html`<button class="btn btn-primary" id="btn-new-meter-2">${icon('plus')} Novo medidor</button>` : html`<a class="btn btn-primary" href="#/condominios">${icon('plus')} Cadastrar condomínio</a>`) : '')}</div>`}
  `);

  $('#m-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go('medidores'); });
  const openNew = () => openMeterForm(null, { condominiumId: condoId, onSaved: refresh });
  $('#btn-new-meter', el)?.addEventListener('click', openNew);
  $('#btn-new-meter-2', el)?.addEventListener('click', openNew);
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => openMeterForm(meters.find((m) => m.id === Number(b.dataset.edit)), { onSaved: refresh })));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => deleteMeter(meters.find((m) => m.id === Number(b.dataset.del)), refresh)));
}

export async function deleteMeter(m, onDone) {
  const n = m.readings_count ?? 0;
  const ok = await confirmDialog({
    title: 'Excluir medidor',
    message: n
      ? html`O medidor <b>${m.name}</b> possui <b>${n} leitura(s)</b>. Ao excluir, todo o histórico dele será apagado.
        Se o medidor foi desligado, prefira editar e marcá-lo como <b>Inativo</b>.`
      : html`Deseja excluir o medidor <b>${m.name}</b>?`,
    confirmText: 'Excluir', danger: true, requireText: n ? 'excluir' : null,
  });
  if (!ok) return;
  try {
    await api.del(`/api/meters/${m.id}`);
    invalidateCondos();
    toast('Medidor excluído.');
    onDone();
  } catch (err) { toast(err.message, 'error'); }
}

export async function openMeterForm(meter, { condominiumId = '', onSaved }) {
  const condos = (await getCondos()).filter((c) => c.status === 'active' || (meter && c.id === meter.condominium_id));
  const types = state.meta.utility_types.filter((t) => t.active || (meter && t.code === meter.utility_type));
  const v = meter || { utility_type: 'agua', kind: 'principal', frequency_days: 7, active: 1, condominium_id: condominiumId };
  const hasReadings = meter && meter.readings_count > 0;
  const m = openModal({
    title: meter ? 'Editar medidor' : 'Novo medidor',
    body: html`<form class="form" id="meter-form" novalidate>
      ${meter ? html`<div class="field"><span class="label">Condomínio</span><div><b>${meter.condominium_name}</b></div></div>`
        : html`<div class="field"><label for="mf-condo">Condomínio *</label>${condoSelect(condos, { value: v.condominium_id, id: 'mf-condo', required: true })}</div>`}
      <div class="field"><span class="label">Tipo de medidor *</span>
        <div class="seg" id="mf-types" role="radiogroup">${types.map((t) => html`<button type="button" data-type="${t.code}" class="${t.code === v.utility_type ? 'active' : ''}" ${hasReadings && t.code !== v.utility_type ? 'disabled' : ''}>${t.name}</button>`)}</div>
        <input type="hidden" name="utility_type" value="${v.utility_type}">
      </div>
      <div class="form-row">
        <div class="field"><label for="mf-name">Nome do medidor *</label><input class="input" id="mf-name" name="name" value="${v.name || ''}" placeholder="Ex.: Hidrômetro principal" required></div>
        <div class="field"><label for="mf-id">Número / identificação</label><input class="input" id="mf-id" name="identifier" value="${v.identifier || ''}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="mf-unit">Unidade de medida</label><input class="input" id="mf-unit" name="unit" value="${v.unit || typeInfo(v.utility_type).unit}"></div>
        <div class="field"><label for="mf-kind">Tipo</label><select class="select" id="mf-kind" name="kind">
          <option value="principal" ${v.kind === 'principal' ? 'selected' : ''}>Principal</option>
          <option value="area" ${v.kind === 'area' ? 'selected' : ''}>Área específica</option></select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="mf-company">Concessionária</label><input class="input" id="mf-company" name="utility_company" value="${v.utility_company || ''}" placeholder="Ex.: Sabesp, Comgás, Enel" list="mf-companies">
          <datalist id="mf-companies"><option value="Sabesp"><option value="Comgás"><option value="Naturgy"><option value="Enel"><option value="CPFL"><option value="Light"><option value="Cemig"><option value="Copasa"><option value="Cedae"></datalist></div>
        <div class="field"><label for="mf-freq">Frequência de leitura</label><select class="select" id="mf-freq" name="frequency_days">
          ${FREQUENCIES.map(([d, l]) => html`<option value="${d}" ${Number(v.frequency_days) === d ? 'selected' : ''}>${l}</option>`)}
          ${FREQUENCIES.some(([d]) => d === Number(v.frequency_days)) ? '' : html`<option value="${v.frequency_days}" selected>A cada ${v.frequency_days} dias</option>`}
        </select></div>
      </div>
      <div class="field"><label for="mf-loc">Localização</label><input class="input" id="mf-loc" name="location" value="${v.location || ''}" placeholder="Ex.: Entrada — térreo"></div>
      <div class="field"><label for="mf-notes">Observações</label><textarea class="textarea" id="mf-notes" name="notes">${v.notes || ''}</textarea></div>
      ${meter ? html`<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Medidor ativo (desmarque se o medidor foi desligado)</label>` : ''}
      <div id="meter-error"></div>
    </form>`,
    footer: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="meter-save">${icon('save')} Salvar</button>`,
  });
  const form = $('#meter-form', m.el);
  $$('#mf-types button', m.el).forEach((b) => b.addEventListener('click', () => {
    $$('#mf-types button', m.el).forEach((x) => x.classList.toggle('active', x === b));
    const prevType = form.utility_type.value;
    form.utility_type.value = b.dataset.type;
    const unit = $('#mf-unit', m.el);
    if (!unit.value || unit.value === typeInfo(prevType).unit) unit.value = typeInfo(b.dataset.type).unit;
  }));
  const save = () => withBusy($('#meter-save', m.el), async () => {
    try {
      const d = formData(form);
      if (meter) d.active = !!d.active;
      const saved = meter ? await api.put(`/api/meters/${meter.id}`, d) : await api.post('/api/meters', d);
      invalidateCondos();
      m.close();
      toast(meter ? 'Medidor atualizado.' : 'Medidor cadastrado com sucesso.');
      onSaved(saved);
    } catch (err) {
      mount($('#meter-error', m.el), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message}</div></div>`);
    }
  });
  $('#meter-save', m.el).addEventListener('click', save);
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
}
