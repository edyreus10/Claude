// Dashboard: cards, alertas e próximas leituras.
import { api } from '../api.js';
import { html, mount, icon, $, fmtNum, capital } from '../util.js';
import { activeCondos, currentCondo } from '../state.js';
import { condoSelect, typeDot, statusBadge, nextReadingText, utilityText, alertList } from '../components.js';
import { go } from '../app.js';

export async function render(el, ctx) {
  const condos = await activeCondos();
  let condoId = currentCondo.get();
  if (condoId && !condos.some((c) => c.id === condoId)) condoId = '';
  const d = await api.get('/api/dashboard', { condominium_id: condoId });
  if (!ctx.isCurrent()) return;

  const stat = (ic, cls, label, value, sub, link) => html`<div class="card stat ${link ? 'clickable' : ''}" ${link ? html`data-link="${link}"` : ''}>
    <span class="stat-icon ${cls}">${icon(ic)}</span>
    <div><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div></div>`;

  const consCard = (c) => stat(c.icon, `t-${c.utility_type}`, `Consumo de ${c.name.toLowerCase()}`,
      html`${fmtNum(c.consumption)} <small>${c.unit}</small>`,
      html`${capital(d.month_name)}${c.previous !== null ? html` · mês anterior ${fmtNum(c.previous)} ${c.unit}` : ''}`,
      'relatorios/graficos');

  mount(el, html`
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Visão geral das leituras e do consumo.</p></div>
      <div class="page-actions">
        <div style="min-width:240px">${condoSelect(condos, { value: condoId, all: true, id: 'dash-condo' })}</div>
        <a class="btn btn-primary hide-mobile" href="#/leituras/nova">${icon('plus')} Registrar leitura</a>
      </div>
    </div>

    <div class="grid stats section">
      ${stat('building', '', 'Condomínios ativos', d.cards.condominiums, `${d.cards.meters} medidores`, 'condominios')}
      ${stat('clock-alert', d.cards.pending ? 't-danger' : 't-success', 'Leituras pendentes', d.cards.pending, d.cards.pending ? 'atrasadas ou sem leitura' : 'nenhuma pendência', 'calendario')}
      ${stat('clipboard-check', 't-success', 'Leituras no mês', d.cards.readings_month, capital(d.month_name), 'leituras')}
      ${stat('calendar-clock', 't-warning', 'Próximas leituras', d.cards.upcoming, 'nos próximos dias', 'calendario')}
    </div>

    <div class="grid stats-3 section">${d.consumption.map(consCard)}</div>
    <p class="small muted" style="margin:-12px 0 20px">Consumo do mês atual somando os medidores principais${condoId ? '' : ' de todos os condomínios'}.</p>

    <div class="grid two-col">
      <div class="card">
        <div class="card-head"><h2>${icon('calendar-clock')} Próximas leituras</h2><a class="btn btn-sm" href="#/calendario">${icon('calendar-days')} Calendário</a></div>
        ${d.upcoming.length ? html`<ul class="list">${d.upcoming.map((g) => html`
          <li class="list-group-title">${g.condominium_name}</li>
          ${g.items.map((st) => html`<li class="list-item">
            ${typeDot(st.utility_type)}
            <div class="grow">
              <div class="title">${st.type_name}${st.kind === 'area' ? html` <span class="muted small">— ${st.meter_name}</span>` : ''}</div>
              <div class="sub">${capital(nextReadingText(st))} · ${utilityText(st, d.today)}</div>
            </div>
            ${statusBadge(st.status)}
            <a class="icon-btn hide-mobile" href="#/leituras/nova?meter=${st.meter_id}" title="Registrar leitura" aria-label="Registrar leitura">${icon('plus')}</a>
          </li>`)}`)}</ul>`
        : html`<div class="empty">${icon('gauge')}<h3>Nenhum medidor cadastrado</h3><p>Cadastre um condomínio e seus medidores para começar.</p>
            <a class="btn btn-primary" href="#/condominios">${icon('plus')} Cadastrar condomínio</a></div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon('bell')} Alertas</h2><span class="badge b-gray">${d.alerts.length}</span></div>
        <div class="card-body">${alertList(d.alerts)}</div>
      </div>
    </div>
  `);

  $('#dash-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go('dashboard'); });
  el.querySelectorAll('[data-link]').forEach((c) => c.addEventListener('click', () => go(c.dataset.link)));
}
