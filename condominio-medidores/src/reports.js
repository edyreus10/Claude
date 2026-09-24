'use strict';
/** Montagem dos dados do relatório e exportação em PDF, Excel e CSV. */
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { getSettings } = require('./db');
const { ValidationError, id } = require('./validate');
const F = require('./format');
const S = require('./services');
const { READING_SELECT } = require('./routes/readings');
const { uploadPath } = require('./storage');

function buildReport(db, q, user) {
  const condominiumId = id(q.condominium_id, 'condomínio');
  const condo = db.prepare('SELECT * FROM condominiums WHERE id = ?').get(condominiumId);
  if (!condo) throw new ValidationError('Condomínio não encontrado.', 404);
  const year = Number(q.year);
  const month = Number(q.month || 0);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ValidationError('Selecione o ano.');
  if (!Number.isInteger(month) || month < 0 || month > 12) throw new ValidationError('Selecione o mês.');
  const range = month ? F.monthRange(year, month) : { from: `${year}-01-01`, to: `${year}-12-31` };
  const periodLabel = month ? `${F.monthName(month)} de ${year}` : `ano de ${year}`;

  let type = null;
  if (q.utility_type) {
    type = db.prepare('SELECT * FROM utility_types WHERE code = ?').get(q.utility_type);
    if (!type) throw new ValidationError('Concessionária/tipo inválido.');
  }
  const params = [condominiumId, range.from, range.to];
  let extra = '';
  if (type) { extra = 'AND m.utility_type = ?'; params.push(type.code); }
  const rows = db.prepare(`${READING_SELECT} WHERE m.condominium_id = ? AND v.reading_date BETWEEN ? AND ? ${extra}
      ORDER BY v.reading_date, v.reading_time, t.sort_order, m.name`).all(...params)
    .map((x) => ({ ...x, weekday: F.weekday(x.reading_date) }));

  const meters = S.listMeters(db, { condominiumId }).filter((m) => !type || m.utility_type === type.code);
  const summary = meters.map((m) => ({ meter_id: m.id, meter_name: m.name, identifier: m.identifier, kind: m.kind,
    type_name: m.type_name, utility_type: m.utility_type, unit: m.unit, type_color: m.type_color,
    ...S.closingForMeter(db, m.id, range.from, range.to) }))
    .filter((s) => s.readings_count > 0);

  // Total por tipo: soma dos medidores principais (os de área são submedições).
  const totals = [];
  for (const s of summary) {
    let t = totals.find((x) => x.utility_type === s.utility_type);
    if (!t) { t = { utility_type: s.utility_type, type_name: s.type_name, unit: s.unit, consumption: 0, area_consumption: 0 }; totals.push(t); }
    if (s.consumption !== null) {
      if (s.kind === 'principal') t.consumption = Math.round((t.consumption + s.consumption) * 1000) / 1000;
      else t.area_consumption = Math.round((t.area_consumption + s.consumption) * 1000) / 1000;
    }
  }
  const settings = getSettings(db);
  return {
    org_name: settings.org_name, logo_file: settings.logo_file || null,
    condominium: condo, year, month, from: range.from, to: range.to, period_label: periodLabel,
    period_days: F.diffDays(range.from, range.to) + 1,
    utility_type: type ? type.code : null, utility_name: type ? type.name : 'Todas',
    rows, summary, totals,
    generated_at: F.nowLocal(), generated_by: user ? user.name : '',
  };
}

function fileBase(rep) {
  const slug = rep.condominium.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `relatorio-${slug}-${rep.year}${rep.month ? '-' + F.pad(rep.month) : ''}${rep.utility_type ? '-' + rep.utility_type : ''}`;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- CSV
function toCSV(rep) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
  const lines = [];
  lines.push(['Condomínio', rep.condominium.name].map(esc).join(';'));
  lines.push(['Período', capital(rep.period_label)].map(esc).join(';'));
  lines.push(['Concessionária', rep.utility_name].map(esc).join(';'));
  lines.push('');
  lines.push(['Data', 'Dia', 'Horário', 'Tipo', 'Medidor', 'Leitura', 'Consumo', 'Unidade', 'Responsável', 'Observação'].join(';'));
  for (const r of rep.rows) {
    lines.push([F.fmtDate(r.reading_date), r.weekday, r.reading_time, r.type_name, r.meter_name, num(r.value),
      num(r.consumption), r.unit, r.responsible || '', r.notes || ''].map(esc).join(';'));
  }
  lines.push('');
  lines.push(['Resumo por medidor', '', 'Leitura inicial', 'Data inicial', 'Leitura final', 'Data final', 'Consumo', 'Unidade', 'Dias'].join(';'));
  for (const s of rep.summary) {
    lines.push([`${s.type_name} — ${s.meter_name}`, s.kind === 'area' ? 'Área específica' : 'Principal', num(s.initial_value),
      F.fmtDate(s.initial_date), num(s.final_value), F.fmtDate(s.final_date), num(s.consumption), s.unit, s.days].map(esc).join(';'));
  }
  lines.push('');
  for (const t of rep.totals) lines.push([`CONSUMO TOTAL DO PERÍODO — ${t.type_name}`, num(t.consumption), t.unit].map(esc).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Excel
async function toXLSX(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = rep.org_name;
  wb.created = new Date();
  const ws = wb.addWorksheet('Leituras', { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 } });
  ws.columns = [
    { width: 12 }, { width: 10 }, { width: 9 }, { width: 18 }, { width: 26 }, { width: 14 }, { width: 13 }, { width: 8 }, { width: 20 }, { width: 34 },
  ];
  const brand = 'FF0F766E';
  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = `${rep.condominium.name} — Relatório de leituras e consumo`;
  ws.getCell('A1').font = { size: 15, bold: true, color: { argb: brand } };
  ws.getCell('A2').value = `Período: ${capital(rep.period_label)}   ·   Concessionária: ${rep.utility_name}`;
  ws.mergeCells('A2:J2');
  ws.getCell('A3').value = `Gerado em ${F.fmtDateTime(rep.generated_at)} por ${rep.generated_by}   ·   ${rep.org_name}`;
  ws.mergeCells('A3:J3');
  ws.getCell('A3').font = { size: 9, color: { argb: 'FF64748B' } };

  const header = ['Data', 'Dia', 'Horário', 'Tipo', 'Medidor', 'Leitura', 'Consumo', 'Unid.', 'Responsável', 'Observação'];
  const hr = ws.getRow(6);
  hr.values = header;
  hr.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } };
    c.alignment = { vertical: 'middle' };
  });
  hr.height = 20;
  let rowIdx = 7;
  for (const r of rep.rows) {
    const row = ws.getRow(rowIdx++);
    row.values = [F.parseISODate(r.reading_date), r.weekday, r.reading_time, r.type_name, r.meter_name, r.value,
      r.consumption, r.unit, r.responsible || '', r.notes || ''];
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(6).numFmt = '#,##0.0##';
    row.getCell(7).numFmt = '#,##0.0##';
    if (rowIdx % 2 === 0) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; });
  }
  if (rep.rows.length) ws.autoFilter = { from: 'A6', to: `J${rowIdx - 1}` };
  rowIdx++;
  for (const t of rep.totals) {
    const row = ws.getRow(rowIdx++);
    row.getCell(1).value = `CONSUMO TOTAL DO PERÍODO — ${t.type_name}`;
    ws.mergeCells(`A${row.number}:F${row.number}`);
    row.getCell(7).value = t.consumption;
    row.getCell(7).numFmt = '#,##0.0##';
    row.getCell(8).value = t.unit;
    row.font = { bold: true };
  }

  const rs = wb.addWorksheet('Resumo');
  rs.columns = [{ width: 18 }, { width: 28 }, { width: 16 }, { width: 14 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 13 }, { width: 8 }, { width: 7 }];
  rs.getCell('A1').value = `Resumo — ${rep.condominium.name} — ${capital(rep.period_label)}`;
  rs.getCell('A1').font = { size: 14, bold: true, color: { argb: brand } };
  const rh = rs.getRow(3);
  rh.values = ['Tipo', 'Medidor', 'Classificação', 'Data inicial', 'Leitura inicial', 'Data final', 'Leitura final', 'Consumo', 'Unid.', 'Dias'];
  rh.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } }; });
  let i = 4;
  for (const s of rep.summary) {
    const row = rs.getRow(i++);
    row.values = [s.type_name, s.meter_name, s.kind === 'area' ? 'Área específica' : 'Principal',
      s.initial_date ? F.parseISODate(s.initial_date) : null, s.initial_value, s.final_date ? F.parseISODate(s.final_date) : null,
      s.final_value, s.consumption, s.unit, s.days];
    row.getCell(4).numFmt = 'dd/mm/yyyy';
    row.getCell(6).numFmt = 'dd/mm/yyyy';
    [5, 7, 8].forEach((c) => { row.getCell(c).numFmt = '#,##0.0##'; });
  }
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------- PDF
const C = { brand: '#0f766e', brandLight: '#ccfbf1', text: '#0f172a', muted: '#64748b', line: '#e2e8f0', zebra: '#f8fafc' };

function drawLogo(doc, rep, x, y, size) {
  if (rep.logo_file) {
    try {
      const p = uploadPath(rep.logo_file);
      if (fs.existsSync(p)) {
        doc.image(p, x, y, { fit: [size * 2.2, size], valign: 'center' });
        return size * 2.2;
      }
    } catch (_e) { /* usa o logo padrão */ }
  }
  // Logo padrão: quadrado arredondado com um "medidor".
  doc.save();
  doc.roundedRect(x, y, size, size, 8).fill(C.brand);
  doc.circle(x + size / 2, y + size / 2 + 2, size * 0.28).lineWidth(2.2).stroke('#ffffff');
  doc.moveTo(x + size / 2, y + size / 2 + 2).lineTo(x + size / 2 + size * 0.17, y + size / 2 - size * 0.14).lineWidth(2.2).stroke('#ffffff');
  doc.restore();
  return size;
}

function toPDF(rep) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true,
      info: { Title: `Relatório — ${rep.condominium.name} — ${rep.period_label}`, Author: rep.org_name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 10;

    // Cabeçalho
    const logoW = drawLogo(doc, rep, L, 40, 42);
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(rep.org_name, L + logoW + 12, 44, { width: W - logoW - 150 });
    doc.fillColor(C.text).font('Helvetica-Bold').fontSize(16).text('Relatório de Leituras e Consumo', L + logoW + 12, 57, { width: W - logoW - 150 });
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text(`Gerado em ${F.fmtDateTime(rep.generated_at)}`, L + W - 150, 46, { width: 150, align: 'right' })
      .text(`por ${rep.generated_by}`, L + W - 150, 57, { width: 150, align: 'right' });
    doc.moveTo(L, 94).lineTo(L + W, 94).lineWidth(2).stroke(C.brand);

    // Bloco de identificação
    let y = 106;
    doc.roundedRect(L, y, W, 62, 6).fill(C.zebra);
    const info = (label, value, x, yy, w) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label.toUpperCase(), x, yy, { width: w });
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.text).text(value || '—', x, yy + 10, { width: w, height: 14, ellipsis: true });
    };
    const colW = (W - 24) / 3;
    info('Condomínio', rep.condominium.name, L + 12, y + 9, colW * 1.3);
    info('Período', capital(rep.period_label), L + 12 + colW * 1.3, y + 9, colW * 0.9);
    info('Concessionária', rep.utility_name, L + 12 + colW * 2.2, y + 9, colW * 0.8);
    info('Endereço', rep.condominium.address, L + 12, y + 35, colW * 1.3);
    info('CNPJ', rep.condominium.cnpj, L + 12 + colW * 1.3, y + 35, colW * 0.9);
    info('Síndico', rep.condominium.syndic, L + 12 + colW * 2.2, y + 35, colW * 0.8);
    y += 76;

    function table(title, cols, data, opts = {}) {
      const rowH = opts.rowH || 18;
      const headerH = 20;
      const ensure = (h) => {
        if (y + h > bottom()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
      };
      function drawHeader() {
        doc.rect(L, y, W, headerH).fill(C.brand);
        let x = L;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
        for (const c of cols) {
          doc.text(c.label, x + 5, y + 6.5, { width: c.w - 10, align: c.align || 'left', lineBreak: false });
          x += c.w;
        }
        y += headerH;
      }
      if (title) {
        ensure(headerH + rowH + 26);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.text).text(title, L, y);
        y += 18;
      }
      drawHeader();
      data.forEach((row, idx) => {
        ensure(rowH);
        if (idx % 2 === 1) doc.rect(L, y, W, rowH).fill(C.zebra);
        let x = L;
        for (const c of cols) {
          const v = row[c.key];
          doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(c.color ? c.color(row) : C.text)
            .text(v === null || v === undefined ? '—' : String(v), x + 5, y + 5, { width: c.w - 10, height: 11, align: c.align || 'left', ellipsis: true });
          x += c.w;
        }
        doc.moveTo(L, y + rowH).lineTo(L + W, y + rowH).lineWidth(0.5).stroke(C.line);
        y += rowH;
      });
      if (!data.length) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted).text('Nenhuma leitura registrada no período.', L + 5, y + 6);
        y += rowH;
      }
      y += 16;
    }

    const u = (v, unit) => (v === null || v === undefined ? '—' : `${F.fmtNum(v)} ${unit}`);
    const sw = W;
    table('Resumo por medidor', [
      { key: 'meter', label: 'MEDIDOR', w: sw * 0.30 },
      { key: 'initial', label: 'LEITURA INICIAL', w: sw * 0.20, align: 'right' },
      { key: 'final', label: 'LEITURA FINAL', w: sw * 0.20, align: 'right' },
      { key: 'days', label: 'DIAS', w: sw * 0.08, align: 'right' },
      { key: 'consumption', label: 'CONSUMO', w: sw * 0.22, align: 'right', bold: true },
    ], rep.summary.map((s) => ({
      meter: `${s.type_name} — ${s.meter_name}${s.kind === 'area' ? ' (área)' : ''}`,
      initial: s.initial_value !== null ? `${u(s.initial_value, s.unit)} (${F.fmtDate(s.initial_date).slice(0, 5)})` : '—',
      final: s.final_value !== null ? `${u(s.final_value, s.unit)} (${F.fmtDate(s.final_date).slice(0, 5)})` : '—',
      days: s.days, consumption: u(s.consumption, s.unit),
    })));

    table('Leituras do período', [
      { key: 'date', label: 'DATA', w: W * 0.12 },
      { key: 'weekday', label: 'DIA', w: W * 0.09 },
      { key: 'meter', label: 'MEDIDOR', w: W * 0.27 },
      { key: 'value', label: 'LEITURA', w: W * 0.15, align: 'right' },
      { key: 'consumption', label: 'CONSUMO', w: W * 0.14, align: 'right', bold: true },
      { key: 'time', label: 'HORA', w: W * 0.08, align: 'center' },
      { key: 'responsible', label: 'RESPONSÁVEL', w: W * 0.15 },
    ], rep.rows.map((r) => ({
      date: F.fmtDate(r.reading_date), weekday: r.weekday, meter: `${r.type_name} — ${r.meter_name}`,
      value: u(r.value, r.unit), consumption: r.is_reset ? 'troca' : u(r.consumption, r.unit), time: r.reading_time, responsible: r.responsible,
    })));

    // Consumo total do período
    const boxH = 30 + rep.totals.length * 20;
    if (y + boxH > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    doc.roundedRect(L, y, W, boxH, 6).fill(C.brandLight);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.brand).text('CONSUMO TOTAL DO PERÍODO', L + 14, y + 10);
    let ty = y + 28;
    if (!rep.totals.length) {
      doc.font('Helvetica').fontSize(10).fillColor(C.text).text('Sem consumo no período.', L + 14, ty);
    }
    for (const t of rep.totals) {
      doc.font('Helvetica').fontSize(10).fillColor(C.text).text(t.type_name, L + 14, ty, { width: W / 2 });
      doc.font('Helvetica-Bold').fontSize(12).text(`${F.fmtNum(t.consumption)} ${t.unit}`, L + W / 2, ty - 1, { width: W / 2 - 14, align: 'right' });
      ty += 20;
    }
    y += boxH + 8;
    if (rep.totals.some((t) => t.area_consumption)) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted)
        .text('O total considera os medidores principais. Medidores de áreas específicas aparecem no resumo por medidor.', L, y, { width: W });
    }

    // Rodapé com numeração de páginas
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // evita página extra ao escrever no rodapé
      const fy = doc.page.height - 34;
      doc.moveTo(L, fy - 6).lineTo(L + W, fy - 6).lineWidth(0.5).stroke(C.line);
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
        .text(`${rep.condominium.name} · ${capital(rep.period_label)} · Gerado em ${F.fmtDateTime(rep.generated_at)} por ${rep.generated_by}`,
          L, fy, { width: W - 80, lineBreak: false })
        .text(`Página ${i + 1} de ${range.count}`, L + W - 80, fy, { width: 80, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildReport, toCSV, toXLSX, toPDF, fileBase };
