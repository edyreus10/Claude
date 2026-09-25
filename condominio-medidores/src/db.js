'use strict';
/**
 * Banco de dados SQLite.
 *
 * Estrutura principal:
 *   users ─┬─< sessions
 *          └─< audit_logs
 *   condominiums ─< meters ─┬─< readings
 *                           ├─< utility_company_readings
 *                           └─< monthly_closings
 *   utility_types ─< meters        (água, gás, energia, e futuros tipos)
 *   settings                       (configurações gerais: chave/valor)
 *
 * Consumo: cada leitura guarda a leitura anterior e o consumo (atual − anterior).
 * Esses campos NUNCA são digitados: são recalculados por recalcMeter() para o
 * medidor inteiro, na mesma transação, sempre que uma leitura dele é incluída,
 * alterada ou excluída. Assim os consumos ficam sempre coerentes e as consultas
 * usam índices (rápidas mesmo com muitos condomínios).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nowLocal } = require('./format');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator')),
  active          INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS condominiums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  address     TEXT,
  cnpj        TEXT,
  syndic      TEXT,
  manager     TEXT,
  phone       TEXT,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS utility_types (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,
  icon        TEXT NOT NULL,
  color       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS meters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  condominium_id  INTEGER NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  utility_type    TEXT NOT NULL REFERENCES utility_types(code),
  name            TEXT NOT NULL,
  identifier      TEXT,
  unit            TEXT NOT NULL,
  location        TEXT,
  utility_company TEXT,
  kind            TEXT NOT NULL DEFAULT 'principal' CHECK (kind IN ('principal','area')),
  frequency_days  INTEGER NOT NULL DEFAULT 1,   -- dias entre leituras da administração (padrão: diária)
  notes           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meters_condo ON meters(condominium_id);

CREATE TABLE IF NOT EXISTS readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_id      INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  reading_date  TEXT NOT NULL,              -- AAAA-MM-DD
  reading_time  TEXT NOT NULL DEFAULT '08:00', -- HH:MM
  value         REAL NOT NULL,
  is_reset      INTEGER NOT NULL DEFAULT 0, -- 1 = leitura com ocorrência (não calcula consumo; vira nova base)
  responsible   TEXT,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (meter_id, reading_date, reading_time)
);
CREATE INDEX IF NOT EXISTS idx_readings_meter_date ON readings(meter_id, reading_date, reading_time);
CREATE INDEX IF NOT EXISTS idx_readings_date ON readings(reading_date);

CREATE TABLE IF NOT EXISTS utility_company_readings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_id          INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  reading_date      TEXT NOT NULL,
  value             REAL,
  company           TEXT,
  next_reading_date TEXT,
  notes             TEXT,
  attachment_path   TEXT,
  attachment_name   TEXT,
  attachment_mime   TEXT,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucr_meter_date ON utility_company_readings(meter_id, reading_date);

CREATE TABLE IF NOT EXISTS monthly_closings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  condominium_id  INTEGER NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  meter_id        INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL,
  month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  initial_date    TEXT,
  initial_value   REAL,
  final_date      TEXT,
  final_value     REAL,
  consumption     REAL,
  days            INTEGER,
  notes           TEXT,
  closed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at       TEXT NOT NULL,
  UNIQUE (meter_id, year, month)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name       TEXT,
  action          TEXT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       INTEGER,
  condominium_id  INTEGER,
  description     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Compatibilidade: as consultas usam v_readings (o consumo agora fica gravado em readings).
DROP VIEW IF EXISTS v_readings;
CREATE VIEW v_readings AS SELECT * FROM readings;
`;

const UTILITY_TYPES = [
  // code, name, unit, icon (lucide), color, ordem, ativo
  ['agua', 'Água', 'm³', 'droplet', '#0284c7', 1, 1],
  ['gas', 'Gás', 'm³', 'flame', '#ea580c', 2, 1],
  ['energia', 'Energia elétrica', 'kWh', 'zap', '#ca8a04', 3, 1],
  // Preparados para o futuro (podem ser ativados em Configurações)
  ['solar', 'Energia solar', 'kWh', 'sun', '#16a34a', 4, 0],
  ['combustivel', 'Combustível', 'L', 'fuel', '#7c3aed', 5, 0],
  ['outro', 'Outro medidor', 'un', 'gauge', '#475569', 6, 0],
];

const DEFAULT_SETTINGS = {
  org_name: 'Controle de Medidores',
  alert_threshold_pct: '20',   // % acima da média para alertar
  upcoming_days: '3',          // "leitura próxima" = até N dias
  utility_upcoming_days: '5',  // leitura da concessionária próxima
};

const round3 = (v) => Math.round(v * 1000) / 1000;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/**
 * Recalcula leitura anterior, intervalo e consumo de todas as leituras de um medidor.
 * Leituras com ocorrência (troca, zeramento, correção, outra) não geram consumo
 * automático e passam a ser a nova base para a leitura seguinte.
 */
function recalcMeter(db, meterId) {
  const rows = db.prepare(`SELECT id, reading_date, reading_time, value, is_reset, prev_value, prev_date, prev_time, consumption, interval_days
      FROM readings WHERE meter_id = ? ORDER BY reading_date, reading_time, id`).all(meterId);
  const up = db.prepare('UPDATE readings SET prev_value=?, prev_date=?, prev_time=?, consumption=?, interval_days=? WHERE id=?');
  let prev = null;
  for (const r of rows) {
    const pv = prev ? prev.value : null;
    const pd = prev ? prev.reading_date : null;
    const pt = prev ? prev.reading_time : null;
    const cons = !prev || r.is_reset ? null : round3(r.value - prev.value);
    const days = prev ? dayDiff(prev.reading_date, r.reading_date) : null;
    if (r.prev_value !== pv || r.prev_date !== pd || r.prev_time !== pt || r.consumption !== cons || r.interval_days !== days) {
      up.run(pv, pd, pt, cons, days, r.id);
    }
    prev = r;
  }
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}
function addColumn(db, table, name, def) {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

/** Atualiza bancos criados por versões anteriores (sem perder dados). */
const SCHEMA_VERSION = 4;
function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  addColumn(db, 'readings', 'prev_value', 'REAL');
  addColumn(db, 'readings', 'prev_date', 'TEXT');
  addColumn(db, 'readings', 'prev_time', 'TEXT');
  addColumn(db, 'readings', 'consumption', 'REAL');
  addColumn(db, 'readings', 'interval_days', 'INTEGER');
  addColumn(db, 'readings', 'occurrence', "TEXT CHECK (occurrence IN ('troca','zeramento','correcao','outra'))");
  addColumn(db, 'readings', 'occurrence_note', 'TEXT');
  addColumn(db, 'condominiums', 'default_frequency_days', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'audit_logs', 'details', 'TEXT');
  // v4: fechamento separa consumo registrado e estimado (dias sem leitura).
  addColumn(db, 'monthly_closings', 'consumption_registered', 'REAL');
  addColumn(db, 'monthly_closings', 'consumption_estimated', 'REAL');
  addColumn(db, 'monthly_closings', 'days_with_reading', 'INTEGER');
  addColumn(db, 'monthly_closings', 'days_without_reading', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_meters_type ON meters(utility_type);
    CREATE INDEX IF NOT EXISTS idx_ucr_next ON utility_company_readings(next_reading_date);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, action);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  if (version < 2) {
    db.transaction(() => {
      // Leituras marcadas como "medidor trocado/zerado" na versão 1.
      db.prepare("UPDATE readings SET occurrence = 'troca', occurrence_note = COALESCE(occurrence_note, 'Registrado como medidor trocado/zerado') WHERE is_reset = 1 AND occurrence IS NULL").run();
      for (const m of db.prepare('SELECT id FROM meters').all()) recalcMeter(db, m.id);
    })();
  }
  if (version < 3) {
    // v3: a leitura da administração passou a ser DIÁRIA por padrão. Condomínios e
    // medidores que estavam no padrão antigo (semanal) passam para diária.
    db.prepare('UPDATE condominiums SET default_frequency_days = 1 WHERE default_frequency_days = 7').run();
    db.prepare('UPDATE meters SET frequency_days = 1 WHERE frequency_days = 7').run();
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function open(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'medidores.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  db.file = dbFile;

  const insType = db.prepare(`INSERT OR IGNORE INTO utility_types (code,name,unit,icon,color,sort_order,active) VALUES (?,?,?,?,?,?,?)`);
  for (const t of UTILITY_TYPES) insType.run(...t);

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  // Primeiro acesso: cria o administrador inicial. A senha vem de ADMIN_PASSWORD
  // ou é gerada aleatoriamente (mostrada uma única vez no terminal).
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count === 0) {
    const now = nowLocal();
    const email = (process.env.ADMIN_EMAIL || 'admin@admin.com').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    db.prepare(`INSERT INTO users (name,email,password_hash,role,must_change_password,created_at,updated_at)
                VALUES (?,?,?,?,1,?,?)`)
      .run('Administrador', email, bcrypt.hashSync(password, 10), 'admin', now, now);
    db.firstRun = { email, password: process.env.ADMIN_PASSWORD ? '(definida em ADMIN_PASSWORD)' : password };
  }
  return db;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { open, getSettings, recalcMeter, SCHEMA_VERSION };
