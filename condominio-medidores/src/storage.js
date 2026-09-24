'use strict';
/** Pasta de arquivos enviados (comprovantes e logo). */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Caminho absoluto de um arquivo salvo (somente o nome, sem subpastas). */
function uploadPath(name) {
  return path.join(UPLOAD_DIR, path.basename(name));
}

function removeUpload(name) {
  if (!name) return;
  fs.rm(uploadPath(name), { force: true }, () => {});
}

/** Remove os comprovantes ligados a medidores (antes de excluí-los). */
function removeAttachmentsWhere(db, sql, ...params) {
  for (const r of db.prepare(`SELECT attachment_path FROM utility_company_readings u
      JOIN meters m ON m.id = u.meter_id WHERE u.attachment_path IS NOT NULL AND ${sql}`).all(...params)) {
    removeUpload(r.attachment_path);
  }
}

module.exports = { DATA_DIR, UPLOAD_DIR, uploadPath, removeUpload, removeAttachmentsWhere };
