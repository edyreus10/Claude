'use strict';
/**
 * Backup automático do banco de dados e dos comprovantes.
 *
 * - Uma cópia do banco por dia (ou manual em Configurações → Backup), feita com a
 *   API de backup do SQLite: é segura mesmo com o sistema em uso.
 * - Os comprovantes (pasta uploads) são espelhados em backups/uploads.
 * - Mantém as BACKUP_KEEP cópias mais recentes (padrão: 30).
 *
 * Variáveis: BACKUP_DIR (padrão data/backups), BACKUP_KEEP, BACKUP_DISABLED=true.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, UPLOAD_DIR } = require('./storage');
const F = require('./format');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);
const NAME_RE = /^medidores-\d{4}-\d{2}-\d{2}_\d{6}\.db$/;

function list() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).sort().reverse()
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, created_at: F.nowLocal(st.mtime) };
    });
}

function mirrorUploads() {
  const dest = path.join(BACKUP_DIR, 'uploads');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const target = path.join(dest, f);
    if (!fs.existsSync(target)) { fs.copyFileSync(path.join(UPLOAD_DIR, f), target); copied++; }
  }
  return copied;
}

async function run(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = F.nowLocal().replace(' ', '_').replace(/:/g, '');
  const name = `medidores-${stamp}.db`;
  const target = path.join(BACKUP_DIR, name);
  await db.backup(target);
  const uploads = mirrorUploads();
  for (const old of list().slice(KEEP)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });
  return { name, size: fs.statSync(target).size, uploads };
}

function filePath(name) {
  if (!NAME_RE.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

/** Faz um backup ao iniciar (se o último tiver mais de 24 h) e verifica a cada hora. */
function schedule(db, log = console.log) {
  if (String(process.env.BACKUP_DISABLED || '').toLowerCase() === 'true') return null;
  const check = async () => {
    try {
      const last = list()[0];
      const age = last ? Date.now() - fs.statSync(path.join(BACKUP_DIR, last.name)).mtimeMs : Infinity;
      if (age > 24 * 3600 * 1000) {
        const r = await run(db);
        log(`  Backup automático criado: ${path.join(BACKUP_DIR, r.name)}`);
      }
    } catch (err) {
      console.error('  ERRO no backup automático:', err.message);
    }
  };
  check();
  const t = setInterval(check, 3600 * 1000);
  t.unref();
  return t;
}

module.exports = { BACKUP_DIR, list, run, filePath, schedule };
