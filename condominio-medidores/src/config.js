'use strict';
/**
 * Conferência das configurações antes de o sistema iniciar.
 *
 * Em produção (NODE_ENV=production) o sistema SE RECUSA a iniciar sem:
 *   - COOKIE_SECURE=true   (login só por HTTPS)
 *   - TRUST_PROXY          (o Render entrega o HTTPS por um proxy)
 *   - DATA_DIR             (pasta do disco permanente — sem ela os dados se perderiam)
 * e avisa quando o backup externo (Cloudflare R2) não está configurado.
 */
const remote = require('./remote-backup');

function checkConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  const demo = String(env.DEMO_ON_START || '').toLowerCase() === 'true';
  if (production) {
    if (String(env.COOKIE_SECURE || '').toLowerCase() !== 'true') {
      errors.push('COOKIE_SECURE deve ser "true" em produção (o login só pode funcionar com HTTPS).');
    }
    if (!env.TRUST_PROXY) errors.push('TRUST_PROXY não foi definido (use "1" no Render).');
    if (!env.DATA_DIR) errors.push('DATA_DIR não foi definido: os dados precisam ficar no disco permanente (ex.: /var/data).');
    const r2 = remote.config(env);
    const partial = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => env[k]);
    if (!demo && partial.length && !r2.configured) {
      errors.push('A configuração do Cloudflare R2 está incompleta: preencha R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BUCKET.');
    }
    if (!demo && !partial.length) {
      warnings.push('Backup externo (Cloudflare R2) NÃO configurado: os backups ficam só no disco do servidor.');
    }
  }
  if (demo && env.R2_BUCKET) {
    errors.push('O modo de demonstração (DEMO_ON_START) não pode ser usado com o backup externo do sistema oficial.');
  }
  return { errors, warnings, production, demo };
}

module.exports = { checkConfig };
