'use strict';
// Testes da API:  npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.TZ = 'America/Sao_Paulo';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'medidores-test-'));
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BACKUP_DISABLED = 'true';
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { todayISO, addDays } = require('../src/format');

const db = open(':memory:');
let server; let base;

function client() {
  let cookie = '';
  const req = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, type };
  };
  return {
    get: (u) => req('GET', u), post: (u, b) => req('POST', u, b ?? {}), put: (u, b) => req('PUT', u, b), del: (u) => req('DELETE', u),
    login: async (email, password) => { const r = await req('POST', '/api/auth/login', { email, password }); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); return r; },
  };
}

const admin = client();
const operator = client();
let condoId; let aguaId; let gasId;
const d0 = addDays(todayISO(), -14);
const d1 = addDays(todayISO(), -7);

test.before(async () => {
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('login do administrador padrão exige troca de senha', async () => {
  const r = await admin.login('admin@admin.com', 'admin123');
  assert.strictEqual(r.data.user.must_change_password, 1);
  // Enquanto não troca a senha provisória, o sistema não pode ser usado (nem pela API).
  const blockedRes = await admin.get('/api/condominiums');
  assert.strictEqual(blockedRes.status, 403);
  assert.strictEqual(blockedRes.data.code, 'PASSWORD_CHANGE_REQUIRED');
  const bad = await client().post('/api/auth/login', { email: 'admin@admin.com', password: 'errada' });
  assert.strictEqual(bad.status, 401);
  const ch = await admin.post('/api/auth/change-password', { current_password: 'admin123', new_password: 'nova-senha' });
  assert.strictEqual(ch.status, 200);
});

test('requisições sem cabeçalho de proteção são recusadas', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(res.status, 403);
});

test('cadastro de condomínio e medidores', async () => {
  const c = await admin.post('/api/condominiums', { name: 'Geo Paulista', cnpj: '12345678000190', status: 'active' });
  assert.strictEqual(c.status, 201);
  assert.strictEqual(c.data.cnpj, '12.345.678/0001-90');
  condoId = c.data.id;
  const a = await admin.post('/api/meters', { condominium_id: condoId, utility_type: 'agua', name: 'Hidrômetro principal' });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.data.unit, 'm³');
  aguaId = a.data.id;
  const g = await admin.post('/api/meters', { condominium_id: condoId, utility_type: 'gas', name: 'Gás geral' });
  gasId = g.data.id;
});

test('consumo é calculado automaticamente (478,0 → 498,0 = 20,0)', async () => {
  const r1 = await admin.post('/api/readings', { meter_id: aguaId, reading_date: d0, reading_time: '08:00', value: '478,0', responsible: 'Edmilson' });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.data.consumption, null);
  await admin.post('/api/readings', { meter_id: gasId, reading_date: d0, reading_time: '08:00', value: '2.740,0' });
  const r2 = await admin.post('/api/readings', { meter_id: aguaId, reading_date: d1, reading_time: '08:00', value: '498,0' });
  assert.strictEqual(r2.data.consumption, 20);
  assert.strictEqual(r2.data.prev_value, 478);
  const g2 = await admin.post('/api/readings', { meter_id: gasId, reading_date: d1, reading_time: '08:00', value: '2.888,0' });
  assert.strictEqual(g2.data.consumption, 148);

  const prev = await admin.get(`/api/meters/${aguaId}/previous?date=${todayISO()}&time=09:00`);
  assert.strictEqual(prev.data.previous.value, 498);
});

test('leitura menor que a anterior exige ocorrência com justificativa', async () => {
  const bad = await admin.post('/api/readings', { meter_id: aguaId, reading_date: todayISO(), reading_time: '07:00', value: '10' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.data.code, 'LOWER_THAN_PREVIOUS');
  const semNota = await admin.post('/api/readings', { meter_id: aguaId, reading_date: todayISO(), reading_time: '07:00', value: '10', occurrence: 'troca' });
  assert.strictEqual(semNota.status, 400);
  const invalida = await admin.post('/api/readings', { meter_id: aguaId, reading_date: todayISO(), reading_time: '07:00', value: '10', occurrence: 'xyz', occurrence_note: 'teste' });
  assert.strictEqual(invalida.status, 400);
  for (const occ of ['troca', 'zeramento', 'correcao', 'outra']) {
    const ok = await admin.post('/api/readings', { meter_id: aguaId, reading_date: todayISO(), reading_time: '07:00', value: '10',
      occurrence: occ, occurrence_note: 'Medidor substituído pela concessionária' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
    assert.strictEqual(ok.data.consumption, null);
    assert.strictEqual(ok.data.occurrence, occ);
    await admin.del(`/api/readings/${ok.data.id}`);
  }
  const audit = await admin.get('/api/audit');
  assert.ok(audit.data.rows.some((r) => /ocorrência: correção de leitura — Medidor substituído/.test(r.description)));
});

test('não aceita data futura nem leitura duplicada', async () => {
  const fut = await admin.post('/api/readings', { meter_id: aguaId, reading_date: addDays(todayISO(), 2), value: '600' });
  assert.strictEqual(fut.status, 400);
  const dup = await admin.post('/api/readings', { meter_id: aguaId, reading_date: d1, reading_time: '08:00', value: '499' });
  assert.strictEqual(dup.status, 400);
});

test('edição recalcula consumo e fica registrada na auditoria', async () => {
  const list = await admin.get(`/api/readings?meter_id=${aguaId}`);
  const r2 = list.data.find((r) => r.reading_date === d1);
  const up = await admin.put(`/api/readings/${r2.id}`, { reading_date: d1, reading_time: '08:00', value: '497,0', responsible: 'Edmilson' });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.data.consumption, 19);
  const audit = await admin.get('/api/audit');
  assert.match(audit.data.rows[0].description, /alterou a leitura de água do dia .* de 498,0 para 497,0 m³/);
});

test('histórico em formato de planilha', async () => {
  const s = await admin.get(`/api/readings/sheet?condominium_id=${condoId}`);
  assert.strictEqual(s.data.meters.length, 2);
  assert.strictEqual(s.data.rows.length, 2);
  const row = s.data.rows[0];
  assert.strictEqual(row.cells[aguaId].consumption, 19);
  assert.strictEqual(row.cells[gasId].consumption, 148);
  assert.ok(row.weekday);
});

test('operador registra leituras, mas não exclui nem gerencia usuários', async () => {
  const curta = await admin.post('/api/users', { name: 'Maria', email: 'maria@x.com', password: '123456', role: 'operator' });
  assert.strictEqual(curta.status, 400); // senha mínima de 8 caracteres
  const u = await admin.post('/api/users', { name: 'Maria', email: 'maria@x.com', password: '12345678', role: 'operator' });
  assert.strictEqual(u.status, 201);
  await operator.login('maria@x.com', '12345678');
  assert.strictEqual((await operator.post('/api/auth/change-password', { current_password: '12345678', new_password: 'maria-2026' })).status, 200);
  const r = await operator.post('/api/readings', { meter_id: gasId, reading_date: todayISO(), reading_time: '08:00', value: '3000' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.consumption, 112);
  assert.strictEqual((await operator.del(`/api/readings/${r.data.id}`)).status, 403);
  assert.strictEqual((await operator.put(`/api/readings/${r.data.id}`, { value: 1 })).status, 403);
  assert.strictEqual((await operator.del(`/api/condominiums/${condoId}`)).status, 403);
  assert.strictEqual((await operator.get('/api/users')).status, 403);
  assert.strictEqual((await operator.post('/api/condominiums', { name: 'X' })).status, 403);
  assert.strictEqual((await operator.get(`/api/reports?condominium_id=${condoId}&year=${todayISO().slice(0, 4)}&month=0`)).status, 200);
});

test('dados de condomínios diferentes não se misturam', async () => {
  const c2 = await admin.post('/api/condominiums', { name: 'Flow Perdizes' });
  const m = await admin.post('/api/meters', { condominium_id: c2.data.id, utility_type: 'agua', name: 'Hidrômetro' });
  await admin.post('/api/readings', { meter_id: m.data.id, reading_date: d0, value: '100' });
  const s1 = await admin.get(`/api/readings?condominium_id=${condoId}`);
  assert.ok(s1.data.every((r) => r.condominium_id === condoId));
  const s2 = await admin.get(`/api/readings/sheet?condominium_id=${c2.data.id}`);
  assert.strictEqual(s2.data.meters.length, 1);
});

test('dashboard, calendário, gráficos, fechamento e alertas', async () => {
  const t = todayISO();
  const y = Number(t.slice(0, 4)); const mo = Number(t.slice(5, 7));
  const dash = await admin.get('/api/dashboard');
  assert.strictEqual(dash.status, 200);
  assert.strictEqual(dash.data.cards.condominiums, 2);
  const cal = await admin.get(`/api/calendar?year=${y}&month=${mo}`);
  assert.ok(cal.data.events.some((e) => e.kind === 'programada' || e.kind === 'realizada'));
  const ch = await admin.get(`/api/charts?months=3&condominium_id=${condoId}`);
  assert.strictEqual(ch.data.labels.length, 3);
  const cl = await admin.get(`/api/closing?condominium_id=${condoId}&year=${y}&month=${mo}`);
  assert.strictEqual(cl.status, 200);
  const save = await admin.post('/api/closing', { condominium_id: condoId, year: y, month: mo });
  if (cl.data.items.some((i) => i.readings_count)) {
    assert.strictEqual(save.status, 200);
    assert.strictEqual(save.data.is_closed, true);
  }
  const al = await admin.get('/api/alerts');
  assert.ok(Array.isArray(al.data));
});

test('exportação em PDF, Excel e CSV', async () => {
  const q = `condominium_id=${condoId}&year=${todayISO().slice(0, 4)}&month=0`;
  const pdf = await admin.get(`/api/reports/export?${q}&format=pdf`);
  assert.strictEqual(pdf.type, 'application/pdf');
  assert.strictEqual(pdf.data.subarray(0, 4).toString(), '%PDF');
  const xlsx = await admin.get(`/api/reports/export?${q}&format=xlsx`);
  assert.strictEqual(xlsx.data.subarray(0, 2).toString(), 'PK');
  const csv = await admin.get(`/api/reports/export?${q}&format=csv`);
  const text = csv.data.toString('utf8');
  assert.match(text, /CONSUMO TOTAL DO PERÍODO/);
  assert.match(text, /Geo Paulista/);
});

test('exclusão de condomínio remove seus dados (somente admin)', async () => {
  const c = await admin.post('/api/condominiums', { name: 'IS Moema' });
  const m = await admin.post('/api/meters', { condominium_id: c.data.id, utility_type: 'energia', name: 'Energia' });
  assert.strictEqual(m.data.unit, 'kWh');
  await admin.post('/api/readings', { meter_id: m.data.id, reading_date: d0, value: '1000' });
  assert.strictEqual((await admin.del(`/api/condominiums/${c.data.id}`)).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM readings WHERE meter_id = ?').get(m.data.id).n, 0);
});

test('fechamento: leitura do dia 01 fecha o mês anterior e abre o novo (sem contar em dobro)', async () => {
  const m = await admin.post('/api/meters', { condominium_id: condoId, utility_type: 'agua', name: 'Teste fechamento' });
  const mid = m.data.id;
  const add = (d, v) => admin.post('/api/readings', { meter_id: mid, reading_date: d, reading_time: '08:00', value: v });
  for (const [d, v] of [['2026-05-24', 100], ['2026-05-31', 150], ['2026-06-01', 160], ['2026-06-08', 200], ['2026-07-01', 260]]) {
    assert.strictEqual((await add(d, v)).status, 201);
  }
  const S = require('../src/services');
  const mai = S.closingForMonth(db, mid, 2026, 5);
  const jun = S.closingForMonth(db, mid, 2026, 6);
  assert.strictEqual(mai.final_date, '2026-06-01'); // 01/06 fecha maio
  assert.strictEqual(mai.final_value, 160);
  assert.strictEqual(jun.initial_date, '2026-06-01'); // e abre junho
  assert.strictEqual(jun.initial_value, 160);
  assert.strictEqual(jun.final_date, '2026-07-01');
  assert.strictEqual(jun.consumption, 100); // 160 → 260
  assert.strictEqual(mai.consumption, 60); // 100 → 160 (inclui 31/05 → 01/06)
  const ano = S.closingForMonth(db, mid, 2026, 0);
  assert.strictEqual(ano.consumption, mai.consumption + jun.consumption); // nada contado duas vezes

  const cl = await admin.get(`/api/closing?condominium_id=${condoId}&year=2026&month=6`);
  const item = cl.data.items.find((i) => i.meter_id === mid);
  assert.strictEqual(item.initial_value, 160);
  assert.strictEqual(item.consumption, 100);
  const rep = await admin.get(`/api/reports?condominium_id=${condoId}&year=2026&month=6&utility_type=agua`);
  const rows = rep.data.rows.filter((r) => r.meter_id === mid);
  assert.deepStrictEqual(rows.map((r) => [r.reading_date, r.role, r.counted]),
    [['2026-06-01', 'inicial', false], ['2026-06-08', 'periodo', true], ['2026-07-01', 'fechamento', true]]);
  const sm = rep.data.summary.find((x) => x.meter_id === mid);
  assert.strictEqual(sm.consumption, 100);
  await admin.del(`/api/meters/${mid}`);
});

test('consumo muito acima do normal pede confirmação (erro de digitação)', async () => {
  const m = await admin.post('/api/meters', { condominium_id: condoId, utility_type: 'gas', name: 'Teste digitação' });
  const mid = m.data.id;
  let v = 1000;
  for (const d of ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']) {
    await admin.post('/api/readings', { meter_id: mid, reading_date: d, value: v });
    v += 10;
  }
  const typo = await admin.post('/api/readings', { meter_id: mid, reading_date: '2026-09-05', value: '10400' });
  assert.strictEqual(typo.status, 400);
  assert.strictEqual(typo.data.code, 'HIGH_CONSUMPTION');
  const normal = await admin.post('/api/readings', { meter_id: mid, reading_date: '2026-09-05', value: '1052' });
  assert.strictEqual(normal.status, 201);
  const conf = await admin.post('/api/readings', { meter_id: mid, reading_date: '2026-09-12', value: '1400', confirm_high: true });
  assert.strictEqual(conf.status, 201);
  await admin.del(`/api/meters/${mid}`);
});

test('regras de medidor e concessionária', async () => {
  const unit = await admin.put(`/api/meters/${aguaId}`, { utility_type: 'agua', name: 'Hidrômetro principal', unit: 'L' });
  assert.strictEqual(unit.status, 400); // unidade não muda com leituras
  const fut = await admin.post('/api/utility-readings', { meter_id: aguaId, reading_date: addDays(todayISO(), 5) });
  assert.strictEqual(fut.status, 400);
  const ok = await admin.post('/api/utility-readings', { meter_id: aguaId, reading_date: todayISO(), next_reading_date: addDays(todayISO(), 30) });
  assert.strictEqual(ok.status, 201);
});

test('CSV protege contra fórmulas', async () => {
  await admin.post('/api/readings', { meter_id: gasId, reading_date: addDays(todayISO(), -1), reading_time: '09:00', value: '2950',
    responsible: '=HYPERLINK("http://x")' });
  const csv = await admin.get(`/api/reports/export?condominium_id=${condoId}&year=${todayISO().slice(0, 4)}&month=0&format=csv`);
  const text = csv.data.toString('utf8');
  assert.ok(!/;"?=HYPERLINK/.test(text));
  assert.match(text, /'=HYPERLINK/);
});

test('segurança do login e sessões', async () => {
  const other = client();
  for (let i = 0; i < 9; i++) await other.post('/api/auth/login', { email: 'maria@x.com', password: 'errada' });
  const blocked = await other.post('/api/auth/login', { email: 'maria@x.com', password: 'maria-2026' });
  assert.strictEqual(blocked.status, 429);
  // outra conta, do mesmo endereço, continua entrando
  await client().login('admin@admin.com', 'nova-senha');
  const audit = await admin.get('/api/audit?action=login_failed');
  assert.ok(audit.data.total >= 1);
  // trocar a senha encerra as outras sessões
  const s2 = client();
  await s2.login('admin@admin.com', 'nova-senha');
  assert.strictEqual((await admin.post('/api/auth/change-password', { current_password: 'nova-senha', new_password: 'outra-senha-1' })).status, 200);
  assert.strictEqual((await s2.get('/api/condominiums')).status, 401);
  assert.strictEqual((await admin.get('/api/condominiums')).status, 200);
});

test('backup do banco e auditoria com dados excluídos', async () => {
  const b = await admin.post('/api/backups');
  assert.strictEqual(b.status, 200, JSON.stringify(b.data));
  const list = await admin.get('/api/backups');
  assert.ok(list.data.backups.some((x) => x.name === b.data.name));
  const dl = await admin.get(`/api/backups/${b.data.name}`);
  assert.strictEqual(dl.data.subarray(0, 15).toString(), 'SQLite format 3');
  assert.strictEqual((await admin.get('/api/backups/..%2Fmedidores.db')).status, 404);
  const log = (await admin.get('/api/audit?action=delete')).data.rows.find((r) => r.entity === 'condominium');
  const det = await admin.get(`/api/audit/${log.id}`);
  assert.strictEqual(det.data.details.condominium.name, 'IS Moema');
  assert.strictEqual(det.data.details.readings.length, 1);
});

test('migração: consumo gravado confere com o recálculo', () => {
  const { recalcMeter } = require('../src/db');
  const before = db.prepare('SELECT id, consumption, prev_value FROM readings ORDER BY id').all();
  for (const m of db.prepare('SELECT id FROM meters').all()) recalcMeter(db, m.id);
  const after = db.prepare('SELECT id, consumption, prev_value FROM readings ORDER BY id').all();
  assert.deepStrictEqual(after, before);
});
