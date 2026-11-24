'use strict';
/**
 * Inventory: supply deliveries (Monday), stock counts (Saturday night), recipes,
 * and the usage / waste report between two counts.
 *
 *   actual used  = opening count + received - closing count
 *   sold         = Σ (menu items sold × recipe qty)          (from the sales-by-item report)
 *   waste        = actual used - sold                        (waste, staff meals, theft, mis-portioning...)
 */
const imp = require('./importers');
const { getSettings } = require('./db');

const r3 = n => Math.round((n || 0) * 1000) / 1000;
const r2 = n => Math.round((n || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }

// ---------- products ----------
function listProducts(db) {
  return db.prepare('SELECT * FROM inv_products ORDER BY active DESC, category, name').all();
}

function upsertProduct(db, p) {
  const name = String(p.name || '').trim();
  if (!name) throw bad('שם מוצר חובה');
  const vals = {
    name,
    unit: String(p.unit || 'יח׳').trim() || 'יח׳',
    category: p.category ? String(p.category).trim() : null,
    supplier: p.supplier ? String(p.supplier).trim() : null,
    unit_cost: Number(p.unit_cost) || 0,
    par_level: p.par_level === '' || p.par_level == null ? null : Number(p.par_level),
    active: p.active === false || p.active === 0 || p.active === '0' ? 0 : 1
  };
  if (p.id) {
    db.prepare(`UPDATE inv_products SET name=@name, unit=@unit, category=@category, supplier=@supplier,
      unit_cost=@unit_cost, par_level=@par_level, active=@active WHERE id=@id`).run({ ...vals, id: Number(p.id) });
    return Number(p.id);
  }
  return Number(db.prepare(`INSERT INTO inv_products(name, unit, category, supplier, unit_cost, par_level, active)
    VALUES (@name, @unit, @category, @supplier, @unit_cost, @par_level, @active)`).run(vals).lastInsertRowid);
}

/** Finds a product by id or name; unknown names are created (so uploads never lose lines). */
function resolveProduct(db, line) {
  if (line.product_id) {
    const p = db.prepare('SELECT * FROM inv_products WHERE id = ?').get(Number(line.product_id));
    if (p) return p;
  }
  const name = String(line.product || '').trim();
  if (!name) throw bad('שורה בלי שם מוצר');
  let p = db.prepare('SELECT * FROM inv_products WHERE name = ?').get(name);
  if (!p) {
    const id = upsertProduct(db, { name, unit: line.unit, category: line.category, unit_cost: line.unit_cost });
    p = db.prepare('SELECT * FROM inv_products WHERE id = ?').get(id);
  }
  return p;
}

const cleanLines = lines => (Array.isArray(lines) ? lines : [])
  .map(l => ({ ...l, qty: l.qty === '' || l.qty == null ? null : Number(l.qty), unit_cost: l.unit_cost === '' || l.unit_cost == null ? null : Number(l.unit_cost) }))
  .filter(l => l.qty != null && !Number.isNaN(l.qty));

// ---------- deliveries ----------
function saveDelivery(db, d) {
  if (!DATE_RE.test(d.date || '')) throw bad('תאריך לא תקין');
  const lines = cleanLines(d.lines).filter(l => l.qty !== 0);
  if (!lines.length) throw bad('אין שורות בהזמנה');
  return db.transaction(() => {
    let id = Number(d.id) || null;
    if (id) {
      db.prepare('UPDATE inv_deliveries SET date=?, supplier=?, note=? WHERE id=?').run(d.date, d.supplier || null, d.note || null, id);
      db.prepare('DELETE FROM inv_delivery_lines WHERE delivery_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO inv_deliveries(date, supplier, note) VALUES (?,?,?)').run(d.date, d.supplier || null, d.note || null).lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO inv_delivery_lines(delivery_id, product_id, qty, unit_cost) VALUES (?,?,?,?)');
    const cost = db.prepare('UPDATE inv_products SET unit_cost = ? WHERE id = ?');
    for (const l of lines) {
      const p = resolveProduct(db, l);
      ins.run(id, p.id, l.qty, l.unit_cost);
      if (l.unit_cost) cost.run(l.unit_cost, p.id);   // keep the latest purchase price
    }
    return { id, lines: lines.length };
  })();
}

function listDeliveries(db) {
  return db.prepare(`SELECT d.*, COUNT(l.id) lines, SUM(l.qty * COALESCE(l.unit_cost, p.unit_cost)) total
    FROM inv_deliveries d LEFT JOIN inv_delivery_lines l ON l.delivery_id = d.id LEFT JOIN inv_products p ON p.id = l.product_id
    GROUP BY d.id ORDER BY d.date DESC, d.id DESC LIMIT 200`).all().map(r => ({ ...r, total: r2(r.total) }));
}

function getDelivery(db, id) {
  const d = db.prepare('SELECT * FROM inv_deliveries WHERE id = ?').get(id);
  if (!d) return null;
  d.lines = db.prepare(`SELECT l.product_id, p.name product, p.unit, l.qty, l.unit_cost FROM inv_delivery_lines l
    JOIN inv_products p ON p.id = l.product_id WHERE l.delivery_id = ? ORDER BY p.category, p.name`).all(id);
  return d;
}

// ---------- counts ----------
function saveCount(db, c) {
  if (!DATE_RE.test(c.date || '')) throw bad('תאריך לא תקין');
  const lines = cleanLines(c.lines);
  if (!lines.length) throw bad('אין שורות בספירה');
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM inv_counts WHERE date = ?').get(c.date);
    let id;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE inv_counts SET note = ? WHERE id = ?').run(c.note || null, id);
      db.prepare('DELETE FROM inv_count_lines WHERE count_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO inv_counts(date, note) VALUES (?,?)').run(c.date, c.note || null).lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO inv_count_lines(count_id, product_id, qty) VALUES (?,?,?) ON CONFLICT(count_id, product_id) DO UPDATE SET qty = excluded.qty');
    for (const l of lines) ins.run(id, resolveProduct(db, l).id, l.qty);
    return { id, lines: lines.length, replaced: Boolean(existing) };
  })();
}

function listCounts(db) {
  return db.prepare(`SELECT c.*, COUNT(l.id) lines, SUM(l.qty * p.unit_cost) value FROM inv_counts c
    LEFT JOIN inv_count_lines l ON l.count_id = c.id LEFT JOIN inv_products p ON p.id = l.product_id
    GROUP BY c.id ORDER BY c.date DESC`).all().map(r => ({ ...r, value: r2(r.value) }));
}

function getCount(db, id) {
  const c = db.prepare('SELECT * FROM inv_counts WHERE id = ?').get(id);
  if (!c) return null;
  c.lines = db.prepare(`SELECT l.product_id, p.name product, p.unit, l.qty FROM inv_count_lines l
    JOIN inv_products p ON p.id = l.product_id WHERE l.count_id = ? ORDER BY p.category, p.name`).all(id);
  return c;
}

// ---------- file upload (supplier invoice / count sheet) ----------
const LINE_FIELDS = {
  product: { required: true, syn: ['מוצר', 'שם מוצר', 'פריט', 'שם פריט', 'תיאור', 'תאור', 'תיאור פריט', 'product', 'item', 'name', 'description'] },
  qty: { required: true, syn: ['כמות', 'כמות שנספרה', 'ספירה', 'כמות בפועל', 'כמות שסופקה', 'יחידות', 'qty', 'quantity', 'count', 'units'] },
  unit: { syn: ['יחידה', 'יח מידה', 'יחידת מידה', 'unit', 'uom'] },
  unit_cost: { syn: ['מחיר', 'מחיר ליחידה', 'מחיר יחידה', 'עלות ליחידה', 'עלות', 'unit price', 'price', 'unit cost', 'cost'] },
  category: { syn: ['קטגוריה', 'מחלקה', 'קבוצה', 'category', 'group'] }
};

async function parseLinesFile(db, buffer, filename) {
  const parsed = await imp.parseFile(buffer, filename);
  const mapping = imp.guessFieldMapping(LINE_FIELDS, parsed.headers);
  if (!mapping.product || !mapping.qty) {
    throw bad(`לא נמצאו עמודות מוצר וכמות בקובץ. עמודות שנמצאו: ${parsed.headers.join(' | ')}`);
  }
  const lines = parsed.rows.map(r => ({
    product: String(r[mapping.product] ?? '').trim(),
    qty: imp.toNumber(r[mapping.qty]),
    unit: mapping.unit ? String(r[mapping.unit] ?? '').trim() || null : null,
    unit_cost: mapping.unit_cost ? imp.toNumber(r[mapping.unit_cost]) : null,
    category: mapping.category ? String(r[mapping.category] ?? '').trim() || null : null
  })).filter(l => l.product && l.qty != null && !/^סה["״]?כ/.test(l.product));
  // mark products we don't know yet, so the UI can show which ones will be created
  const find = db.prepare('SELECT id, unit FROM inv_products WHERE name = ?');
  for (const l of lines) {
    const p = find.get(l.product);
    l.product_id = p?.id || null;
    l.is_new = !p;
    if (!l.unit && p) l.unit = p.unit;
  }
  return { lines, mapping };
}

// ---------- recipes ----------
function menuItems(db) {
  const sold = db.prepare(`SELECT item, MAX(category) category, SUM(qty) qty FROM items
    WHERE date >= date('now', '-90 day') GROUP BY item ORDER BY qty DESC`).all();
  const rec = db.prepare(`SELECT r.menu_item, r.product_id, p.name product, p.unit, r.qty FROM recipes r
    JOIN inv_products p ON p.id = r.product_id ORDER BY p.name`).all();
  const byItem = {};
  for (const r of rec) (byItem[r.menu_item] ||= []).push(r);
  const names = new Set([...sold.map(s => s.item), ...Object.keys(byItem)]);
  return [...names].map(item => ({
    item,
    category: sold.find(s => s.item === item)?.category || null,
    sold_90d: r2(sold.find(s => s.item === item)?.qty),
    lines: byItem[item] || []
  })).sort((a, b) => (b.sold_90d - a.sold_90d) || a.item.localeCompare(b.item, 'he'));
}

function setRecipe(db, menuItem, lines) {
  const item = String(menuItem || '').trim();
  if (!item) throw bad('שם מנה חובה');
  const clean = cleanLines(lines).filter(l => l.qty > 0);
  db.transaction(() => {
    db.prepare('DELETE FROM recipes WHERE menu_item = ?').run(item);
    const ins = db.prepare('INSERT INTO recipes(menu_item, product_id, qty) VALUES (?,?,?) ON CONFLICT(menu_item, product_id) DO UPDATE SET qty = excluded.qty');
    for (const l of clean) ins.run(item, resolveProduct(db, l).id, l.qty);
  })();
  return { item, lines: clean.length };
}

// ---------- usage & waste report ----------
/**
 * Report for the period that ends at `countId` and starts at the previous count.
 * Period days: (opening.date, closing.date], i.e. a Saturday-night count includes Saturday's sales.
 */
function usageReport(db, countId) {
  const closing = countId
    ? db.prepare('SELECT * FROM inv_counts WHERE id = ?').get(countId)
    : db.prepare('SELECT * FROM inv_counts ORDER BY date DESC LIMIT 1').get();
  if (!closing) return { status: 'no-counts' };
  const opening = db.prepare('SELECT * FROM inv_counts WHERE date < ? ORDER BY date DESC LIMIT 1').get(closing.date);
  if (!opening) return { status: 'need-two-counts', closing };

  const from = opening.date, to = closing.date;
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const map = (rows, k = 'product_id', v = 'qty') => Object.fromEntries(rows.map(r => [r[k], r[v]]));

  const open = map(q('SELECT product_id, qty FROM inv_count_lines WHERE count_id = ?', opening.id));
  const close = map(q('SELECT product_id, qty FROM inv_count_lines WHERE count_id = ?', closing.id));
  const recRows = q(`SELECT l.product_id, SUM(l.qty) qty, SUM(l.qty * COALESCE(l.unit_cost, p.unit_cost)) cost
    FROM inv_delivery_lines l JOIN inv_deliveries d ON d.id = l.delivery_id JOIN inv_products p ON p.id = l.product_id
    WHERE d.date > ? AND d.date <= ? GROUP BY l.product_id`, from, to);
  const received = map(recRows);
  const receivedCost = map(recRows, 'product_id', 'cost');

  // theoretical usage from the sales-by-item report × recipes
  const soldItems = q(`SELECT item, SUM(qty) qty, SUM(amount) amount FROM items WHERE date > ? AND date <= ? GROUP BY item`, from, to);
  const recipes = q('SELECT menu_item, product_id, qty FROM recipes');
  const recipeItems = new Set(recipes.map(r => r.menu_item));
  const theo = {};
  const soldBy = {};                 // product -> [{item, qty}]
  for (const s of soldItems) {
    for (const r of recipes.filter(x => x.menu_item === s.item)) {
      theo[r.product_id] = (theo[r.product_id] || 0) + s.qty * r.qty;
      (soldBy[r.product_id] ||= []).push({ item: s.item, qty: s.qty });
    }
  }
  const productsWithRecipe = new Set(recipes.map(r => r.product_id));
  const itemsWithoutRecipe = soldItems.filter(s => !recipeItems.has(s.item)).sort((a, b) => b.amount - a.amount)
    .map(s => ({ item: s.item, qty: r2(s.qty), amount: r2(s.amount) }));

  const products = q('SELECT * FROM inv_products ORDER BY category, name');
  const rows = [];
  for (const p of products) {
    const has = p.id in open || p.id in close || p.id in received;
    if (!has) continue;
    const o = open[p.id] ?? null, c = close[p.id] ?? null, rc = received[p.id] || 0;
    const missingCount = o == null || c == null;
    const used = missingCount ? null : o + rc - c;
    const sold = productsWithRecipe.has(p.id) ? (theo[p.id] || 0) : null;
    const waste = used != null && sold != null ? used - sold : null;
    rows.push({
      product_id: p.id, product: p.name, unit: p.unit, category: p.category, unit_cost: p.unit_cost,
      opening: o == null ? null : r3(o), received: r3(rc), closing: c == null ? null : r3(c),
      used: used == null ? null : r3(used),
      sold: sold == null ? null : r3(sold),
      waste: waste == null ? null : r3(waste),
      waste_pct: waste != null && used > 0 ? r2((waste / used) * 100) : null,
      used_cost: used == null ? null : r2(used * p.unit_cost),
      waste_cost: waste == null ? null : r2(waste * p.unit_cost),
      received_cost: r2(receivedCost[p.id] || 0),
      closing_value: c == null ? null : r2(c * p.unit_cost),
      suggested_order: p.par_level != null && c != null ? r3(Math.max(0, p.par_level - c)) : null,
      missing_count: missingCount,
      no_recipe: !productsWithRecipe.has(p.id),
      sold_by: (soldBy[p.id] || []).sort((a, b) => b.qty - a.qty).slice(0, 5)
    });
  }

  const sum = (k, f = () => true) => r2(rows.filter(f).reduce((a, r) => a + (r[k] || 0), 0));
  const s = getSettings(db);
  const vat = Number(s.vat_percent || 0) / 100;
  const salesGross = db.prepare('SELECT SUM(amount) t FROM sales WHERE date > ? AND date <= ?').get(from, to).t || 0;
  const salesNet = salesGross / (1 + vat);
  const usedCost = sum('used_cost');
  const theoCost = r2(rows.reduce((a, r) => a + (r.sold != null ? r.sold * r.unit_cost : 0), 0));
  const wasteCost = sum('waste_cost', r => r.waste_cost > 0);

  return {
    status: 'ok',
    opening: { id: opening.id, date: opening.date },
    closing: { id: closing.id, date: closing.date },
    rows,
    itemsWithoutRecipe,
    itemSalesDays: db.prepare('SELECT COUNT(DISTINCT date) c FROM items WHERE date > ? AND date <= ?').get(from, to).c,
    periodDays: Math.round((new Date(to) - new Date(from)) / 864e5),
    totals: {
      received_cost: sum('received_cost'),
      used_cost: usedCost,
      theoretical_cost: theoCost,
      waste_cost: wasteCost,                         // only shortages (positive waste)
      surplus_cost: Math.abs(sum('waste_cost', r => r.waste_cost < 0)),
      closing_value: sum('closing_value'),
      sales_net: r2(salesNet),
      food_cost_pct: salesNet ? r2((usedCost / salesNet) * 100) : null,
      theoretical_food_cost_pct: salesNet ? r2((theoCost / salesNet) * 100) : null,
      waste_pct_of_sales: salesNet ? r2((wasteCost / salesNet) * 100) : null
    }
  };
}

/** One summary line per count period (for the trend table). */
function periods(db) {
  return db.prepare('SELECT id FROM inv_counts ORDER BY date DESC LIMIT 26').all()
    .map(c => usageReport(db, c.id))
    .filter(r => r.status === 'ok')
    .map(r => ({ count_id: r.closing.id, from: r.opening.date, to: r.closing.date, ...r.totals }));
}

module.exports = {
  listProducts, upsertProduct, saveDelivery, listDeliveries, getDelivery, saveCount, listCounts, getCount,
  parseLinesFile, menuItems, setRecipe, usageReport, periods, LINE_FIELDS
};
