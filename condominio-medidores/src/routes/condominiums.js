'use strict';
const express = require('express');
const { requireAdmin } = require('../auth');
const { audit, describeChanges } = require('../audit');
const { ValidationError, required, str, oneOf, isEmail, number } = require('../validate');
const { nowLocal } = require('../format');
const { removeAttachmentsWhere } = require('../storage');

const LABELS = {
  name: 'Nome', address: 'Endereço', cnpj: 'CNPJ', syndic: 'Síndico', manager: 'Administrador responsável',
  phone: 'Telefone', email: 'E-mail', status: 'Status', default_frequency_days: 'Frequência padrão (dias)',
};
const statusLabel = (s) => (s === 'inactive' ? 'Inativo' : 'Ativo');

function readBody(body) {
  const data = {
    name: required(body.name, 'Nome do condomínio', 150),
    address: str(body.address, 300),
    cnpj: str(body.cnpj, 30),
    syndic: str(body.syndic, 150),
    manager: str(body.manager, 150),
    phone: str(body.phone, 40),
    email: str(body.email, 150),
    status: oneOf(body.status, ['active', 'inactive'], 'Status', 'active'),
    default_frequency_days: number(body.default_frequency_days, 'Frequência padrão de leitura', { min: 1 }) || 7,
  };
  if (!Number.isInteger(data.default_frequency_days) || data.default_frequency_days > 366) {
    throw new ValidationError('A frequência padrão deve ser um número de dias entre 1 e 366.');
  }
  if (data.email && !isEmail(data.email)) throw new ValidationError('O e-mail informado não é válido.');
  if (data.cnpj) {
    const digits = data.cnpj.replace(/\D/g, '');
    if (digits.length !== 14) throw new ValidationError('O CNPJ deve ter 14 números.');
    data.cnpj = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  return data;
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const rows = db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM meters m WHERE m.condominium_id = c.id AND m.active = 1) AS meters_count,
        (SELECT GROUP_CONCAT(DISTINCT m.utility_type) FROM meters m WHERE m.condominium_id = c.id AND m.active = 1) AS utility_types,
        (SELECT MAX(r.reading_date) FROM readings r JOIN meters m ON m.id = r.meter_id WHERE m.condominium_id = c.id) AS last_reading_date
      FROM condominiums c ORDER BY c.status, c.name COLLATE NOCASE`).all();
    res.json(rows);
  });

  r.get('/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Condomínio não encontrado.' });
    res.json(c);
  });

  r.post('/', requireAdmin, (req, res) => {
    const d = readBody(req.body);
    const dup = db.prepare('SELECT id FROM condominiums WHERE name = ? COLLATE NOCASE').get(d.name);
    if (dup) throw new ValidationError('Já existe um condomínio com esse nome.');
    const now = nowLocal();
    const info = db.prepare(`INSERT INTO condominiums (name,address,cnpj,syndic,manager,phone,email,status,default_frequency_days,created_at,updated_at)
        VALUES (@name,@address,@cnpj,@syndic,@manager,@phone,@email,@status,@default_frequency_days,@now,@now)`).run({ ...d, now });
    audit(db, req.user, { action: 'create', entity: 'condominium', entityId: info.lastInsertRowid, condominiumId: info.lastInsertRowid,
      description: `${req.user.name} cadastrou o condomínio ${d.name}.` });
    res.status(201).json(db.prepare('SELECT * FROM condominiums WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/:id', requireAdmin, (req, res) => {
    const before = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(req.params.id);
    if (!before) return res.status(404).json({ error: 'Condomínio não encontrado.' });
    const d = readBody(req.body);
    const dup = db.prepare('SELECT id FROM condominiums WHERE name = ? COLLATE NOCASE AND id <> ?').get(d.name, before.id);
    if (dup) throw new ValidationError('Já existe um condomínio com esse nome.');
    db.prepare(`UPDATE condominiums SET name=@name,address=@address,cnpj=@cnpj,syndic=@syndic,manager=@manager,
        phone=@phone,email=@email,status=@status,default_frequency_days=@default_frequency_days,updated_at=@now WHERE id=@id`).run({ ...d, now: nowLocal(), id: before.id });
    const changes = describeChanges(before, d, LABELS, { status: statusLabel });
    if (changes) {
      audit(db, req.user, { action: 'update', entity: 'condominium', entityId: before.id, condominiumId: before.id,
        description: `${req.user.name} alterou o condomínio ${before.name} (${changes}).` });
    }
    res.json(db.prepare('SELECT * FROM condominiums WHERE id = ?').get(before.id));
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const c = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Condomínio não encontrado.' });
    const n = db.prepare('SELECT COUNT(*) n FROM readings r JOIN meters m ON m.id = r.meter_id WHERE m.condominium_id = ?').get(c.id).n;
    // Guarda na auditoria uma cópia dos dados excluídos (condomínio, medidores e leituras).
    const snapshot = {
      condominium: c,
      meters: db.prepare('SELECT * FROM meters WHERE condominium_id = ?').all(c.id),
      readings: db.prepare(`SELECT r.meter_id, r.reading_date, r.reading_time, r.value, r.consumption, r.occurrence, r.responsible, r.notes
          FROM readings r JOIN meters m ON m.id = r.meter_id WHERE m.condominium_id = ?`).all(c.id),
      utility_readings: db.prepare(`SELECT u.meter_id, u.reading_date, u.value, u.company, u.next_reading_date, u.notes
          FROM utility_company_readings u JOIN meters m ON m.id = u.meter_id WHERE m.condominium_id = ?`).all(c.id),
    };
    removeAttachmentsWhere(db, 'm.condominium_id = ?', c.id);
    db.prepare('DELETE FROM condominiums WHERE id = ?').run(c.id);
    audit(db, req.user, { action: 'delete', entity: 'condominium', entityId: c.id,
      description: `${req.user.name} excluiu o condomínio ${c.name} (com ${n} leitura(s) registrada(s)).`, details: snapshot });
    res.json({ ok: true });
  });

  return r;
};
