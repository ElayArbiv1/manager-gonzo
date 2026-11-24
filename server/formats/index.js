'use strict';
/**
 * Known report formats that need more than "one table with a header row":
 * multi-sheet workbooks, per-employee sheets, totals-only reports. Each format exports
 * { id, detect(workbook), parse(workbook) → { format, label, source, range, parts: [{ kind, rows, range }], notes } }.
 * Anything not recognised here goes through the generic column-mapping importer.
 */
const path = require('path');
const ExcelJS = require('exceljs');
const imp = require('../importers');

const FORMATS = [require('./shiftorganizer'), require('./beecomm')];

async function detectFormat(buffer, filename) {
  if (!/^\.(xlsx|xlsm)$/i.test(path.extname(filename || ''))) return null;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { return null; }
  for (const f of FORMATS) {
    if (f.detect(wb)) return f.parse(wb);
  }
  return null;
}

/** Short summary for previews / logs. */
function describe(result) {
  const LABEL = { sales: 'מכירות', items: 'פריטים', cancellations: 'ביטולים', shifts: 'משמרות', tips_daily: 'שעתי' };
  return result.parts.map(p => {
    const sum = k => Math.round(p.rows.reduce((a, r) => a + (r[k] || 0), 0) * 100) / 100;
    const extra = p.kind === 'shifts' ? { hours: sum('hours'), cost: sum('cost'), tips: sum('tips'), employees: new Set(p.rows.map(r => r.employee)).size }
      : p.kind === 'sales' ? { amount: sum('amount'), orders: sum('orders'), guests: sum('guests'), tips: sum('tips'), discount: sum('discount') }
        : { amount: sum('amount'), qty: sum('qty') };
    return { kind: p.kind, label: LABEL[p.kind] || p.kind, rows: p.rows.length, ...extra };
  });
}

function commitFormat(db, result, { filename, source } = {}) {
  const src = source || result.source;
  return db.transaction(() => result.parts.map(p => ({
    kind: p.kind,
    ...(p.rows.length || p.range ? imp.commitImport(db, { kind: p.kind, source: src, filename, rows: p.rows, range: p.range, replace: true }) : { inserted: 0 })
  })))();
}

module.exports = { detectFormat, describe, commitFormat };
