'use strict';
/** Formatação no padrão brasileiro (servidor: auditoria, PDF, Excel, CSV). */

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const pad = (n) => String(n).padStart(2, '0');

/** Data/hora local no formato AAAA-MM-DD HH:MM:SS */
function nowLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Converte 'AAAA-MM-DD' em Date (meio-dia UTC, sem problema de fuso). */
function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function isoFromDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(iso, days) {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromDate(d);
}

function diffDays(a, b) {
  return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
}

function weekday(iso) {
  return WEEKDAYS[parseISODate(iso).getUTCDay()];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function fmtDateTime(s) {
  if (!s) return '—';
  return `${fmtDate(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

const nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return nf.format(v);
}

function monthName(m) {
  return MONTHS[m - 1];
}

function monthRange(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return isoFromDate(parseISODate(s)) === s;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

module.exports = {
  WEEKDAYS, MONTHS, pad, nowLocal, todayISO, parseISODate, addDays, diffDays, weekday,
  fmtDate, fmtDateTime, fmtNum, monthName, monthRange, isValidISODate, isValidTime,
};
