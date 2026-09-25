'use strict';
/**
 * Regras de negócio: cálculo de consumo, programação de leituras,
 * fechamento mensal, gráficos e alertas.
 */
const { getSettings } = require('./db');
const F = require('./format');
const E = require('./estimates');

const METER_SELECT = `
  SELECT m.*, c.name AS condominium_name, c.status AS condominium_status,
         t.name AS type_name, t.icon AS type_icon, t.color AS type_color, t.sort_order AS type_order
  FROM meters m
  JOIN condominiums c ON c.id = m.condominium_id
  JOIN utility_types t ON t.code = m.utility_type`;

function listMeters(db, { condominiumId, activeOnly } = {}) {
  const where = [];
  const params = [];
  if (condominiumId) { where.push('m.condominium_id = ?'); params.push(condominiumId); }
  if (activeOnly) where.push("m.active = 1 AND c.status = 'active'");
  const sql = `${METER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY c.name COLLATE NOCASE, t.sort_order, CASE m.kind WHEN 'principal' THEN 0 ELSE 1 END, m.name COLLATE NOCASE`;
  return db.prepare(sql).all(...params);
}

function getMeter(db, id) {
  return db.prepare(`${METER_SELECT} WHERE m.id = ?`).get(id);
}

/** Leitura imediatamente anterior a (data, hora) de um medidor. */
function previousReading(db, meterId, date, time, excludeId = 0) {
  return db.prepare(`SELECT * FROM readings WHERE meter_id = ? AND id <> ?
      AND (reading_date < ? OR (reading_date = ? AND reading_time < ?))
      ORDER BY reading_date DESC, reading_time DESC, id DESC LIMIT 1`)
    .get(meterId, excludeId, date, date, time);
}

function nextReading(db, meterId, date, time, excludeId = 0) {
  return db.prepare(`SELECT * FROM readings WHERE meter_id = ? AND id <> ?
      AND (reading_date > ? OR (reading_date = ? AND reading_time > ?))
      ORDER BY reading_date, reading_time, id LIMIT 1`)
    .get(meterId, excludeId, date, date, time);
}

/** Quantos dias para trás o sistema procura dias sem leitura (medidores diários). */
const MISSING_WINDOW_DAYS = 31;

/**
 * Dias sem leitura de um medidor DIÁRIO, de ontem para trás (até MISSING_WINDOW_DAYS),
 * a partir da primeira leitura do medidor. O dia de hoje não conta como falta:
 * a leitura de hoje ainda pode ser registrada.
 */
function missingDays(db, meterId, firstDate, today) {
  const yesterday = F.addDays(today, -1);
  let start = F.addDays(today, -MISSING_WINDOW_DAYS);
  if (firstDate > start) start = firstDate;
  if (start > yesterday) return [];
  const have = new Set(db.prepare(`SELECT DISTINCT reading_date d FROM readings WHERE meter_id = ? AND reading_date BETWEEN ? AND ?`)
    .all(meterId, start, yesterday).map((r) => r.d));
  const out = [];
  for (let d = start; d <= yesterday; d = F.addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

/**
 * Situação de cada medidor ativo: última leitura, próxima leitura programada,
 * dias sem leitura e leitura da concessionária (controlada separadamente).
 *
 * Medidor DIÁRIO (padrão): espera-se uma leitura por dia.
 *   - leu hoje → em dia;  ainda não leu hoje → "próxima" (leitura de hoje);
 *   - algum dia anterior sem leitura → atrasada (missing_dates lista os dias).
 * Outras frequências: próxima leitura = última leitura + frequência.
 */
function meterStatuses(db, { condominiumId, today = F.todayISO() } = {}) {
  const s = getSettings(db);
  const upcomingDays = Number(s.upcoming_days) || 3;
  const meters = listMeters(db, { condominiumId, activeOnly: true });
  const lastStmt = db.prepare(`SELECT reading_date, reading_time, value FROM readings WHERE meter_id = ?
                               ORDER BY reading_date DESC, reading_time DESC, id DESC LIMIT 1`);
  const firstStmt = db.prepare('SELECT MIN(reading_date) d FROM readings WHERE meter_id = ?');
  const ucStmt = db.prepare(`SELECT reading_date, next_reading_date, value, company FROM utility_company_readings
                             WHERE meter_id = ? ORDER BY reading_date DESC, id DESC LIMIT 1`);
  return meters.map((m) => {
    const last = lastStmt.get(m.id) || null;
    const uc = ucStmt.get(m.id) || null;
    let status = 'sem_leitura';
    let nextDue = null;
    let daysToDue = null;
    let missing = [];
    const daily = Number(m.frequency_days) === 1;
    if (last && daily) {
      missing = missingDays(db, m.id, firstStmt.get(m.id).d, today);
      nextDue = last.reading_date >= today ? F.addDays(last.reading_date, 1) : (missing[0] || today);
      daysToDue = F.diffDays(today, nextDue);
      status = missing.length ? 'atrasada' : last.reading_date >= today ? 'em_dia' : 'proxima';
    } else if (last) {
      nextDue = F.addDays(last.reading_date, m.frequency_days);
      daysToDue = F.diffDays(today, nextDue);
      status = daysToDue < 0 ? 'atrasada' : daysToDue <= upcomingDays ? 'proxima' : 'em_dia';
    }
    return {
      meter_id: m.id, meter_name: m.name, identifier: m.identifier, unit: m.unit, kind: m.kind,
      utility_type: m.utility_type, type_name: m.type_name, type_icon: m.type_icon, type_color: m.type_color,
      condominium_id: m.condominium_id, condominium_name: m.condominium_name,
      frequency_days: m.frequency_days, daily,
      last_reading: last, next_due: nextDue, days_to_due: daysToDue, status,
      missing_dates: missing, read_today: !!last && last.reading_date >= today,
      utility_last: uc,
      utility_next: uc && uc.next_reading_date ? uc.next_reading_date : null,
    };
  });
}

/**
 * Fechamento de um medidor em um período de apuração (from..to).
 * Use closingForMonth para meses: o período vai de 02/MM a 01/(MM+1), pois a
 * leitura do dia 01 fecha o mês anterior e é a leitura inicial do mês.
 *
 * consumption = consumo total considerado = registrado + estimado (ver estimates.js).
 */
function closingForMeter(db, meterId, from, to, today = F.todayISO()) {
  const meter = db.prepare('SELECT id, frequency_days FROM meters WHERE id = ?').get(meterId);
  const rows = db.prepare(`SELECT * FROM v_readings WHERE meter_id = ? AND reading_date BETWEEN ? AND ?
                           ORDER BY reading_date, reading_time, id`).all(meterId, from, to);
  const sum = E.summarize(E.dailySeries(db, meter, from, to, today));
  const base = {
    registered: sum.registered, estimated: sum.estimated,
    days_with_reading: sum.days_with_reading, days_without_reading: sum.days_without_reading,
    days_estimated: sum.days_estimated, days_no_estimate: sum.days_no_estimate, days_no_history: sum.days_no_history,
    days_waiting: sum.days_waiting, covered_days: sum.covered_days, daily_avg: sum.daily_avg,
    missing_dates: sum.missing_dates, messages: E.estimateMessages(sum),
  };
  if (!rows.length) {
    return { readings_count: 0, initial_date: null, initial_value: null, final_date: null, final_value: null,
      consumption: sum.covered_days ? sum.total : null, days: null, has_reset: false, ...base };
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  // Leitura inicial = última leitura REAL antes do período (normalmente a do dia 01).
  const usePrev = first.prev_value !== null && !first.is_reset;
  const initialDate = usePrev ? first.prev_date : first.reading_date;
  const initialValue = usePrev ? first.prev_value : first.value;
  return {
    readings_count: rows.length,
    initial_date: initialDate, initial_value: initialValue,
    final_date: last.reading_date, final_value: last.value,
    consumption: sum.covered_days ? sum.total : null,
    days: F.diffDays(initialDate, last.reading_date),
    has_reset: rows.some((r) => r.is_reset),
    ...base,
  };
}

/** Fechamento de um medidor em um mês (month = 0 → ano inteiro). */
function closingForMonth(db, meterId, year, month, today) {
  const { from, to } = F.closingRange(year, month);
  return closingForMeter(db, meterId, from, to, today);
}

/** Consumo por medidor em um período (mapa meter_id → fechamento). */
function consumptionByMeter(db, from, to, condominiumId) {
  const map = new Map();
  for (const m of listMeters(db, { condominiumId })) {
    const c = closingForMeter(db, m.id, from, to);
    if (c.covered_days || c.readings_count) map.set(m.id, c);
  }
  return map;
}

/**
 * Consumo total por tipo (água, gás, energia...) em um período, incluindo o consumo
 * estimado dos dias sem leitura. Considera apenas medidores PRINCIPAIS para não somar
 * em dobro os medidores de áreas específicas (que normalmente são submedições).
 */
function consumptionByType(db, from, to, condominiumId) {
  const types = db.prepare('SELECT * FROM utility_types ORDER BY sort_order').all();
  const out = [];
  for (const m of listMeters(db, { condominiumId, activeOnly: true }).filter((x) => x.kind === 'principal')) {
    const c = closingForMeter(db, m.id, from, to);
    if (!c.covered_days) continue;
    let t = out.find((x) => x.utility_type === m.utility_type);
    if (!t) {
      const ty = types.find((x) => x.code === m.utility_type);
      t = { utility_type: ty.code, name: ty.name, unit: ty.unit, color: ty.color, icon: ty.icon, consumption: 0, estimated: 0 };
      out.push(t);
    }
    t.consumption = Math.round((t.consumption + c.consumption) * 1000) / 1000;
    t.estimated = Math.round((t.estimated + c.estimated) * 1000) / 1000;
  }
  return out;
}

function monthKeys(count, today = F.todayISO()) {
  const [y, m] = today.split('-').map(Number);
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return keys;
}

/** Séries mensais de consumo por tipo (gráficos). */
function chartSeries(db, { condominiumId, months = 6, today = F.todayISO() }) {
  const keys = monthKeys(months, today);
  const from = F.closingRange(keys[0].year, keys[0].month).from;
  const to = F.closingRange(keys[keys.length - 1].year, keys[keys.length - 1].month).to;
  // Soma por mês (regra do fechamento) de registrado + estimado, só medidores principais.
  const rows = [];
  for (const m of listMeters(db, { condominiumId, activeOnly: true }).filter((x) => x.kind === 'principal')) {
    for (const d of E.dailySeries(db, m, from, to, today)) {
      const ym = F.billingMonth(d.date);
      let r = rows.find((x) => x.ym === ym && x.utility_type === m.utility_type);
      if (!r) { r = { ym, utility_type: m.utility_type, consumption: 0 }; rows.push(r); }
      r.consumption = Math.round((r.consumption + d.registered + d.estimated) * 1000) / 1000;
    }
  }
  const types = db.prepare('SELECT * FROM utility_types WHERE active = 1 ORDER BY sort_order').all();
  const labels = keys.map((k) => `${F.monthName(k.month).slice(0, 3)}/${String(k.year).slice(2)}`);
  const series = types.map((t) => ({
    utility_type: t.code, name: t.name, unit: t.unit, color: t.color, icon: t.icon,
    data: keys.map((k) => {
      const ym = `${k.year}-${F.pad(k.month)}`;
      const r = rows.find((x) => x.ym === ym && x.utility_type === t.code);
      return r ? r.consumption : 0;
    }),
  }));
  return { labels, months: keys, series };
}

/** Consumo médio por dia de um medidor em um intervalo (baseado nos intervalos entre leituras). */
function dailyRate(db, meterId, from, to) {
  const r = db.prepare(`SELECT SUM(consumption) AS c, SUM(interval_days) AS d, COUNT(*) AS n
      FROM v_readings WHERE meter_id = ? AND reading_date > ? AND reading_date <= ?
      AND consumption IS NOT NULL AND interval_days > 0`).get(meterId, from, to);
  if (!r || !r.n || !r.d) return null;
  return { rate: r.c / r.d, readings: r.n };
}

/** Alertas visuais (apenas informativos). */
function alerts(db, { condominiumId, today = F.todayISO() } = {}) {
  const s = getSettings(db);
  const threshold = Number(s.alert_threshold_pct) || 20;
  const utilUpcoming = Number(s.utility_upcoming_days) || 5;
  const out = [];
  const statuses = meterStatuses(db, { condominiumId, today });
  for (const m of statuses) {
    const label = `${m.type_name} — ${m.meter_name}`;
    if (m.status === 'sem_leitura') {
      out.push({ level: 'danger', kind: 'sem_leitura', icon: 'circle-alert', condominium_id: m.condominium_id, meter_id: m.meter_id,
        text: `${m.condominium_name}: o medidor ${label} ainda não possui nenhuma leitura.` });
    } else if (m.status === 'atrasada' && m.daily) {
      const n = m.missing_dates.length;
      const list = m.missing_dates.slice(-5).map((d) => F.fmtDate(d).slice(0, 5)).join(', ');
      out.push({ level: 'danger', kind: 'atrasada', icon: 'clock-alert', condominium_id: m.condominium_id, meter_id: m.meter_id,
        text: `${m.condominium_name}: ${label} — leitura não realizada em ${n} dia${n > 1 ? 's' : ''} (${n > 5 ? '…, ' : ''}${list}).` });
    } else if (m.status === 'atrasada') {
      const d = -m.days_to_due;
      out.push({ level: 'danger', kind: 'atrasada', icon: 'clock-alert', condominium_id: m.condominium_id, meter_id: m.meter_id,
        text: `${m.condominium_name}: leitura de ${label} atrasada há ${d} dia${d > 1 ? 's' : ''} (prevista para ${F.fmtDate(m.next_due)}).` });
    } else if (m.status === 'proxima' && m.daily) {
      out.push({ level: 'warning', kind: 'proxima', icon: 'calendar-clock', condominium_id: m.condominium_id, meter_id: m.meter_id,
        text: `${m.condominium_name}: leitura de hoje de ${label} ainda não registrada.` });
    } else if (m.status === 'proxima') {
      const when = m.days_to_due === 0 ? 'hoje' : m.days_to_due === 1 ? 'amanhã' : `em ${m.days_to_due} dias (${F.fmtDate(m.next_due)})`;
      out.push({ level: 'warning', kind: 'proxima', icon: 'calendar-clock', condominium_id: m.condominium_id, meter_id: m.meter_id,
        text: `${m.condominium_name}: leitura de ${label} ${when}.` });
    }
    if (m.utility_next && m.utility_next >= today) {
      const d = F.diffDays(today, m.utility_next);
      if (d <= utilUpcoming) {
        const when = d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias (${F.fmtDate(m.utility_next)})`;
        out.push({ level: 'info', kind: 'concessionaria_proxima', icon: 'building', condominium_id: m.condominium_id, meter_id: m.meter_id,
          text: `${m.condominium_name}: leitura da concessionária de ${m.type_name.toLowerCase()} ${when}.` });
      }
    }
    // Consumo acima da média: últimos 30 dias x 6 meses anteriores
    if (m.last_reading) {
      const recentFrom = F.addDays(today, -30);
      const recent = dailyRate(db, m.meter_id, recentFrom, today);
      const base = dailyRate(db, m.meter_id, F.addDays(recentFrom, -180), recentFrom);
      if (recent && base && base.readings >= 3 && base.rate > 0) {
        const pct = Math.round(((recent.rate - base.rate) / base.rate) * 100);
        if (pct >= threshold) {
          out.push({ level: 'warning', kind: 'consumo_alto', icon: 'trending-up', condominium_id: m.condominium_id, meter_id: m.meter_id,
            text: `O consumo de ${m.type_name.toLowerCase()} do ${m.condominium_name}${m.kind === 'area' ? ` (${m.meter_name})` : ''} está ${pct}% acima da média dos últimos 6 meses.` });
        }
      }
    }
  }
  // Leituras com ocorrência nos últimos 30 dias (sem cálculo automático de consumo).
  const occParams = [F.addDays(today, -30)];
  let occExtra = '';
  if (condominiumId) { occExtra = 'AND m.condominium_id = ?'; occParams.push(condominiumId); }
  const occ = db.prepare(`SELECT r.reading_date, r.occurrence, r.occurrence_note, m.id AS meter_id, m.name AS meter_name, m.condominium_id,
        t.name AS type_name, c.name AS condominium_name
      FROM readings r JOIN meters m ON m.id = r.meter_id JOIN utility_types t ON t.code = m.utility_type
      JOIN condominiums c ON c.id = m.condominium_id
      WHERE r.occurrence IS NOT NULL AND r.reading_date >= ? AND c.status = 'active' AND m.active = 1 ${occExtra}
      ORDER BY r.reading_date DESC`).all(...occParams);
  for (const o of occ) {
    const review = o.occurrence === 'correcao' || o.occurrence === 'outra';
    out.push({ level: review ? 'warning' : 'info', kind: 'ocorrencia', icon: 'message-square-warning', condominium_id: o.condominium_id, meter_id: o.meter_id,
      text: `${o.condominium_name}: leitura de ${o.type_name.toLowerCase()} (${o.meter_name}) de ${F.fmtDate(o.reading_date)} registrada com ocorrência `
        + `"${OCCURRENCES[o.occurrence]}"${o.occurrence_note ? ` — ${o.occurrence_note}` : ''}. O consumo desse intervalo não foi calculado${review ? '; confira a leitura anterior' : ''}.` });
  }
  const order = { danger: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}

const OCCURRENCES = { troca: 'troca do medidor', zeramento: 'zeramento do medidor', correcao: 'correção de leitura', outra: 'outra ocorrência' };

/** Eventos do calendário em um mês. */
function calendarEvents(db, { year, month, condominiumId, today = F.todayISO() }) {
  const { from, to } = F.monthRange(year, month);
  const events = [];
  const params = [from, to];
  let extra = '';
  if (condominiumId) { extra = 'AND m.condominium_id = ?'; params.push(condominiumId); }

  const readings = db.prepare(`SELECT v.id, v.reading_date, v.reading_time, v.value, v.consumption, v.responsible,
        m.id AS meter_id, m.name AS meter_name, m.unit, m.utility_type, t.name AS type_name, t.icon, c.name AS condominium_name, c.id AS condominium_id
      FROM v_readings v JOIN meters m ON m.id = v.meter_id JOIN utility_types t ON t.code = m.utility_type
      JOIN condominiums c ON c.id = m.condominium_id
      WHERE v.reading_date BETWEEN ? AND ? ${extra} ORDER BY v.reading_date, v.reading_time`).all(...params);
  for (const r of readings) {
    events.push({ date: r.reading_date, kind: 'realizada', condominium_id: r.condominium_id, condominium_name: r.condominium_name,
      utility_type: r.utility_type, type_name: r.type_name, icon: r.icon, meter_name: r.meter_name,
      title: `${r.type_name} — leitura realizada`,
      detail: `${F.fmtNum(r.value)} ${r.unit}${r.consumption !== null ? ` · consumo ${F.fmtNum(r.consumption)} ${r.unit}` : ''} · ${r.reading_time}${r.responsible ? ` · ${r.responsible}` : ''}` });
  }

  const ucr = db.prepare(`SELECT u.*, m.name AS meter_name, m.unit, m.utility_type, t.name AS type_name, t.icon, c.name AS condominium_name, c.id AS condominium_id
      FROM utility_company_readings u JOIN meters m ON m.id = u.meter_id JOIN utility_types t ON t.code = m.utility_type
      JOIN condominiums c ON c.id = m.condominium_id
      WHERE ((u.reading_date BETWEEN ? AND ?) OR (u.next_reading_date BETWEEN ? AND ?)) ${extra}`)
    .all(from, to, from, to, ...params.slice(2));
  for (const u of ucr) {
    const base = { condominium_id: u.condominium_id, condominium_name: u.condominium_name, utility_type: u.utility_type,
      type_name: u.type_name, icon: u.icon, meter_name: u.meter_name };
    if (u.reading_date >= from && u.reading_date <= to) {
      events.push({ ...base, date: u.reading_date, kind: 'concessionaria',
        title: `${u.type_name} — leitura realizada pela concessionária`,
        detail: `${u.value !== null ? `${F.fmtNum(u.value)} ${u.unit}` : 'sem valor informado'}${u.company ? ` · ${u.company}` : ''}` });
    }
    if (u.next_reading_date && u.next_reading_date >= from && u.next_reading_date <= to) {
      events.push({ ...base, date: u.next_reading_date, kind: 'concessionaria',
        title: `${u.type_name} — próxima leitura da concessionária (prevista)`,
        detail: u.company || '' });
    }
  }

  // Leituras programadas (futuras) e pendentes (vencidas ou nunca feitas).
  const readDays = db.prepare('SELECT DISTINCT reading_date d FROM readings WHERE meter_id = ? AND reading_date BETWEEN ? AND ?');
  const firstRead = db.prepare('SELECT MIN(reading_date) d FROM readings WHERE meter_id = ?');
  const dailyPlanned = new Map(); // "data|condomínio" → medidores diários esperados
  const estimates = new Map(); // "medidor|data" → texto da estimativa
  for (const st of meterStatuses(db, { condominiumId, today })) {
    if (st.daily && st.status !== 'sem_leitura') {
      // Medidor diário: uma leitura esperada por dia, a partir da primeira leitura.
      const base = { condominium_id: st.condominium_id, condominium_name: st.condominium_name, utility_type: st.utility_type,
        type_name: st.type_name, icon: st.type_icon, meter_name: st.meter_name };
      const start = firstRead.get(st.meter_id).d;
      // Consumo estimado dos dias sem leitura (a pendência continua visível).
      for (const x of E.dailySeries(db, { id: st.meter_id, frequency_days: 1 }, from, to, today)) {
        if (x.kind === 'estimado') estimates.set(`${st.meter_id}|${x.date}`, `consumo estimado ${F.fmtNum(x.estimated)} ${st.unit}`);
        else if (x.kind === 'sem_estimativa') estimates.set(`${st.meter_id}|${x.date}`, x.reason === 'historico' ? E.MSG_NO_HISTORY : 'sem estimativa');
      }
      const have = new Set(readDays.all(st.meter_id, from, to).map((r) => r.d));
      for (let d = from; d <= to; d = F.addDays(d, 1)) {
        if (d < start || have.has(d)) continue;
        if (d < today) {
          const est = estimates.get(`${st.meter_id}|${d}`);
          events.push({ ...base, date: d, kind: 'pendente', title: `${st.type_name} — leitura não realizada`,
            detail: `${st.meter_name}${est ? ` · ${est}` : ''}` });
        } else {
          const key = `${d}|${st.condominium_id}`;
          if (!dailyPlanned.has(key)) dailyPlanned.set(key, { ...base, date: d, meters: [] });
          dailyPlanned.get(key).meters.push(st.type_name);
        }
      }
      continue;
    }
    if (st.status === 'sem_leitura') {
      if (today >= from && today <= to) {
        events.push({ date: today, kind: 'pendente', condominium_id: st.condominium_id, condominium_name: st.condominium_name,
          utility_type: st.utility_type, type_name: st.type_name, icon: st.type_icon, meter_name: st.meter_name,
          title: `${st.type_name} — medidor sem nenhuma leitura`, detail: st.meter_name });
      }
      continue;
    }
    const base = { condominium_id: st.condominium_id, condominium_name: st.condominium_name, utility_type: st.utility_type,
      type_name: st.type_name, icon: st.type_icon, meter_name: st.meter_name };
    if (st.status === 'atrasada') {
      // Mostra no dia previsto e também HOJE, para a pendência não "sumir" nos meses seguintes.
      if (st.next_due >= from && st.next_due <= to) {
        events.push({ ...base, date: st.next_due, kind: 'pendente', title: `${st.type_name} — leitura pendente`,
          detail: `${st.meter_name} · atrasada há ${-st.days_to_due} dia(s)` });
      }
      if (today >= from && today <= to && today !== st.next_due) {
        events.push({ ...base, date: today, kind: 'pendente', title: `${st.type_name} — leitura pendente desde ${F.fmtDate(st.next_due)}`,
          detail: `${st.meter_name} · atrasada há ${-st.days_to_due} dia(s)` });
      }
      continue;
    }
    let d = st.next_due;
    let guard = 0;
    while (d <= to && guard++ < 400) {
      if (d >= from && d >= today) {
        events.push({ ...base, date: d, kind: 'programada', title: `${st.type_name} — leitura programada`, detail: st.meter_name });
      }
      d = F.addDays(d, st.frequency_days);
    }
  }
  // Leituras diárias programadas: um evento por dia e condomínio (não um por medidor).
  for (const p of dailyPlanned.values()) {
    const names = [...new Set(p.meters)];
    events.push({ date: p.date, kind: 'programada', condominium_id: p.condominium_id, condominium_name: p.condominium_name,
      utility_type: names.length === 1 ? p.utility_type : 'outro', type_name: names.length === 1 ? names[0] : 'Diária',
      icon: 'calendar-clock', meter_name: '',
      title: `${p.date === today ? 'Leitura de hoje' : 'Leitura diária programada'} — ${names.join(', ')}`, detail: 'leitura da administração' });
  }
  const order = { pendente: 0, programada: 1, concessionaria: 2, realizada: 3 };
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.kind] - order[b.kind]));
  return events;
}

module.exports = {
  listMeters, getMeter, previousReading, nextReading, meterStatuses, consumptionByMeter, consumptionByType,
  closingForMeter, closingForMonth, chartSeries, alerts, calendarEvents, monthKeys, OCCURRENCES,
};
