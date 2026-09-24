'use strict';
/** Autenticação por sessão (cookie HttpOnly) e controle de permissões. */
const crypto = require('crypto');
const { nowLocal } = require('./format');

const COOKIE = 'cm_session';
const SESSION_DAYS = 7;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, expires, nowLocal());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Carrega req.user a partir do cookie de sessão. */
function loadUser(db) {
  const stmt = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.must_change_password
                           FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? stmt.get(sha256(token), Date.now()) || null : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Somente administradores podem realizar esta ação.' });
  }
  next();
}

/**
 * Proteção contra CSRF: requisições que alteram dados precisam do cabeçalho
 * X-Requested-With, que formulários de outros sites não conseguem enviar.
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Requisição inválida.' });
  }
  next();
}

/** Limite simples de tentativas de login (por IP). */
const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60000; }
  if (entry.count >= 10) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }
  entry.count++;
  attempts.set(key, entry);
  req.resetLoginAttempts = () => attempts.delete(key);
  next();
}

module.exports = { createSession, destroySession, loadUser, requireAuth, requireAdmin, csrfGuard, loginRateLimit };
