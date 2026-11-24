'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { openDb } = require('../server/db');
const formats = require('../server/formats');
const reports = require('../server/reports');

// Text cells the way Beecomm writes them: a formula with no cached value
const cc = s => ({ formula: `CONCATENATE(" ", "${s}", " ")` });
const d = (y, m, day, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, day, h, min));

async function beecommWorkbook({ generated = '24/11/2026 22:33', range = '28/11/2026 - 22/11/2026' } = {}) {
  const wb = new ExcelJS.Workbook();
  const head = ws => {
    for (let i = 0; i < 4; i++) ws.addRow([]);
    ws.addRow(['כותרת']);
    ws.addRow([`הופק : ${generated}`]);
    ws.addRow([`טווח תאריכים לדוח : ${range}`]);
    ws.addRow(['סניף : בדיקה']);
    ws.addRow([]);
  };
  const t = wb.addWorksheet('דוח סוגי הזמנות'); head(t);
  t.addRow(['סוג הזמנה', 'מספר הזמנות', 'סה״כ הכנסות', 'ממוצע להזמנה', 'מספר ביטולים', 'סה״כ ביטולים', 'סועדים', 'סה״כ שירות', 'סה״כ הנחות', 'סה״כ ביטולי פריטים', 'סה״כ']);
  t.addRow([cc('סה״כ הכנסות'), 100, 20000, 0, 0, 0, 400, 2600, 3000, 100, 20000]);
  t.addRow([cc('מסעדה'), 92, 20004, 217, 0, 0, 400, 2400, 3000, 100, 20004]);
  t.addRow([cc('תנועה כספית מהירה'), 8, -4, 0, 0, 0, 0, 200, 0, 0, -4]);
  t.addRow(['שירות מסעדה: 2400']);
  const it = wb.addWorksheet('דוח פריטים לפי מרכזי רווח'); head(it);
  it.addRow(['שם הפריט', 'מרכז רווח', 'קטלוג רמה 1', 'קטלוג רמה 2', 'קטלוג רמה 3', 'קטלוג רמה 4', 'פריט קומבו', 'יחידות שנמכרו בעסקית', 'סה״כ יחידות שנמכרו', 'סה״כ הכנסות', 'יחידות שבוטלו', 'סה״כ ביטולים', 'סה״כ הנחות']);
  it.addRow([cc('המבורגר'), cc('ללא'), cc('אוכל'), cc('עיקריות'), cc(''), cc(''), cc('לא'), 0, 40, 2800, 2, 140, 0]);
  it.addRow([cc('בירה'), cc('ללא'), cc('שתיה'), cc('בירות'), cc(''), cc(''), cc('לא'), 0, 60, 1800, 0, 0, 0]);
  const c = wb.addWorksheet('לקוחות הקפה - יתרות'); head(c);
  c.addRow(['שם הלקוח', 'יום הולדת', 'תנועות לתקופה', 'סה״כ לתקופה']);
  c.addRow(['לקוח', '-', 0, 0]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function shiftWorkbook() {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, rows, split = false) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(['העסק']);
    ws.addRow(['דוח מפורט']);
    ws.addRow([`שם עובד: ${name}\nבין התאריכים: 22/11/2026 - 28/11/2026`, '', '', 'ימי עבודה: 1']);
    ws.addRow([]);
    ws.addRow(split
      ? ['יום', 'תאריך', 'תפקיד', 'כניסה', 'יציאה', 'הערות', 'תפקיד', 'כניסה', 'יציאה', 'הערות', 'סיכום', 'עלות', 'טיפ מזומן', 'טיפ אשראי', 'סה"כ טיפ', 'השלמה']
      : ['יום', 'תאריך', 'תפקיד', 'כניסה', 'יציאה', 'הערות', 'סיכום', 'עלות', 'טיפ מזומן', 'טיפ אשראי', 'סה"כ טיפ', 'השלמה']);
    for (const r of rows) ws.addRow(r);
    ws.addRow(['סיכום כללי', 'סיכום כללי', '', '', '', '', 1]);
  };
  sheet('מנהלת', [
    ["א'", d(2026, 11, 22), 'מנהל', d(2026, 11, 22, 16), d(2026, 11, 23, 2), '', 10, 400],
    ["ב'", d(2026, 11, 23), 'מנהל', d(2026, 11, 23, 17, 30), null, '', null, null]            // still open
  ]);
  sheet('מלצרית', [
    ["א'", d(2026, 11, 22), 'מלצר', d(2026, 11, 22, 18), d(2026, 11, 22, 23), '', 5, null, 100, 150, 250, 20],
    ["ג'", d(2026, 11, 24), 'מלצר', null, null, '', null]                                        // planned, not worked
  ]);
  sheet('טבח', [
    ["א'", d(2026, 11, 22), 'אירוע', d(2026, 11, 22, 12), d(2026, 11, 22, 14), '', 'מטבח', d(2026, 11, 22, 17), d(2026, 11, 22, 23), '', 8, 320]
  ], true);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('Beecomm workbook: weekly totals, items and per-item cancellations', async () => {
  const r = await formats.detectFormat(await beecommWorkbook(), 'week.xlsx');
  assert.equal(r.format, 'beecomm');
  assert.deepEqual(r.range, { from: '2026-11-22', to: '2026-11-28' });
  assert.equal(r.day, '2026-11-24');                       // stored on the generated date, not the future end of range
  const [sales, items, canc] = r.parts;
  assert.deepEqual(sales.rows.map(x => [x.channel, x.amount, x.orders, x.tips]), [['מסעדה', 20004, 92, 2400], ['תנועה כספית מהירה', -4, 8, 200]]);
  assert.deepEqual(items.rows.map(x => [x.item, x.qty, x.amount, x.category]), [['המבורגר', 40, 2800, 'אוכל / עיקריות'], ['בירה', 60, 1800, 'שתיה / בירות']]);
  assert.deepEqual(canc.rows.map(x => [x.item, x.qty, x.amount]), [['המבורגר', 2, 140]]);

  // importing the same week again (later, full week) replaces instead of adding
  const db = openDb(':memory:');
  formats.commitFormat(db, r, { filename: 'a.xlsx' });
  const later = await formats.detectFormat(await beecommWorkbook({ generated: '29/11/2026 01:00' }), 'b.xlsx');
  assert.equal(later.day, '2026-11-28');
  formats.commitFormat(db, later, { filename: 'b.xlsx' });
  assert.equal(db.prepare('SELECT SUM(amount) t FROM sales').get().t, 20000);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT date) c FROM sales').get().c, 1);
});

test('ShiftOrganizer detailed report: per-employee sheets, split and open shifts, app cost and tips', async () => {
  const r = await formats.detectFormat(await shiftWorkbook(), 'detailed_report.xlsx');
  assert.equal(r.format, 'shiftorganizer');
  const rows = r.parts[0].rows;
  assert.deepEqual(rows.map(x => [x.employee, x.role, x.start, x.end, x.hours, x.cost]), [
    ['מנהלת', 'מנהל', '16:00', '02:00', 10, 400],
    ['מלצרית', 'מלצר', '18:00', '23:00', 5, null],
    ['טבח', 'אירוע', '12:00', '14:00', 2, 80],             // split shift: day cost shared by hours (2h / 8h)
    ['טבח', 'מטבח', '17:00', '23:00', 6, 240]
  ]);
  assert.equal(rows[1].tips, 250);
  assert.ok(r.notes.some(n => /משמרות פתוחות/.test(n)));

  const db = openDb(':memory:');
  formats.commitFormat(db, r, { filename: 'x.xlsx' });
  const day = reports.summary(db, '2026-11-22', '2026-11-22').days[0];
  // business cost = app costs (400 + 320) + the app's minimum-wage top-up for the waitress (20)
  assert.equal(day.labor_cost, 740);
  assert.equal(day.tip_hours, 5);
  assert.deepEqual([day.tips, day.tips_per_hour, day.tips_per_hour_source], [250, 50, 'shift_app']);
});

test('weekly totals: days in the period get the weekly tips per hour, no fake daily sales gaps', async () => {
  const db = openDb(':memory:');
  formats.commitFormat(db, await formats.detectFormat(await shiftWorkbook(), 's.xlsx'), {});
  // drop the shift-app tips so the weekly service total is the only tips source
  db.prepare('UPDATE shifts SET tips = NULL, topup = NULL').run();
  formats.commitFormat(db, await formats.detectFormat(await beecommWorkbook(), 'b.xlsx'), {});
  const s = reports.summary(db, '2026-11-22', '2026-11-28');
  const d22 = s.days.find(d => d.date === '2026-11-22');
  assert.equal(d22.tips_per_hour, 2600 / 5);               // weekly service ÷ weekly waiter hours (5h)
  assert.equal(d22.tips_per_hour_source, 'calculated_period');
  assert.deepEqual(d22.sales_period, { from: '2026-11-22', to: '2026-11-24' });
  assert.equal(d22.labor_pct, null);
  assert.equal(s.totals.sales, 20000);
  assert.ok(!s.alerts.some(a => /אין מכירות/.test(a.text)));
});
