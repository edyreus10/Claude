// Relatórios: fechamento do mês, gráficos e relatório para exportação.
import { api, qs } from '../api.js';
import { html, mount, icon, $, $$, fmtNum, fmtDate, fmtDateTime, capital, pref, monthOptions, yearOptions, confirmDialog, withBusy, toast, emptyState, pct } from '../util.js';
import { state, getCondos, currentCondo, isAdmin, activeTypes } from '../state.js';
import { condoSelect, typeDot } from '../components.js';
import { go, refresh, logo } from '../app.js';
import { occurrenceLabel } from './new-reading.js';

const charts = [];
function destroyCharts() { while (charts.length) charts.pop().destroy(); }

function tabs(active) {
  const t = [['fechamento', 'Fechamento do mês', 'calculator'], ['graficos', 'Gráficos', 'chart-line'], ['relatorio', 'Relatório', 'file-text']];
  return html`<div class="tabs">${t.map(([k, l, i]) => html`<a href="#/relatorios/${k}" class="${k === active ? 'active' : ''}">${icon(i)} ${l}</a>`)}</div>`;
}

function head() {
  return html`<div class="page-head"><div><h1>Relatórios</h1><p>Fechamento mensal, gráficos de consumo e relatórios para exportar.</p></div></div>`;
}

function selectedPeriod() {
  const now = new Date();
  const p = pref.get('period', null);
  return { year: p ? p.year : now.getFullYear(), month: p ? p.month : now.getMonth() + 1 };
}

export async function render(el, ctx) {
  destroyCharts();
  const tab = ctx.params[0] || 'fechamento';
  const condos = await getCondos();
  if (!ctx.isCurrent()) return;
  if (!condos.length) {
    mount(el, html`${head()}${tabs(tab)}<div class="card">${emptyState('building', 'Nenhum condomínio cadastrado', 'Cadastre um condomínio para gerar relatórios.')}</div>`);
    return;
  }
  if (tab === 'graficos') return renderCharts(el, ctx, condos);
  if (tab === 'relatorio') return renderReport(el, ctx, condos);
  return renderClosing(el, ctx, condos);
}

function defaultCondo(condos, allowAll = false) {
  let id = currentCondo.get();
  if (id && condos.some((c) => c.id === Number(id))) return id;
  if (allowAll) return '';
  return (condos.find((c) => c.status === 'active') || condos[0]).id;
}

function periodFilters(condos, condoId, { year, month }, { allMonths = false } = {}) {
  return html`
    <div class="field wide"><label for="p-condo">Condomínio</label>${condoSelect(condos, { value: condoId, id: 'p-condo' })}</div>
    <div class="field"><label for="p-month">Mês</label><select class="select" id="p-month">
      ${allMonths ? html`<option value="0" ${Number(month) === 0 ? 'selected' : ''}>Ano inteiro</option>` : ''}${monthOptions(month)}</select></div>
    <div class="field narrow"><label for="p-year">Ano</label><select class="select" id="p-year">${yearOptions(year)}</select></div>`;
}

function bindPeriod(el, route) {
  const save = () => {
    currentCondo.set($('#p-condo', el).value);
    pref.set('period', { year: Number($('#p-year', el).value), month: Number($('#p-month', el).value) });
    go(route);
  };
  ['#p-condo', '#p-month', '#p-year'].forEach((s) => $(s, el)?.addEventListener('change', save));
}

// ---------------------------------------------------------------- Fechamento
async function renderClosing(el, ctx, condos) {
  const condoId = defaultCondo(condos);
  const per = selectedPeriod();
  if (!per.month) per.month = new Date().getMonth() + 1;
  const c = await api.get('/api/closing', { condominium_id: condoId, year: per.year, month: per.month });
  if (!ctx.isCurrent()) return;
  const admin = isAdmin();
  const withData = c.items.filter((i) => i.readings_count);
  const changed = c.is_closed && c.items.some((i) => i.changed_since_closing);

  const trend = (v, label) => (v === null || v === undefined ? '' : html`<span><span class="${v > 0 ? 'trend-up' : v < 0 ? 'trend-down' : ''}">${pct(v)}</span> ${label}</span>`);

  mount(el, html`${head()}${tabs('fechamento')}
    <div class="card section"><div class="card-body"><div class="filters">
      ${periodFilters(condos, condoId, per)}
      <a class="btn" href="#/relatorios/relatorio">${icon('file-down')} Gerar relatório</a>
    </div></div></div>

    <div class="card section"><div class="card-body" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;justify-content:space-between">
      <div>
        <div style="font-size:18px;font-weight:700">${c.condominium.name} — ${capital(c.month_name)} de ${c.year}</div>
        <div class="muted">${c.period_start ? html`Período das leituras: <b>${fmtDate(c.period_start)}</b> a <b>${fmtDate(c.period_end)}</b> · <b>${c.period_days} dias</b>` : 'Sem leituras neste mês.'}
          · Mês com ${c.days_in_month} dias</div>
        <div class="small muted" style="margin-top:4px">${icon('info', 'small')} Regra: a leitura do dia 01 fecha o mês anterior e é a leitura inicial do mês.
          O consumo do mês vai da leitura inicial até a leitura do dia 01 do mês seguinte (ou a última leitura registrada).</div>
      </div>
      <div class="page-actions">
        ${c.is_closed ? html`<span class="badge b-green">${icon('lock')} Mês fechado em ${fmtDateTime(c.closed_at)}${c.closed_by_name ? ` por ${c.closed_by_name}` : ''}</span>` : html`<span class="badge b-yellow">Mês em aberto</span>`}
        ${admin && withData.length ? html`<button class="btn btn-primary" id="btn-close">${icon('lock')} ${c.is_closed ? 'Atualizar fechamento' : 'Fechar o mês'}</button>` : ''}
        ${admin && c.is_closed ? html`<button class="btn" id="btn-reopen">Reabrir</button>` : ''}
      </div>
    </div>
    ${changed ? html`<div class="card-body" style="padding-top:0"><div class="alert alert-warning">${icon('triangle-alert')}<div>Algumas leituras foram alteradas depois do fechamento. Confira e clique em <b>Atualizar fechamento</b>.</div></div></div>` : ''}
    </div>

    ${c.items.length ? html`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr))">
      ${c.items.map((i) => html`<div class="card closing-card">
        <div class="card-head"><h3>${typeDot(i.utility_type)} ${i.type_name}</h3><span class="muted small">${i.meter_name}${i.kind === 'area' ? ' (área)' : ''}</span></div>
        <div class="card-body">
          ${i.readings_count ? html`<div class="rows">
            <div><div class="k">Leitura inicial</div><div class="v">${fmtNum(i.initial_value)}</div><div class="d">${fmtDate(i.initial_date)}</div></div>
            <div><div class="k">Leitura final</div><div class="v">${fmtNum(i.final_value)}</div><div class="d">${fmtDate(i.final_date)}</div></div>
            <div class="total"><div class="k">Consumo total</div><div class="v">${fmtNum(i.consumption)} <small>${i.unit}</small></div><div class="d">${i.days} dias · ${i.readings_count} leitura(s)</div></div>
          </div>
          <div class="small" style="margin-top:12px;display:flex;gap:14px;flex-wrap:wrap">
            ${i.average !== null ? html`<span>Média 6 meses: <b>${fmtNum(i.average)} ${i.unit}</b></span>` : ''}
            ${trend(i.vs_average_pct, 'vs. média')}
            ${trend(i.vs_last_pct, 'vs. mês anterior')}
          </div>
          ${i.has_reset ? html`<div class="small muted" style="margin-top:6px">${icon('info', 'small')} Houve ocorrência (troca, zeramento ou correção) neste mês: o consumo não é "final − inicial".</div>` : ''}
          ${i.changed_since_closing ? html`<div class="small" style="margin-top:6px;color:var(--warning)">${icon('triangle-alert', 'small')} Diferente do fechamento gravado (${fmtNum(i.saved.consumption)} ${i.unit}).</div>` : ''}`
          : html`<div class="muted">Nenhuma leitura neste mês.</div>`}
        </div>
      </div>`)}
    </div>

    <div class="card section" style="margin-top:16px">
      <div class="card-head"><h2>${icon('chart-column')} Comparação com meses anteriores</h2></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Mês</th>${c.items.map((i) => html`<th class="num">${i.type_name}${c.items.filter((x) => x.utility_type === i.utility_type).length > 1 ? ` — ${i.meter_name}` : ''} (${i.unit})</th>`)}</tr></thead>
        <tbody>
          ${(c.items[0]?.previous || []).map((p, idx) => html`<tr><td>${capital(p.label)}</td>${c.items.map((i) => html`<td class="num">${fmtNum(i.previous[idx].consumption)}</td>`)}</tr>`)}
          <tr><td><b>${capital(c.month_name.slice(0, 3))}/${c.year} (atual)</b></td>${c.items.map((i) => html`<td class="num cons">${fmtNum(i.consumption)}</td>`)}</tr>
        </tbody>
        <tfoot><tr><td>Média dos meses anteriores</td>${c.items.map((i) => html`<td class="num">${fmtNum(i.average)}</td>`)}</tr></tfoot>
      </table></div>
    </div>` : html`<div class="card">${emptyState('gauge', 'Nenhum medidor', 'Este condomínio ainda não possui medidores.')}</div>`}
  `);
  bindPeriod(el, 'relatorios/fechamento');
  $('#btn-close', el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: c.is_closed ? 'Atualizar fechamento' : 'Fechar o mês', confirmText: 'Confirmar',
      message: html`Gravar o fechamento de <b>${capital(c.month_name)}/${c.year}</b> do condomínio <b>${c.condominium.name}</b> com os valores exibidos?` });
    if (!ok) return;
    withBusy($('#btn-close', el), async () => {
      try { await api.post('/api/closing', { condominium_id: condoId, year: c.year, month: c.month }); toast('Fechamento gravado.'); refresh(); } catch (err) { toast(err.message, 'error'); }
    });
  });
  $('#btn-reopen', el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Reabrir mês', message: 'Deseja reabrir este mês? O fechamento gravado será removido (as leituras não são apagadas).', confirmText: 'Reabrir', danger: true });
    if (!ok) return;
    try { await api.del('/api/closing', { condominium_id: condoId, year: c.year, month: c.month }); toast('Mês reaberto.'); refresh(); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- Gráficos
async function renderCharts(el, ctx, condos) {
  const condoId = defaultCondo(condos, true);
  const months = pref.get('chartMonths', 6);
  const d = await api.get('/api/charts', { condominium_id: condoId, months });
  if (!ctx.isCurrent()) return;

  mount(el, html`${head()}${tabs('graficos')}
    <div class="card section"><div class="card-body"><div class="filters">
      <div class="field wide"><label for="g-condo">Condomínio</label>${condoSelect(condos, { value: condoId, id: 'g-condo', all: true })}</div>
      <div class="field" style="flex:0 0 auto"><span class="label">Período</span>
        <div class="seg" id="g-months">${[3, 6, 12].map((n) => html`<button type="button" data-m="${n}" class="${n === months ? 'active' : ''}">${n} meses</button>`)}</div></div>
    </div></div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))">
      ${d.series.map((s, idx) => {
        const total = s.data.reduce((a, b) => a + b, 0);
        const nonZero = s.data.filter((v) => v > 0);
        const avg = nonZero.length ? total / nonZero.length : 0;
        return html`<div class="card">
          <div class="card-head"><h3>${typeDot(s.utility_type)} Consumo de ${s.name.toLowerCase()}</h3></div>
          <div class="card-body">
            <div class="small muted" style="margin-bottom:8px">Total: <b style="color:var(--text)">${fmtNum(Math.round(total * 10) / 10)} ${s.unit}</b> · Média mensal: <b style="color:var(--text)">${fmtNum(Math.round(avg * 10) / 10)} ${s.unit}</b></div>
            <div class="chart-box"><canvas id="chart-${idx}" aria-label="Gráfico de consumo de ${s.name}" role="img"></canvas></div>
          </div></div>`;
      })}
    </div>
    <p class="small muted" style="margin-top:12px">${icon('info', 'small')} Os gráficos somam os medidores principais. Consumo do mês atual é parcial.</p>`);

  $('#g-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go('relatorios/graficos'); });
  $$('#g-months button', el).forEach((b) => b.addEventListener('click', () => { pref.set('chartMonths', Number(b.dataset.m)); go('relatorios/graficos'); }));

  if (!window.Chart) return;
  d.series.forEach((s, idx) => {
    const canvas = $(`#chart-${idx}`, el);
    charts.push(new window.Chart(canvas, {
      type: 'bar',
      data: { labels: d.labels.map(capital), datasets: [{ label: `${s.name} (${s.unit})`, data: s.data, backgroundColor: s.color, borderRadius: 6, maxBarThickness: 44 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${fmtNum(c.parsed.y)} ${s.unit}` } } },
        scales: {
          y: { beginAtZero: true, grid: { color: '#eef2f6' }, ticks: { callback: (v) => new Intl.NumberFormat('pt-BR').format(v) } },
          x: { grid: { display: false } },
        },
      },
    }));
  });
}

// ---------------------------------------------------------------- Relatório
async function renderReport(el, ctx, condos) {
  const condoId = defaultCondo(condos);
  const per = selectedPeriod();
  const type = pref.get('reportType', '');
  const params = { condominium_id: condoId, year: per.year, month: per.month, utility_type: type };
  const rep = await api.get('/api/reports', params);
  if (!ctx.isCurrent()) return;

  mount(el, html`${head()}${tabs('relatorio')}
    <div class="card section no-print"><div class="card-body"><div class="filters">
      ${periodFilters(condos, condoId, per, { allMonths: true })}
      <div class="field"><label for="p-type">Concessionária</label><select class="select" id="p-type">
        <option value="">Todas</option>${activeTypes().map((t) => html`<option value="${t.code}" ${t.code === type ? 'selected' : ''}>${t.name}</option>`)}</select></div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <a class="btn btn-primary" href="/api/reports/export${qs({ ...params, format: 'pdf' })}" download>${icon('file-down')} Exportar PDF</a>
      <a class="btn" href="/api/reports/export${qs({ ...params, format: 'xlsx' })}" download>${icon('file-spreadsheet')} Excel</a>
      <a class="btn" href="/api/reports/export${qs({ ...params, format: 'csv' })}" download>${icon('file-text')} CSV</a>
      <button class="btn btn-ghost" id="btn-print">${icon('printer')} Imprimir</button>
    </div></div></div>

    <div class="report-paper">
      <div class="report-head">
        <div class="org">${logo()}<div><div class="small muted">${state.meta.org_name}</div><div style="font-size:18px;font-weight:700">Relatório de Leituras e Consumo</div></div></div>
        <div class="small muted" style="text-align:right">Gerado em ${fmtDateTime(rep.generated_at)}<br>por ${rep.generated_by}</div>
      </div>
      <div class="report-info">
        <div><div class="k">Condomínio</div><div class="v">${rep.condominium.name}</div></div>
        <div><div class="k">Período</div><div class="v">${capital(rep.period_label)}</div></div>
        <div><div class="k">Concessionária</div><div class="v">${rep.utility_name}</div></div>
      </div>

      ${rep.summary.length ? html`<h3 style="font-size:15px;margin-bottom:8px">Resumo por medidor</h3>
        <div class="table-wrap" style="margin-bottom:18px"><table class="table">
          <thead><tr><th>Medidor</th><th class="num">Leitura inicial</th><th class="num">Leitura final</th><th class="num">Dias</th><th class="num">Consumo</th></tr></thead>
          <tbody>${rep.summary.map((s) => html`<tr><td>${s.type_name} — ${s.meter_name}${s.kind === 'area' ? ' (área)' : ''}</td>
            <td class="num">${fmtNum(s.initial_value)} <span class="muted small">${fmtDate(s.initial_date)}</span></td>
            <td class="num">${fmtNum(s.final_value)} <span class="muted small">${fmtDate(s.final_date)}</span></td>
            <td class="num">${s.days}</td><td class="num cons">${fmtNum(s.consumption)} ${s.unit}</td></tr>`)}</tbody>
        </table></div>` : ''}

      <h3 style="font-size:15px;margin-bottom:8px">Leituras do período</h3>
      ${rep.rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Data</th><th>Medidor</th><th class="num">Leitura</th><th class="num">Consumo</th><th>Responsável</th></tr></thead>
        <tbody>${rep.rows.map((r) => html`<tr class="${r.role === 'inicial' ? 'row-initial' : ''}">
          <td class="nowrap">${fmtDate(r.reading_date)} <span class="muted small">${r.weekday}</span>
            ${r.role === 'inicial' ? html`<div><span class="badge b-gray">leitura inicial</span></div>` : r.role === 'fechamento' ? html`<div><span class="badge b-blue">fechamento</span></div>` : ''}</td>
          <td>${r.type_name} — ${r.meter_name}</td>
          <td class="num">${fmtNum(r.value)} ${r.unit}</td>
          <td class="num cons">${r.role === 'inicial' ? html`<span class="muted small" title="Consumo pertence ao mês anterior">mês anterior</span>`
            : r.occurrence ? html`<span class="badge b-yellow">${occurrenceLabel(r.occurrence)}</span>` : r.consumption !== null ? `${fmtNum(r.consumption)} ${r.unit}` : '—'}</td>
          <td>${r.responsible || '—'}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted">Nenhuma leitura registrada no período.</p>`}

      <div class="report-total">
        <h3>CONSUMO TOTAL DO PERÍODO</h3>
        ${rep.totals.length ? rep.totals.map((t) => html`<div class="row"><span>${t.type_name}</span><b>${fmtNum(t.consumption)} ${t.unit}</b></div>`) : html`<div class="muted">Sem consumo no período.</div>`}
      </div>
      <p class="small muted">A leitura do dia 01 fecha o mês anterior e é a leitura inicial do mês: o consumo dela pertence ao mês anterior e não entra no total.</p>
      ${rep.totals.some((t) => t.area_consumption) ? html`<p class="small muted">O total considera os medidores principais. Medidores de áreas específicas aparecem no resumo.</p>` : ''}
    </div>`);

  bindPeriod(el, 'relatorios/relatorio');
  $('#p-type', el).addEventListener('change', (e) => { pref.set('reportType', e.target.value); go('relatorios/relatorio'); });
  $('#btn-print', el).addEventListener('click', () => window.print());
}
