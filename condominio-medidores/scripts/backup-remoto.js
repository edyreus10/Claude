'use strict';
/**
 * Backups no Cloudflare R2.
 *
 *   npm run backup:remoto            lista os backups guardados no R2
 *   npm run backup:remoto -- testar  faz um backup agora e envia ao R2 (confere a configuração)
 */
require('../src/env').loadEnv();
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const remote = require('../src/remote-backup');
const F = require('../src/format');

(async () => {
  const cfg = remote.config();
  if (!cfg.configured) {
    console.error('\n  O Cloudflare R2 não está configurado (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).\n');
    process.exit(1);
  }
  if (process.argv[2] === 'testar') {
    const db = require('../src/db').open();
    const r = await require('../src/backup').run(db);
    db.close();
    if (!r.remote || !r.remote.ok) throw new Error(r.remote ? r.remote.error : 'envio não realizado');
    console.log(`\n  OK: backup ${r.remote.name} enviado ao bucket "${cfg.bucket}".\n`);
    return;
  }
  const list = await remote.listBackups();
  console.log(`\n  Backups no bucket "${cfg.bucket}" (${list.length}):`);
  for (const b of list) console.log(`    ${b.name}   ${(b.size / 1024).toFixed(0)} KB   ${F.nowLocal(new Date(b.last_modified))}`);
  console.log('');
})().catch((err) => { console.error(`\n  ERRO: ${err.message}\n`); process.exit(1); });
