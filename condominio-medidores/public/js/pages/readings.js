// Histórico de leituras no formato de planilha.
import { api } from '../api.js';
import { html, mount, icon, $, $$, fmtNum, fmtDate, todayISO, addDays, pref, emptyState } from '../util.js';
import { getCondos, currentCondo } from '../state.js';
import { condoSelect, typeDot } from '../components.js';
import { openReading } from './new-reading.js';
import { go, refresh } from '../app.js';

export const PERIODS = [
  ['1', 'Este mês'], ['3', 'Últimos 3 meses'], ['6', 'Últimos 6 meses'], ['12', 'Últimos 12 meses'], ['all', 'Todo o histórico'],
];
export function periodRange(p) {
  const today = todayISO();
  if (p === 'all') return { from: '', to: '' };
  if (p === '1') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDays(today, -Math.round(Number(p) * 30.4)), to: today };
}

export function readingsTabs(active) {
  return html`<div class="tabs">
    <a href="#/leituras" class="${active === 'hist' ? 'active' : ''}">${icon('table')} Leituras do condomínio</a>
    <a href="#/leituras/concessionaria" class="${active === 'uc' ? 'active' : ''}">${icon('building')} Leituras da concessionária</a>
  </div>`;
}

export async function render(el, ctx) {
  const condos = await getCondos();
  if (!ctx.isCurrent()) return;
  let condoId = currentCondo.get();
  if (!condos.some((c) => c.id === Number(condoId))) condoId = condos.length ? condos.find((c) => c.status === 'active')?.id || condos[0].id : '';
  const period = pref.get('histPeriod', '3');

  const head = html`<div class="page-head">
      <div><h1>Leituras</h1><p>Histórico com consumo calculado automaticamente entre uma leitura e outra.</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/leituras/nova">${icon('plus')} Registrar leitura</a></div>
    </div>${readingsTabs('hist')}`;

  if (!condos.length) {
    mount(el, html`${head}<div class="card">${emptyState('building', 'Nenhum condomínio cadastrado', 'Cadastre um condomínio para começar.')}</div>`);
    return;
  }

  const { from, to } = periodRange(period);
  const sheet = await api.get('/api/readings/sheet', { condominium_id: condoId, from, to });
  if (!ctx.isCurrent()) return;
  currentCondo.set(condoId);
  const { meters, rows, totals } = sheet;
  const multi = (type) => meters.filter((m) => m.utility_type === type).length > 1;
  const colTitle = (m) => (multi(m.utility_type) ? `${m.type_name} — ${m.name}` : m.type_name);

  mount(el, html`${head}
    <div class="card section"><div class="card-body">
      <div class="filters">
        <div class="field wide"><label for="h-condo">Condomínio</label>${condoSelect(condos, { value: condoId, id: 'h-condo' })}</div>
        <div class="field"><label for="h-period">Período</label><select class="select" id="h-period">
          ${PERIODS.map(([v, l]) => html`<option value="${v}" ${v === period ? 'selected' : ''}>${l}</option>`)}</select></div>
        <a class="btn" href="#/relatorios/relatorio">${icon('file-down')} Gerar relatório</a>
      </div>
    </div></div>

    <div class="card">
      ${rows.length ? html`<div class="table-wrap"><table class="table sheet">
        <thead>
          <tr><th rowspan="2">Data</th><th rowspan="2">Dia</th>
            ${meters.map((m) => html`<th colspan="2" class="group gstart"><span style="display:inline-flex;gap:6px;align-items:center">${typeDot(m.utility_type)} ${colTitle(m)} (${m.unit})</span></th>`)}
            <th rowspan="2" class="gstart">Horário</th><th rowspan="2">Responsável</th></tr>
          <tr>${meters.map(() => html`<th class="num gstart">Leitura</th><th class="num">Consumo</th>`)}</tr>
        </thead>
        <tbody>${rows.map((r) => html`<tr>
          <td class="nowrap"><b>${fmtDate(r.date)}</b></td><td>${r.weekday}</td>
          ${meters.map((m) => {
            const c = r.cells[m.id];
            if (!c) return html`<td class="num gstart muted">—</td><td class="num muted">—</td>`;
            return html`<td class="num gstart cell-click" data-reading="${c.id}" title="${c.notes ? `Obs.: ${c.notes}` : 'Ver detalhes'}">${fmtNum(c.value)}${c.notes ? html` ${icon('message-square', 'small')}` : ''}</td>
              <td class="num cons cell-click" data-reading="${c.id}">${c.is_reset ? html`<span class="badge b-gray" title="Medidor trocado/zerado">troca</span>` : fmtNum(c.consumption)}</td>`;
          })}
          <td class="gstart">${r.time}</td><td>${r.responsible || '—'}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td colspan="2">Consumo no período</td>
          ${meters.map((m) => html`<td class="gstart"></td><td class="num cons">${fmtNum(totals[m.id])}</td>`)}
          <td class="gstart" colspan="2"></td></tr></tfoot>
      </table></div>
      <div class="card-body small muted">${icon('info', 'small')} Toque em uma leitura para ver os detalhes.</div>`
      : emptyState('clipboard-list', 'Nenhuma leitura no período', meters.length ? 'Registre a primeira leitura ou escolha outro período.' : 'Este condomínio ainda não tem medidores cadastrados.',
        meters.length ? html`<a class="btn btn-primary" href="#/leituras/nova">${icon('plus')} Registrar leitura</a>` : html`<a class="btn btn-primary" href="#/condominios/${condoId}">${icon('gauge')} Cadastrar medidores</a>`)}
    </div>`);

  $('#h-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go('leituras'); });
  $('#h-period', el).addEventListener('change', (e) => { pref.set('histPeriod', e.target.value); go('leituras'); });
  $$('[data-reading]', el).forEach((td) => td.addEventListener('click', () => openReading(td.dataset.reading, refresh)));
}
