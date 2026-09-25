'use strict';
// Testes da preparação para publicação (Render + Cloudflare R2):  npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medidores-pub-'));
process.env.TZ = 'America/Sao_Paulo';
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.BACKUP_DISABLED = 'true';
process.env.ADMIN_PASSWORD = 'admin12345';

const S3rver = require('s3rver');
const { open } = require('../src/db');
const backup = require('../src/backup');
const remote = require('../src/remote-backup');
const { restore, restoreOnStartup, validateBackup } = require('../src/restore');
const { checkConfig } = require('../src/config');
const { UPLOAD_DIR } = require('../src/storage');

const ROOT = path.join(__dirname, '..');
let s3;

test.before(async () => {
  s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: path.join(TMP, 's3'), configureBuckets: [{ name: 'backups-teste' }] });
  const { port } = await s3.run();
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${port}`, R2_ACCESS_KEY_ID: 'S3RVER', R2_SECRET_ACCESS_KEY: 'S3RVER', R2_BUCKET: 'backups-teste',
  });
});
test.after(() => s3 && s3.close());

test('produção: o sistema não inicia sem HTTPS, proxy e disco permanente', () => {
  const r = checkConfig({ NODE_ENV: 'production' });
  assert.strictEqual(r.errors.length, 3);
  assert.ok(r.errors.some((e) => /COOKIE_SECURE/.test(e)));
  assert.ok(r.errors.some((e) => /TRUST_PROXY/.test(e)));
  assert.ok(r.errors.some((e) => /DATA_DIR/.test(e)));
  const ok = checkConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1', DATA_DIR: '/var/data' });
  assert.deepStrictEqual(ok.errors, []);
  assert.ok(ok.warnings.some((w) => /Cloudflare R2/.test(w))); // avisa quando falta o backup externo
  const parcial = checkConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1', DATA_DIR: '/x', R2_BUCKET: 'b' });
  assert.ok(parcial.errors.some((e) => /incompleta/.test(e)));
  const completo = checkConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1', DATA_DIR: '/x',
    R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd' });
  assert.deepStrictEqual([completo.errors, completo.warnings], [[], []]);
  const demoComR2 = checkConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1', DATA_DIR: '/x', DEMO_ON_START: 'true', R2_BUCKET: 'd' });
  assert.ok(demoComR2.errors.some((e) => /demonstração/.test(e)));
});

test('servidor em produção se recusa a iniciar com configuração insegura', () => {
  const r = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: path.join(TMP, 'x'), PORT: '0' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /NÃO foi iniciado/);
  assert.match(r.stderr, /COOKIE_SECURE/);
});

test('servidor em produção inicia com a configuração do Render', async () => {
  const dir = path.join(TMP, 'prod');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1', DATA_DIR: dir,
      DB_FILE: path.join(dir, 'medidores.db'), PORT: '3491', ADMIN_EMAIL: 'gestor@exemplo.com.br', ADMIN_PASSWORD: 'Provisoria123', BACKUP_DISABLED: 'true' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { ok = (await fetch('http://127.0.0.1:3491/api/health')).ok; } catch { /* ainda iniciando */ }
    }
    assert.ok(ok, out);
    const login = await fetch('http://127.0.0.1:3491/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'gestor@exemplo.com.br', password: 'Provisoria123' }) });
    assert.strictEqual(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /Secure/); // cookie só trafega por HTTPS
    assert.match(out, /Backup externo \(Cloudflare R2\) NÃO configurado/);
    assert.doesNotMatch(out, /Provisoria123/); // a senha definida no painel não aparece nos registros
  } finally {
    child.kill('SIGTERM');
  }
});

test('npm run demo é bloqueado no sistema oficial', () => {
  const r = spawnSync(process.execPath, ['scripts/seed-demo.js'], { cwd: ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DB_FILE: path.join(TMP, 'oficial.db') } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /não pode ser usado no sistema oficial/);
  assert.ok(!fs.existsSync(path.join(TMP, 'oficial.db')));
});

let db; let dbFile;
test('backup diário é enviado ao Cloudflare R2 (banco compactado + comprovantes)', async () => {
  dbFile = path.join(process.env.DATA_DIR, 'medidores.db');
  db = open(dbFile);
  db.prepare("INSERT INTO condominiums (name,status,created_at,updated_at) VALUES ('Geo Paulista','active','x','x')").run();
  fs.writeFileSync(path.join(UPLOAD_DIR, 'ucr-teste.pdf'), '%PDF-1.4 teste');
  const r = await backup.run(db);
  assert.strictEqual(r.remote.ok, true, JSON.stringify(r.remote));
  assert.strictEqual(r.remote.uploads, 1);
  const list = await remote.listBackups();
  assert.strictEqual(list.length, 1);
  assert.match(list[0].name, /^medidores-.*\.db\.gz$/);
  const st = backup.remoteStatus(db);
  assert.deepStrictEqual([st.configured, st.last.ok], [true, true]);
});

test('R2 guarda só os backups mais recentes (BACKUP_REMOTE_KEEP)', async () => {
  const dir = path.join(TMP, 'antigos');
  fs.mkdirSync(dir, { recursive: true });
  process.env.BACKUP_REMOTE_KEEP = '3';
  for (const d of ['01', '02', '03', '04', '05']) {
    const f = path.join(dir, `medidores-2020-01-${d}_030000.db`);
    fs.copyFileSync(dbFile, f);
    await remote.uploadBackup(f, null);
  }
  const names = (await remote.listBackups()).map((b) => b.name);
  assert.strictEqual(names.length, 3);
  assert.ok(!names.includes('medidores-2020-01-01_030000.db.gz'));
  delete process.env.BACKUP_REMOTE_KEEP;
});

test('falha no R2 fica registrada e não impede o backup local', async () => {
  const saved = process.env.R2_BUCKET;
  process.env.R2_BUCKET = 'bucket-inexistente';
  try {
    const r = await backup.run(db);
    assert.ok(fs.existsSync(path.join(backup.BACKUP_DIR, r.name))); // backup local feito
    assert.strictEqual(r.remote.ok, false);
    assert.strictEqual(backup.remoteStatus(db).last.ok, false);
  } finally {
    process.env.R2_BUCKET = saved;
  }
});

test('restauração a partir do R2 (servidor novo, disco vazio)', async () => {
  const novo = path.join(TMP, 'servidor-novo');
  fs.mkdirSync(novo, { recursive: true });
  const r = await restore('r2:latest', { dbFile: path.join(novo, 'medidores.db'), uploadDir: path.join(novo, 'uploads'),
    backupDir: path.join(novo, 'backups'), log: () => {} });
  assert.strictEqual(r.condominiums, 1);
  assert.strictEqual(r.previous, null);
  assert.ok(fs.existsSync(path.join(novo, 'uploads', 'ucr-teste.pdf'))); // comprovantes também voltam
  const check = open(path.join(novo, 'medidores.db'));
  assert.strictEqual(check.prepare('SELECT name FROM condominiums').get().name, 'Geo Paulista');
  check.close();
});

test('restauração guarda o banco atual e é aplicada uma única vez (RESTORE_FROM)', async () => {
  const dir = path.join(TMP, 'render');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'medidores.db');
  const atual = open(file);
  atual.prepare("INSERT INTO condominiums (name,status,created_at,updated_at) VALUES ('Banco atual','active','x','x')").run();
  atual.close();
  const opts = { dbFile: file, uploadDir: path.join(dir, 'uploads'), backupDir: path.join(dir, 'backups'), dataDir: dir,
    env: { ...process.env, RESTORE_FROM: 'r2:latest' }, log: () => {} };
  const r = await restoreOnStartup(opts);
  assert.ok(r && fs.existsSync(r.previous)); // banco anterior guardado
  assert.match(path.basename(r.previous), /^antes-da-restauracao-/);
  assert.strictEqual(await restoreOnStartup(opts), null); // segunda vez: não restaura de novo
});

test('restauração recusa arquivos que não são backups do sistema', async () => {
  const lixo = path.join(TMP, 'lixo.db');
  fs.writeFileSync(lixo, 'isto não é um banco');
  assert.throws(() => validateBackup(lixo), /não é um banco/);
  const outro = path.join(TMP, 'outro.db');
  const x = new (require('better-sqlite3'))(outro);
  x.exec('CREATE TABLE qualquer (id INTEGER)');
  x.close();
  await assert.rejects(restore(outro, { dbFile: path.join(TMP, 'alvo.db'), uploadDir: path.join(TMP, 'u'), backupDir: path.join(TMP, 'b'), log: () => {} }),
    /não é um banco do Controle de Medidores/);
  assert.ok(!fs.existsSync(path.join(TMP, 'alvo.db')));
});

test('atualização do sistema guarda uma cópia do banco antes de mudar a estrutura', () => {
  const file = path.join(TMP, 'versao-antiga.db');
  const a = open(file);
  a.pragma('user_version = 3'); // simula um banco da versão anterior
  a.close();
  const b = open(file);
  b.close();
  const copias = fs.readdirSync(backup.BACKUP_DIR).filter((f) => /^antes-da-atualizacao-v3-para-v4-/.test(f));
  assert.strictEqual(copias.length, 1);
  assert.ok(validateBackup(path.join(backup.BACKUP_DIR, copias[0])));
});
