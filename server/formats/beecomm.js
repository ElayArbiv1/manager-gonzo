'use strict';
/**
 * Beecomm back-office Excel export (several report sheets in one workbook):
 *   "דוח סוגי הזמנות"            → sales per order type: orders, revenue, diners, service (tips), discounts
 *   "מרכזי רווח"                 → fallback for totals
 *   "דוח פריטים לפי מרכזי רווח"  → sales by item + cancelled units / amount per item
 * Other sheets (e.g. house-account customers) are ignored.
 *
 * The workbook covers a date range ("טווח תאריכים לדוח") with totals only, no per-day split.
 * Totals are stored on one day (the last day of the range that already happened) and the
 * whole range is replaced on re-import, so exporting the same week again never double counts.
 */
const { sheetRows, findHeader, parseRange, findMeta, text, num } = require('./sheet');
const { toDate } = require('../importers');

const SHEETS = { types: 'דוח סוגי הזמנות', centers: 'מרכזי רווח', items: 'דוח פריטים לפי מרכזי רווח' };

function detect(wb) {
  const names = wb.worksheets.map(w => w.name.trim());
  return names.includes(SHEETS.types) || names.includes(SHEETS.items) || (names.includes(SHEETS.centers) && names.some(n => n.startsWith('דוח')));
}

function parse(wb) {
  const sheet = name => wb.worksheets.find(w => w.name.trim() === name);
  const anySheet = sheet(SHEETS.types) || sheet(SHEETS.items) || sheet(SHEETS.centers);
  const metaRows = sheetRows(anySheet);
  const range = parseRange(findMeta(metaRows, 'טווח תאריכים לדוח') || '');
  if (!range) throw new Error('לא נמצא טווח התאריכים של הדוח (טווח תאריכים לדוח)');
  const generatedRaw = findMeta(metaRows, 'הופק');
  const generated = generatedRaw ? toDate(generatedRaw) : null;
  // the day the totals are stored on: end of the range, but not in the future
  const day = generated && generated < range.to ? (generated < range.from ? range.from : generated) : range.to;
  const branch = findMeta(metaRows, 'סניף');
  const parts = [];
  const notes = [];

  // ---- sales by order type ----
  const typesWs = sheet(SHEETS.types);
  let salesRows = [];
  if (typesWs) {
    const rows = sheetRows(typesWs);
    const h = findHeader(rows, ['סוג הזמנה', 'מספר הזמנות']);
    if (h) {
      const c = { type: h.col('סוג הזמנה'), orders: h.col('מספר הזמנות'), amount: h.col('סה"כ הכנסות'), guests: h.col('סועדים'),
        tips: h.col('סה"כ שירות'), discount: h.col('סה"כ הנחות') };
      for (const r of rows.slice(h.index + 1)) {
        const type = text(r.vals[c.type]);
        if (!type || /^סה["״]?כ/.test(type) || /:/.test(type)) continue;   // total row / footnotes
        const amount = num(r.vals[c.amount]);
        if (amount == null) continue;
        salesRows.push({
          date: day, amount, orders: Math.round(num(r.vals[c.orders]) || 0), guests: Math.round(num(r.vals[c.guests]) || 0),
          tips: num(r.vals[c.tips]) || 0, discount: num(r.vals[c.discount]) || 0, channel: type
        });
      }
    }
  }
  if (!salesRows.length && sheet(SHEETS.centers)) {
    const rows = sheetRows(sheet(SHEETS.centers));
    const h = findHeader(rows, ['מרכז רווח', 'סה"כ הכנסה']);
    if (h) {
      for (const r of rows.slice(h.index + 1)) {
        const amount = num(r.vals[h.col('סה"כ הכנסה')]);
        if (amount == null || !text(r.vals[h.col('מרכז רווח')])) continue;
        salesRows.push({ date: day, amount, orders: Math.round(num(r.vals[h.col('מספר הזמנות')]) || 0),
          guests: Math.round(num(r.vals[h.col('סועדים')]) || 0), tips: num(r.vals[h.col('שירות')]) || 0, channel: text(r.vals[h.col('מרכז רווח')]) });
      }
    }
  }
  // totals for several days: remember the first day, so daily views can tell these apart from a single day's sales
  if (range.from !== day) salesRows = salesRows.map(r => ({ ...r, period_from: range.from }));
  if (salesRows.length) parts.push({ kind: 'sales', rows: salesRows });

  // ---- items + per-item cancellations ----
  const itemsWs = sheet(SHEETS.items);
  if (itemsWs) {
    const rows = sheetRows(itemsWs);
    const h = findHeader(rows, ['שם הפריט', 'סה"כ יחידות שנמכרו']);
    if (h) {
      const c = { item: h.col('שם הפריט'), l1: h.col('קטלוג רמה 1'), l2: h.col('קטלוג רמה 2'), qty: h.col('סה"כ יחידות שנמכרו'),
        amount: h.col('סה"כ הכנסות'), cQty: h.col('יחידות שבוטלו'), cAmount: h.col('סה"כ ביטולים'), discount: h.col('סה"כ הנחות') };
      const items = [], canc = [];
      for (const r of rows.slice(h.index + 1)) {
        const item = text(r.vals[c.item]);
        if (!item || /^סה["״]?כ/.test(item)) continue;
        const qty = num(r.vals[c.qty]) || 0, amount = num(r.vals[c.amount]) || 0;
        const category = [text(r.vals[c.l1]), text(r.vals[c.l2])].filter(Boolean).join(' / ') || null;
        if (qty || amount) items.push({ date: day, item, category, qty, amount });
        const cq = c.cQty >= 0 ? num(r.vals[c.cQty]) || 0 : 0, ca = c.cAmount >= 0 ? num(r.vals[c.cAmount]) || 0 : 0;
        if (cq || ca) canc.push({ date: day, item, qty: cq || 1, amount: Math.abs(ca), reason: 'מסיכום פריטים (ללא פירוט עובד/סיבה)' });
      }
      if (items.length) parts.push({ kind: 'items', rows: items });
      parts.push({ kind: 'cancellations', rows: canc });   // even if empty: clears the range
      if (!canc.length) notes.push('לא היו ביטולי פריטים בדוח');
    }
  }
  if (!parts.length) throw new Error('לא נמצאו בדוח גיליונות מוכרים של ביקום');

  const weekly = range.from !== range.to;
  if (weekly) notes.push(`הדוח מסכם את ${range.from.split('-').reverse().join('/')} עד ${range.to.split('-').reverse().join('/')} בלי פירוט יומי, ולכן הנתונים נשמרים כסיכום על ${day.split('-').reverse().join('/')}. לפירוט יומי, ייצאו מביקום דוח לכל יום בנפרד`);

  return {
    format: 'beecomm', label: 'דוח ביקום', source: 'beecomm', range, day, branch,
    parts: parts.map(p => ({ ...p, range })),
    notes
  };
}

module.exports = { id: 'beecomm', detect, parse };
