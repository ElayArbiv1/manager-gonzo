'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const imp = require('../server/importers');
const inv = require('../server/inventory');

function setup() {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'vat_percent'").run();
  inv.setRecipe(db, 'המבורגר', [{ product: 'לחמנייה', qty: 1 }, { product: 'בשר', qty: 0.2 }]);
  db.prepare("UPDATE inv_products SET unit_cost = 2 WHERE name = 'לחמנייה'").run();
  db.prepare("UPDATE inv_products SET unit_cost = 60, unit = 'ק״ג' WHERE name = 'בשר'").run();
  return db;
}

test('usage and waste between two counts', () => {
  const db = setup();
  // Saturday 14/11 count → Monday 16/11 delivery → sales during the week → Saturday 21/11 count
  inv.saveCount(db, { date: '2026-11-14', lines: [{ product: 'לחמנייה', qty: 20 }, { product: 'בשר', qty: 5 }, { product: 'קולה', qty: 10 }] });
  inv.saveDelivery(db, { date: '2026-11-16', supplier: 'ספק', lines: [{ product: 'לחמנייה', qty: 100, unit_cost: 2.5 }, { product: 'בשר', qty: 20 }] });
  imp.commitImport(db, { kind: 'items', source: 'beecomm', rows: [
    { date: '2026-11-14', item: 'המבורגר', qty: 999, amount: 1 },   // before the period: excluded
    { date: '2026-11-17', item: 'המבורגר', qty: 50, amount: 3000 },
    { date: '2026-11-21', item: 'המבורגר', qty: 30, amount: 1800 },  // Saturday itself: included
    { date: '2026-11-20', item: 'קולה', qty: 6, amount: 72 }
  ] });
  imp.commitImport(db, { kind: 'sales', source: 'beecomm', rows: [{ date: '2026-11-18', amount: 4872 }] });
  inv.saveCount(db, { date: '2026-11-21', lines: [{ product: 'לחמנייה', qty: 35 }, { product: 'בשר', qty: 7 }, { product: 'קולה', qty: 4 }] });

  const r = inv.usageReport(db);
  assert.equal(r.status, 'ok');
  assert.deepEqual([r.opening.date, r.closing.date], ['2026-11-14', '2026-11-21']);
  const row = name => r.rows.find(x => x.product === name);

  // buns: 20 + 100 - 35 = 85 used, 80 sold → 5 waste; latest delivery cost 2.5 applied
  assert.deepEqual([row('לחמנייה').used, row('לחמנייה').sold, row('לחמנייה').waste], [85, 80, 5]);
  assert.equal(row('לחמנייה').waste_cost, 12.5);
  // meat: 5 + 20 - 7 = 18 used, 80 × 0.2 = 16 sold → 2 kg waste
  assert.deepEqual([row('בשר').used, row('בשר').sold, row('בשר').waste], [18, 16, 2]);
  assert.equal(row('בשר').waste_cost, 120);
  // cola has no recipe: usage known, sold unknown, and the menu item is listed
  assert.equal(row('קולה').used, 6);
  assert.equal(row('קולה').sold, null);
  assert.ok(row('קולה').no_recipe);
  assert.deepEqual(r.itemsWithoutRecipe.map(x => x.item), ['קולה']);
  assert.equal(r.totals.waste_cost, 132.5);
  assert.equal(inv.periods(db).length, 1);
});

test('one count per date: saving again replaces it', () => {
  const db = setup();
  inv.saveCount(db, { date: '2026-11-21', lines: [{ product: 'לחמנייה', qty: 10 }] });
  const r = inv.saveCount(db, { date: '2026-11-21', lines: [{ product: 'לחמנייה', qty: 12 }, { product: 'בשר', qty: '' }] });
  assert.ok(r.replaced);
  const c = inv.getCount(db, r.id);
  assert.deepEqual(c.lines.map(l => [l.product, l.qty]), [['לחמנייה', 12]]);   // empty qty = not counted
  assert.equal(inv.usageReport(db).status, 'need-two-counts');
});

test('supplier invoice file is parsed into lines', async () => {
  const db = setup();
  const csv = 'חשבונית 123\n\nתיאור פריט,כמות,יחידה,מחיר ליחידה\nלחמנייה,120,יח׳,2.4\nאבוקדו,5,ק"ג,18\nסה"כ,,,358\n';
  const r = await inv.parseLinesFile(db, Buffer.from(csv), 'inv.csv');
  assert.deepEqual(r.lines.map(l => [l.product, l.qty, l.unit_cost, l.is_new]), [['לחמנייה', 120, 2.4, false], ['אבוקדו', 5, 18, true]]);
});
