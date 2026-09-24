'use strict';
/** Leituras realizadas pelas concessionárias (com comprovante opcional). */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { requireAdmin } = require('../auth');
const { audit } = require('../audit');
const { ValidationError, str, id, number } = require('../validate');
const F = require('../format');
const S = require('../services');
const { UPLOAD_DIR, uploadPath, removeUpload } = require('../storage');

const ALLOWED = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `ucr-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(new ValidationError('Formato de arquivo não aceito. Envie PDF ou imagem (JPG, PNG).'));
  },
});

const SELECT = `
  SELECT u.*, m.name AS meter_name, m.unit, m.utility_type, m.condominium_id, m.utility_company AS meter_company,
         t.name AS type_name, t.icon AS type_icon, t.color AS type_color, c.name AS condominium_name, us.name AS created_by_name
  FROM utility_company_readings u
  JOIN meters m ON m.id = u.meter_id
  JOIN utility_types t ON t.code = m.utility_type
  JOIN condominiums c ON c.id = m.condominium_id
  LEFT JOIN users us ON us.id = u.created_by`;

module.exports = (db) => {
  const r = express.Router();
  const get = (x) => db.prepare(`${SELECT} WHERE u.id = ?`).get(x);

  function readBody(body, existing) {
    const meterId = existing ? existing.meter_id : id(body.meter_id, 'medidor');
    const meter = S.getMeter(db, meterId);
    if (!meter) throw new ValidationError('Medidor não encontrado.');
    const date = String(body.reading_date || '');
    if (!F.isValidISODate(date)) throw new ValidationError('Informe a data da leitura da concessionária.');
    if (date > F.todayISO()) {
      throw new ValidationError('A data da leitura realizada não pode ser no futuro. Para uma leitura agendada, use "Próxima leitura prevista".');
    }
    const nextDate = body.next_reading_date ? String(body.next_reading_date) : null;
    if (nextDate && !F.isValidISODate(nextDate)) throw new ValidationError('A data da próxima leitura não é válida.');
    if (nextDate && nextDate <= date) throw new ValidationError('A próxima leitura deve ser depois da data da leitura.');
    return {
      meter,
      data: {
        meter_id: meterId, reading_date: date,
        value: number(body.value, 'Leitura registrada', { min: 0 }),
        company: str(body.company, 120) || meter.utility_company,
        next_reading_date: nextDate,
        notes: str(body.notes, 1000),
      },
    };
  }

  r.get('/', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.condominium_id) { where.push('m.condominium_id = ?'); params.push(Number(req.query.condominium_id)); }
    if (req.query.utility_type) { where.push('m.utility_type = ?'); params.push(String(req.query.utility_type)); }
    if (F.isValidISODate(req.query.from)) { where.push('u.reading_date >= ?'); params.push(req.query.from); }
    if (F.isValidISODate(req.query.to)) { where.push('u.reading_date <= ?'); params.push(req.query.to); }
    const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY u.reading_date DESC, u.id DESC LIMIT 1000`).all(...params);
    res.json(rows.map(({ attachment_path: p, ...x }) => ({ ...x, has_attachment: !!p })));
  });

  r.post('/', upload.single('attachment'), (req, res) => {
    try {
      const { meter, data } = readBody(req.body);
      const now = F.nowLocal();
      const info = db.prepare(`INSERT INTO utility_company_readings (meter_id,reading_date,value,company,next_reading_date,notes,
          attachment_path,attachment_name,attachment_mime,created_by,created_at,updated_at)
          VALUES (@meter_id,@reading_date,@value,@company,@next_reading_date,@notes,@ap,@an,@am,@uid,@now,@now)`)
        .run({ ...data, ap: req.file ? req.file.filename : null, an: req.file ? req.file.originalname.slice(0, 200) : null,
          am: req.file ? req.file.mimetype : null, uid: req.user.id, now });
      audit(db, req.user, { action: 'create', entity: 'utility_reading', entityId: info.lastInsertRowid, condominiumId: meter.condominium_id,
        description: `${req.user.name} registrou a leitura da concessionária de ${meter.type_name.toLowerCase()} do dia ${F.fmtDate(data.reading_date)}`
          + `${data.value !== null ? `: ${F.fmtNum(data.value)} ${meter.unit}` : ''} — ${meter.condominium_name}.` });
      res.status(201).json(get(info.lastInsertRowid));
    } catch (e) {
      if (req.file) removeUpload(req.file.filename);
      throw e;
    }
  });

  r.put('/:id', requireAdmin, upload.single('attachment'), (req, res) => {
    const before = get(req.params.id);
    if (!before) {
      if (req.file) removeUpload(req.file.filename);
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }
    try {
      const { meter, data } = readBody(req.body, before);
      let ap = before.attachment_path; let an = before.attachment_name; let am = before.attachment_mime;
      if (req.file || req.body.remove_attachment === '1') {
        removeUpload(before.attachment_path);
        ap = req.file ? req.file.filename : null;
        an = req.file ? req.file.originalname.slice(0, 200) : null;
        am = req.file ? req.file.mimetype : null;
      }
      db.prepare(`UPDATE utility_company_readings SET reading_date=@reading_date,value=@value,company=@company,
          next_reading_date=@next_reading_date,notes=@notes,attachment_path=@ap,attachment_name=@an,attachment_mime=@am,updated_at=@now
          WHERE id=@id`).run({ ...data, ap, an, am, now: F.nowLocal(), id: before.id });
      const parts = [];
      if (before.reading_date !== data.reading_date) parts.push(`data de ${F.fmtDate(before.reading_date)} para ${F.fmtDate(data.reading_date)}`);
      if (before.value !== data.value) parts.push(`leitura de ${F.fmtNum(before.value)} para ${F.fmtNum(data.value)} ${meter.unit}`);
      if ((before.next_reading_date || '') !== (data.next_reading_date || '')) parts.push(`próxima leitura de ${F.fmtDate(before.next_reading_date)} para ${F.fmtDate(data.next_reading_date)}`);
      if ((before.company || '') !== (data.company || '')) parts.push('concessionária');
      if ((before.notes || '') !== (data.notes || '')) parts.push('observação');
      if (ap !== before.attachment_path) parts.push('comprovante');
      if (parts.length) {
        audit(db, req.user, { action: 'update', entity: 'utility_reading', entityId: before.id, condominiumId: meter.condominium_id,
          description: `${req.user.name} alterou a leitura da concessionária de ${meter.type_name.toLowerCase()} do dia ${F.fmtDate(before.reading_date)} `
            + `(${meter.condominium_name}): ${parts.join('; ')}.` });
      }
      res.json(get(before.id));
    } catch (e) {
      if (req.file) removeUpload(req.file.filename);
      throw e;
    }
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const u = get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Registro não encontrado.' });
    db.prepare('DELETE FROM utility_company_readings WHERE id = ?').run(u.id);
    removeUpload(u.attachment_path);
    audit(db, req.user, { action: 'delete', entity: 'utility_reading', entityId: u.id, condominiumId: u.condominium_id,
      description: `${req.user.name} excluiu a leitura da concessionária de ${u.type_name.toLowerCase()} do dia ${F.fmtDate(u.reading_date)} — ${u.condominium_name}.` });
    res.json({ ok: true });
  });

  r.get('/:id/attachment', (req, res) => {
    const u = get(req.params.id);
    if (!u || !u.attachment_path) return res.status(404).json({ error: 'Comprovante não encontrado.' });
    const ext = path.extname(u.attachment_path);
    const name = (u.attachment_name || `comprovante${ext}`).replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', u.attachment_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="comprovante${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(uploadPath(u.attachment_path));
  });

  return r;
};
