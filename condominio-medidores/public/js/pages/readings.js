// Histórico de leituras no formato de planilha.
import { api } from '../api.js';
import { html, mount, icon, $, $$, fmtNum, fmtDate, todayISO, addDays, pref, emptyState } from '../util.js';
import { getCondos, currentCondo } from '../state.js';
import { condoSelect, typeDot } from '../components.js';
import { openReading, occurrenceShort } from './new-reading.js';
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

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** "fechamento ago" para uma leitura do dia 01/09. */
function closesLabel(iso) {
  const m = Number(iso.slice(5, 7));
  return MONTHS_SHORT[(m + 10) % 12];
}

/** Consumo estimado (ou motivo de não haver estimativa) de um dia sem leitura. */
function estCell(c, unit) {
  if (c.estimated !== null && c.estimated !== undefined) {
    return html`<span class="est" title="${c.reason_text}">est. ${fmtNum(c.estimated)} <small>${unit}</small></span>`;
  }
  return html`<span class="muted small" title="${c.reason_text}">${c.reason === 'historico' ? 'sem histórico p/ estimar' : 'sem estimativa'}</span>`;
}
/** Marca a leitura que veio depois de dias sem leitura (consumo registrado = medido − estimado). */
function gapMark(c, unit) {
  if (!c.gap) return '';
  return html`<span class="gap-mark" title="${`Intervalo de ${c.gap.days + 1} dias: ${fmtNum(c.gap.measured)} ${unit} medidos; ${fmtNum(c.gap.estimated)} ${unit} estimados para os dias sem leitura.`}">*</span>`;
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
  for (const r of rows) for (const c of Object.values(r.cells)) c.occurrence_label = c.occurrence ? occurrenceShort(c.occurrence) : '';
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
      ${rows.length ? html`<div class="sheet-cards show-mobile-block">${rows.map((r) => html`<div class="sheet-card">
          <div class="sc-head"><b>${fmtDate(r.date)}</b> <span class="muted">${r.weekday}${r.time ? ` · ${r.time}` : ''}${r.responsible ? ` · ${r.responsible}` : ''}</span>
            ${r.date.slice(8) === '01' ? html`<span class="badge b-blue">fechamento ${closesLabel(r.date)}</span>` : ''}</div>
          ${meters.filter((m) => r.cells[m.id]).map((m) => {
            const c = r.cells[m.id];
            if (c.missing) {
              return html`<div class="sc-row sc-missing">${typeDot(m.utility_type)}
                <span class="sc-name">${colTitle(m)}</span>
                <span class="sc-val"><span class="badge b-red">Leitura não realizada</span></span>
                <span class="sc-cons">${estCell(c, m.unit)}</span></div>`;
            }
            return html`<button type="button" class="sc-row" data-reading="${c.id}">${typeDot(m.utility_type)}
              <span class="sc-name">${colTitle(m)}</span>
              <span class="sc-val">${fmtNum(c.value)} <small>${m.unit}</small></span>
              <span class="sc-cons">${c.occurrence ? html`<span class="badge b-yellow">${c.occurrence_label}</span>` : c.registered !== null ? html`+${fmtNum(c.registered)}${gapMark(c, m.unit)}` : '—'}</span></button>`;
          })}
        </div>`)}</div>
        <div class="table-wrap hide-mobile"><table class="table sheet">
        <thead>
          <tr><th rowspan="2">Data</th><th rowspan="2">Dia</th>
            ${meters.map((m) => html`<th colspan="2" class="group gstart"><span style="display:inline-flex;gap:6px;align-items:center">${typeDot(m.utility_type)} ${colTitle(m)} (${m.unit})</span></th>`)}
            <th rowspan="2" class="gstart">Horário</th><th rowspan="2">Responsável</th></tr>
          <tr>${meters.map(() => html`<th class="num gstart">Leitura</th><th class="num">Consumo</th>`)}</tr>
        </thead>
        <tbody>${rows.map((r) => html`<tr>
          <td class="nowrap"><b>${fmtDate(r.date)}</b>${r.date.slice(8) === '01' ? html`<div><span class="badge b-blue" title="Fecha o mês anterior e é a leitura inicial do mês">fechamento ${closesLabel(r.date)}</span></div>` : ''}</td><td>${r.weekday}</td>
          ${meters.map((m) => {
            const c = r.cells[m.id];
            if (!c) return html`<td class="num gstart muted">—</td><td class="num muted">—</td>`;
            if (c.missing) {
              return html`<td class="num gstart"><span class="badge b-red" title="Não há leitura do medidor neste dia">Leitura não realizada</span></td>
                <td class="num">${estCell(c, m.unit)}</td>`;
            }
            return html`<td class="num gstart cell-click" data-reading="${c.id}" title="${c.notes ? `Obs.: ${c.notes}` : 'Ver detalhes'}">${fmtNum(c.value)}${c.notes ? html` ${icon('message-square', 'small')}` : ''}</td>
              <td class="num cons cell-click" data-reading="${c.id}">${c.occurrence ? html`<span class="badge b-yellow" title="Leitura com ocorrência: consumo não calculado">${c.occurrence_label}</span>` : html`${fmtNum(c.registered)}${gapMark(c, m.unit)}`}</td>`;
          })}
          <td class="gstart">${r.time}</td><td>${r.responsible || '—'}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td colspan="2">Consumo considerado</td>
          ${meters.map((m) => html`<td class="gstart"></td><td class="num cons">${fmtNum(totals[m.id])}${sheet.estimated_totals && sheet.estimated_totals[m.id] ? html`<div class="est-note">inclui ${fmtNum(sheet.estimated_totals[m.id])} estimado</div>` : ''}</td>`)}
          <td class="gstart" colspan="2"></td></tr></tfoot>
      </table></div>
      <div class="card-body small muted">${icon('info', 'small')} Toque em uma leitura para ver os detalhes. A leitura do dia 01 fecha o mês anterior e é a leitura inicial do mês.
        Nos dias com <b>leitura não realizada</b>, o consumo mostrado é uma <b>estimativa</b> pela média diária anterior (a leitura do medidor nunca é inventada);
        a leitura seguinte mostra só a parte registrada (*).</div>`
      : emptyState('clipboard-list', 'Nenhuma leitura no período', meters.length ? 'Registre a primeira leitura ou escolha outro período.' : 'Este condomínio ainda não tem medidores cadastrados.',
        meters.length ? html`<a class="btn btn-primary" href="#/leituras/nova">${icon('plus')} Registrar leitura</a>` : html`<a class="btn btn-primary" href="#/condominios/${condoId}">${icon('gauge')} Cadastrar medidores</a>`)}
    </div>`);

  $('#h-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go('leituras'); });
  $('#h-period', el).addEventListener('change', (e) => { pref.set('histPeriod', e.target.value); go('leituras'); });
  $$('[data-reading]', el).forEach((td) => td.addEventListener('click', () => openReading(td.dataset.reading, refresh)));
}
