'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { createSession, destroySession, destroyOtherSessions, requireLogin, loginRateLimit } = require('../auth');
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
      req.loginFailed();
      if (user) {
        audit(db, null, { action: 'login_failed', entity: 'user', entityId: user.id,
          description: `Tentativa de acesso com senha incorreta para ${user.name} (${user.email})${user.active ? '' : ' — usuário inativo'}, endereço ${req.ip}.` });
      }
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    req.loginSucceeded();
    createSession(db, req, res, user.id);
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

  r.post('/change-password', requireLogin, (req, res) => {
    const current = String(req.body.current_password || '');
    const next = required(req.body.new_password, 'Nova senha', 200);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(current, user.password_hash)) throw new ValidationError('A senha atual está incorreta.');
    if (next.length < 8) throw new ValidationError('A nova senha deve ter pelo menos 8 caracteres.');
    if (next === current) throw new ValidationError('A nova senha deve ser diferente da atual.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(bcrypt.hashSync(next, 10), nowLocal(), user.id);
    destroyOtherSessions(db, req); // outras sessões abertas precisam entrar de novo
    audit(db, req.user, { action: 'update', entity: 'user', entityId: user.id, description: `${user.name} alterou a própria senha.` });
    res.json({ ok: true });
  });

  return r;
};
