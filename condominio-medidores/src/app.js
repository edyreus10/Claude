'use strict';
/** Monta a aplicação Express (API + arquivos da interface). */
const path = require('path');
const express = require('express');
const multer = require('multer');
const { loadUser, requireAuth, csrfGuard } = require('./auth');
const { ValidationError } = require('./validate');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser(db));

  const api = express.Router();
  api.use(csrfGuard);
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use('/auth', require('./routes/auth')(db));
  api.use(requireAuth);
  api.use('/condominiums', require('./routes/condominiums')(db));
  api.use('/meters', require('./routes/meters')(db));
  api.use('/readings', require('./routes/readings')(db));
  api.use('/utility-readings', require('./routes/utility')(db));
  api.use('/', require('./routes/panel')(db));
  api.use('/', require('./routes/admin')(db));
  api.use((_req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));
  app.use('/api', api);

  // Interface (arquivos estáticos) e bibliotecas locais (funcionam sem internet).
  const nm = path.join(__dirname, '..', 'node_modules');
  app.use('/vendor/chart.umd.min.js', (req, res) => res.sendFile(path.join(nm, 'chart.js', 'dist', 'chart.umd.min.js')));
  app.use('/vendor/lucide.min.js', (req, res) => res.sendFile(path.join(nm, 'lucide', 'dist', 'umd', 'lucide.min.js')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // Tratamento de erros: mensagens claras para o usuário.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'O arquivo é muito grande.' : 'Não foi possível enviar o arquivo.';
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Registro duplicado.' });
    console.error(err);
    res.status(500).json({ error: 'Ocorreu um erro inesperado. Tente novamente.' });
  });

  return app;
}

module.exports = { createApp };
