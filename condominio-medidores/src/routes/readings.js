'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { ValidationError, str, id, number, oneOf } = require('../validate');
const { recalcMeter } = require('../db');
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
const pick = (r) => ({ meter_id: r.meter_id, meter_name: r.meter_name, reading_date: r.reading_date, reading_time: r.reading_time,
  value: r.value, consumption: r.consumption, occurrence: r.occurrence, occurrence_note: r.occurrence_note,
  responsible: r.responsible, notes: r.notes, created_by: r.created_by, created_at: r.created_at });

module.exports = (db) => {
  const r = express.Router();

  /**
   * Consumo esperado para um intervalo, pela média das últimas leituras do medidor.
   * Serve para pegar erros de digitação (ex.: 4980 no lugar de 498,0).
   */
  function expectedConsumption(meterId, date, days) {
    const rows = db.prepare(`SELECT consumption, interval_days FROM readings WHERE meter_id = ? AND reading_date < ?
        AND consumption IS NOT NULL AND interval_days > 0 ORDER BY reading_date DESC, reading_time DESC LIMIT 10`).all(meterId, date);
    if (rows.length < 3) return null;
    const c = rows.reduce((x, r) => x + r.consumption, 0);
    const d = rows.reduce((x, r) => x + r.interval_days, 0);
    return (c / d) * Math.max(days, 1);
  }

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
    const occurrence = oneOf(body.occurrence || null, Object.keys(S.OCCURRENCES), 'Ocorrência', null);
    const occurrenceNote = str(body.occurrence_note, 500);
    if (occurrence && (!occurrenceNote || occurrenceNote.length < 3)) {
      throw new ValidationError('Descreva a ocorrência (o que aconteceu com o medidor ou com a leitura).');
    }
    const exclude = existing ? existing.id : 0;

    const dup = db.prepare('SELECT id FROM readings WHERE meter_id = ? AND reading_date = ? AND reading_time = ? AND id <> ?')
      .get(meterId, date, time, exclude);
    if (dup) throw new ValidationError(`Já existe uma leitura deste medidor em ${F.fmtDate(date)} às ${time}.`);

    const prev = S.previousReading(db, meterId, date, time, exclude);
    if (prev && !occurrence && value < prev.value) {
      const err = new ValidationError(`A leitura informada (${F.fmtNum(value)} ${meter.unit}) é menor que a leitura anterior `
        + `(${F.fmtNum(prev.value)} ${meter.unit} em ${F.fmtDate(prev.reading_date)}). O consumo não pode ser calculado. `
        + 'Confira o valor ou informe a ocorrência: troca do medidor, zeramento, correção de leitura ou outra.');
      err.code = 'LOWER_THAN_PREVIOUS';
      throw err;
    }
    const next = S.nextReading(db, meterId, date, time, exclude);
    if (next && !next.is_reset && value > next.value) {
      throw new ValidationError(`A leitura informada (${F.fmtNum(value)} ${meter.unit}) é maior que a leitura seguinte `
        + `já registrada (${F.fmtNum(next.value)} ${meter.unit} em ${F.fmtDate(next.reading_date)}). Confira o valor.`);
    }
    // Consumo muito acima do normal: pede confirmação (possível erro de digitação).
    const confirmed = body.confirm_high === true || body.confirm_high === '1';
    if (prev && !occurrence && !confirmed) {
      const cons = value - prev.value;
      const days = F.diffDays(prev.reading_date, date);
      const expected = expectedConsumption(meterId, date, days);
      if (expected !== null && cons > expected * 3 && cons - expected >= 1) {
        const err = new ValidationError(`O consumo calculado (${F.fmtNum(Math.round(cons * 10) / 10)} ${meter.unit} em ${Math.max(days, 1)} dia(s)) `
          + `é muito maior que o normal para este medidor (cerca de ${F.fmtNum(Math.round(expected * 10) / 10)} ${meter.unit}). `
          + 'Confira se não houve erro de digitação. Se o valor estiver correto, confirme para salvar.');
        err.code = 'HIGH_CONSUMPTION';
        throw err;
      }
    }
    return {
      meter, prev,
      data: {
        meter_id: meterId, reading_date: date, reading_time: time, value, is_reset: occurrence ? 1 : 0,
        occurrence, occurrence_note: occurrence ? occurrenceNote : null,
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
        id: rd.id, value: rd.value, consumption: rd.consumption, is_reset: rd.is_reset, occurrence: rd.occurrence,
        closes_previous_month: rd.reading_date.slice(8) === '01',
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
    const info = db.transaction(() => {
      const x = db.prepare(`INSERT INTO readings (meter_id,reading_date,reading_time,value,is_reset,occurrence,occurrence_note,responsible,notes,
          created_by,updated_by,created_at,updated_at) VALUES (@meter_id,@reading_date,@reading_time,@value,@is_reset,@occurrence,@occurrence_note,
          @responsible,@notes,@uid,@uid,@now,@now)`).run({ ...data, uid: req.user.id, now });
      recalcMeter(db, data.meter_id);
      return x;
    })();
    const saved = getReading(db, info.lastInsertRowid);
    audit(db, req.user, { action: 'create', entity: 'reading', entityId: saved.id, condominiumId: meter.condominium_id,
      description: `${req.user.name} registrou a leitura de ${typeLower(meter)} (${meter.name}) do dia ${F.fmtDate(data.reading_date)} `
        + `às ${data.reading_time}: ${F.fmtNum(data.value)} ${meter.unit}`
        + `${saved.consumption !== null ? `, consumo de ${F.fmtNum(saved.consumption)} ${meter.unit}` : ''}`
        + `${data.occurrence ? ` (ocorrência: ${S.OCCURRENCES[data.occurrence]} — ${data.occurrence_note})` : ''} — ${meter.condominium_name}.`,
      details: { after: data } });
    res.status(201).json(saved);
  });

  r.put('/:id', requireAdmin, (req, res) => {
    const before = getReading(db, req.params.id);
    if (!before) return res.status(404).json({ error: 'Leitura não encontrada.' });
    const { meter, data } = validate(req.body, before);
    db.transaction(() => {
      db.prepare(`UPDATE readings SET reading_date=@reading_date,reading_time=@reading_time,value=@value,is_reset=@is_reset,
          occurrence=@occurrence,occurrence_note=@occurrence_note,responsible=@responsible,notes=@notes,updated_by=@uid,updated_at=@now
          WHERE id=@id`).run({ ...data, uid: req.user.id, now: F.nowLocal(), id: before.id });
      recalcMeter(db, before.meter_id);
    })();

    const parts = [];
    if (before.value !== data.value) parts.push(`de ${F.fmtNum(before.value)} para ${F.fmtNum(data.value)} ${meter.unit}`);
    if (before.reading_date !== data.reading_date) parts.push(`data de ${F.fmtDate(before.reading_date)} para ${F.fmtDate(data.reading_date)}`);
    if (before.reading_time !== data.reading_time) parts.push(`horário de ${before.reading_time} para ${data.reading_time}`);
    if ((before.responsible || '') !== (data.responsible || '')) parts.push(`responsável de "${before.responsible || '—'}" para "${data.responsible || '—'}"`);
    if ((before.notes || '') !== (data.notes || '')) parts.push(`observação de "${before.notes || '—'}" para "${data.notes || '—'}"`);
    if ((before.occurrence || '') !== (data.occurrence || '') || (before.occurrence_note || '') !== (data.occurrence_note || '')) {
      parts.push(data.occurrence ? `ocorrência: ${S.OCCURRENCES[data.occurrence]} — ${data.occurrence_note}` : 'removeu a ocorrência');
    }
    if (parts.length) {
      audit(db, req.user, { action: 'update', entity: 'reading', entityId: before.id, condominiumId: meter.condominium_id,
        description: `${req.user.name} alterou a leitura de ${typeLower(meter)} do dia ${F.fmtDate(before.reading_date)} `
          + `(${meter.condominium_name}): ${parts.join('; ')}.`,
        details: { before: pick(before), after: data } });
    }
    res.json(getReading(db, before.id));
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const rd = getReading(db, req.params.id);
    if (!rd) return res.status(404).json({ error: 'Leitura não encontrada.' });
    db.transaction(() => {
      db.prepare('DELETE FROM readings WHERE id = ?').run(rd.id);
      recalcMeter(db, rd.meter_id);
    })();
    audit(db, req.user, { action: 'delete', entity: 'reading', entityId: rd.id, condominiumId: rd.condominium_id,
      description: `${req.user.name} excluiu a leitura de ${rd.type_name.toLowerCase()} do dia ${F.fmtDate(rd.reading_date)} `
        + `(${F.fmtNum(rd.value)} ${rd.unit}) — ${rd.condominium_name}.`, details: { before: pick(rd) } });
    res.json({ ok: true });
  });

  return r;
};

module.exports.READING_SELECT = READING_SELECT;
