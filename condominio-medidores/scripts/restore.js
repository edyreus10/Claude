'use strict';
/**
 * Restaura o banco de dados a partir de um backup (com o sistema PARADO).
 *
 *   npm run restore -- data/backups/medidores-2026-09-25_031500.db
 *   npm run restore -- r2:latest                     (mais recente do Cloudflare R2)
 *   npm run restore -- r2:medidores-2026-09-25_031500.db.gz
 *
 * O banco atual é guardado em backups/antes-da-restauracao-*.db antes de ser substituído.
 * No Render, prefira a variável RESTORE_FROM (veja PUBLICACAO.md).
 */
require('../src/env').loadEnv();
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const path = require('path');
const { DATA_DIR, UPLOAD_DIR } = require('../src/storage');
const { BACKUP_DIR } = require('../src/backup');
const { restore } = require('../src/restore');

const source = process.argv[2];
if (!source) {
  console.error('\n  Informe o backup: npm run restore -- <arquivo.db | arquivo.db.gz | r2:latest | r2:nome>\n');
  process.exit(1);
}
const dbFile = process.env.DB_FILE || path.join(DATA_DIR, 'medidores.db');
console.log('\n  ATENÇÃO: o sistema deve estar PARADO durante a restauração.\n');
restore(source, { dbFile, uploadDir: UPLOAD_DIR, backupDir: BACKUP_DIR })
  .then(() => console.log('\n  Pronto. Inicie o sistema novamente.\n'))
  .catch((err) => { console.error(`\n  A restauração NÃO foi feita: ${err.message}\n`); process.exit(1); });
