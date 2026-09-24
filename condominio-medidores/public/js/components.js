// Componentes reutilizados em várias telas.
import { html, icon, fmtDate } from './util.js';
import { typeInfo } from './state.js';

export function typeDot(code) {
  const t = typeInfo(code);
  return html`<span class="type-dot t-${code}" title="${t.name}">${icon(t.icon)}</span>`;
}

export function typeBadge(code) {
  const t = typeInfo(code);
  return html`<span class="badge t-${code}">${icon(t.icon)} ${t.name}</span>`;
}

/** Select de condomínios. */
export function condoSelect(condos, { name = 'condominium_id', id = 'f-condo', value = '', all = false, allLabel = 'Todos os condomínios', placeholder = 'Selecione o condomínio', required = false } = {}) {
  return html`<select class="select" name="${name}" id="${id}" ${required ? 'required' : ''}>
    ${all ? html`<option value="">${allLabel}</option>` : (condos.length === 1 ? '' : html`<option value="">${placeholder}</option>`)}
    ${condos.map((c) => html`<option value="${c.id}" ${String(c.id) === String(value) ? 'selected' : ''}>${c.name}${c.status === 'inactive' ? ' (inativo)' : ''}</option>`)}
  </select>`;
}

const STATUS = {
  em_dia: ['b-green', 'check', 'Em dia'],
  proxima: ['b-yellow', 'calendar-clock', 'Próxima'],
  atrasada: ['b-red', 'clock-alert', 'Atrasada'],
  sem_leitura: ['b-red', 'circle-alert', 'Sem leitura'],
};
export function statusBadge(status) {
  const [cls, ic, label] = STATUS[status] || STATUS.em_dia;
  return html`<span class="badge ${cls}">${icon(ic)} ${label}</span>`;
}

/** Texto amigável para a próxima leitura de um medidor. */
export function nextReadingText(st) {
  if (st.status === 'sem_leitura') return 'nenhuma leitura registrada';
  if (st.daily) {
    // Leitura diária: mostra se a de hoje já foi feita e os dias que faltaram.
    const hoje = st.read_today ? 'leitura de hoje registrada' : 'leitura de hoje pendente';
    const n = st.missing_dates ? st.missing_dates.length : 0;
    return n ? `${hoje} · ${n} dia${n > 1 ? 's' : ''} sem leitura (último: ${fmtDate(st.missing_dates[n - 1])})` : hoje;
  }
  if (st.status === 'atrasada') return `atrasada desde ${fmtDate(st.next_due)}`;
  if (st.days_to_due === 0) return `próxima leitura: hoje (${fmtDate(st.next_due)})`;
  if (st.days_to_due === 1) return `próxima leitura: amanhã (${fmtDate(st.next_due)})`;
  return `próxima leitura: ${fmtDate(st.next_due)}`;
}

export function utilityText(st, today) {
  if (st.utility_next && st.utility_next >= today) return `concessionária: ${fmtDate(st.utility_next)}`;
  if (st.utility_last && st.utility_last.reading_date.slice(0, 7) === today.slice(0, 7)) return `concessionária: ${fmtDate(st.utility_last.reading_date)} (realizada)`;
  return 'concessionária: pendente';
}

export function alertList(alerts, { limit = 0 } = {}) {
  const list = limit ? alerts.slice(0, limit) : alerts;
  if (!list.length) {
    return html`<div class="alert alert-success">${icon('circle-check')}<div>Tudo em dia! Nenhum alerta no momento.</div></div>`;
  }
  return html`<div class="alerts">${list.map((a) => html`<div class="alert alert-${a.level}">${icon(a.level === 'warning' && a.kind === 'consumo_alto' ? 'triangle-alert' : a.icon)}<div>${a.text}</div></div>`)}</div>`;
}

export const FREQUENCIES = [
  [1, 'Diária'], [7, 'Semanal'], [15, 'Quinzenal'], [30, 'Mensal'],
];
export function frequencyLabel(days) {
  const f = FREQUENCIES.find(([d]) => d === Number(days));
  return f ? f[1] : `A cada ${days} dias`;
}
