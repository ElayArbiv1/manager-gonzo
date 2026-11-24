'use strict';
/** Small helpers for reading report-style Excel sheets (title lines, merged headers, total rows). */
const { cellValue, normHeader, toDate, toNumber } = require('../importers');

/** All rows of a sheet as arrays of plain values (1-based columns become 0-based). */
function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const vals = [];
    for (let i = 1; i <= row.cellCount; i++) vals.push(cellValue(row.getCell(i).value));
    rows.push({ rowNo, vals });
  });
  return rows;
}

const text = v => (v instanceof Date ? v.toISOString() : String(v ?? '')).trim();

/** Finds the header row containing all `required` names; returns { index, col(name) }. */
function findHeader(rows, required) {
  const req = required.map(normHeader);
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const normed = rows[i].vals.map(v => normHeader(text(v)));
    if (req.every(r => normed.includes(r))) {
      const col = (name, nth = 0) => {
        const n = normHeader(name);
        let seen = -1;
        for (let c = 0; c < normed.length; c++) if (normed[c] === n && ++seen === nth) return c;
        return -1;
      };
      const all = name => normed.map((h, c) => (h === normHeader(name) ? c : -1)).filter(c => c >= 0);
      return { index: i, col, all };
    }
  }
  return null;
}

/** "28/11/2026 - 22/11/2026" (any order) → { from, to } */
function parseRange(s) {
  const m = [...String(s).matchAll(/(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/g)].map(x => toDate(x[1])).filter(Boolean).sort();
  return m.length >= 2 ? { from: m[0], to: m[m.length - 1] } : m.length === 1 ? { from: m[0], to: m[0] } : null;
}

/** Searches the first rows of a sheet for "label : value". */
function findMeta(rows, label) {
  for (const r of rows.slice(0, 12)) {
    for (const v of r.vals) {
      const t = text(v);
      const i = t.indexOf(label);
      if (i >= 0) return t.slice(i + label.length).replace(/^\s*:\s*/, '').trim();
    }
  }
  return null;
}

const num = v => toNumber(v instanceof Date ? null : v);

module.exports = { sheetRows, findHeader, parseRange, findMeta, text, num };
