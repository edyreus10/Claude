'use strict';
/**
 * Restauração do banco de dados a partir de um backup.
 *
 * Origens aceitas:
 *   - caminho de um arquivo de backup (.db ou .db.gz)
 *   - r2:latest            → backup mais recente guardado no Cloudflare R2
 *   - r2:<nome do arquivo> → um backup específico do R2
 *
 * Segurança:
 *   - o arquivo é conferido (precisa ser um banco deste sistema e estar íntegro);
 *   - o banco atual NUNCA é apagado: ele é guardado em backups/antes-da-restauracao-*.db;
 *   - comprovantes que faltarem são copiados de volta (backup local ou R2).
 *
 * No Render, a restauração é feita definindo RESTORE_FROM no painel e reiniciando:
 * ela é aplicada uma única vez (arquivo .restauracao-aplicada), mesmo que a variável
 * continue definida. Passo a passo em PUBLICACAO.md.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const remote = require('./remote-backup');
const F = require('./format');

const REQUIRED_TABLES = ['users', 'condominiums', 'meters', 'readings'];

/** Confere se o arquivo é um banco íntegro do Controle de Medidores. */
function validateBackup(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new Error(`o arquivo não é um banco do Controle de Medidores (faltam: ${missing.join(', ')}).`);
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`o arquivo está danificado (${check}).`);
    return {
      condominiums: db.prepare('SELECT COUNT(*) n FROM condominiums').get().n,
      readings: db.prepare('SELECT COUNT(*) n FROM readings').get().n,
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      last_reading: db.prepare('SELECT MAX(reading_date) d FROM readings').get().d,
    };
  } catch (err) {
    if (/file is not a database|file is encrypted/i.test(err.message)) throw new Error('o arquivo não é um banco de dados SQLite válido.');
    throw err;
  } finally {
    if (db) db.close();
  }
}

/**
 * Restaura o banco `dbFile` a partir de `source`. O sistema deve estar PARADO
 * (no Render isso é garantido: a restauração acontece antes de o sistema abrir o banco).
 */
async function restore(source, { dbFile, uploadDir, backupDir, env = process.env, log = console.log }) {
  if (!source) throw new Error('Informe o backup a restaurar.');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = F.nowLocal().replace(' ', '_').replace(/:/g, '');
  const temp = path.join(backupDir, `restaurando-${stamp}.db`);
  let from = source;
  try {
    if (source.startsWith('r2:')) {
      const item = await remote.downloadBackup(source.slice(3) || 'latest', temp, env);
      from = `Cloudflare R2 (${item.name})`;
    } else {
      if (!fs.existsSync(source)) throw new Error(`arquivo não encontrado: ${source}`);
      if (source.endsWith('.gz')) {
        fs.writeFileSync(temp, zlib.gunzipSync(fs.readFileSync(source)));
      } else {
        fs.copyFileSync(source, temp);
      }
    }
    const info = validateBackup(temp);
    // Guarda o banco atual antes de substituir.
    let previous = null;
    if (fs.existsSync(dbFile)) {
      previous = path.join(backupDir, `antes-da-restauracao-${stamp}.db`);
      const cur = new Database(dbFile);
      try { cur.pragma('wal_checkpoint(TRUNCATE)'); } finally { cur.close(); }
      fs.copyFileSync(dbFile, previous);
    }
    for (const f of [`${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.renameSync(temp, dbFile);
    // Comprovantes
    let uploads = 0;
    fs.mkdirSync(uploadDir, { recursive: true });
    const localMirror = path.join(backupDir, 'uploads');
    if (fs.existsSync(localMirror)) {
      for (const f of fs.readdirSync(localMirror)) {
        const t = path.join(uploadDir, f);
        if (!fs.existsSync(t)) { fs.copyFileSync(path.join(localMirror, f), t); uploads++; }
      }
    }
    if (remote.isConfigured(env)) uploads += await remote.downloadMissingUploads(uploadDir, env);
    log(`  Restauração concluída a partir de: ${from}`);
    log(`    ${info.condominiums} condomínio(s), ${info.readings} leitura(s), última leitura: ${F.fmtDate(info.last_reading)}`);
    if (previous) log(`    O banco anterior foi guardado em: ${previous}`);
    return { from, previous, uploads, ...info };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Restauração pedida pelo painel do Render (variável RESTORE_FROM).
 * Aplicada uma única vez por valor de RESTORE_FROM.
 */
async function restoreOnStartup({ dbFile, uploadDir, backupDir, dataDir, env = process.env, log = console.log }) {
  const source = (env.RESTORE_FROM || '').trim();
  if (!source) return null;
  const marker = path.join(dataDir, '.restauracao-aplicada');
  const done = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (done === source) {
    log(`  RESTORE_FROM="${source}" já foi aplicado antes. Remova a variável RESTORE_FROM do painel.`);
    return null;
  }
  log(`  Restaurando o banco a partir de "${source}"...`);
  const r = await restore(source, { dbFile, uploadDir, backupDir, env, log });
  fs.writeFileSync(marker, `${source}\n`);
  log('  Pronto. Remova a variável RESTORE_FROM do painel do Render.');
  return r;
}

module.exports = { restore, restoreOnStartup, validateBackup };
