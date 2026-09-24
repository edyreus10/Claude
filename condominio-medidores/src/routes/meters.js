'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit, describeChanges } = require('../audit');
const { ValidationError, required, str, oneOf, id, number } = require('../validate');
const { nowLocal, isValidISODate, isValidTime } = require('../format');
const S = require('../services');
const { removeAttachmentsWhere } = require('../storage');

const LABELS = {
  name: 'Nome', identifier: 'Identificação', unit: 'Unidade', location: 'Localização',
  utility_company: 'Concessionária', kind: 'Tipo', frequency_days: 'Frequência (dias)', notes: 'Observações', active: 'Situação',
};
const kindLabel = (k) => (k === 'area' ? 'Área específica' : 'Principal');

function readBody(db, body) {
  const type = db.prepare('SELECT * FROM utility_types WHERE code = ?').get(body.utility_type);
  if (!type) throw new ValidationError('Selecione o tipo de medidor (Água, Gás, Energia...).');
  const freq = number(body.frequency_days, 'Frequência de leitura', { min: 1 })
    || (db.prepare('SELECT default_frequency_days d FROM condominiums WHERE id = ?').get(Number(body.condominium_id)) || {}).d || 1; // padrão: diária
  if (freq > 366 || !Number.isInteger(freq)) throw new ValidationError('A frequência de leitura deve ser um número de dias entre 1 e 366.');
  return {
    condominium_id: id(body.condominium_id, 'condomínio'),
    utility_type: type.code,
    name: required(body.name, 'Nome do medidor', 120),
    identifier: str(body.identifier, 80),
    unit: str(body.unit, 10) || type.unit,
    location: str(body.location, 200),
    utility_company: str(body.utility_company, 120),
    kind: oneOf(body.kind, ['principal', 'area'], 'Tipo', 'principal'),
    frequency_days: freq,
    notes: str(body.notes, 1000),
    active: body.active === false || body.active === 0 || body.active === '0' ? 0 : 1,
  };
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const condominiumId = req.query.condominium_id ? Number(req.query.condominium_id) : null;
    const rows = S.listMeters(db, { condominiumId, activeOnly: req.query.active === '1' });
    const counts = new Map(db.prepare('SELECT meter_id, COUNT(*) n FROM readings GROUP BY meter_id').all().map((x) => [x.meter_id, x.n]));
    res.json(rows.map((m) => ({ ...m, readings_count: counts.get(m.id) || 0 })));
  });

  r.get('/:id', (req, res) => {
    const m = S.getMeter(db, req.params.id);
    if (!m) return res.status(404).json({ error: 'Medidor não encontrado.' });
    res.json(m);
  });

  /** Leitura anterior (e seguinte) a uma data/hora — usada no formulário de leitura. */
  r.get('/:id/previous', (req, res) => {
    const m = S.getMeter(db, req.params.id);
    if (!m) return res.status(404).json({ error: 'Medidor não encontrado.' });
    const date = isValidISODate(req.query.date) ? req.query.date : '9999-12-31';
    const time = isValidTime(req.query.time) ? req.query.time : '23:59';
    const exclude = Number(req.query.exclude_id) || 0;
    res.json({
      meter: m,
      previous: S.previousReading(db, m.id, date, time, exclude) || null,
      next: S.nextReading(db, m.id, date, time, exclude) || null,
    });
  });

  r.post('/', requireAdmin, (req, res) => {
    const d = readBody(db, req.body);
    const condo = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(d.condominium_id);
    if (!condo) throw new ValidationError('Condomínio não encontrado.');
    const now = nowLocal();
    const info = db.prepare(`INSERT INTO meters (condominium_id,utility_type,name,identifier,unit,location,utility_company,kind,
        frequency_days,notes,active,created_at,updated_at) VALUES (@condominium_id,@utility_type,@name,@identifier,@unit,@location,
        @utility_company,@kind,@frequency_days,@notes,@active,@now,@now)`).run({ ...d, now });
    audit(db, req.user, { action: 'create', entity: 'meter', entityId: info.lastInsertRowid, condominiumId: condo.id,
      description: `${req.user.name} cadastrou o medidor "${d.name}" (${d.unit}) no condomínio ${condo.name}.` });
    res.status(201).json(S.getMeter(db, info.lastInsertRowid));
  });

  r.put('/:id', requireAdmin, (req, res) => {
    const before = S.getMeter(db, req.params.id);
    if (!before) return res.status(404).json({ error: 'Medidor não encontrado.' });
    const d = readBody(db, { ...req.body, condominium_id: before.condominium_id });
    const n = db.prepare('SELECT COUNT(*) n FROM readings WHERE meter_id = ?').get(before.id).n;
    if (n && d.utility_type !== before.utility_type) {
      throw new ValidationError('Não é possível trocar o tipo de um medidor que já possui leituras.');
    }
    if (n && d.unit !== before.unit) {
      throw new ValidationError(`Não é possível trocar a unidade de um medidor que já possui leituras (as ${n} leituras estão em ${before.unit}). `
        + 'Se o medidor foi substituído, cadastre um novo medidor e inative o antigo.');
    }
    db.prepare(`UPDATE meters SET utility_type=@utility_type,name=@name,identifier=@identifier,unit=@unit,location=@location,
        utility_company=@utility_company,kind=@kind,frequency_days=@frequency_days,notes=@notes,active=@active,updated_at=@now
        WHERE id=@id`).run({ ...d, now: nowLocal(), id: before.id });
    const changes = describeChanges(before, d, LABELS, { kind: kindLabel, active: (a) => (Number(a) ? 'Ativo' : 'Inativo') });
    if (changes) {
      audit(db, req.user, { action: 'update', entity: 'meter', entityId: before.id, condominiumId: before.condominium_id,
        description: `${req.user.name} alterou o medidor "${before.name}" do condomínio ${before.condominium_name} (${changes}).` });
    }
    res.json(S.getMeter(db, before.id));
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const m = S.getMeter(db, req.params.id);
    if (!m) return res.status(404).json({ error: 'Medidor não encontrado.' });
    const n = db.prepare('SELECT COUNT(*) n FROM readings WHERE meter_id = ?').get(m.id).n;
    const snapshot = {
      meter: m,
      readings: db.prepare('SELECT reading_date, reading_time, value, consumption, occurrence, responsible, notes FROM readings WHERE meter_id = ?').all(m.id),
      utility_readings: db.prepare('SELECT reading_date, value, company, next_reading_date, notes FROM utility_company_readings WHERE meter_id = ?').all(m.id),
    };
    removeAttachmentsWhere(db, 'm.id = ?', m.id);
    db.prepare('DELETE FROM meters WHERE id = ?').run(m.id);
    audit(db, req.user, { action: 'delete', entity: 'meter', entityId: m.id, condominiumId: m.condominium_id,
      description: `${req.user.name} excluiu o medidor "${m.name}" do condomínio ${m.condominium_name} (com ${n} leitura(s)).`, details: snapshot });
    res.json({ ok: true });
  });

  return r;
};
