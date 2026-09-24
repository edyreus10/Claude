'use strict';
/**
 * Cria um banco de DEMONSTRAÇÃO com três condomínios e um histórico de leituras.
 *
 *   npm run demo
 *
 * Por segurança, o comando SE RECUSA a rodar se o banco já tiver dados reais.
 * Para apagar mesmo assim (ex.: um banco de testes): npm run demo -- --force
 * Para criar em outro arquivo: DB_FILE=data/demo.db npm run demo
 */
require('../src/env').loadEnv();
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const F = require('../src/format');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'medidores.db');
const force = process.argv.includes('--force');
if (fs.existsSync(dbFile)) {
  let hasData = false;
  try {
    const check = new Database(dbFile, { readonly: true });
    const n = (t) => { try { return check.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };
    const isDemo = n('users') > 0 && check.prepare("SELECT COUNT(*) n FROM users WHERE email = 'edmilson@condominio.com'").get().n > 0
      && n('condominiums') === 3;
    hasData = (n('condominiums') > 0 || n('readings') > 0) && !isDemo;
    check.close();
  } catch { hasData = true; }
  if (hasData && !force) {
    console.error('');
    console.error(`  ATENÇÃO: o banco ${dbFile} já possui dados.`);
    console.error('  O comando "npm run demo" APAGA o banco para criar dados de exemplo, por isso foi cancelado.');
    console.error('  Nada foi alterado.');
    console.error('');
    console.error('  Para criar a demonstração em outro arquivo:  DB_FILE=data/demo.db npm run demo');
    console.error('  Para apagar este banco mesmo assim:          npm run demo -- --force');
    console.error('');
    process.exit(1);
  }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
}
const db = require('../src/db').open(dbFile);
const now = F.nowLocal();

// Gerador pseudoaleatório com semente fixa (dados sempre iguais).
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const between = (a, b) => a + (b - a) * rnd();
const round1 = (v) => Math.round(v * 10) / 10;

// Usuários
const users = [
  ['Edmilson', 'edmilson@condominio.com', 'admin'],
  ['Maria Souza', 'maria@condominio.com', 'operator'],
];
const insUser = db.prepare(`INSERT INTO users (name,email,password_hash,role,active,must_change_password,created_at,updated_at)
                            VALUES (?,?,?,?,1,0,?,?)`);
for (const [name, email, role] of users) insUser.run(name, email, bcrypt.hashSync('12345678', 10), role, now, now);
db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE role = 'admin' AND id = 1").run(bcrypt.hashSync('admin12345', 10));
db.prepare("UPDATE settings SET value = 'Administradora Exemplo' WHERE key = 'org_name'").run();
const edmilson = db.prepare("SELECT id FROM users WHERE email = 'edmilson@condominio.com'").get().id;

const insCondo = db.prepare(`INSERT INTO condominiums (name,address,cnpj,syndic,manager,phone,email,status,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?,'active',?,?)`);
const insMeter = db.prepare(`INSERT INTO meters (condominium_id,utility_type,name,identifier,unit,location,utility_company,kind,frequency_days,notes,active,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`);
const insReading = db.prepare(`INSERT INTO readings (meter_id,reading_date,reading_time,value,is_reset,responsible,notes,created_by,updated_by,created_at,updated_at)
                               VALUES (?,?,?,?,0,?,?,?,?,?,?)`);
const insUC = db.prepare(`INSERT INTO utility_company_readings (meter_id,reading_date,value,company,next_reading_date,notes,created_by,created_at,updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?)`);

const today = F.todayISO();

/**
 * Gera leituras semanais ancoradas em uma data/valor conhecidos.
 * weekly: consumo médio por semana; recent: consumo das semanas após a âncora.
 */
function weeklyReadings(meterId, { anchorDate, anchorValue, weekly, spread = 0.12, weeksBack = 52, recent, responsible = 'Edmilson', fixed = {}, stopBefore }) {
  const rows = [];
  let d = anchorDate; let v = anchorValue;
  for (let i = 0; i < weeksBack; i++) {
    rows.unshift([d, fixed[d] ?? round1(v)]);
    const season = 1 + 0.12 * Math.sin((Number(d.slice(5, 7)) / 12) * Math.PI * 2);
    const c = weekly * season * between(1 - spread, 1 + spread);
    if (v - c < 0) break;
    v -= c; d = F.addDays(d, -7);
  }
  d = anchorDate; v = anchorValue;
  for (;;) {
    d = F.addDays(d, 7);
    if (d > today || (stopBefore && d >= stopBefore)) break;
    v = fixed[d] ?? v + (recent || weekly) * between(1 - spread, 1 + spread);
    rows.push([d, round1(v)]);
  }
  for (const [date, value] of rows) {
    insReading.run(meterId, date, '08:00', value, responsible, null, edmilson, edmilson, now, now);
  }
}

db.transaction(() => {
  // --- Geo Paulista (exemplo real do enunciado)
  const geo = insCondo.run('Geo Paulista', 'Av. Paulista, 1000 — Bela Vista, São Paulo/SP', '12.345.678/0001-90', 'Carlos Lima',
    'Edmilson', '(11) 3333-1000', 'sindico@geopaulista.com.br', now, now).lastInsertRowid;
  const geoAgua = insMeter.run(geo, 'agua', 'Hidrômetro principal', 'A18S123456', 'm³', 'Entrada — térreo', 'Sabesp', 'principal', 7, null, now, now).lastInsertRowid;
  const geoGas = insMeter.run(geo, 'gas', 'Medidor de gás geral', 'G-778812', 'm³', 'Central de gás', 'Comgás', 'principal', 7, null, now, now).lastInsertRowid;
  const geoEnergia = insMeter.run(geo, 'energia', 'Energia áreas comuns', 'E-5599021', 'kWh', 'Quadro geral — subsolo', 'Enel', 'principal', 7, null, now, now).lastInsertRowid;
  weeklyReadings(geoAgua, { anchorDate: '2026-09-01', anchorValue: 478.0, weekly: 19, recent: 30, fixed: { '2026-09-08': 498.0 } });
  weeklyReadings(geoGas, { anchorDate: '2026-09-01', anchorValue: 2740.0, weekly: 145, fixed: { '2026-09-08': 2888.0 } });
  weeklyReadings(geoEnergia, { anchorDate: '2026-09-01', anchorValue: 81250, weekly: 1180 });
  insUC.run(geoGas, '2026-09-16', 3052.0, 'Comgás', '2026-10-16', 'Leitura conferida com a portaria.', edmilson, now, now);
  insUC.run(geoGas, '2026-08-17', 2440.0, 'Comgás', '2026-09-16', null, edmilson, now, now);
  insUC.run(geoAgua, '2026-09-03', 505.0, 'Sabesp', '2026-10-02', null, edmilson, now, now);

  // --- Flow Perdizes
  const flow = insCondo.run('Flow Perdizes', 'Rua Cardoso de Almeida, 500 — Perdizes, São Paulo/SP', '23.456.789/0001-01', 'Ana Martins',
    'Edmilson', '(11) 3333-2000', 'contato@flowperdizes.com.br', now, now).lastInsertRowid;
  const flowAgua = insMeter.run(flow, 'agua', 'Hidrômetro principal', 'A20F998877', 'm³', 'Calçada — frente', 'Sabesp', 'principal', 7, null, now, now).lastInsertRowid;
  const flowPiscina = insMeter.run(flow, 'agua', 'Piscina', 'A-PISC-01', 'm³', 'Casa de máquinas da piscina', 'Sabesp', 'area', 7, 'Submedidor da piscina', now, now).lastInsertRowid;
  const flowGas = insMeter.run(flow, 'gas', 'Medidor de gás geral', 'G-334455', 'm³', 'Abrigo de gás', 'Comgás', 'principal', 7, null, now, now).lastInsertRowid;
  const flowEnergia = insMeter.run(flow, 'energia', 'Energia áreas comuns', 'E-1122334', 'kWh', 'Medição — térreo', 'Enel', 'principal', 30, 'Leitura mensal', now, now).lastInsertRowid;
  weeklyReadings(flowAgua, { anchorDate: '2026-09-02', anchorValue: 8420.0, weekly: 31, responsible: 'Maria Souza' });
  weeklyReadings(flowPiscina, { anchorDate: '2026-09-02', anchorValue: 612.0, weekly: 3.5, responsible: 'Maria Souza' });
  weeklyReadings(flowGas, { anchorDate: '2026-09-02', anchorValue: 15890.0, weekly: 110, responsible: 'Maria Souza' });
  {
    let v = 45210; let d = '2025-09-05';
    while (d <= today) {
      insReading.run(flowEnergia, d, '09:00', v, 'Maria Souza', null, edmilson, edmilson, now, now);
      v = Math.round(v + between(3900, 4600));
      const [y, m] = d.split('-').map(Number);
      d = `${m === 12 ? y + 1 : y}-${F.pad(m === 12 ? 1 : m + 1)}-05`;
    }
  }
  insUC.run(flowAgua, '2026-09-10', 8455.0, 'Sabesp', '2026-10-09', null, edmilson, now, now);
  insUC.run(flowEnergia, '2026-09-12', 49800, 'Enel', '2026-09-27', null, edmilson, now, now);

  // --- IS Moema (leitura de gás atrasada para demonstrar alertas)
  const moema = insCondo.run('IS Moema', 'Av. Ibirapuera, 2000 — Moema, São Paulo/SP', '34.567.890/0001-12', 'Roberto Alves',
    'Edmilson', '(11) 3333-3000', 'administracao@ismoema.com.br', now, now).lastInsertRowid;
  const moemaAgua = insMeter.run(moema, 'agua', 'Hidrômetro principal', 'A19M445566', 'm³', 'Entrada de serviço', 'Sabesp', 'principal', 7, null, now, now).lastInsertRowid;
  const moemaGas = insMeter.run(moema, 'gas', 'Medidor de gás geral', 'G-990011', 'm³', 'Central de gás — subsolo', 'Comgás', 'principal', 7, null, now, now).lastInsertRowid;
  insMeter.run(moema, 'energia', 'Energia áreas comuns', 'E-7788990', 'kWh', 'Quadro geral', 'Enel', 'principal', 7, 'Medidor instalado recentemente', now, now);
  weeklyReadings(moemaAgua, { anchorDate: '2026-09-03', anchorValue: 3120.0, weekly: 24, stopBefore: '2026-09-24' });
  weeklyReadings(moemaGas, { anchorDate: '2026-09-03', anchorValue: 9870.0, weekly: 95, stopBefore: '2026-09-10' });
  insUC.run(moemaGas, '2026-09-18', 10070.0, 'Comgás', '2026-10-19', null, edmilson, now, now);
})();

// Calcula leitura anterior e consumo de todas as leituras.
const { recalcMeter } = require('../src/db');
db.transaction(() => { for (const m of db.prepare('SELECT id FROM meters').all()) recalcMeter(db, m.id); })();

const n = db.prepare('SELECT COUNT(*) n FROM readings').get().n;
console.log(`Banco de demonstração criado em ${dbFile}`);
console.log(`  ${n} leituras em 3 condomínios.`);
const adm = db.prepare('SELECT email FROM users WHERE id = 1').get().email;
console.log('  Acessos: edmilson@condominio.com / 12345678 (administrador)');
console.log('           maria@condominio.com / 12345678 (operador)');
console.log(`           ${adm} / admin12345 (administrador)`);
