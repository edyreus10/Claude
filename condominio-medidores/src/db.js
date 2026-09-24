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
 * O consumo NÃO é gravado na tabela readings: ele é sempre calculado pela
 * view v_readings (leitura atual − leitura anterior do mesmo medidor). Assim,
 * se uma leitura antiga for corrigida, todos os consumos continuam corretos.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
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
  frequency_days  INTEGER NOT NULL DEFAULT 7,
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
  is_reset      INTEGER NOT NULL DEFAULT 0, -- 1 = medidor trocado/zerado (não calcula consumo)
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

-- Leituras com consumo calculado automaticamente (leitura atual − anterior).
DROP VIEW IF EXISTS v_readings;
CREATE VIEW v_readings AS
SELECT x.*,
       CASE WHEN x.is_reset = 1 OR x.prev_value IS NULL THEN NULL
            ELSE ROUND(x.value - x.prev_value, 3) END AS consumption,
       CASE WHEN x.prev_date IS NULL THEN NULL
            ELSE CAST(julianday(x.reading_date) - julianday(x.prev_date) AS INTEGER) END AS interval_days
FROM (
  SELECT r.*,
         LAG(r.value)        OVER w AS prev_value,
         LAG(r.reading_date) OVER w AS prev_date,
         LAG(r.reading_time) OVER w AS prev_time
  FROM readings r
  WINDOW w AS (PARTITION BY r.meter_id ORDER BY r.reading_date, r.reading_time, r.id)
) x;
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

function open(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'medidores.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insType = db.prepare(`INSERT OR IGNORE INTO utility_types (code,name,unit,icon,color,sort_order,active) VALUES (?,?,?,?,?,?,?)`);
  for (const t of UTILITY_TYPES) insType.run(...t);

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  // Primeiro acesso: cria o administrador padrão.
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count === 0) {
    const now = nowLocal();
    db.prepare(`INSERT INTO users (name,email,password_hash,role,must_change_password,created_at,updated_at)
                VALUES (?,?,?,?,1,?,?)`)
      .run('Administrador', 'admin@admin.com', bcrypt.hashSync('admin123', 10), 'admin', now, now);
    db.firstRun = true;
  }
  return db;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { open, getSettings };
