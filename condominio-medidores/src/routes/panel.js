'use strict';
/** Dashboard, alertas, calendário, fechamento mensal e gráficos. */
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { ValidationError, id, str } = require('../validate');
const F = require('../format');
const S = require('../services');

function parseYearMonth(q) {
  const year = Number(q.year);
  const month = Number(q.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ValidationError('Selecione o ano.');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new ValidationError('Selecione o mês.');
  return { year, month };
}

function shiftMonth(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Fechamento de todos os medidores de um condomínio em um mês, com comparação aos meses anteriores. */
function buildClosing(db, condominiumId, year, month, compareMonths = 6) {
  const condo = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(condominiumId);
  if (!condo) throw new ValidationError('Condomínio não encontrado.', 404);
  const { from, to } = F.monthRange(year, month);
  const meters = S.listMeters(db, { condominiumId });
  const savedRows = db.prepare(`SELECT mc.*, u.name AS closed_by_name FROM monthly_closings mc
      LEFT JOIN users u ON u.id = mc.closed_by WHERE mc.condominium_id = ? AND mc.year = ? AND mc.month = ?`).all(condominiumId, year, month);
  const saved = new Map(savedRows.map((x) => [x.meter_id, x]));

  const history = [];
  for (let i = compareMonths; i >= 1; i--) history.push(shiftMonth(year, month, -i));
  const historyData = history.map((h) => {
    const rng = F.monthRange(h.year, h.month);
    return { ...h, label: `${F.monthName(h.month).slice(0, 3)}/${h.year}`, map: S.consumptionByMeter(db, rng.from, rng.to, condominiumId) };
  });

  const items = [];
  for (const m of meters) {
    const cur = S.closingForMeter(db, m.id, from, to);
    if (!m.active && !cur.readings_count && !saved.has(m.id)) continue;
    const previous = historyData.map((h) => {
      const x = h.map.get(m.id);
      return { year: h.year, month: h.month, label: h.label, consumption: x && x.consumption !== null ? Math.round(x.consumption * 1000) / 1000 : null };
    });
    const valid = previous.filter((p) => p.consumption !== null);
    const avg = valid.length ? valid.reduce((a, p) => a + p.consumption, 0) / valid.length : null;
    const last = previous[previous.length - 1];
    items.push({
      meter_id: m.id, meter_name: m.name, identifier: m.identifier, unit: m.unit, kind: m.kind, active: m.active,
      utility_type: m.utility_type, type_name: m.type_name, type_icon: m.type_icon, type_color: m.type_color,
      ...cur,
      previous,
      average: avg !== null ? Math.round(avg * 10) / 10 : null,
      vs_average_pct: avg && cur.consumption !== null ? Math.round(((cur.consumption - avg) / avg) * 100) : null,
      vs_last_pct: last && last.consumption && cur.consumption !== null ? Math.round(((cur.consumption - last.consumption) / last.consumption) * 100) : null,
      saved: saved.get(m.id) || null,
    });
  }
  const dated = items.filter((i) => i.initial_date);
  const periodStart = dated.length ? dated.map((i) => i.initial_date).sort()[0] : null;
  const periodEnd = dated.length ? dated.map((i) => i.final_date).sort().pop() : null;
  return {
    condominium: condo, year, month, month_name: F.monthName(month), from, to,
    days_in_month: Number(to.slice(8)),
    period_start: periodStart, period_end: periodEnd,
    period_days: periodStart ? F.diffDays(periodStart, periodEnd) : null,
    is_closed: savedRows.length > 0,
    closed_at: savedRows.length ? savedRows[0].closed_at : null,
    closed_by_name: savedRows.length ? savedRows[0].closed_by_name : null,
    notes: savedRows.length ? savedRows[0].notes : null,
    items,
  };
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/dashboard', (req, res) => {
    const condominiumId = req.query.condominium_id ? Number(req.query.condominium_id) : null;
    const today = F.todayISO();
    const { from, to } = F.monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
    const statuses = S.meterStatuses(db, { condominiumId, today });
    const condoWhere = condominiumId ? 'AND m.condominium_id = ?' : '';
    const condoParams = condominiumId ? [condominiumId] : [];
    const readingsMonth = db.prepare(`SELECT COUNT(*) n FROM readings r JOIN meters m ON m.id = r.meter_id
        JOIN condominiums c ON c.id = m.condominium_id WHERE r.reading_date BETWEEN ? AND ? AND c.status = 'active' ${condoWhere}`)
      .get(from, to, ...condoParams).n;
    const totalCondos = db.prepare(`SELECT COUNT(*) n FROM condominiums WHERE status = 'active' ${condominiumId ? 'AND id = ?' : ''}`)
      .get(...condoParams).n;
    const types = db.prepare('SELECT * FROM utility_types WHERE active = 1 ORDER BY sort_order').all();
    const cons = S.consumptionByType(db, from, to, condominiumId);
    const prev = shiftMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)), -1);
    const prevRange = F.monthRange(prev.year, prev.month);
    const consPrev = S.consumptionByType(db, prevRange.from, prevRange.to, condominiumId);

    // Próximas leituras agrupadas por condomínio
    const groups = [];
    for (const st of statuses) {
      let g = groups.find((x) => x.condominium_id === st.condominium_id);
      if (!g) { g = { condominium_id: st.condominium_id, condominium_name: st.condominium_name, items: [] }; groups.push(g); }
      g.items.push(st);
    }

    res.json({
      today,
      month_name: F.monthName(Number(today.slice(5, 7))),
      cards: {
        condominiums: totalCondos,
        pending: statuses.filter((s) => s.status === 'atrasada' || s.status === 'sem_leitura').length,
        readings_month: readingsMonth,
        upcoming: statuses.filter((s) => s.status === 'proxima').length,
        meters: statuses.length,
      },
      consumption: types.filter((t) => ['agua', 'gas', 'energia'].includes(t.code) || cons.some((c) => c.utility_type === t.code))
        .map((t) => {
          const c = cons.find((x) => x.utility_type === t.code);
          const p = consPrev.find((x) => x.utility_type === t.code);
          return { utility_type: t.code, name: t.name, unit: t.unit, icon: t.icon, color: t.color,
            consumption: c ? c.consumption : 0, previous: p ? p.consumption : null };
        }),
      upcoming: groups,
      alerts: S.alerts(db, { condominiumId, today }),
    });
  });

  r.get('/alerts', (req, res) => {
    const condominiumId = req.query.condominium_id ? Number(req.query.condominium_id) : null;
    res.json(S.alerts(db, { condominiumId }));
  });

  r.get('/calendar', (req, res) => {
    const { year, month } = parseYearMonth(req.query);
    const condominiumId = req.query.condominium_id ? Number(req.query.condominium_id) : null;
    res.json({ year, month, month_name: F.monthName(month), today: F.todayISO(),
      events: S.calendarEvents(db, { year, month, condominiumId }) });
  });

  r.get('/charts', (req, res) => {
    const months = [3, 6, 12].includes(Number(req.query.months)) ? Number(req.query.months) : 6;
    const condominiumId = req.query.condominium_id ? Number(req.query.condominium_id) : null;
    res.json(S.chartSeries(db, { condominiumId, months }));
  });

  r.get('/closing', (req, res) => {
    const { year, month } = parseYearMonth(req.query);
    res.json(buildClosing(db, id(req.query.condominium_id, 'condomínio'), year, month));
  });

  /** Grava (fecha) o mês: guarda uma "fotografia" das leituras inicial/final e consumo. */
  r.post('/closing', requireAdmin, (req, res) => {
    const { year, month } = parseYearMonth(req.body);
    const condominiumId = id(req.body.condominium_id, 'condomínio');
    const c = buildClosing(db, condominiumId, year, month);
    const withData = c.items.filter((i) => i.readings_count > 0);
    if (!withData.length) throw new ValidationError('Não há leituras neste mês para fechar.');
    const notes = str(req.body.notes, 1000);
    const now = F.nowLocal();
    const up = db.prepare(`INSERT INTO monthly_closings (condominium_id,meter_id,year,month,initial_date,initial_value,final_date,final_value,
        consumption,days,notes,closed_by,closed_at) VALUES (@cid,@meter_id,@year,@month,@initial_date,@initial_value,@final_date,@final_value,
        @consumption,@days,@notes,@uid,@now)
        ON CONFLICT(meter_id,year,month) DO UPDATE SET initial_date=excluded.initial_date,initial_value=excluded.initial_value,
        final_date=excluded.final_date,final_value=excluded.final_value,consumption=excluded.consumption,days=excluded.days,
        notes=excluded.notes,closed_by=excluded.closed_by,closed_at=excluded.closed_at`);
    db.transaction(() => {
      for (const i of withData) {
        up.run({ cid: condominiumId, meter_id: i.meter_id, year, month, initial_date: i.initial_date, initial_value: i.initial_value,
          final_date: i.final_date, final_value: i.final_value, consumption: i.consumption, days: i.days, notes, uid: req.user.id, now });
      }
    })();
    const resume = withData.map((i) => `${i.type_name} ${F.fmtNum(i.consumption)} ${i.unit}`).join(', ');
    audit(db, req.user, { action: c.is_closed ? 'update' : 'create', entity: 'monthly_closing', condominiumId,
      description: `${req.user.name} ${c.is_closed ? 'atualizou o fechamento' : 'fechou o mês'} de ${F.monthName(month)}/${year} do condomínio `
        + `${c.condominium.name} (${resume}).` });
    res.json(buildClosing(db, condominiumId, year, month));
  });

  r.delete('/closing', requireAdmin, (req, res) => {
    const { year, month } = parseYearMonth(req.query);
    const condominiumId = id(req.query.condominium_id, 'condomínio');
    const condo = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(condominiumId);
    if (!condo) return res.status(404).json({ error: 'Condomínio não encontrado.' });
    const info = db.prepare('DELETE FROM monthly_closings WHERE condominium_id = ? AND year = ? AND month = ?').run(condominiumId, year, month);
    if (info.changes) {
      audit(db, req.user, { action: 'delete', entity: 'monthly_closing', condominiumId,
        description: `${req.user.name} reabriu o mês de ${F.monthName(month)}/${year} do condomínio ${condo.name}.` });
    }
    res.json({ ok: true });
  });

  return r;
};

module.exports.buildClosing = buildClosing;
