'use strict';
/** Relatórios, usuários, configurações e auditoria. */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { requireAdmin } = require('../auth');
const { audit, describeChanges } = require('../audit');
const { ValidationError, required, str, oneOf, isEmail, number } = require('../validate');
const { getSettings } = require('../db');
const F = require('../format');
const R = require('../reports');
const backup = require('../backup');
const { UPLOAD_DIR, uploadPath, removeUpload } = require('../storage');

const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg' };
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${LOGO_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (LOGO_TYPES[file.mimetype] ? cb(null, true) : cb(new ValidationError('O logo deve ser uma imagem PNG ou JPG.'))),
});

const roleLabel = (r) => (r === 'admin' ? 'Administrador' : 'Operador');

module.exports = (db) => {
  const r = express.Router();

  // ------------------------------------------------------------ Relatórios
  r.get('/reports', (req, res) => {
    res.json(R.buildReport(db, req.query, req.user));
  });

  r.get('/reports/export', async (req, res) => {
    const rep = R.buildReport(db, req.query, req.user);
    const base = R.fileBase(rep);
    const format = String(req.query.format || 'pdf');
    let body; let type; let ext;
    if (format === 'csv') { body = R.toCSV(rep); type = 'text/csv; charset=utf-8'; ext = 'csv'; }
    else if (format === 'xlsx') { body = Buffer.from(await R.toXLSX(rep)); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ext = 'xlsx'; }
    else if (format === 'pdf') { body = await R.toPDF(rep); type = 'application/pdf'; ext = 'pdf'; }
    else throw new ValidationError('Formato de exportação inválido.');
    audit(db, req.user, { action: 'export', entity: 'report', condominiumId: rep.condominium.id,
      description: `${req.user.name} gerou o relatório ${ext.toUpperCase()} de ${rep.condominium.name} (${rep.period_label}, ${rep.utility_name}).` });
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `${format === 'pdf' && req.query.inline ? 'inline' : 'attachment'}; filename="${base}.${ext}"`);
    res.send(body);
  });

  // ------------------------------------------------------------ Usuários
  r.get('/users/responsibles', (_req, res) => {
    res.json(db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all());
  });

  r.get('/users', requireAdmin, (_req, res) => {
    res.json(db.prepare(`SELECT id, name, email, role, active, must_change_password, created_at,
        (SELECT MAX(created_at) FROM audit_logs a WHERE a.user_id = users.id AND a.action = 'login') AS last_login
        FROM users ORDER BY active DESC, name COLLATE NOCASE`).all());
  });

  function readUser(body, isNew) {
    const d = {
      name: required(body.name, 'Nome', 120),
      email: required(body.email, 'E-mail', 150).toLowerCase(),
      role: oneOf(body.role, ['admin', 'operator'], 'Perfil', 'operator'),
      active: body.active === false || body.active === 0 || body.active === '0' ? 0 : 1,
      password: str(body.password, 200),
    };
    if (!isEmail(d.email)) throw new ValidationError('O e-mail informado não é válido.');
    if (isNew && !d.password) throw new ValidationError('Defina uma senha inicial para o usuário.');
    if (d.password && d.password.length < 8) throw new ValidationError('A senha deve ter pelo menos 8 caracteres.');
    return d;
  }

  const activeAdmins = (exceptId) => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(exceptId).n;

  r.post('/users', requireAdmin, (req, res) => {
    const d = readUser(req.body, true);
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(d.email)) throw new ValidationError('Já existe um usuário com esse e-mail.');
    const now = F.nowLocal();
    const info = db.prepare(`INSERT INTO users (name,email,password_hash,role,active,must_change_password,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)`).run(d.name, d.email, bcrypt.hashSync(d.password, 10), d.role, d.active, now, now);
    audit(db, req.user, { action: 'create', entity: 'user', entityId: info.lastInsertRowid,
      description: `${req.user.name} cadastrou o usuário ${d.name} (${d.email}) com perfil ${roleLabel(d.role)}.` });
    res.status(201).json({ id: info.lastInsertRowid });
  });

  r.put('/users/:id', requireAdmin, (req, res) => {
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!before) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const d = readUser(req.body, false);
    if (db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(d.email, before.id)) throw new ValidationError('Já existe um usuário com esse e-mail.');
    if (before.role === 'admin' && (d.role !== 'admin' || !d.active) && activeAdmins(before.id) === 0) {
      throw new ValidationError('É preciso manter pelo menos um administrador ativo.');
    }
    db.prepare('UPDATE users SET name=?, email=?, role=?, active=?, updated_at=? WHERE id=?')
      .run(d.name, d.email, d.role, d.active, F.nowLocal(), before.id);
    if (d.password) {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(d.password, 10), before.id);
    }
    // Encerra as sessões abertas do usuário desativado ou com senha redefinida.
    if (before.id !== req.user.id && (!d.active || d.password)) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(before.id);
    let changes = describeChanges(before, d, { name: 'Nome', email: 'E-mail', role: 'Perfil', active: 'Situação' },
      { role: roleLabel, active: (a) => (Number(a) ? 'Ativo' : 'Inativo') });
    if (d.password) changes = changes ? `${changes}; senha redefinida` : 'senha redefinida';
    if (changes) {
      audit(db, req.user, { action: 'update', entity: 'user', entityId: before.id,
        description: `${req.user.name} alterou o usuário ${before.name} (${changes}).` });
    }
    res.json({ ok: true });
  });

  r.delete('/users/:id', requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (u.id === req.user.id) throw new ValidationError('Você não pode excluir o seu próprio usuário.');
    if (u.role === 'admin' && activeAdmins(u.id) === 0) throw new ValidationError('É preciso manter pelo menos um administrador ativo.');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    audit(db, req.user, { action: 'delete', entity: 'user', entityId: u.id, description: `${req.user.name} excluiu o usuário ${u.name} (${u.email}).` });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ Configurações
  r.get('/meta', (_req, res) => {
    const s = getSettings(db);
    res.json({
      org_name: s.org_name, has_logo: !!s.logo_file,
      alert_threshold_pct: Number(s.alert_threshold_pct), upcoming_days: Number(s.upcoming_days),
      utility_upcoming_days: Number(s.utility_upcoming_days),
      utility_types: db.prepare('SELECT * FROM utility_types ORDER BY sort_order').all(),
      today: F.todayISO(),
    });
  });

  r.put('/settings', requireAdmin, (req, res) => {
    const before = getSettings(db);
    const d = {
      org_name: required(req.body.org_name, 'Nome da administradora', 120),
      alert_threshold_pct: String(number(req.body.alert_threshold_pct, 'Percentual de alerta', { requiredField: true, min: 1 })),
      upcoming_days: String(number(req.body.upcoming_days, 'Dias para leitura próxima', { requiredField: true, min: 0 })),
      utility_upcoming_days: String(number(req.body.utility_upcoming_days, 'Dias para leitura da concessionária', { requiredField: true, min: 0 })),
    };
    const up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(d)) up.run(k, v);
    const changes = describeChanges(before, d, { org_name: 'Nome', alert_threshold_pct: 'Alerta de consumo (%)',
      upcoming_days: 'Dias para leitura próxima', utility_upcoming_days: 'Dias para leitura da concessionária' });
    if (changes) audit(db, req.user, { action: 'update', entity: 'settings', description: `${req.user.name} alterou as configurações (${changes}).` });
    res.json({ ok: true });
  });

  r.put('/utility-types/:code', requireAdmin, (req, res) => {
    const t = db.prepare('SELECT * FROM utility_types WHERE code = ?').get(req.params.code);
    if (!t) return res.status(404).json({ error: 'Tipo não encontrado.' });
    const active = req.body.active ? 1 : 0;
    if (!active) {
      const n = db.prepare('SELECT COUNT(*) n FROM meters WHERE utility_type = ? AND active = 1').get(t.code).n;
      if (n) throw new ValidationError(`Existem ${n} medidor(es) ativo(s) de ${t.name}. Inative-os antes de desativar este tipo.`);
    }
    db.prepare('UPDATE utility_types SET active = ? WHERE code = ?').run(active, t.code);
    audit(db, req.user, { action: 'update', entity: 'settings', description: `${req.user.name} ${active ? 'ativou' : 'desativou'} o tipo de medidor ${t.name}.` });
    res.json({ ok: true });
  });

  r.get('/settings/logo', (_req, res) => {
    const s = getSettings(db);
    if (!s.logo_file) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(uploadPath(s.logo_file));
  });

  r.post('/settings/logo', requireAdmin, logoUpload.single('logo'), (req, res) => {
    if (!req.file) throw new ValidationError('Selecione uma imagem.');
    const s = getSettings(db);
    removeUpload(s.logo_file);
    db.prepare("INSERT INTO settings (key,value) VALUES ('logo_file',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(req.file.filename);
    audit(db, req.user, { action: 'update', entity: 'settings', description: `${req.user.name} alterou o logo do sistema.` });
    res.json({ ok: true });
  });

  r.delete('/settings/logo', requireAdmin, (req, res) => {
    const s = getSettings(db);
    removeUpload(s.logo_file);
    db.prepare("DELETE FROM settings WHERE key = 'logo_file'").run();
    audit(db, req.user, { action: 'delete', entity: 'settings', description: `${req.user.name} removeu o logo do sistema.` });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ Backup
  r.get('/backups', requireAdmin, (_req, res) => {
    res.json({ dir: backup.BACKUP_DIR, backups: backup.list(), remote: backup.remoteStatus(db) });
  });

  r.post('/backups', requireAdmin, async (req, res) => {
    const b = await backup.run(db);
    audit(db, req.user, { action: 'create', entity: 'backup', description: `${req.user.name} fez um backup manual (${b.name})`
      + `${b.remote ? (b.remote.ok ? ' e a cópia externa foi enviada ao Cloudflare R2' : ` — FALHA na cópia externa: ${b.remote.error}`) : ''}.` });
    res.json(b);
  });

  r.get('/backups/:name', requireAdmin, (req, res) => {
    const p = backup.filePath(req.params.name);
    if (!p) return res.status(404).json({ error: 'Backup não encontrado.' });
    audit(db, req.user, { action: 'export', entity: 'backup', description: `${req.user.name} baixou o backup ${req.params.name}.` });
    res.download(p, req.params.name);
  });

  // ------------------------------------------------------------ Auditoria
  r.get('/audit', requireAdmin, (req, res) => {
    const where = [];
    const params = [];
    if (req.query.q) { where.push('(description LIKE ? OR user_name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.action) { where.push('action = ?'); params.push(String(req.query.action)); }
    if (F.isValidISODate(req.query.from)) { where.push('created_at >= ?'); params.push(req.query.from); }
    if (F.isValidISODate(req.query.to)) { where.push('created_at <= ?'); params.push(`${req.query.to} 23:59:59`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 50;
    const total = db.prepare(`SELECT COUNT(*) n FROM audit_logs ${w}`).get(...params).n;
    const rows = db.prepare(`SELECT id, user_id, user_name, action, entity, entity_id, condominium_id, description, created_at,
        details IS NOT NULL AS has_details FROM audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / size)), rows });
  });

  r.get('/audit/:id', requireAdmin, (req, res) => {
    const a = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Registro não encontrado.' });
    res.json({ ...a, details: a.details ? JSON.parse(a.details) : null });
  });

  return r;
};
