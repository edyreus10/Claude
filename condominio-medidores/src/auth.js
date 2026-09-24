'use strict';
/** Autenticação por sessão (cookie HttpOnly) e controle de permissões. */
const crypto = require('crypto');
const { nowLocal } = require('./format');

const COOKIE = 'cm_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie inválido */ }
  }
  return out;
}

/**
 * Cookie "Secure" (só enviado por HTTPS):
 *   COOKIE_SECURE=true  → sempre (servidor publicado com HTTPS)
 *   COOKIE_SECURE=false → nunca (desenvolvimento local)
 *   (padrão)            → automático, quando a requisição chegou por HTTPS
 */
function isSecure(req) {
  const v = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return !!req.secure;
}

function cookie(req, value, maxAge) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}

function createSession(db, req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, expires, nowLocal());
  res.setHeader('Set-Cookie', cookie(req, token, SESSION_DAYS * 86400));
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}

/** Encerra as outras sessões do usuário (ex.: depois de trocar a senha). */
function destroyOtherSessions(db, req) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionHash || '');
}

/** Carrega req.user a partir do cookie de sessão. */
function loadUser(db) {
  const stmt = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.must_change_password
                           FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionHash = token ? sha256(token) : null;
    req.user = token ? stmt.get(req.sessionHash, Date.now()) || null : null;
    next();
  };
}

/** Exige login (sem exigir a troca de senha — usado na própria troca de senha). */
function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  next();
}

/** Exige login e que a senha provisória já tenha sido trocada. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  if (req.user.must_change_password) {
    return res.status(403).json({ error: 'Troque a senha provisória antes de continuar.', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Somente administradores podem realizar esta ação.' });
    }
    next();
  });
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

/**
 * Limite de tentativas de login erradas.
 * - por conta + endereço: 8 erros em 15 min bloqueiam só aquela conta naquele endereço
 *   (outras pessoas na mesma rede continuam entrando);
 * - por endereço: 40 erros em 15 min (tentativas em muitas contas).
 */
const WINDOW = 15 * 60000;
const failures = new Map();
function hit(key, now) {
  const e = failures.get(key);
  if (!e || now > e.reset) { failures.set(key, { count: 1, reset: now + WINDOW }); return 1; }
  e.count++;
  return e.count;
}
function blocked(key, limit, now) {
  const e = failures.get(key);
  return !!e && now <= e.reset && e.count >= limit;
}
function loginRateLimit(req, res, next) {
  const now = Date.now();
  if (failures.size > 10000) for (const [k, e] of failures) if (now > e.reset) failures.delete(k);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const accountKey = `a:${req.ip}|${email}`;
  const ipKey = `i:${req.ip}`;
  if (blocked(accountKey, 8, now) || blocked(ipKey, 40, now)) {
    return res.status(429).json({ error: 'Muitas tentativas erradas. Aguarde 15 minutos e tente novamente.' });
  }
  req.loginFailed = () => { hit(accountKey, now); hit(ipKey, now); };
  req.loginSucceeded = () => { failures.delete(accountKey); };
  next();
}

module.exports = {
  createSession, destroySession, destroyOtherSessions, loadUser, requireLogin, requireAuth, requireAdmin, csrfGuard, loginRateLimit,
};
