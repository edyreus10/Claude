'use strict';
/**
 * Controle de Medidores — servidor.
 *   npm start      inicia o sistema em http://localhost:3000
 */
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const db = require('./src/db').open();
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp(db).listen(PORT, HOST, () => {
  console.log('');
  console.log('  Controle de Medidores iniciado!');
  console.log(`  Acesse: http://localhost:${PORT}`);
  if (db.firstRun) {
    console.log('');
    console.log('  Primeiro acesso:');
    console.log('    E-mail: admin@admin.com');
    console.log('    Senha:  admin123   (o sistema pedirá para trocar)');
  }
  console.log('');
});
