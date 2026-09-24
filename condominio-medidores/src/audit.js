'use strict';
/** Registro de auditoria: quem fez o quê e quando. */
const { nowLocal } = require('./format');

function audit(db, user, { action, entity, entityId = null, condominiumId = null, description }) {
  db.prepare(`INSERT INTO audit_logs (user_id,user_name,action,entity,entity_id,condominium_id,description,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(user ? user.id : null, user ? user.name : 'Sistema', action, entity, entityId, condominiumId, description, nowLocal());
}

/** Descreve as diferenças entre dois objetos, usando rótulos amigáveis. */
function describeChanges(before, after, labels, formatters = {}) {
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    const a = before[key] ?? '';
    const b = after[key] ?? '';
    if (String(a) !== String(b)) {
      const f = formatters[key] || ((v) => (v === '' || v === null ? '(vazio)' : String(v)));
      parts.push(`${label}: ${f(a)} → ${f(b)}`);
    }
  }
  return parts.join('; ');
}

module.exports = { audit, describeChanges };
