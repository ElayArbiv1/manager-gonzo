'use strict';
/**
 * File import engine.
 * Reads CSV / XLSX exports (website, Beecomm, shift app...) and maps their columns
 * onto our fields using Hebrew + English header synonyms. The user can override
 * the mapping in the UI before committing.
 */
const path = require('path');
const Papa = require('papaparse');
const ExcelJS = require('exceljs');

// ---------- field definitions ----------
const KINDS = {
  sales: {
    label: 'מכירות',
    fields: {
      date: { label: 'תאריך', required: true, syn: ['date', 'תאריך', 'יום', 'order date', 'created at', 'created_at', 'תאריך הזמנה', 'תאריך עסקה', 'business date', 'יום עסקים', 'תאריך פתיחה', 'opened'] },
      time: { label: 'שעה', syn: ['time', 'שעה', 'שעת הזמנה', 'שעת פתיחה', 'hour'] },
      amount: { label: 'סכום', required: true, syn: ['total', 'amount', 'סכום', 'סה"כ', 'סהכ', 'סה״כ', 'סך הכל', 'סה"כ כולל מע"מ', 'מחזור', 'הכנסות', 'revenue', 'sales', 'gross', 'gross sales', 'order total', 'total sales', 'net sales', 'מכירות', 'סכום כולל', 'לתשלום', 'pay'] },
      orders: { label: 'מס׳ הזמנות', syn: ['orders', 'order count', 'הזמנות', 'מס הזמנות', 'מספר הזמנות', 'חשבונות', 'מס חשבונות', 'מספר חשבונות', 'checks', 'tickets', 'עסקאות', 'מספר עסקאות'] },
      guests: { label: 'סועדים', syn: ['guests', 'covers', 'סועדים', 'מס סועדים', 'מספר סועדים', 'אורחים', 'pax'] },
      discount: { label: 'הנחות', syn: ['discount', 'discounts', 'הנחה', 'הנחות', 'סה"כ הנחות'] },
      tips: { label: 'טיפים', syn: ['tip', 'tips', 'טיפ', 'טיפים', 'תשר', 'שירות'] },
      channel: { label: 'ערוץ', syn: ['channel', 'type', 'order type', 'ערוץ', 'סוג', 'סוג הזמנה', 'סוג מכירה', 'משלוח/ישיבה'] },
      payment: { label: 'אמצעי תשלום', syn: ['payment', 'payment method', 'אמצעי תשלום', 'תשלום', 'סוג תשלום'] }
    }
  },
  items: {
    label: 'מכירות לפי פריט',
    fields: {
      date: { label: 'תאריך', required: true, syn: ['date', 'תאריך', 'יום', 'business date'] },
      item: { label: 'פריט', required: true, syn: ['item', 'product', 'name', 'פריט', 'מוצר', 'שם פריט', 'שם מוצר', 'מנה', 'product name', 'item name'] },
      category: { label: 'קטגוריה', syn: ['category', 'קטגוריה', 'מחלקה', 'קבוצה', 'group'] },
      qty: { label: 'כמות', syn: ['qty', 'quantity', 'כמות', 'יחידות', 'count', 'units', 'נמכרו'] },
      amount: { label: 'סכום', required: true, syn: ['amount', 'total', 'revenue', 'סכום', 'סה"כ', 'סהכ', 'סה״כ', 'מחזור', 'הכנסות', 'sales'] }
    }
  },
  cancellations: {
    label: 'ביטולים',
    fields: {
      date: { label: 'תאריך', required: true, syn: ['date', 'תאריך', 'יום', 'תאריך ביטול', 'business date'] },
      time: { label: 'שעה', syn: ['time', 'שעה', 'שעת ביטול'] },
      item: { label: 'פריט', syn: ['item', 'product', 'פריט', 'מוצר', 'שם פריט', 'מנה', 'name'] },
      qty: { label: 'כמות', syn: ['qty', 'quantity', 'כמות'] },
      amount: { label: 'סכום', required: true, syn: ['amount', 'total', 'סכום', 'סה"כ', 'סהכ', 'סה״כ', 'מחיר', 'price', 'value', 'שווי', 'סכום ביטול'] },
      employee: { label: 'עובד', syn: ['employee', 'waiter', 'user', 'עובד', 'מלצר', 'שם עובד', 'מבטל', 'בוטל ע"י', 'בוטל על ידי', 'cancelled by', 'server'] },
      reason: { label: 'סיבה', syn: ['reason', 'סיבה', 'סיבת ביטול', 'הערה', 'note', 'comment'] },
      approved_by: { label: 'אושר ע״י', syn: ['approved by', 'manager', 'אושר ע"י', 'אושר על ידי', 'מאשר', 'מנהל'] }
    }
  },
  shifts: {
    label: 'משמרות / שעות',
    fields: {
      date: { label: 'תאריך', required: true, syn: ['date', 'תאריך', 'יום', 'shift date', 'תאריך משמרת'] },
      employee: { label: 'עובד', required: true, syn: ['employee', 'name', 'עובד', 'שם', 'שם עובד', 'שם העובד', 'employee name', 'staff', 'worker'] },
      role: { label: 'תפקיד', syn: ['role', 'position', 'תפקיד', 'עמדה', 'מחלקה', 'job'] },
      start: { label: 'כניסה', syn: ['start', 'start time', 'clock in', 'in', 'כניסה', 'שעת כניסה', 'התחלה', 'שעת התחלה', 'מ'] },
      end: { label: 'יציאה', syn: ['end', 'end time', 'clock out', 'out', 'יציאה', 'שעת יציאה', 'סיום', 'שעת סיום', 'עד'] },
      hours: { label: 'שעות', syn: ['hours', 'total hours', 'duration', 'שעות', 'סה"כ שעות', 'סהכ שעות', 'סה״כ שעות', 'שעות עבודה', 'משך'] },
      hourly_rate: { label: 'שכר לשעה', syn: ['rate', 'hourly rate', 'wage', 'שכר לשעה', 'תעריף', 'תעריף שעתי', 'שכר שעתי'] },
      cost: { label: 'עלות', syn: ['cost', 'pay', 'total pay', 'wages', 'עלות', 'שכר', 'סה"כ שכר', 'עלות משמרת', 'סכום'] }
    }
  }
};

// ---------- parsing ----------
function normHeader(h) {
  return String(h ?? '')
    .replace(/[‎‏﻿]/g, '')
    .replace(/[״”“]/g, '"')
    .replace(/[׳’`]/g, "'")
    .replace(/[_\-.:()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function parseFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  let table;
  if (ext === '.xlsx' || ext === '.xlsm') table = await parseXlsx(buffer);
  else if (ext === '.csv' || ext === '.txt' || ext === '') table = parseCsv(buffer);
  else throw new Error(`סוג קובץ לא נתמך: ${ext}. יש להעלות CSV או XLSX`);
  return locateHeader(table);
}

function decodeText(buffer) {
  // Many Israeli systems export CSV in Windows-1255. Fall back to it when UTF-8 decoding fails.
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('windows-1255').decode(buffer); } catch { return utf8; }
}

function parseCsv(buffer) {
  const text = decodeText(buffer);
  const res = Papa.parse(text, { skipEmptyLines: 'greedy' });
  return res.data.map(r => r.map(c => (typeof c === 'string' ? c.trim() : c)));
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // pick the sheet with the most rows
  let best = null;
  wb.eachSheet(ws => { if (!best || ws.actualRowCount > best.actualRowCount) best = ws; });
  if (!best) return [];
  const rows = [];
  best.eachRow({ includeEmpty: false }, row => {
    const vals = [];
    for (let i = 1; i <= row.cellCount; i++) vals.push(cellValue(row.getCell(i).value));
    rows.push(vals);
  });
  return rows;
}

function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);           // formula
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if ('text' in v) return v.text;                          // hyperlink
    return String(v);
  }
  return v;
}

/** Reports often start with a few title lines. Find the row that looks most like a header. */
function locateHeader(table) {
  const allSyn = new Set();
  for (const k of Object.values(KINDS)) for (const f of Object.values(k.fields)) for (const s of f.syn) allSyn.add(normHeader(s));
  let bestIdx = 0, bestScore = -1;
  for (let i = 0; i < Math.min(table.length, 25); i++) {
    const score = table[i].filter(c => typeof c === 'string' && allSyn.has(normHeader(c))).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  const headers = (table[bestIdx] || []).map((h, i) => (String(h ?? '').trim() || `עמודה ${i + 1}`));
  const rows = table.slice(bestIdx + 1)
    .filter(r => r.some(c => c !== '' && c != null))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, rows };
}

// ---------- mapping ----------
function guessMapping(kind, headers) {
  const def = KINDS[kind];
  if (!def) throw new Error('סוג ייבוא לא מוכר');
  const mapping = {};
  const used = new Set();
  const normed = headers.map(normHeader);
  // pass 1: exact synonym match; pass 2: header contains synonym
  for (const pass of [1, 2]) {
    for (const [field, f] of Object.entries(def.fields)) {
      if (mapping[field]) continue;
      const syns = f.syn.map(normHeader);
      let idx = -1;
      // synonyms are ordered by preference, so look for them one at a time
      for (const s of syns) {
        idx = normed.findIndex((h, i) => !used.has(i) && (pass === 1 ? h === s : s.length >= 3 && h.includes(s)));
        if (idx >= 0) break;
      }
      if (idx >= 0) { mapping[field] = headers[idx]; used.add(idx); }
    }
  }
  return mapping;
}

function detectKind(headers) {
  let best = 'sales', bestScore = -1;
  for (const kind of Object.keys(KINDS)) {
    const m = guessMapping(kind, headers);
    const req = Object.entries(KINDS[kind].fields).filter(([, f]) => f.required).map(([k]) => k);
    const hasReq = req.every(r => m[r]);
    const score = Object.keys(m).length + (hasReq ? 10 : 0);
    if (score > bestScore) { bestScore = score; best = kind; }
  }
  return best;
}

// ---------- value coercion ----------
function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[₪$€\s‎‏]/g, '').replace(/ש"ח|שח|ils|nis/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/,/g, '');
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

const pad = n => String(n).padStart(2, '0');

function fromExcelSerial(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms);
}

/** Returns YYYY-MM-DD or null. Israeli format (DD/MM/YYYY) is assumed for ambiguous dates. */
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return toDate(fromExcelSerial(v));
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    let d = Number(m[1]), mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // clearly US format
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return toDate(Number(s));
  return null;
}

/** Returns HH:MM or null. */
function toTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number') {
    const frac = v % 1;
    const mins = Math.round(frac * 24 * 60);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${pad(m[1])}:${m[2]}` : null;
}

/** Hours as decimal. Accepts 7.5, "7.5", "7:30". */
function toHours(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1 && v > 0 && !Number.isInteger(v) && v * 24 < 24 ? round2(v * 24) : v; // excel duration fraction
  const s = String(v).trim();
  const m = s.match(/^(\d{1,3}):(\d{2})(?::\d{2})?$/);
  if (m) return round2(Number(m[1]) + Number(m[2]) / 60);
  return toNumber(s);
}

function hoursBetween(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // overnight shift
  return round2(mins / 60);
}

const round2 = n => Math.round(n * 100) / 100;
const str = v => (v == null ? null : (v instanceof Date ? toDate(v) : String(v).trim() || null));

// ---------- row normalisation ----------
function normalizeRows(kind, rows, mapping) {
  const def = KINDS[kind];
  const get = (row, field) => (mapping[field] ? row[mapping[field]] : undefined);
  const out = [];
  const errors = [];
  let lastDate = null;

  rows.forEach((row, i) => {
    // Date: some reports only print the date once per group - carry it forward.
    let date = toDate(get(row, 'date'));
    const rawDate = get(row, 'date');
    if (!date && (rawDate === '' || rawDate == null) && lastDate) date = lastDate;
    if (date) lastDate = date;

    // skip total / summary lines
    const joined = Object.values(row).map(v => String(v)).join(' ');
    if (/סה"כ כללי|סה״כ כללי|grand total|^\s*total\s*$/i.test(joined) && !date) return;

    if (!date) { errors.push({ line: i + 1, error: 'תאריך חסר או לא תקין' }); return; }

    if (kind === 'sales') {
      const amount = toNumber(get(row, 'amount'));
      if (amount == null) { errors.push({ line: i + 1, error: 'סכום חסר' }); return; }
      const dateTime = (rawDate instanceof Date && (rawDate.getUTCHours() || rawDate.getUTCMinutes())) || typeof rawDate === 'string' ? rawDate : null;
      const time = toTime(get(row, 'time')) || toTime(dateTime);
      out.push({
        date,
        hour: time ? Number(time.slice(0, 2)) : null,
        amount,
        orders: mapping.orders ? Math.round(toNumber(get(row, 'orders')) ?? 0) : 1,
        guests: mapping.guests ? Math.round(toNumber(get(row, 'guests')) ?? 0) : null,
        discount: toNumber(get(row, 'discount')) ?? 0,
        tips: toNumber(get(row, 'tips')) ?? 0,
        channel: str(get(row, 'channel')),
        payment: str(get(row, 'payment'))
      });
    } else if (kind === 'items') {
      const item = str(get(row, 'item'));
      const amount = toNumber(get(row, 'amount'));
      if (!item || amount == null) { errors.push({ line: i + 1, error: 'פריט או סכום חסר' }); return; }
      out.push({ date, item, category: str(get(row, 'category')), qty: toNumber(get(row, 'qty')) ?? 0, amount });
    } else if (kind === 'cancellations') {
      const amount = toNumber(get(row, 'amount'));
      if (amount == null) { errors.push({ line: i + 1, error: 'סכום חסר' }); return; }
      out.push({
        date,
        time: toTime(get(row, 'time')),
        item: str(get(row, 'item')),
        qty: toNumber(get(row, 'qty')) ?? 1,
        amount: Math.abs(amount),
        employee: str(get(row, 'employee')),
        reason: str(get(row, 'reason')),
        approved_by: str(get(row, 'approved_by'))
      });
    } else if (kind === 'shifts') {
      const employee = str(get(row, 'employee'));
      if (!employee) { errors.push({ line: i + 1, error: 'שם עובד חסר' }); return; }
      const start = toTime(get(row, 'start'));
      const end = toTime(get(row, 'end'));
      const hours = toHours(get(row, 'hours')) ?? hoursBetween(start, end);
      if (hours == null) { errors.push({ line: i + 1, error: 'אין שעות או שעת כניסה/יציאה' }); return; }
      out.push({
        date, employee, role: str(get(row, 'role')), start, end, hours,
        hourly_rate: toNumber(get(row, 'hourly_rate')),
        cost: toNumber(get(row, 'cost'))
      });
    }
  });

  const missing = Object.entries(def.fields).filter(([k, f]) => f.required && !mapping[k]).map(([k, f]) => f.label);
  return { rows: out, errors, missing };
}

// ---------- commit ----------
const COLUMNS = {
  sales: ['date', 'hour', 'amount', 'orders', 'guests', 'discount', 'tips', 'channel', 'payment'],
  items: ['date', 'item', 'category', 'qty', 'amount'],
  cancellations: ['date', 'time', 'item', 'qty', 'amount', 'employee', 'reason', 'approved_by'],
  shifts: ['date', 'employee', 'role', 'start', 'end', 'hours', 'hourly_rate', 'cost']
};

// values for NOT NULL columns when a row leaves them out (e.g. manual entry)
const DEFAULTS = {
  sales: { amount: 0, orders: 1, discount: 0, tips: 0 },
  items: { qty: 0, amount: 0 },
  cancellations: { qty: 1, amount: 0 },
  shifts: { hours: 0 }
};

/**
 * Writes normalised rows. With replace=true (default) existing rows of the same kind+source
 * inside the file's date range are removed first, so re-uploading a week never double counts.
 */
function commitImport(db, { kind, source, filename, rows, replace = true }) {
  if (!COLUMNS[kind]) throw new Error('סוג ייבוא לא מוכר');
  if (!rows.length) throw new Error('אין שורות תקינות לייבוא');
  const dates = rows.map(r => r.date).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const cols = COLUMNS[kind];

  const tx = db.transaction(() => {
    let removed = 0;
    if (replace) {
      removed = db.prepare(`DELETE FROM ${kind} WHERE source = ? AND date BETWEEN ? AND ?`).run(source, from, to).changes;
    }
    const imp = db.prepare('INSERT INTO imports(kind, source, filename, date_from, date_to, rows) VALUES (?,?,?,?,?,?)')
      .run(kind, source, filename || null, from, to, rows.length);
    const importId = imp.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO ${kind}(import_id, source, ${cols.join(',')}) VALUES (?, ?, ${cols.map(() => '?').join(',')})`);
    const defaults = DEFAULTS[kind] || {};
    for (const r of rows) ins.run(importId, source, ...cols.map(c => r[c] ?? defaults[c] ?? null));

    if (kind === 'shifts') {
      const addEmp = db.prepare('INSERT OR IGNORE INTO employees(name, role, hourly_rate) VALUES (?, ?, ?)');
      for (const r of rows) addEmp.run(r.employee, r.role, r.hourly_rate ?? 0);
    }
    return { importId: Number(importId), inserted: rows.length, removed, from, to };
  });
  return tx();
}

module.exports = {
  KINDS, parseFile, guessMapping, detectKind, normalizeRows, commitImport,
  toDate, toTime, toHours, toNumber, hoursBetween, normHeader, locateHeader
};
