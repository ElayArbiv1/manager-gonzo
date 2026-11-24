'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { openDb } = require('../server/db');
const imp = require('../server/importers');
const reports = require('../server/reports');

test('value parsing', () => {
  assert.equal(imp.toDate('05/11/2026'), '2026-11-05');       // Israeli DD/MM
  assert.equal(imp.toDate('2026-11-05 13:45'), '2026-11-05');
  assert.equal(imp.toDate(46331), '2026-11-05');              // Excel serial
  assert.equal(imp.toDate('11/25/2026'), '2026-11-25');       // obvious US date
  assert.equal(imp.toNumber('₪1,234.50'), 1234.5);
  assert.equal(imp.toNumber('(50)'), -50);
  assert.equal(imp.toHours('7:30'), 7.5);
  assert.equal(imp.hoursBetween('18:00', '02:30'), 8.5);      // overnight
  assert.equal(imp.toTime('2026-11-05 09:05'), '09:05');
});

test('Hebrew report with title lines: header detected and mapped', async () => {
  const csv = '﻿דוח מכירות יומי\nמתאריך 01/11/2026\n\nתאריך,יום,מספר חשבונות,סה"כ הנחות,סה"כ כולל מע"מ\n01/11/2026,ראשון,80,100,"9,500"\n02/11/2026,שני,60,50,7000\nסה"כ כללי,,140,150,16500\n';
  const parsed = await imp.parseFile(Buffer.from(csv), 'z.csv');
  assert.equal(imp.detectKind(parsed.headers), 'sales');
  const m = imp.guessMapping('sales', parsed.headers);
  assert.equal(m.date, 'תאריך');
  assert.equal(m.amount, 'סה"כ כולל מע"מ');
  assert.equal(m.orders, 'מספר חשבונות');
  assert.equal(m.discount, 'סה"כ הנחות');
  const n = imp.normalizeRows('sales', parsed.rows, m);
  assert.equal(n.rows.length, 2);              // total line skipped
  assert.equal(n.rows[0].amount, 9500);
  assert.equal(n.rows[0].orders, 80);
});

test('shift import computes hours, cost and labor %', async () => {
  const db = openDb(':memory:');
  const shiftsCsv = 'שם העובד,תפקיד,תאריך,שעת כניסה,שעת יציאה\nדנה,מלצרית,01/11/2026,18:00,02:00\nאבי,טבח,01/11/2026,10:00,18:00\n';
  const p = await imp.parseFile(Buffer.from(shiftsCsv), 's.csv');
  assert.equal(imp.detectKind(p.headers), 'shifts');
  const n = imp.normalizeRows('shifts', p.rows, imp.guessMapping('shifts', p.headers));
  imp.commitImport(db, { kind: 'shifts', source: 'shift', rows: n.rows });
  db.prepare("UPDATE employees SET hourly_rate = 40").run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'employer_cost_factor'").run();
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'vat_percent'").run();
  imp.commitImport(db, { kind: 'sales', source: 'beecomm', rows: [{ date: '2026-11-01', amount: 2000, orders: 20 }] });

  const s = reports.summary(db, '2026-11-01', '2026-11-01');
  assert.equal(s.totals.labor_hours, 16);
  // the waitress is paid from tips → only the cook (8h × 40) is a business cost
  assert.equal(s.totals.labor_cost, 320);
  assert.equal(s.totals.tip_hours, 8);
  assert.equal(s.totals.labor_pct, 16);
  assert.equal(s.totals.avg_ticket, 100);
});

test('role rates, tip-funded roles and the shift app "שעתי"', async () => {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'employer_cost_factor'").run();
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'vat_percent'").run();
  const csv = 'שם העובד,תפקיד,תאריך,סה"כ שעות\nדנה,מלצרית,01/11/2026,6\nיוסי,ברמן,01/11/2026,4\nרוני,מנהל משמרת,01/11/2026,9\nאבי,טבח,01/11/2026,8\n';
  const p = await imp.parseFile(Buffer.from(csv), 's.csv');
  imp.commitImport(db, { kind: 'shifts', source: 'shift', rows: imp.normalizeRows('shifts', p.rows, imp.guessMapping('shifts', p.headers)).rows });

  const roles = Object.fromEntries(db.prepare('SELECT name, pay_type FROM roles').all().map(r => [r.name, r.pay_type]));
  assert.deepEqual(roles, { 'מלצרית': 'tips', 'ברמן': 'tips', 'מנהל משמרת': 'shift', 'טבח': 'shift' });

  // no rates yet → roles reported as missing, cost 0
  let l = reports.labor(db, '2026-11-01', '2026-11-01');
  assert.deepEqual(l.missingRates.sort(), ['טבח', 'מנהל משמרת']);

  db.prepare("UPDATE roles SET rate = 500 WHERE name = 'מנהל משמרת'").run();                      // per shift
  db.prepare("UPDATE roles SET pay_type = 'hourly', rate = 60 WHERE name = 'טבח'").run();          // per hour
  imp.commitImport(db, { kind: 'sales', source: 'beecomm', rows: [{ date: '2026-11-01', amount: 5000, tips: 400 }] });
  let d = reports.summary(db, '2026-11-01', '2026-11-01').days[0];
  assert.equal(d.labor_cost, 500 + 8 * 60);
  assert.equal(d.tip_hours, 10);
  assert.equal(d.tips_per_hour, 40);                       // fallback: 400 tips / 10 hours
  assert.equal(d.tips_per_hour_source, 'calculated');

  // ShiftOrganizer's own "שעתי" wins over the calculation
  const t = await imp.parseFile(Buffer.from('תאריך,שעתי,סה"כ טיפים\n01/11/2026,52.5,525\n'), 'tips.csv');
  assert.equal(imp.detectKind(t.headers), 'tips_daily');
  imp.commitImport(db, { kind: 'tips_daily', source: 'shift', rows: imp.normalizeRows('tips_daily', t.rows, imp.guessMapping('tips_daily', t.headers)).rows });
  d = reports.summary(db, '2026-11-01', '2026-11-01').days[0];
  assert.deepEqual([d.tips_per_hour, d.tips, d.tips_per_hour_source], [52.5, 525, 'shift_app']);

  // below minimum wage → the business tops up the difference
  db.prepare("UPDATE settings SET value = '60' WHERE key = 'min_hourly_wage'").run();
  d = reports.summary(db, '2026-11-01', '2026-11-01').days[0];
  assert.equal(d.tip_topup, (60 - 52.5) * 10);
  assert.equal(d.labor_cost, 980 + 75);
});

test('re-importing the same range replaces instead of duplicating', () => {
  const db = openDb(':memory:');
  const rows = [{ date: '2026-11-01', amount: 100 }, { date: '2026-11-02', amount: 200 }];
  imp.commitImport(db, { kind: 'sales', source: 'website', rows });
  imp.commitImport(db, { kind: 'sales', source: 'website', rows });
  imp.commitImport(db, { kind: 'sales', source: 'beecomm', rows: [{ date: '2026-11-01', amount: 50 }] });
  const total = db.prepare('SELECT SUM(amount) t FROM sales').get().t;
  assert.equal(total, 350);
});

test('xlsx files are parsed', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ביטולים');
  ws.addRow(['תאריך', 'שם פריט', 'סכום', 'בוטל ע"י', 'סיבת ביטול']);
  ws.addRow([new Date(Date.UTC(2026, 10, 3)), 'המבורגר', -68, 'יוסי', 'טעות']);
  const buf = await wb.xlsx.writeBuffer();
  const p = await imp.parseFile(Buffer.from(buf), 'c.xlsx');
  assert.equal(imp.detectKind(p.headers), 'cancellations');
  const n = imp.normalizeRows('cancellations', p.rows, imp.guessMapping('cancellations', p.headers));
  assert.deepEqual([n.rows[0].date, n.rows[0].amount, n.rows[0].employee], ['2026-11-03', 68, 'יוסי']);
});
