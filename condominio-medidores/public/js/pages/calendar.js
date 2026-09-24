// Calendário mensal de leituras.
import { api } from '../api.js';
import { html, mount, icon, $, $$, fmtDate, capital, weekday } from '../util.js';
import { getCondos, currentCondo } from '../state.js';
import { condoSelect, typeDot } from '../components.js';
import { go } from '../app.js';

const KIND = {
  realizada: ['realizada', 'Leitura realizada', 'b-green'],
  programada: ['programada', 'Leitura programada', 'b-yellow'],
  concessionaria: ['concessionaria', 'Leitura da concessionária', 'b-blue'],
  pendente: ['pendente', 'Leitura pendente', 'b-red'],
};
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export async function render(el, ctx) {
  const condos = await getCondos();
  let condoId = currentCondo.get();
  if (condoId && !condos.some((c) => c.id === Number(condoId))) condoId = '';
  const now = new Date();
  const year = Number(ctx.query.ano) || now.getFullYear();
  const month = Number(ctx.query.mes) || now.getMonth() + 1;
  const data = await api.get('/api/calendar', { year, month, condominium_id: condoId });
  if (!ctx.isCurrent()) return;

  const byDay = new Map();
  for (const e of data.events) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = first.getDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);

  const prev = month === 1 ? [year - 1, 12] : [year, month - 1];
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  const showCondo = !condoId;
  const defaultDay = data.today.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}` ? data.today : cells.find(Boolean);

  const counts = { realizada: 0, programada: 0, concessionaria: 0, pendente: 0 };
  data.events.forEach((e) => { counts[e.kind]++; });

  mount(el, html`
    <div class="page-head">
      <div><h1>Calendário</h1><p>Leituras realizadas, programadas, pendentes e da concessionária.</p></div>
      <div class="page-actions"><div style="min-width:240px">${condoSelect(condos, { value: condoId, all: true, id: 'cal-condo' })}</div></div>
    </div>
    <div class="grid two-col">
      <div class="card card-pad">
        <div class="cal-head">
          <button class="icon-btn" id="cal-prev" aria-label="Mês anterior">${icon('chevron-left')}</button>
          <div class="cal-title">${data.month_name} ${year}</div>
          <button class="icon-btn" id="cal-next" aria-label="Próximo mês">${icon('chevron-right')}</button>
        </div>
        <div class="cal-legend" style="margin-bottom:12px">
          ${Object.values(KIND).map(([k, label]) => html`<span><i class="dot dot-${k}"></i> ${label} (${counts[k]})</span>`)}
        </div>
        <div class="calendar">
          ${WD.map((w) => html`<div class="wd">${w}</div>`)}
          ${cells.map((d) => {
            if (!d) return html`<div class="day out"></div>`;
            const evs = byDay.get(d) || [];
            const kinds = [...new Set(evs.map((e) => e.kind))];
            return html`<div class="day ${d === data.today ? 'today' : ''}" data-day="${d}" tabindex="0" role="button" aria-label="${fmtDate(d)}: ${evs.length} evento(s)">
              <span class="n">${Number(d.slice(8))}</span>
              <div class="evs">${evs.slice(0, 3).map((e) => html`<div class="ev"><i class="dot dot-${e.kind}"></i>${e.type_name}${showCondo ? html` · <span class="muted">${e.condominium_name}</span>` : ''}</div>`)}
                ${evs.length > 3 ? html`<div class="ev muted">+${evs.length - 3} mais</div>` : ''}</div>
              <div class="dots">${kinds.map((k) => html`<i class="dot dot-${k}"></i>`)}</div>
            </div>`;
          })}
        </div>
      </div>
      <div class="card" id="day-panel"></div>
    </div>`);

  const showDay = (d) => {
    $$('.calendar .day', el).forEach((x) => x.classList.toggle('selected', x.dataset.day === d));
    const evs = byDay.get(d) || [];
    mount($('#day-panel', el), html`<div class="card-head"><h2>${icon('calendar-days')} ${fmtDate(d)}</h2><span class="muted">${capital(weekday(d))}</span></div>
      ${evs.length ? html`<ul class="list">${evs.map((e) => html`<li class="list-item">
        ${typeDot(e.utility_type)}
        <div class="grow"><div class="title">${e.title}</div>
          <div class="sub">${e.condominium_name}${e.detail ? ` · ${e.detail}` : ''}</div></div>
        <span class="badge ${KIND[e.kind][2]}">${KIND[e.kind][1].replace('Leitura ', '')}</span>
      </li>`)}</ul>` : html`<div class="empty">${icon('calendar-check')}<p>Nenhum evento neste dia.</p></div>`}
      ${d <= data.today ? html`<div class="card-body"><a class="btn btn-block" href="#/leituras/nova">${icon('plus')} Registrar leitura</a></div>` : ''}`);
  };
  $$('.calendar .day[data-day]', el).forEach((c) => {
    c.addEventListener('click', () => {
      showDay(c.dataset.day);
      if (window.matchMedia('(max-width: 1100px)').matches) $('#day-panel', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDay(c.dataset.day); } });
  });
  showDay(defaultDay);

  const nav = ([y, m]) => { go(`calendario?ano=${y}&mes=${m}`); };
  $('#cal-prev', el).addEventListener('click', () => nav(prev));
  $('#cal-next', el).addEventListener('click', () => nav(next));
  $('#cal-condo', el).addEventListener('change', (e) => { currentCondo.set(e.target.value); go(`calendario?ano=${year}&mes=${month}`); });
}
