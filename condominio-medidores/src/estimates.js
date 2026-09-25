'use strict';
/**
 * Dias sem leitura e consumo estimado (medidores de leitura DIÁRIA).
 *
 * Regras:
 * - O sistema NUNCA inventa uma leitura do medidor: o dia sem leitura aparece como
 *   "Leitura não realizada".
 * - Quando há dias sem leitura ENTRE duas leituras reais, o consumo medido nesse
 *   intervalo (leitura seguinte − leitura anterior) é dividido assim:
 *     • cada dia sem leitura recebe um consumo ESTIMADO = média diária anterior;
 *     • o dia da leitura real recebe o RESTANTE, como consumo REGISTRADO.
 *   O total do intervalo continua igual ao que o medidor mediu — a estimativa não
 *   aumenta nem diminui o consumo, só o distribui pelos dias (e pelo mês certo).
 *   Se a média × dias for maior que o medido, a estimativa é limitada para que o
 *   dia da leitura real nunca fique negativo (divisão igual entre os dias).
 * - Média diária anterior: consumo dos dias com leitura em dias consecutivos, sem
 *   ocorrência, nos 30 dias antes do intervalo. São necessários pelo menos
 *   MIN_HISTORY_DAYS dias; sem isso: "Não há histórico suficiente para estimativa"
 *   (o consumo medido fica todo no dia da leitura real, sem estimativa).
 * - Dias sem leitura depois da última leitura (ainda sem leitura seguinte) ficam
 *   "aguardando a próxima leitura": sem estimativa.
 * - Leitura com ocorrência (troca, zeramento...) logo após o intervalo: sem estimativa.
 *
 * Um "dia de consumo" D é o consumo que termina na leitura do dia D. O mês a que ele
 * pertence segue a regra do fechamento: o dia 01 pertence ao mês anterior.
 */
const F = require('./format');

const MIN_HISTORY_DAYS = 3;
const HISTORY_WINDOW = 30;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100; // médias diárias: 2 casas

const MSG_NO_HISTORY = 'Não há histórico suficiente para estimativa.';

/** Média diária anterior a uma data (inclusive), usando só dias consecutivos com leitura real. */
function dailyAverageBefore(readings, date) {
  const start = F.addDays(date, -HISTORY_WINDOW);
  const days = readings.filter((r) => r.reading_date > start && r.reading_date <= date
    && r.interval_days === 1 && r.consumption !== null && !r.occurrence);
  if (days.length < MIN_HISTORY_DAYS) return null;
  return days.reduce((a, r) => a + r.consumption, 0) / days.length;
}

/**
 * Série diária de um medidor no intervalo [from, to] (datas de "dia de consumo").
 * Cada item: { date, weekday, kind, registered, estimated, covered_days, reading, ... }
 *   kind: 'leitura'   – dia com leitura real (registered = consumo registrado do dia)
 *         'estimado'  – leitura não realizada, consumo estimado
 *         'sem_estimativa' – leitura não realizada, sem estimativa (reason explica)
 */
function dailySeries(db, meter, from, to, today = F.todayISO()) {
  const meterId = meter.id;
  const daily = Number(meter.frequency_days) === 1;
  const before = db.prepare('SELECT reading_date FROM readings WHERE meter_id = ? AND reading_date < ? ORDER BY reading_date DESC LIMIT 1').get(meterId, from);
  const after = db.prepare('SELECT reading_date FROM readings WHERE meter_id = ? AND reading_date > ? ORDER BY reading_date LIMIT 1').get(meterId, to);
  let lower = F.addDays(from, -(HISTORY_WINDOW + 1));
  if (before && before.reading_date < lower) lower = F.addDays(before.reading_date, -(HISTORY_WINDOW + 1));
  const upper = after ? after.reading_date : to;
  const readings = db.prepare(`SELECT id, reading_date, reading_time, value, consumption, interval_days, prev_date, occurrence, occurrence_note,
      responsible, notes, is_reset FROM readings WHERE meter_id = ? AND reading_date BETWEEN ? AND ?
      ORDER BY reading_date, reading_time, id`).all(meterId, lower, upper);

  const days = new Map(); // data → item
  const item = (date) => {
    if (!days.has(date)) {
      days.set(date, { date, weekday: F.weekday(date), kind: 'leitura', registered: 0, estimated: 0, covered_days: 0, readings: [] });
    }
    return days.get(date);
  };

  for (const r of readings) {
    const it = item(r.reading_date);
    it.readings.push(r);
    const gapDays = daily && r.interval_days > 1 ? r.interval_days - 1 : 0;
    if (r.consumption === null) {
      // Primeira leitura ou leitura com ocorrência: sem consumo calculado.
      if (gapDays) {
        for (let i = 1; i <= gapDays; i++) {
          const g = item(F.addDays(r.prev_date, i));
          Object.assign(g, { kind: 'sem_estimativa', reason: 'ocorrencia',
            reason_text: 'Sem estimativa: a leitura seguinte tem ocorrência (troca, zeramento ou correção).' });
        }
      }
      continue;
    }
    if (!gapDays) {
      it.registered = r3(it.registered + r.consumption);
      it.covered_days += r.interval_days || 1;
      continue;
    }
    // Há dias sem leitura entre a leitura anterior e esta.
    const avg = dailyAverageBefore(readings, r.prev_date);
    if (avg === null) {
      for (let i = 1; i <= gapDays; i++) {
        const g = item(F.addDays(r.prev_date, i));
        Object.assign(g, { kind: 'sem_estimativa', reason: 'historico', reason_text: MSG_NO_HISTORY });
      }
      it.registered = r3(it.registered + r.consumption);
      it.covered_days += r.interval_days;
      it.gap = { days: gapDays, measured: r.consumption, estimated: 0, from: r.prev_date };
      continue;
    }
    const estTotal = Math.min(gapDays * avg, (r.consumption * gapDays) / (gapDays + 1));
    const perDay = r3(estTotal / gapDays);
    for (let i = 1; i <= gapDays; i++) {
      const g = item(F.addDays(r.prev_date, i));
      Object.assign(g, { kind: 'estimado', estimated: perDay, covered_days: 1, avg_used: r3(avg),
        reason_text: `Consumo estimado pela média diária anterior (${F.fmtNum(r3(avg))} por dia).` });
    }
    const remainder = r3(r.consumption - perDay * gapDays);
    it.registered = r3(it.registered + remainder);
    it.covered_days += 1;
    it.gap = { days: gapDays, measured: r.consumption, estimated: r3(perDay * gapDays), from: r.prev_date };
  }

  // Dias sem leitura depois da última leitura (até ontem): aguardando a próxima leitura.
  if (daily && readings.length) {
    const lastDate = readings[readings.length - 1].reading_date;
    const yesterday = F.addDays(today, -1);
    for (let d = F.addDays(lastDate, 1); d <= to && d <= yesterday; d = F.addDays(d, 1)) {
      Object.assign(item(d), { kind: 'sem_estimativa', reason: 'aguardando',
        reason_text: 'Sem estimativa: ainda não há leitura posterior para medir o consumo do intervalo.' });
    }
  }
  return [...days.values()].filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}

/** Resumo de uma série: consumo registrado, estimado, total e dias com/sem leitura. */
function summarize(series) {
  const s = { registered: 0, estimated: 0, total: 0, covered_days: 0, days_with_reading: 0, days_without_reading: 0,
    days_estimated: 0, days_no_estimate: 0, days_no_history: 0, days_waiting: 0, missing_dates: [] };
  for (const d of series) {
    s.registered += d.registered;
    s.estimated += d.estimated;
    s.covered_days += d.covered_days;
    if (d.kind === 'leitura') s.days_with_reading++;
    else {
      s.days_without_reading++;
      s.missing_dates.push(d.date);
      if (d.kind === 'estimado') s.days_estimated++;
      else {
        s.days_no_estimate++;
        if (d.reason === 'historico') s.days_no_history++;
        if (d.reason === 'aguardando') s.days_waiting++;
      }
    }
  }
  s.registered = r3(s.registered);
  s.estimated = r3(s.estimated);
  s.total = r3(s.registered + s.estimated);
  s.daily_avg = s.covered_days ? r2(s.total / s.covered_days) : null;
  return s;
}

/** Texto explicativo das estimativas de um período (relatório e fechamento). */
function estimateMessages(sum) {
  const out = [];
  if (sum.days_estimated) {
    out.push(`Este período possui ${sum.days_estimated} dia${sum.days_estimated > 1 ? 's' : ''} sem leitura. `
      + 'O consumo desses dias foi estimado com base na média diária anterior.');
  }
  if (sum.days_no_history) {
    out.push(`${sum.days_no_history} dia${sum.days_no_history > 1 ? 's' : ''} sem leitura sem estimativa: ${MSG_NO_HISTORY}`);
  }
  if (sum.days_waiting) {
    out.push(`${sum.days_waiting} dia${sum.days_waiting > 1 ? 's' : ''} sem leitura aguardando a próxima leitura (ainda sem estimativa).`);
  }
  return out;
}

/**
 * Comparação justa entre períodos com quantidades diferentes de dias:
 * usa a média diária (consumo ÷ dias com consumo apurado), não o consumo bruto.
 */
function compareDaily(current, previous) {
  const valid = previous.filter((p) => p.covered_days > 0 && p.consumption !== null);
  const prevTotal = valid.reduce((a, p) => a + p.consumption, 0);
  const prevDays = valid.reduce((a, p) => a + p.covered_days, 0);
  const avg = prevDays ? prevTotal / prevDays : null;
  const last = previous.length ? previous[previous.length - 1] : null;
  const pct = (a, b) => (a !== null && b ? Math.round(((a - b) / b) * 100) : null);
  return {
    average_daily: avg !== null ? r2(avg) : null,
    vs_average_pct: current.covered_days ? pct(current.daily_avg, avg) : null,
    vs_last_pct: current.covered_days && last && last.covered_days ? pct(current.daily_avg, last.daily_avg) : null,
  };
}

module.exports = { dailySeries, summarize, estimateMessages, compareDaily, dailyAverageBefore, MIN_HISTORY_DAYS, MSG_NO_HISTORY };
