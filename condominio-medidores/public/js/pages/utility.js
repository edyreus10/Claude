// Leituras realizadas pelas concessionárias (datas oficiais, comprovantes).
import { api } from '../api.js';
import { html, mount, icon, $, $$, openModal, confirmDialog, withBusy, toast, fmtNum, fmtDate, todayISO, numInput, emptyState, diffDays } from '../util.js';
import { getCondos, currentCondo, isAdmin, activeTypes } from '../state.js';
import { condoSelect, typeDot } from '../components.js';
import { readingsTabs } from './readings.js';
import { go, refresh } from '../app.js';

export async function render(el, ctx) {
  const condos = await getCondos();
  let condoId = currentCondo.get();
  if (condoId && !condos.some((c) => c.id === Number(condoId))) condoId = '';
  const type = ctx.query.tipo || '';
  const rows = await api.get('/api/utility-readings', { condominium_id: condoId, utility_type: type });
  if (!ctx.isCurrent()) return;
  const admin = isAdmin();
  const today = todayISO();

  mount(el, html`
    <div class="page-head">
      <div><h1>Leituras</h1><p>Datas e valores das leituras oficiais feitas pelas concessionárias.</p></div>
      <div class="page-actions"><button class="btn btn-primary" id="btn-new-uc">${icon('plus')} Registrar leitura da concessionária</button></div>
    </div>
    ${readingsTabs('uc')}
    <div class="card section"><div class="card-body"><div class="filters">
      <div class="field wide"><label for="u-condo">Condomínio</label>${condoSelect(condos, { value: condoId, all: true, id: 'u-condo' })}</div>
      <div class="field"><label for="u-type">Concessionária</label><select class="select" id="u-type">
        <option value="">Todas</option>${activeTypes().map((t) => html`<option value="${t.code}" ${t.code === type ? 'selected' : ''}>${t.name}</option>`)}</select></div>
    </div></div></div>

    <div class="card">
      ${rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Data</th><th>Medidor</th><th class="hide-mobile">Condomínio</th><th class="num">Leitura registrada</th>
          <th class="hide-mobile">Concessionária</th><th>Próxima leitura</th><th class="hide-mobile">Observação</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const days = r.next_reading_date ? diffDays(today, r.next_reading_date) : null;
          return html`<tr>
          <td class="nowrap"><b>${fmtDate(r.reading_date)}</b></td>
          <td><div style="display:flex;gap:8px;align-items:center">${typeDot(r.utility_type)}<div><div style="font-weight:600">${r.type_name}</div>
            <div class="small muted">${r.meter_name}<span class="show-mobile"> · ${r.condominium_name}</span></div></div></div></td>
          <td class="hide-mobile">${r.condominium_name}</td>
          <td class="num">${r.value !== null ? `${fmtNum(r.value)} ${r.unit}` : '—'}</td>
          <td class="hide-mobile">${r.company || '—'}</td>
          <td class="nowrap">${r.next_reading_date ? html`${fmtDate(r.next_reading_date)}
            ${days !== null && days >= 0 && days <= 7 ? html` <span class="badge b-blue">${days === 0 ? 'hoje' : `em ${days}d`}</span>` : ''}` : '—'}</td>
          <td class="hide-mobile small">${r.notes || ''}</td>
          <td class="actions">
            ${r.has_attachment ? html`<a class="icon-btn" href="/api/utility-readings/${r.id}/attachment" target="_blank" rel="noopener" title="Ver comprovante" aria-label="Ver comprovante">${icon('paperclip')}</a>` : ''}
            ${admin ? html`<button class="icon-btn" data-edit="${r.id}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
              <button class="icon-btn danger" data-del="${r.id}" title="Excluir" aria-label="Excluir">${icon('trash')}</button>` : ''}
          </td></tr>`;
        })}</tbody></table></div>`
      : emptyState('building', 'Nenhuma leitura da concessionária', 'Registre aqui a data em que a concessionária fez a leitura oficial.',
        html`<button class="btn btn-primary" id="btn-new-uc-2">${icon('plus')} Registrar leitura da concessionária</button>`)}
    </div>`);

  $('#u-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go(`leituras/concessionaria${type ? `?tipo=${type}` : ''}`); });
  $('#u-type', el).addEventListener('change', (e) => go(`leituras/concessionaria${e.target.value ? `?tipo=${e.target.value}` : ''}`));
  const openNew = () => openUtilityForm(null, { condominiumId: condoId, onSaved: refresh });
  $('#btn-new-uc', el).addEventListener('click', openNew);
  $('#btn-new-uc-2', el)?.addEventListener('click', openNew);
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => openUtilityForm(rows.find((r) => r.id === Number(b.dataset.edit)), { onSaved: refresh })));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = rows.find((x) => x.id === Number(b.dataset.del));
    const ok = await confirmDialog({ title: 'Excluir registro', danger: true, confirmText: 'Excluir',
      message: html`Excluir a leitura da concessionária de <b>${r.type_name.toLowerCase()}</b> do dia <b>${fmtDate(r.reading_date)}</b>${r.has_attachment ? ' e o comprovante anexado' : ''}?` });
    if (!ok) return;
    try { await api.del(`/api/utility-readings/${r.id}`); toast('Registro excluído.'); refresh(); } catch (err) { toast(err.message, 'error'); }
  }));
}

export async function openUtilityForm(rec, { condominiumId = '', onSaved }) {
  const condos = (await getCondos()).filter((c) => c.status === 'active');
  const m = openModal({
    title: rec ? 'Editar leitura da concessionária' : 'Leitura da concessionária',
    body: html`<form class="form" id="uf" novalidate>
      ${rec ? html`<div class="muted">${rec.condominium_name} · <b>${rec.type_name} — ${rec.meter_name}</b></div>` : html`
        <div class="field"><label for="uf-condo">Condomínio</label>${condoSelect(condos, { value: condominiumId, id: 'uf-condo' })}</div>
        <div class="field"><label for="uf-meter">Concessionária / medidor</label><select class="select" id="uf-meter" name="meter_id" disabled><option>Selecione o condomínio</option></select></div>`}
      <div class="form-row">
        <div class="field"><label for="uf-date">Data da leitura</label><input class="input" type="date" id="uf-date" name="reading_date" value="${rec ? rec.reading_date : todayISO()}"></div>
        <div class="field"><label for="uf-value">Leitura registrada</label><div class="input-group"><input class="input" id="uf-value" name="value" inputmode="decimal" value="${rec ? numInput(rec.value) : ''}" placeholder="opcional"><span class="addon" id="uf-unit">${rec ? rec.unit : ''}</span></div></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="uf-company">Concessionária</label><input class="input" id="uf-company" name="company" value="${rec ? rec.company || '' : ''}"></div>
        <div class="field"><label for="uf-next">Próxima leitura prevista</label><input class="input" type="date" id="uf-next" name="next_reading_date" value="${rec ? rec.next_reading_date || '' : ''}">
          <span class="hint">Consta na conta. Usada nos alertas e no calendário.</span></div>
      </div>
      <div class="field"><label for="uf-notes">Observação</label><textarea class="textarea" id="uf-notes" name="notes">${rec ? rec.notes || '' : ''}</textarea></div>
      <div class="field"><label for="uf-file">Comprovante / anexo (PDF ou foto)</label>
        <input class="input" type="file" id="uf-file" name="attachment" accept="application/pdf,image/*">
        ${rec && rec.has_attachment ? html`<label class="check" style="margin-top:6px"><input type="checkbox" id="uf-remove"> Remover o comprovante atual (${rec.attachment_name || 'arquivo'})</label>` : ''}</div>
      <div id="uf-error"></div>
    </form>`,
    footer: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="uf-save">${icon('save')} Salvar</button>`,
  });
  const q = (s) => $(s, m.el);
  let meters = [];
  if (!rec) {
    const load = async () => {
      const cid = q('#uf-condo').value;
      const sel = q('#uf-meter');
      if (!cid) { sel.disabled = true; mount(sel, html`<option>Selecione o condomínio</option>`); return; }
      meters = await api.get('/api/meters', { condominium_id: cid, active: '1' });
      sel.disabled = !meters.length;
      mount(sel, meters.length ? html`${meters.map((x) => html`<option value="${x.id}">${x.type_name} — ${x.name}${x.utility_company ? ` (${x.utility_company})` : ''}</option>`)}`
        : html`<option>Nenhum medidor ativo</option>`);
      sync();
    };
    const sync = () => {
      const mt = meters.find((x) => x.id === Number(q('#uf-meter').value));
      q('#uf-unit').textContent = mt ? mt.unit : '';
      if (mt && !q('#uf-company').dataset.touched) q('#uf-company').value = mt.utility_company || '';
    };
    q('#uf-condo').addEventListener('change', load);
    q('#uf-meter').addEventListener('change', sync);
    q('#uf-company').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
    load();
  }
  q('#uf-save').addEventListener('click', () => withBusy(q('#uf-save'), async () => {
    const fd = new FormData(q('#uf'));
    if (!rec) fd.set('meter_id', q('#uf-meter').value);
    if (q('#uf-remove')?.checked) fd.set('remove_attachment', '1');
    if (!q('#uf-file').files.length) fd.delete('attachment');
    try {
      if (rec) await api.put(`/api/utility-readings/${rec.id}`, fd);
      else await api.post('/api/utility-readings', fd);
      m.close();
      toast(rec ? 'Registro atualizado.' : 'Leitura da concessionária registrada.');
      onSaved();
    } catch (err) {
      mount(q('#uf-error'), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message}</div></div>`);
    }
  }));
}
