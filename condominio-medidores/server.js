'use strict';
/**
 * Controle de Medidores — servidor.
 *   npm start      inicia o sistema em http://localhost:3000
 *
 * Configurações opcionais no arquivo .env (veja .env.example).
 */
require('./src/env').loadEnv();
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const db = require('./src/db').open();
const { createApp } = require('./src/app');
const backup = require('./src/backup');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = createApp(db).listen(PORT, HOST, () => {
  console.log('');
  console.log('  Controle de Medidores iniciado!');
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
  backup.schedule(db);
});

// Encerramento seguro (ex.: reinício do servidor): fecha o banco corretamente.
function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
