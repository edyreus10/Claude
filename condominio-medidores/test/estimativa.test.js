'use strict';
// Testes da regra de dias sem leitura e consumo estimado:  npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.TZ = 'America/Sao_Paulo';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'medidores-est-'));
process.env.BACKUP_DISABLED = 'true';
const { open, recalcMeter } = require('../src/db');
const S = require('../src/services');
const E = require('../src/estimates');
const F = require('../src/format');
const { buildClosing } = require('../src/routes/panel');
const { buildReport } = require('../src/reports');

const db = open(':memory:');
const now = F.nowLocal();
const TODAY = '2026-09-25';

let seq = 0;
function newMeter(name = 'Água') {
  seq++;
  const c = db.prepare("INSERT INTO condominiums (name,status,created_at,updated_at) VALUES (?, 'active', ?, ?)").run(`Condomínio ${seq}`, now, now).lastInsertRowid;
  const m = db.prepare(`INSERT INTO meters (condominium_id,utility_type,name,unit,kind,frequency_days,created_at,updated_at)
      VALUES (?, 'agua', ?, 'm³', 'principal', 1, ?, ?)`).run(c, name, now, now).lastInsertRowid;
  return { condominiumId: c, meterId: m, meter: { id: m, frequency_days: 1 } };
}
function add(meterId, list) {
  const ins = db.prepare(`INSERT INTO readings (meter_id,reading_date,reading_time,value,created_at,updated_at) VALUES (?,?, '08:00', ?, ?, ?)`);
  for (const [d, v] of list) ins.run(meterId, d, v, now, now);
  recalcMeter(db, meterId);
}
/** Leituras diárias de `start` até `end`, somando `step` por dia a partir de `value`. */
function daily(start, end, value, step) {
  const out = [];
  for (let d = start, v = value; d <= end; d = F.addDays(d, 1), v = Math.round((v + step) * 1000) / 1000) out.push([d, v]);
  return out;
}
const day = (series, date) => series.find((x) => x.date === date);
const readingsOn = (meterId, date) => db.prepare('SELECT COUNT(*) n FROM readings WHERE meter_id = ? AND reading_date = ?').get(meterId, date).n;

test('um dia sem leitura: 20/09 = 500,0 · 21/09 sem leitura · 22/09 = 508,0 (média 3,5)', () => {
  const { meterId, meter } = newMeter();
  add(meterId, [...daily('2026-07-13', '2026-07-20', 475.5, 3.5), ['2026-07-22', 508.0]]);
  const s = E.dailySeries(db, meter, '2026-07-02', '2026-08-01', TODAY);
  const d21 = day(s, '2026-07-21');
  assert.strictEqual(d21.kind, 'estimado');
  assert.strictEqual(d21.estimated, 3.5);
  assert.match(d21.reason_text, /média diária anterior/);
  assert.strictEqual(readingsOn(meterId, '2026-07-21'), 0); // nenhuma leitura inventada
  const d22 = day(s, '2026-07-22');
  assert.strictEqual(d22.registered, 4.5); // 8,0 medidos − 3,5 estimados
  assert.deepStrictEqual(d22.gap, { days: 1, measured: 8, estimated: 3.5, from: '2026-07-20' });
  const c = S.closingForMonth(db, meterId, 2026, 7, TODAY);
  assert.strictEqual(c.estimated, 3.5);
  assert.strictEqual(c.registered, 29); // 7 dias × 3,5 + 4,5
  assert.strictEqual(c.consumption, 32.5); // = 508,0 − 475,5 (o que o medidor mediu)
  assert.strictEqual(c.days_with_reading, 9);
  assert.strictEqual(c.days_estimated, 1); // 21/07
  assert.strictEqual(c.days_waiting, 10); // 23/07 a 01/08: depois da última leitura, aguardando a próxima
  assert.strictEqual(c.days_without_reading, 11);
});

test('dois dias consecutivos sem leitura', () => {
  const { meterId, meter } = newMeter();
  add(meterId, [...daily('2026-07-13', '2026-07-20', 475.5, 3.5), ['2026-07-23', 511.0]]);
  const s = E.dailySeries(db, meter, '2026-07-02', '2026-08-01', TODAY);
  assert.deepStrictEqual(['2026-07-21', '2026-07-22'].map((d) => [day(s, d).kind, day(s, d).estimated]), [['estimado', 3.5], ['estimado', 3.5]]);
  assert.strictEqual(day(s, '2026-07-23').registered, 4); // 11,0 medidos − 7,0 estimados
  const c = S.closingForMonth(db, meterId, 2026, 7, TODAY);
  assert.strictEqual(c.estimated, 7);
  assert.strictEqual(c.consumption, 35.5); // 511,0 − 475,5
  assert.strictEqual(c.days_estimated, 2);
});

test('final de semana sem leitura (sábado e domingo)', () => {
  const { meterId, meter } = newMeter();
  add(meterId, [...daily('2026-07-01', '2026-07-10', 100, 4), ['2026-07-13', 148]]); // sex 10/07 = 136; seg 13/07 = 148
  const s = E.dailySeries(db, meter, '2026-07-02', '2026-08-01', TODAY);
  const sab = day(s, '2026-07-11'); const dom = day(s, '2026-07-12');
  assert.deepStrictEqual([sab.weekday, sab.kind, sab.estimated], ['sábado', 'estimado', 4]);
  assert.deepStrictEqual([dom.weekday, dom.kind, dom.estimated], ['domingo', 'estimado', 4]);
  assert.strictEqual(day(s, '2026-07-13').registered, 4); // 12 medidos − 8 estimados
  // A pendência continua visível no dashboard/calendário mesmo com a estimativa.
  const st = S.meterStatuses(db, { condominiumId: db.prepare('SELECT condominium_id c FROM meters WHERE id = ?').get(meterId).c, today: '2026-07-14' })[0];
  assert.deepStrictEqual(st.missing_dates, ['2026-07-11', '2026-07-12']);
});

test('feriado sem leitura (07/09 — Independência)', () => {
  const { condominiumId, meterId, meter } = newMeter();
  add(meterId, [...daily('2026-09-01', '2026-09-06', 1000, 4), ['2026-09-08', 1028]]);
  const s = E.dailySeries(db, meter, '2026-09-02', '2026-09-08', TODAY);
  const f = day(s, '2026-09-07');
  assert.deepStrictEqual([f.weekday, f.kind, f.estimated], ['segunda', 'estimado', 4]);
  const ev = S.calendarEvents(db, { year: 2026, month: 9, condominiumId, today: '2026-09-10' }).filter((e) => e.date === '2026-09-07');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, 'pendente'); // continua como pendência
  assert.match(ev[0].title, /leitura não realizada/);
  assert.match(ev[0].detail, /consumo estimado 4,0 m³/);
});

test('mês com poucos dias registrados (junho com 5 leituras)', () => {
  const { condominiumId, meterId } = newMeter();
  // 01/06 a 06/06 com leitura (+5/dia); próxima leitura só em 03/07 (27 dias depois, 135 medidos).
  add(meterId, [...daily('2026-06-01', '2026-06-06', 200, 5), ['2026-07-03', 360]]);
  const jun = S.closingForMonth(db, meterId, 2026, 6, TODAY);
  assert.strictEqual(jun.days_with_reading, 5); // 02 a 06/06
  assert.strictEqual(jun.days_without_reading, 25); // 07/06 a 01/07
  assert.strictEqual(jun.registered, 25);
  assert.strictEqual(jun.estimated, 125);
  assert.strictEqual(jun.consumption, 150);
  assert.strictEqual(jun.daily_avg, 5);
  const jul = S.closingForMonth(db, meterId, 2026, 7, TODAY);
  assert.strictEqual(Math.round((jun.consumption + jul.consumption) * 1000) / 1000, 160); // 360 − 200: nada duplicado
  const rep = buildReport(db, { condominium_id: condominiumId, year: 2026, month: 6 }, { name: 'Teste' });
  assert.ok(rep.notes.includes('Este período possui 25 dias sem leitura. O consumo desses dias foi estimado com base na média diária anterior.'));
  assert.strictEqual(rep.rows.filter((r) => r.kind === 'nao_realizada').length, 25);
  assert.strictEqual(rep.totals[0].estimated, 125);
});

test('comparação entre meses com quantidades diferentes de dias (média diária)', () => {
  const { condominiumId, meterId } = newMeter();
  // Julho: 20 m³ em 4 dias (5/dia). Agosto: 155 m³ em 31 dias (5/dia).
  add(meterId, daily('2026-07-28', '2026-09-01', 1000, 5));
  const c = buildClosing(db, condominiumId, 2026, 8).items.find((i) => i.meter_id === meterId);
  const julho = c.previous[c.previous.length - 1];
  assert.deepStrictEqual([julho.consumption, julho.covered_days, julho.daily_avg], [20, 4, 5]);
  assert.deepStrictEqual([c.consumption, c.covered_days, c.daily_avg], [155, 31, 5]);
  assert.strictEqual(c.vs_last_pct, 0); // bruto seria +675%
  assert.strictEqual(c.vs_average_pct, 0);
  assert.strictEqual(c.average_daily, 5);
});

test('sem histórico suficiente para estimativa', () => {
  const { condominiumId, meterId, meter } = newMeter();
  add(meterId, [['2026-08-01', 50], ['2026-08-02', 53], ['2026-08-05', 62]]); // só 1 dia com média antes do intervalo
  const s = E.dailySeries(db, meter, '2026-08-02', '2026-09-01', TODAY);
  for (const d of ['2026-08-03', '2026-08-04']) {
    assert.strictEqual(day(s, d).kind, 'sem_estimativa');
    assert.strictEqual(day(s, d).estimated, 0);
    assert.strictEqual(day(s, d).reason_text, 'Não há histórico suficiente para estimativa.');
  }
  assert.strictEqual(day(s, '2026-08-05').registered, 9); // o medido fica todo no dia da leitura real
  const c = S.closingForMonth(db, meterId, 2026, 8, TODAY);
  assert.strictEqual(c.estimated, 0);
  assert.ok(c.messages.some((m) => /Não há histórico suficiente para estimativa/.test(m)));
  const rep = buildReport(db, { condominium_id: condominiumId, year: 2026, month: 8 }, { name: 'Teste' });
  assert.ok(rep.notes.some((m) => /Não há histórico suficiente para estimativa/.test(m)));
});

test('dias sem leitura na virada do mês: estimativa vai para o mês certo e nada é duplicado', () => {
  const { meterId } = newMeter();
  // 31/07 e 01/08 sem leitura; 02/08 real. 31/07 e 01/08 pertencem a julho (o dia 01 fecha o mês anterior).
  add(meterId, [...daily('2026-07-20', '2026-07-30', 300, 2), ['2026-08-02', 326]]);
  const jul = S.closingForMonth(db, meterId, 2026, 7, TODAY);
  const ago = S.closingForMonth(db, meterId, 2026, 8, TODAY);
  assert.strictEqual(jul.estimated, 4); // 31/07 + 01/08
  assert.strictEqual(ago.registered, 2); // 02/08: 6 medidos − 4 estimados
  assert.strictEqual(Math.round((jul.consumption + ago.consumption) * 1000) / 1000, 26); // 326 − 300
});

test('estimativa nunca deixa o dia da leitura real negativo', () => {
  const { meterId, meter } = newMeter();
  add(meterId, [...daily('2026-07-01', '2026-07-10', 0, 10), ['2026-07-13', 96]]); // média 10/dia, mas só 6 medidos em 3 dias
  const s = E.dailySeries(db, meter, '2026-07-02', '2026-08-01', TODAY);
  assert.strictEqual(day(s, '2026-07-11').estimated, 2);
  assert.strictEqual(day(s, '2026-07-12').estimated, 2);
  assert.strictEqual(day(s, '2026-07-13').registered, 2);
});

test('dias sem leitura depois da última leitura aguardam a próxima (sem estimativa)', () => {
  const { meterId } = newMeter();
  add(meterId, daily('2026-09-01', '2026-09-20', 10, 1));
  const c = S.closingForMonth(db, meterId, 2026, 9, TODAY);
  assert.strictEqual(c.days_waiting, 4); // 21 a 24/09 (hoje, 25/09, ainda pode ser lido)
  assert.strictEqual(c.estimated, 0);
  assert.strictEqual(c.consumption, 19);
});
