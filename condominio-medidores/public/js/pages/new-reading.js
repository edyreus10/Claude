// Registro de leitura (tela simples, pensada para o celular) e edição de leitura.
import { api } from '../api.js';
import { html, mount, icon, $, openModal, confirmDialog, withBusy, toast, fmtNum, fmtDate, todayISO, nowTime, parseNumber, numInput, diffDays, weekday, capital, emptyState } from '../util.js';
import { state, activeCondos, currentCondo, isAdmin } from '../state.js';
import { condoSelect } from '../components.js';

let responsiblesCache = null;
async function responsibles() {
  if (!responsiblesCache) responsiblesCache = await api.get('/api/users/responsibles');
  return responsiblesCache;
}

function responsibleField(list, value) {
  const names = list.map((u) => u.name);
  const isOther = value && !names.includes(value);
  return html`<div class="field"><label for="r-resp">Responsável</label>
    <select class="select" id="r-resp">
      ${names.map((n) => html`<option value="${n}" ${n === value ? 'selected' : ''}>${n}</option>`)}
      <option value="__other" ${isOther ? 'selected' : ''}>Outra pessoa...</option>
    </select>
    <input class="input" id="r-resp-other" placeholder="Nome de quem fez a leitura" value="${isOther ? value : ''}" ${isOther ? '' : 'hidden'} style="margin-top:6px">
  </div>`;
}
function bindResponsible(root) {
  const sel = $('#r-resp', root);
  const other = $('#r-resp-other', root);
  sel.addEventListener('change', () => { other.hidden = sel.value !== '__other'; if (!other.hidden) other.focus(); });
  return () => (sel.value === '__other' ? other.value.trim() : sel.value);
}

/** Atualiza as caixas "Leitura anterior" e "Consumo". */
function renderPreview(box, { prev, next, value, unit, date, isReset }) {
  const n = parseNumber(value);
  let consumo = '—'; let consumoSub = 'digite a leitura atual'; let bad = false;
  if (!prev) {
    consumoSub = 'primeira leitura deste medidor';
  } else if (n === null) {
    consumoSub = 'digite a leitura atual';
  } else if (Number.isNaN(n)) {
    consumo = '?'; consumoSub = 'número inválido'; bad = true;
  } else if (isReset) {
    consumoSub = 'medidor trocado/zerado — sem consumo';
  } else {
    const c = Math.round((n - prev.value) * 1000) / 1000;
    consumo = `${fmtNum(c)} ${unit}`;
    const days = date ? diffDays(prev.reading_date, date) : null;
    consumoSub = days !== null && days > 0 ? `em ${days} dia${days > 1 ? 's' : ''}` : '';
    if (c < 0) { bad = true; consumoSub = 'menor que a anterior!'; }
  }
  const nextWarn = next && n !== null && !Number.isNaN(n) && !next.is_reset && n > next.value;
  mount(box, html`<div class="prev-box">
      <div><div class="k">Leitura anterior</div>
        <div class="v">${prev ? html`${fmtNum(prev.value)} <small>${unit}</small>` : '—'}</div>
        <div class="d">${prev ? `${fmtDate(prev.reading_date)} às ${prev.reading_time}` : 'nenhuma leitura anterior'}</div></div>
      <div class="consumo ${bad ? 'bad' : ''}"><div class="k">Consumo</div><div class="v">${consumo}</div><div class="d">${consumoSub}</div></div>
    </div>
    ${nextWarn ? html`<div class="alert alert-warning" style="margin-top:10px">${icon('triangle-alert')}<div>Já existe uma leitura posterior (${fmtNum(next.value)} ${unit} em ${fmtDate(next.reading_date)}) menor que este valor. Confira.</div></div>` : ''}`);
  return { lower: bad && prev && n !== null && !Number.isNaN(n) && n < prev.value };
}

export async function render(el, ctx) {
  const condos = await activeCondos();
  if (!ctx.isCurrent()) return;
  if (!condos.length) {
    mount(el, html`<div class="card">${emptyState('building', 'Nenhum condomínio ativo', 'Cadastre um condomínio e seus medidores antes de registrar leituras.',
      html`<a class="btn btn-primary" href="#/condominios">${icon('plus')} Cadastrar condomínio</a>`)}</div>`);
    return;
  }
  const users = await responsibles();
  let meterFromQuery = null;
  if (ctx.query.meter) {
    try { meterFromQuery = await api.get(`/api/meters/${ctx.query.meter}`); } catch { /* ignora */ }
  }
  let condoId = meterFromQuery ? meterFromQuery.condominium_id : currentCondo.get();
  if (!condos.some((c) => c.id === Number(condoId))) condoId = condos.length === 1 ? condos[0].id : '';
  if (!ctx.isCurrent()) return;

  mount(el, html`<div class="reading-form">
    <div class="page-head"><div><h1>Novo registro</h1><p>Selecione, preencha e salve. O consumo é calculado automaticamente.</p></div></div>
    <div class="card card-pad" id="rf-card">
      <form class="form" id="rf" novalidate>
        <div class="field"><label for="r-condo">Condomínio</label>${condoSelect(condos, { value: condoId, id: 'r-condo' })}</div>
        <div class="field"><label for="r-meter">Medidor</label><select class="select" id="r-meter" disabled><option>Selecione o condomínio</option></select></div>
        <div class="form-row">
          <div class="field"><label for="r-date">Data</label><input class="input" type="date" id="r-date" value="${todayISO()}" max="${todayISO()}" required>
            <span class="hint" id="r-weekday"></span></div>
          <div class="field"><label for="r-time">Horário</label><input class="input" type="time" id="r-time" value="${nowTime()}" required></div>
        </div>
        <div class="field"><label for="r-value">Leitura atual</label>
          <div class="input-group"><input class="input input-lg" id="r-value" inputmode="decimal" autocomplete="off" placeholder="0,0"><span class="addon" id="r-unit">m³</span></div></div>
        <div id="r-preview"></div>
        <label class="check" id="r-reset-wrap" hidden><input type="checkbox" id="r-reset"> O medidor foi trocado ou zerado (não calcular consumo desta leitura)</label>
        ${responsibleField(users, state.user.name)}
        <div class="field" id="r-notes-wrap" hidden><label for="r-notes">Observação</label><textarea class="textarea" id="r-notes" maxlength="1000"></textarea></div>
        <button type="button" class="btn btn-ghost btn-sm" id="r-add-notes" style="align-self:flex-start">${icon('plus')} Adicionar observação</button>
        <div id="r-error"></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit" id="r-save">${icon('check')} SALVAR LEITURA</button>
      </form>
    </div></div>`);

  const f = {
    condo: $('#r-condo', el), meter: $('#r-meter', el), date: $('#r-date', el), time: $('#r-time', el),
    value: $('#r-value', el), unit: $('#r-unit', el), preview: $('#r-preview', el), reset: $('#r-reset', el),
    resetWrap: $('#r-reset-wrap', el), notes: $('#r-notes', el),
  };
  const getResp = bindResponsible(el);
  let meters = [];
  let prevInfo = { prev: null, next: null };
  let seq = 0;

  const meterObj = () => meters.find((m) => m.id === Number(f.meter.value));
  const update = () => {
    const m = meterObj();
    f.unit.textContent = m ? m.unit : '';
    $('#r-weekday', el).textContent = f.date.value ? capital(weekday(f.date.value)) : '';
    const r = renderPreview(f.preview, { ...prevInfo, value: f.value.value, unit: m ? m.unit : '', date: f.date.value, isReset: f.reset.checked });
    f.resetWrap.hidden = !(r.lower || f.reset.checked);
  };
  const loadPrev = async () => {
    const m = meterObj();
    if (!m) { prevInfo = { prev: null, next: null }; update(); return; }
    const my = ++seq;
    const d = await api.get(`/api/meters/${m.id}/previous`, { date: f.date.value, time: f.time.value });
    if (my !== seq) return;
    prevInfo = { prev: d.previous, next: d.next };
    update();
  };
  const loadMeters = async (preferId) => {
    const cid = f.condo.value;
    if (!cid) { f.meter.disabled = true; mount(f.meter, html`<option>Selecione o condomínio</option>`); meters = []; loadPrev(); return; }
    currentCondo.set(cid);
    meters = await api.get('/api/meters', { condominium_id: cid, active: '1' });
    f.meter.disabled = !meters.length;
    mount(f.meter, meters.length
      ? html`${meters.map((m) => html`<option value="${m.id}" ${m.id === Number(preferId) ? 'selected' : ''}>${m.type_name} — ${m.name}</option>`)}`
      : html`<option>Nenhum medidor ativo neste condomínio</option>`);
    loadPrev();
  };

  f.condo.addEventListener('change', () => loadMeters());
  f.meter.addEventListener('change', loadPrev);
  f.date.addEventListener('change', loadPrev);
  f.time.addEventListener('change', loadPrev);
  f.value.addEventListener('input', update);
  f.reset.addEventListener('change', update);
  $('#r-add-notes', el).addEventListener('click', (e) => { e.currentTarget.hidden = true; $('#r-notes-wrap', el).hidden = false; f.notes.focus(); });

  await loadMeters(meterFromQuery ? meterFromQuery.id : ctx.query.next);

  $('#rf', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const showErr = (msg) => mount($('#r-error', el), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${msg}</div></div>`);
    const m = meterObj();
    if (!m) return showErr('Selecione o medidor.');
    const n = parseNumber(f.value.value);
    if (n === null) { f.value.focus(); return showErr('Digite a leitura atual do medidor.'); }
    if (Number.isNaN(n)) { f.value.focus(); return showErr('A leitura deve ser um número. Ex.: 498,0'); }
    mount($('#r-error', el), '');
    withBusy($('#r-save', el), async () => {
      try {
        const saved = await api.post('/api/readings', {
          meter_id: m.id, reading_date: f.date.value, reading_time: f.time.value, value: n,
          is_reset: f.reset.checked, responsible: getResp(), notes: f.notes.value,
        });
        showSuccess(el, saved, m, meters);
      } catch (err) {
        if (err.code === 'LOWER_THAN_PREVIOUS') f.resetWrap.hidden = false;
        showErr(err.message);
      }
    });
  });
}

function showSuccess(el, saved, meter, meters) {
  const idx = meters.findIndex((m) => m.id === meter.id);
  const nextMeter = meters[idx + 1];
  mount($('#rf-card', el), html`<div class="success-box">
    <div class="ok">${icon('check')}</div>
    <h2>Leitura registrada com sucesso.</h2>
    <p class="muted" style="margin:0">${saved.condominium_name} · ${saved.type_name} — ${saved.meter_name}</p>
    <div class="prev-box" style="max-width:420px;margin:18px auto 0;text-align:left">
      <div><div class="k">Leitura</div><div class="v">${fmtNum(saved.value)} <small>${saved.unit}</small></div><div class="d">${fmtDate(saved.reading_date)} às ${saved.reading_time}</div></div>
      <div class="consumo"><div class="k">Consumo</div><div class="v">${saved.consumption !== null ? `${fmtNum(saved.consumption)} ${saved.unit}` : '—'}</div>
        <div class="d">${saved.prev_value !== null ? `desde ${fmtDate(saved.prev_date)}` : 'primeira leitura'}</div></div>
    </div>
    <div class="actions">
      ${nextMeter ? html`<a class="btn btn-primary btn-lg" style="white-space:normal" href="#/leituras/nova?meter=${nextMeter.id}">${icon('arrow-right')} Próxima: ${nextMeter.type_name}</a>` : ''}
      <a class="btn ${nextMeter ? '' : 'btn-primary'} btn-lg" href="#/leituras/nova?meter=${meter.id}&t=${Date.now()}">${icon('plus')} Registrar outra leitura</a>
      <a class="btn btn-ghost" href="#/leituras">${icon('table')} Ver histórico</a>
    </div>
  </div>`);
  toast('Leitura registrada com sucesso.');
  window.scrollTo(0, 0);
}

/** Modal de detalhes da leitura, com edição e exclusão para administradores. */
export async function openReading(readingId, onChanged) {
  const r = await api.get(`/api/readings/${readingId}`);
  const admin = isAdmin();
  const m = openModal({
    title: `${r.type_name} — ${fmtDate(r.reading_date)}`,
    body: html`<dl class="kv">
      <dt>Condomínio</dt><dd>${r.condominium_name}</dd>
      <dt>Medidor</dt><dd>${r.meter_name}</dd>
      <dt>Data</dt><dd>${fmtDate(r.reading_date)} (${r.weekday}) às ${r.reading_time}</dd>
      <dt>Leitura</dt><dd><b>${fmtNum(r.value)} ${r.unit}</b></dd>
      <dt>Leitura anterior</dt><dd>${r.prev_value !== null ? `${fmtNum(r.prev_value)} ${r.unit} (${fmtDate(r.prev_date)})` : '—'}</dd>
      <dt>Consumo</dt><dd><b style="color:var(--primary)">${r.consumption !== null ? `${fmtNum(r.consumption)} ${r.unit}` : '—'}</b>${r.is_reset ? ' (medidor trocado/zerado)' : ''}</dd>
      <dt>Responsável</dt><dd>${r.responsible || '—'}</dd>
      <dt>Observação</dt><dd>${r.notes || '—'}</dd>
      <dt>Registrado em</dt><dd>${fmtDate(r.created_at)} ${r.created_at.slice(11, 16)}${r.updated_at !== r.created_at ? ` · alterado em ${fmtDate(r.updated_at)} ${r.updated_at.slice(11, 16)}` : ''}</dd>
    </dl>`,
    footer: admin ? html`<button class="btn btn-ghost" id="rd-del" style="color:var(--danger);margin-right:auto">${icon('trash')} Excluir</button>
      <button class="btn" data-close>Fechar</button><button class="btn btn-primary" id="rd-edit">${icon('pencil')} Editar</button>`
      : html`<button class="btn" data-close>Fechar</button>`,
  });
  if (!admin) return;
  $('#rd-edit', m.el).addEventListener('click', () => { m.close(); openEditReading(r, onChanged); });
  $('#rd-del', m.el).addEventListener('click', async () => {
    m.close();
    const ok = await confirmDialog({ title: 'Excluir leitura', danger: true, confirmText: 'Excluir',
      message: html`Deseja excluir a leitura de <b>${r.type_name.toLowerCase()}</b> do dia <b>${fmtDate(r.reading_date)}</b> (${fmtNum(r.value)} ${r.unit})?
        O consumo da leitura seguinte será recalculado automaticamente.` });
    if (!ok) return;
    try { await api.del(`/api/readings/${r.id}`); toast('Leitura excluída.'); onChanged(); } catch (err) { toast(err.message, 'error'); }
  });
}

async function openEditReading(r, onChanged) {
  const users = await responsibles();
  const m = openModal({
    title: 'Editar leitura',
    body: html`<form class="form" id="er" novalidate>
      <div class="muted">${r.condominium_name} · <b>${r.type_name} — ${r.meter_name}</b></div>
      <div class="form-row">
        <div class="field"><label for="e-date">Data</label><input class="input" type="date" id="e-date" value="${r.reading_date}" max="${todayISO()}"></div>
        <div class="field"><label for="e-time">Horário</label><input class="input" type="time" id="e-time" value="${r.reading_time}"></div>
      </div>
      <div class="field"><label for="e-value">Leitura</label><div class="input-group"><input class="input input-lg" id="e-value" inputmode="decimal" value="${numInput(r.value)}"><span class="addon">${r.unit}</span></div></div>
      <div id="e-preview"></div>
      <label class="check"><input type="checkbox" id="e-reset" ${r.is_reset ? 'checked' : ''}> Medidor trocado ou zerado nesta leitura</label>
      ${responsibleField(users, r.responsible || '')}
      <div class="field"><label for="e-notes">Observação</label><textarea class="textarea" id="e-notes">${r.notes || ''}</textarea></div>
      <div class="alert alert-info">${icon('info')}<div>A alteração ficará registrada na auditoria.</div></div>
      <div id="e-error"></div>
    </form>`,
    footer: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="e-save">${icon('save')} Salvar alteração</button>`,
  });
  const q = (s) => $(s, m.el);
  const getResp = bindResponsible(m.el);
  let info = { prev: null, next: null };
  const update = () => renderPreview(q('#e-preview'), { ...info, value: q('#e-value').value, unit: r.unit, date: q('#e-date').value, isReset: q('#e-reset').checked });
  const load = async () => {
    const d = await api.get(`/api/meters/${r.meter_id}/previous`, { date: q('#e-date').value, time: q('#e-time').value, exclude_id: r.id });
    info = { prev: d.previous, next: d.next };
    update();
  };
  ['#e-date', '#e-time'].forEach((s) => q(s).addEventListener('change', load));
  q('#e-value').addEventListener('input', update);
  q('#e-reset').addEventListener('change', update);
  load();
  q('#e-save').addEventListener('click', () => withBusy(q('#e-save'), async () => {
    try {
      await api.put(`/api/readings/${r.id}`, {
        reading_date: q('#e-date').value, reading_time: q('#e-time').value, value: q('#e-value').value,
        is_reset: q('#e-reset').checked, responsible: getResp(), notes: q('#e-notes').value,
      });
      m.close();
      toast('Leitura alterada com sucesso.');
      onChanged();
    } catch (err) {
      mount(q('#e-error'), html`<div class="alert alert-danger">${icon('circle-alert')}<div>${err.message}</div></div>`);
    }
  }));
}

