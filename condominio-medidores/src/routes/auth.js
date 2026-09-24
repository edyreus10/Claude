'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { createSession, destroySession, requireAuth, loginRateLimit } = require('../auth');
const { audit } = require('../audit');
const { ValidationError, required } = require('../validate');
const { nowLocal } = require('../format');

module.exports = (db) => {
  const r = express.Router();

  r.post('/login', loginRateLimit, (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    req.resetLoginAttempts();
    createSession(db, res, user.id, req.secure);
    audit(db, user, { action: 'login', entity: 'user', entityId: user.id, description: `${user.name} entrou no sistema.` });
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, must_change_password: user.must_change_password } });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const org = db.prepare("SELECT value FROM settings WHERE key = 'org_name'").get();
    res.json({ user: req.user || null, org_name: org ? org.value : null });
  });

  r.post('/change-password', requireAuth, (req, res) => {
    const current = String(req.body.current_password || '');
    const next = required(req.body.new_password, 'Nova senha', 200);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(current, user.password_hash)) throw new ValidationError('A senha atual está incorreta.');
    if (next.length < 6) throw new ValidationError('A nova senha deve ter pelo menos 6 caracteres.');
    if (next === current) throw new ValidationError('A nova senha deve ser diferente da atual.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(bcrypt.hashSync(next, 10), nowLocal(), user.id);
    audit(db, req.user, { action: 'update', entity: 'user', entityId: user.id, description: `${user.name} alterou a própria senha.` });
    res.json({ ok: true });
  });

  return r;
};
