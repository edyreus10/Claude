'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { ValidationError, str, id, number } = require('../validate');
const F = require('../format');
const S = require('../services');

const READING_SELECT = `
  SELECT v.*, m.name AS meter_name, m.unit, m.utility_type, m.kind, m.condominium_id,
         t.name AS type_name, t.icon AS type_icon, t.color AS type_color, t.sort_order AS type_order,
         c.name AS condominium_name
  FROM v_readings v
  JOIN meters m ON m.id = v.meter_id
  JOIN utility_types t ON t.code = m.utility_type
  JOIN condominiums c ON c.id = m.condominium_id`;

function filters(q) {
  const where = [];
  const params = [];
  if (q.condominium_id) { where.push('m.condominium_id = ?'); params.push(Number(q.condominium_id)); }
  if (q.meter_id) { where.push('v.meter_id = ?'); params.push(Number(q.meter_id)); }
  if (q.utility_type) { where.push('m.utility_type = ?'); params.push(String(q.utility_type)); }
  if (F.isValidISODate(q.from)) { where.push('v.reading_date >= ?'); params.push(q.from); }
  if (F.isValidISODate(q.to)) { where.push('v.reading_date <= ?'); params.push(q.to); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function getReading(db, readingId) {
  return db.prepare(`${READING_SELECT} WHERE v.id = ?`).get(readingId);
}

const typeLower = (m) => m.type_name.toLowerCase();

module.exports = (db) => {
  const r = express.Router();

  function validate(body, existing) {
    const meterId = existing ? existing.meter_id : id(body.meter_id, 'medidor');
    const meter = S.getMeter(db, meterId);
    if (!meter) throw new ValidationError('Medidor não encontrado.');
    if (!existing && (!meter.active || meter.condominium_status !== 'active')) {
      throw new ValidationError('Este medidor (ou o condomínio) está inativo.');
    }
    const date = String(body.reading_date || '');
    if (!F.isValidISODate(date)) throw new ValidationError('Informe uma data válida.');
    if (date > F.todayISO()) throw new ValidationError('A data da leitura não pode ser no futuro.');
    const time = String(body.reading_time || '08:00');
    if (!F.isValidTime(time)) throw new ValidationError('Informe um horário válido (ex.: 08:00).');
    const value = number(body.value, 'Leitura atual', { requiredField: true, min: 0 });
    const isReset = body.is_reset === true || body.is_reset === 1 || body.is_reset === '1' ? 1 : 0;
    const exclude = existing ? existing.id : 0;

    const dup = db.prepare('SELECT id FROM readings WHERE meter_id = ? AND reading_date = ? AND reading_time = ? AND id <> ?')
      .get(meterId, date, time, exclude);
    if (dup) throw new ValidationError(`Já existe uma leitura deste medidor em ${F.fmtDate(date)} às ${time}.`);

    const prev = S.previousReading(db, meterId, date, time, exclude);
    if (prev && !isReset && value < prev.value) {
      const err = new ValidationError(`A leitura informada (${F.fmtNum(value)} ${meter.unit}) é menor que a leitura anterior `
        + `(${F.fmtNum(prev.value)} ${meter.unit} em ${F.fmtDate(prev.reading_date)}). Confira o valor. `
        + 'Se o medidor foi trocado ou zerado, marque essa opção.');
      err.code = 'LOWER_THAN_PREVIOUS';
      throw err;
    }
    const next = S.nextReading(db, meterId, date, time, exclude);
    if (next && !next.is_reset && value > next.value) {
      throw new ValidationError(`A leitura informada (${F.fmtNum(value)} ${meter.unit}) é maior que a leitura seguinte `
        + `já registrada (${F.fmtNum(next.value)} ${meter.unit} em ${F.fmtDate(next.reading_date)}). Confira o valor.`);
    }
    return {
      meter, prev,
      data: {
        meter_id: meterId, reading_date: date, reading_time: time, value, is_reset: isReset,
        responsible: str(body.responsible, 120), notes: str(body.notes, 1000),
      },
    };
  }

  r.get('/', (req, res) => {
    const { where, params } = filters(req.query);
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const rows = db.prepare(`${READING_SELECT} ${where}
        ORDER BY v.reading_date DESC, v.reading_time DESC, c.name, t.sort_order LIMIT ?`).all(...params, limit);
    res.json(rows.map((x) => ({ ...x, weekday: F.weekday(x.reading_date) })));
  });

  /**
   * Histórico no formato de planilha: uma linha por data e uma coluna
   * (leitura + consumo) por medidor.
   */
  r.get('/sheet', (req, res) => {
    const condominiumId = id(req.query.condominium_id, 'condomínio');
    const { where, params } = filters({ ...req.query, condominium_id: condominiumId });
    const readings = db.prepare(`${READING_SELECT} ${where} ORDER BY v.reading_date, v.reading_time, v.id`).all(...params);
    const meterIds = new Set(readings.map((x) => x.meter_id));
    const meters = S.listMeters(db, { condominiumId }).filter((m) => m.active || meterIds.has(m.id));
    const rows = [];
    const byDate = new Map();
    for (const rd of readings) {
      let list = byDate.get(rd.reading_date);
      if (!list) { list = []; byDate.set(rd.reading_date, list); }
      let row = list.find((x) => !x.cells[rd.meter_id]);
      if (!row) {
        row = { date: rd.reading_date, weekday: F.weekday(rd.reading_date), time: rd.reading_time, responsible: rd.responsible, cells: {} };
        list.push(row);
        rows.push(row);
      }
      row.cells[rd.meter_id] = {
        id: rd.id, value: rd.value, consumption: rd.consumption, is_reset: rd.is_reset,
        time: rd.reading_time, responsible: rd.responsible, notes: rd.notes,
      };
    }
    rows.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? 1 : -1));
    const totals = {};
    for (const m of meters) {
      totals[m.id] = readings.filter((x) => x.meter_id === m.id && x.consumption !== null)
        .reduce((a, x) => Math.round((a + x.consumption) * 1000) / 1000, 0);
    }
    res.json({ meters, rows, totals });
  });

  r.get('/:id', (req, res) => {
    const rd = getReading(db, req.params.id);
    if (!rd) return res.status(404).json({ error: 'Leitura não encontrada.' });
    res.json({ ...rd, weekday: F.weekday(rd.reading_date) });
  });

  r.post('/', (req, res) => {
    const { meter, data } = validate(req.body);
    const now = F.nowLocal();
    const info = db.prepare(`INSERT INTO readings (meter_id,reading_date,reading_time,value,is_reset,responsible,notes,
        created_by,updated_by,created_at,updated_at) VALUES (@meter_id,@reading_date,@reading_time,@value,@is_reset,@responsible,@notes,
        @uid,@uid,@now,@now)`).run({ ...data, uid: req.user.id, now });
    const saved = getReading(db, info.lastInsertRowid);
    audit(db, req.user, { action: 'create', entity: 'reading', entityId: saved.id, condominiumId: meter.condominium_id,
      description: `${req.user.name} registrou a leitura de ${typeLower(meter)} (${meter.name}) do dia ${F.fmtDate(data.reading_date)} `
        + `às ${data.reading_time}: ${F.fmtNum(data.value)} ${meter.unit}`
        + `${saved.consumption !== null ? `, consumo de ${F.fmtNum(saved.consumption)} ${meter.unit}` : ''}`
        + `${data.is_reset ? ' (medidor trocado/zerado)' : ''} — ${meter.condominium_name}.` });
    res.status(201).json(saved);
  });

  r.put('/:id', requireAdmin, (req, res) => {
    const before = getReading(db, req.params.id);
    if (!before) return res.status(404).json({ error: 'Leitura não encontrada.' });
    const { meter, data } = validate(req.body, before);
    db.prepare(`UPDATE readings SET reading_date=@reading_date,reading_time=@reading_time,value=@value,is_reset=@is_reset,
        responsible=@responsible,notes=@notes,updated_by=@uid,updated_at=@now WHERE id=@id`)
      .run({ ...data, uid: req.user.id, now: F.nowLocal(), id: before.id });

    const parts = [];
    if (before.value !== data.value) parts.push(`de ${F.fmtNum(before.value)} para ${F.fmtNum(data.value)} ${meter.unit}`);
    if (before.reading_date !== data.reading_date) parts.push(`data de ${F.fmtDate(before.reading_date)} para ${F.fmtDate(data.reading_date)}`);
    if (before.reading_time !== data.reading_time) parts.push(`horário de ${before.reading_time} para ${data.reading_time}`);
    if ((before.responsible || '') !== (data.responsible || '')) parts.push(`responsável de "${before.responsible || '—'}" para "${data.responsible || '—'}"`);
    if ((before.notes || '') !== (data.notes || '')) parts.push('observação');
    if (before.is_reset !== data.is_reset) parts.push(data.is_reset ? 'marcou como medidor trocado/zerado' : 'desmarcou medidor trocado/zerado');
    if (parts.length) {
      audit(db, req.user, { action: 'update', entity: 'reading', entityId: before.id, condominiumId: meter.condominium_id,
        description: `${req.user.name} alterou a leitura de ${typeLower(meter)} do dia ${F.fmtDate(before.reading_date)} `
          + `(${meter.condominium_name}): ${parts.join('; ')}.` });
    }
    res.json(getReading(db, before.id));
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const rd = getReading(db, req.params.id);
    if (!rd) return res.status(404).json({ error: 'Leitura não encontrada.' });
    db.prepare('DELETE FROM readings WHERE id = ?').run(rd.id);
    audit(db, req.user, { action: 'delete', entity: 'reading', entityId: rd.id, condominiumId: rd.condominium_id,
      description: `${req.user.name} excluiu a leitura de ${rd.type_name.toLowerCase()} do dia ${F.fmtDate(rd.reading_date)} `
        + `(${F.fmtNum(rd.value)} ${rd.unit}) — ${rd.condominium_name}.` });
    res.json({ ok: true });
  });

  return r;
};

module.exports.READING_SELECT = READING_SELECT;
