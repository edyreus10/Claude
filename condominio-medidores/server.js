'use strict';
/**
 * Controle de Medidores — servidor.
 *   npm start      inicia o sistema em http://localhost:3000
 *
 * Configurações opcionais no arquivo .env (veja .env.example).
 * Publicação na internet (Render + Cloudflare R2): veja PUBLICACAO.md.
 */
require('./src/env').loadEnv();
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const path = require('path');
const { execFileSync } = require('child_process');
const { checkConfig } = require('./src/config');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  // 1. Configurações obrigatórias (em produção o sistema não inicia sem elas).
  const cfg = checkConfig();
  for (const w of cfg.warnings) console.warn(`  AVISO: ${w}`);
  if (cfg.errors.length) {
    console.error('\n  O sistema NÃO foi iniciado. Corrija as configurações:');
    for (const e of cfg.errors) console.error(`   - ${e}`);
    console.error('');
    process.exit(1);
  }

  const { DATA_DIR, UPLOAD_DIR } = require('./src/storage');
  const dbFile = process.env.DB_FILE || path.join(DATA_DIR, 'medidores.db');
  const backup = require('./src/backup');

  // 2. Restauração pedida pelo painel (RESTORE_FROM), antes de abrir o banco.
  const restored = await require('./src/restore').restoreOnStartup({
    dbFile, uploadDir: UPLOAD_DIR, backupDir: backup.BACKUP_DIR, dataDir: DATA_DIR,
  });

  // 3. Serviço de ensaio: recria os dados de demonstração a cada início.
  if (cfg.demo) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'seed-demo.js')],
        { env: { ...process.env, DB_FILE: dbFile, ALLOW_DEMO: 'true' }, stdio: 'inherit' });
    } catch {
      console.error('  Dados de demonstração não foram criados (veja a mensagem acima).');
    }
  }

  const db = require('./src/db').open(dbFile);
  if (restored) {
    require('./src/audit').audit(db, null, { action: 'update', entity: 'backup',
      description: `Banco de dados restaurado a partir de ${restored.from} (${restored.condominiums} condomínio(s), ${restored.readings} leitura(s)). `
        + `${restored.previous ? 'O banco anterior foi guardado na pasta de backups.' : ''}` });
  }
  const { createApp } = require('./src/app');

  const server = createApp(db).listen(PORT, HOST, () => {
    console.log('');
    console.log(`  Controle de Medidores iniciado!${cfg.demo ? ' (DEMONSTRAÇÃO)' : ''}`);
    console.log(`  Acesse: http://localhost:${PORT}`);
    console.log(`  Banco de dados: ${db.file}`);
    if (db.firstRun) {
      console.log('');
      console.log('  ================= PRIMEIRO ACESSO =================');
      console.log(`    E-mail: ${db.firstRun.email}`);
      console.log(`    Senha:  ${db.firstRun.password}`);
      console.log('    Anote esta senha. O sistema pedirá para trocá-la.');
      console.log('  ===================================================');
    }
    console.log('');
    if (!cfg.demo) backup.schedule(db);
  });

  // Encerramento seguro (ex.: reinício do servidor): fecha o banco corretamente.
  const shutdown = () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('\n  ERRO ao iniciar o sistema:', err.message);
  process.exit(1);
});
