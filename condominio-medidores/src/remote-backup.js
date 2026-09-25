'use strict';
/**
 * Cópia dos backups FORA do servidor — Cloudflare R2 (compatível com S3).
 *
 * Ativa quando estas variáveis estão configuradas (painel do Render → Environment):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Opcionais:
 *   BACKUP_REMOTE_PREFIX  pasta dentro do bucket (padrão: medidores)
 *   BACKUP_REMOTE_KEEP    quantos backups do banco manter no R2 (padrão: 90)
 *   R2_ENDPOINT           outro endereço compatível com S3 (usado nos testes)
 *
 * Organização no bucket:
 *   medidores/banco/medidores-AAAA-MM-DD_HHMMSS.db.gz   (um por dia, compactado)
 *   medidores/comprovantes/<arquivo>                    (comprovantes e logo)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const NAME_RE = /^medidores-\d{4}-\d{2}-\d{2}_\d{6}\.db\.gz$/;

function config(env = process.env) {
  const accountId = (env.R2_ACCOUNT_ID || '').trim();
  const endpoint = (env.R2_ENDPOINT || '').trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const c = {
    endpoint,
    accessKeyId: (env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (env.R2_SECRET_ACCESS_KEY || '').trim(),
    bucket: (env.R2_BUCKET || '').trim(),
    prefix: (env.BACKUP_REMOTE_PREFIX || 'medidores').trim().replace(/^\/+|\/+$/g, ''),
    keep: Math.max(1, Number(env.BACKUP_REMOTE_KEEP) || 90),
  };
  c.configured = !!(c.endpoint && c.accessKeyId && c.secretAccessKey && c.bucket);
  return c;
}

function isConfigured(env) { return config(env).configured; }

function s3(c) {
  // Carregado só quando necessário (o sistema funciona sem o R2 configurado).
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    // O R2 não exige as somas de verificação extras das versões novas do SDK.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function listKeys(client, c, prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const out = [];
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size, last_modified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function putFile(client, c, key, filePath, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = fs.readFileSync(filePath);
  await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: body, ContentType: contentType }));
}

/**
 * Envia um backup do banco (compactado) e os comprovantes que ainda não estão no R2.
 * Remove do R2 os backups do banco mais antigos que o limite (BACKUP_REMOTE_KEEP).
 */
async function uploadBackup(dbBackupPath, uploadDir, env) {
  const c = config(env);
  if (!c.configured) return { skipped: true };
  const client = s3(c);
  const name = `${path.basename(dbBackupPath)}.gz`;
  const gz = `${dbBackupPath}.gz`;
  await pipeline(fs.createReadStream(dbBackupPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz));
  try {
    await putFile(client, c, `${c.prefix}/banco/${name}`, gz, 'application/gzip');
  } finally {
    fs.rmSync(gz, { force: true });
  }
  // Comprovantes: envia só os que faltam (os nomes nunca se repetem).
  let uploads = 0;
  if (uploadDir && fs.existsSync(uploadDir)) {
    const remote = new Set((await listKeys(client, c, `${c.prefix}/comprovantes/`)).map((o) => path.basename(o.key)));
    for (const f of fs.readdirSync(uploadDir)) {
      if (remote.has(f)) continue;
      await putFile(client, c, `${c.prefix}/comprovantes/${f}`, path.join(uploadDir, f), 'application/octet-stream');
      uploads++;
    }
  }
  // Retenção
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const dbs = (await listKeys(client, c, `${c.prefix}/banco/`)).filter((o) => NAME_RE.test(path.basename(o.key)))
    .sort((a, b) => b.key.localeCompare(a.key));
  let removed = 0;
  for (const old of dbs.slice(c.keep)) {
    await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: old.key }));
    removed++;
  }
  return { name, uploads, removed, kept: Math.min(dbs.length, c.keep) };
}

/** Backups do banco guardados no R2 (mais recente primeiro). */
async function listBackups(env) {
  const c = config(env);
  if (!c.configured) return [];
  return (await listKeys(s3(c), c, `${c.prefix}/banco/`)).filter((o) => NAME_RE.test(path.basename(o.key)))
    .sort((a, b) => b.key.localeCompare(a.key)).map((o) => ({ ...o, name: path.basename(o.key) }));
}

async function downloadTo(client, c, key, dest) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
  await pipeline(r.Body, fs.createWriteStream(dest));
}

/**
 * Baixa um backup do banco do R2 e o descompacta em `dest`.
 * which: 'latest' ou o nome do arquivo (ex.: medidores-2026-09-25_031500.db.gz).
 */
async function downloadBackup(which, dest, env) {
  const c = config(env);
  if (!c.configured) throw new Error('O Cloudflare R2 não está configurado (variáveis R2_*).');
  const list = await listBackups(env);
  if (!list.length) throw new Error('Não há backups do banco no R2.');
  const item = which === 'latest' ? list[0] : list.find((x) => x.name === which || x.key === which);
  if (!item) throw new Error(`Backup "${which}" não encontrado no R2.`);
  const client = s3(c);
  const gz = `${dest}.download.gz`;
  await downloadTo(client, c, item.key, gz);
  try {
    await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(dest));
  } finally {
    fs.rmSync(gz, { force: true });
  }
  return item;
}

/** Baixa do R2 os comprovantes que não existem na pasta local. */
async function downloadMissingUploads(uploadDir, env) {
  const c = config(env);
  if (!c.configured) return 0;
  const client = s3(c);
  fs.mkdirSync(uploadDir, { recursive: true });
  let n = 0;
  for (const o of await listKeys(client, c, `${c.prefix}/comprovantes/`)) {
    const target = path.join(uploadDir, path.basename(o.key));
    if (fs.existsSync(target)) continue;
    await downloadTo(client, c, o.key, target);
    n++;
  }
  return n;
}

module.exports = { config, isConfigured, uploadBackup, listBackups, downloadBackup, downloadMissingUploads };
