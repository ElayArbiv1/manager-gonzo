'use strict';
/** Loads the sample-data files + employee rates into the database (demo mode). */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { openDb } = require('../server/db');

const dir = path.join(__dirname, '..', 'sample-data');
execFileSync(process.execPath, [path.join(__dirname, 'make-sample-data.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
const run = (file, source) => execFileSync(process.execPath, [path.join(__dirname, 'import.js'), path.join(dir, file), '--source', source], { stdio: 'inherit' });
run('shifts.csv', 'shift');
run('beecomm-sales.csv', 'beecomm');
run('website-orders.csv', 'website');
run('beecomm-items.csv', 'beecomm');
run('beecomm-cancellations.csv', 'beecomm');

const db = openDb();
const up = db.prepare('UPDATE employees SET role = ? WHERE name = ?');
for (const e of JSON.parse(fs.readFileSync(path.join(dir, 'employees-rates.json'), 'utf8'))) up.run(e.role, e.name);
// demo role costs (made-up numbers): waiters / bartenders are paid from tips automatically
const role = db.prepare('UPDATE roles SET pay_type = ?, rate = ? WHERE name = ?');
role.run('shift', 480, 'אחראי/ת משמרת');
role.run('hourly', 62, 'טבח/ית');
role.run('hourly', 45, 'שוטף/ת');
seedInventory(db);
console.log('נתוני הדמו נטענו.');

/** Demo inventory: products, recipes, Saturday counts and Monday deliveries derived from the item sales. */
function seedInventory(db) {
  const inv = require('../server/inventory');
  if (db.prepare('SELECT COUNT(*) c FROM inv_counts').get().c) return;
  // name, unit, category, supplier, cost, extra waste factor
  const P = [
    ['לחמניית המבורגר', 'יח׳', 'מאפים', 'מאפיית השכונה', 2.2, 0.05],
    ['בשר טחון', 'ק״ג', 'בשר ודגים', 'אטליז כהן', 62, 0.10],
    ['צ׳דר', 'ק״ג', 'מוצרי חלב', 'תנובה', 58, 0.04],
    ['חסה', 'ק״ג', 'ירקות', 'ירקות הגליל', 9, 0.22],
    ['עגבניות', 'ק״ג', 'ירקות', 'ירקות הגליל', 7, 0.12],
    ['תפוחי אדמה קפואים', 'ק״ג', 'קפואים', 'סנפרוסט', 11, 0.03],
    ['שמן טיגון', 'ליטר', 'יבשים', 'סיטונאות דרום', 8.5, 0.06],
    ['חזה עוף', 'ק״ג', 'בשר ודגים', 'אטליז כהן', 38, 0.06],
    ['פרמזן', 'ק״ג', 'מוצרי חלב', 'תנובה', 110, 0.03],
    ['פירורי לחם', 'ק״ג', 'יבשים', 'סיטונאות דרום', 12, 0.05],
    ['פילה דג', 'ק״ג', 'בשר ודגים', 'דגי הים', 54, 0.07],
    ['בירה מהחבית', 'ליטר', 'משקאות', 'טמפו', 14, 0.14],
    ['קוקה קולה', 'בקבוק', 'משקאות', 'החברה המרכזית', 3.1, 0.01],
    ['עוגת שוקולד', 'יח׳', 'קינוחים', 'קונדיטוריה', 95, 0.08],
    ['כנפיים', 'ק״ג', 'בשר ודגים', 'אטליז כהן', 24, 0.05],
    ['בצל', 'ק״ג', 'ירקות', 'ירקות הגליל', 4, 0.06]
  ];
  const R = {
    'המבורגר גונזו': [['לחמניית המבורגר', 1], ['בשר טחון', 0.18], ['צ׳דר', 0.02], ['חסה', 0.02], ['עגבניות', 0.03]],
    "צ'יפס": [['תפוחי אדמה קפואים', 0.25], ['שמן טיגון', 0.02]],
    'סלט קיסר': [['חסה', 0.15], ['חזה עוף', 0.12], ['פרמזן', 0.02]],
    'שניצל': [['חזה עוף', 0.2], ['פירורי לחם', 0.04], ['שמן טיגון', 0.03]],
    "פיש אנד צ'יפס": [['פילה דג', 0.2], ['תפוחי אדמה קפואים', 0.2], ['שמן טיגון', 0.04]],
    'בירה מהחבית': [['בירה מהחבית', 0.5]],
    'קוקה קולה': [['קוקה קולה', 1]],
    'עוגת שוקולד': [['עוגת שוקולד', 1 / 12]],
    'כנפיים': [['כנפיים', 0.3]]
    // 'טבעות בצל' intentionally left without a recipe, to show the warning
  };
  const id = {};
  for (const [name, unit, category, supplier, cost] of P) id[name] = inv.upsertProduct(db, { name, unit, category, supplier, unit_cost: cost });
  for (const [item, lines] of Object.entries(R)) inv.setRecipe(db, item, lines.map(([product, qty]) => ({ product, qty })));

  const range = db.prepare('SELECT MIN(date) a, MAX(date) b FROM items').get();
  if (!range.a) return;
  const day = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wd = s => new Date(s + 'T00:00:00Z').getUTCDay();
  let sat = range.a; while (wd(sat) !== 6) sat = day(sat, -1);      // Saturday before the data starts
  const usageFor = (from, to) => {                                  // theoretical usage per product in (from, to]
    const u = {};
    for (const s of db.prepare('SELECT item, SUM(qty) q FROM items WHERE date > ? AND date <= ? GROUP BY item').all(from, to)) {
      for (const [p, q] of R[s.item] || []) u[p] = (u[p] || 0) + s.q * q;
    }
    return u;
  };
  const weekly = usageFor(range.a, range.b);
  const weeks = Math.max(1, Math.round((new Date(range.b) - new Date(range.a)) / 864e5 / 7));
  const par = Object.fromEntries(P.map(([n]) => [n, Math.ceil(((weekly[n] || 2) / weeks) * 1.5)]));
  for (const [n] of P) db.prepare('UPDATE inv_products SET par_level = ? WHERE id = ?').run(par[n], id[n]);

  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const round = (n, unit) => (unit === 'ק״ג' || unit === 'ליטר' ? Math.round(n * 10) / 10 : Math.round(n));
  const stock = { ...par };
  inv.saveCount(db, { date: sat, lines: P.map(([n, unit]) => ({ product_id: id[n], qty: round(stock[n] * 0.4, unit) })) });
  for (const [n] of P) stock[n] = round(stock[n] * 0.4, P.find(p => p[0] === n)[1]);
  while (day(sat, 7) <= range.b) {
    const mon = day(sat, 2), next = day(sat, 7);
    const lines = P.map(([n, unit, , , cost]) => ({ product_id: id[n], qty: round(Math.max(0, par[n] - stock[n]), unit), unit_cost: cost })).filter(l => l.qty > 0);
    inv.saveDelivery(db, { date: mon, supplier: 'ספקים שונים', lines });
    for (const l of lines) stock[P.find(p => id[p[0]] === l.product_id)[0]] += l.qty;
    const use = usageFor(sat, next);
    const count = P.map(([n, unit, , , , waste]) => {
      stock[n] = Math.max(0, round(stock[n] - (use[n] || 0) * (1 + waste * (0.7 + rnd() * 0.6)), unit));
      return { product_id: id[n], qty: stock[n] };
    });
    inv.saveCount(db, { date: next, lines: count });
    sat = next;
  }
}
