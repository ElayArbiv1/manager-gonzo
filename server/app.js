'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { openDb, getSettings } = require('./db');
const imp = require('./importers');
const reports = require('./reports');
const { buildWorkbook } = require('./export');
const auth = require('./auth');
const connectors = require('./connectors');
const inventory = require('./inventory');
const emailConnector = require('./connectors/email');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createApp(db = openDb()) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const pending = new Map(); // token -> { parsed, filename, expires }

  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));

  app.get('/api/auth/status', auth.status);
  app.post('/api/auth/login', auth.login);
  app.post('/api/auth/logout', auth.logout);
  app.use('/api', auth.requireAuth);

  const range = (req) => {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
      const e = new Error('טווח תאריכים לא תקין'); e.status = 400; throw e;
    }
    return [from, to];
  };

  // ---------- reports ----------
  app.get('/api/reports/summary', (req, res) => res.json(reports.summary(db, ...range(req))));
  app.get('/api/reports/labor', (req, res) => res.json(reports.labor(db, ...range(req))));
  app.get('/api/reports/cancellations', (req, res) => res.json(reports.cancellations(db, ...range(req))));
  app.get('/api/reports/sales', (req, res) => res.json(reports.sales(db, ...range(req))));
  app.get('/api/reports/forecast', (req, res) => {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : new Date().toISOString().slice(0, 10);
    res.json(reports.forecast(db, from));
  });
  app.get('/api/reports/export.xlsx', async (req, res, next) => {
    try {
      const [from, to] = range(req);
      const buf = await buildWorkbook({
        summary: reports.summary(db, from, to),
        labor: reports.labor(db, from, to),
        cancellations: reports.cancellations(db, from, to),
        sales: reports.sales(db, from, to)
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="gonzo-report-${from}_${to}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (e) { next(e); }
  });

  // ---------- imports ----------
  app.get('/api/import/kinds', (req, res) => {
    res.json(Object.fromEntries(Object.entries(imp.KINDS).map(([k, v]) => [k, {
      label: v.label,
      fields: Object.fromEntries(Object.entries(v.fields).map(([f, d]) => [f, { label: d.label, required: !!d.required }]))
    }])));
  });

  app.post('/api/import/preview', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
      const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const parsed = await imp.parseFile(req.file.buffer, filename);
      if (!parsed.rows.length) return res.status(400).json({ error: 'הקובץ ריק או שלא נמצאה בו טבלה' });
      const kind = imp.KINDS[req.body.kind] ? req.body.kind : imp.detectKind(parsed.headers);
      const mapping = imp.guessMapping(kind, parsed.headers);
      const token = crypto.randomUUID();
      for (const [t, p] of pending) if (p.expires < Date.now()) pending.delete(t);
      pending.set(token, { parsed, filename, expires: Date.now() + 30 * 60 * 1000 });
      const norm = imp.normalizeRows(kind, parsed.rows, mapping);
      res.json({
        token, filename, kind, mapping, headers: parsed.headers,
        sample: parsed.rows.slice(0, 8).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v]))),
        totalRows: parsed.rows.length,
        preview: summarizeNorm(norm)
      });
    } catch (e) { next(e); }
  });

  app.post('/api/import/check', (req, res) => {
    const p = pending.get(req.body.token);
    if (!p) return res.status(410).json({ error: 'פג תוקף הקובץ, יש להעלות מחדש' });
    if (!imp.KINDS[req.body.kind]) return res.status(400).json({ error: 'סוג ייבוא לא מוכר' });
    const mapping = req.body.guess ? imp.guessMapping(req.body.kind, p.parsed.headers) : (req.body.mapping || {});
    const norm = imp.normalizeRows(req.body.kind, p.parsed.rows, mapping);
    res.json({ ...summarizeNorm(norm), mapping });
  });

  app.post('/api/import/commit', (req, res) => {
    const { token, kind, mapping, source, replace } = req.body;
    const p = pending.get(token);
    if (!p) return res.status(410).json({ error: 'פג תוקף הקובץ, יש להעלות מחדש' });
    if (!imp.KINDS[kind]) return res.status(400).json({ error: 'סוג ייבוא לא מוכר' });
    const src = String(source || '').trim().toLowerCase() || 'manual';
    const norm = imp.normalizeRows(kind, p.parsed.rows, mapping || {});
    if (norm.missing.length) return res.status(400).json({ error: `חסר שיוך לשדות: ${norm.missing.join(', ')}` });
    const result = imp.commitImport(db, { kind, source: src, filename: p.filename, rows: norm.rows, replace: replace !== false });
    pending.delete(token);
    res.json({ ...result, skipped: norm.errors.length });
  });

  app.get('/api/imports', (req, res) => {
    res.json(db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 200').all());
  });
  app.delete('/api/imports/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT kind FROM imports WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'לא נמצא' });
    db.transaction(() => {
      db.prepare(`DELETE FROM ${row.kind} WHERE import_id = ?`).run(id);
      db.prepare('DELETE FROM imports WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  });

  // ---------- manual daily entry (when there is no file) ----------
  app.post('/api/sales/manual', (req, res) => {
    const { date, amount, orders, source } = req.body;
    if (!DATE_RE.test(date || '') || !(Number(amount) >= 0)) return res.status(400).json({ error: 'תאריך וסכום חובה' });
    const src = String(source || 'manual').toLowerCase();
    const r = imp.commitImport(db, { kind: 'sales', source: src, filename: 'הזנה ידנית', rows: [{ date, amount: Number(amount), orders: Number(orders) || 0 }] });
    res.json(r);
  });

  // ---------- employees ----------
  app.get('/api/employees', (req, res) => res.json(db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all()));
  app.post('/api/employees', (req, res) => {
    const { name, role, hourly_rate } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ error: 'שם חובה' });
    const r = db.prepare('INSERT INTO employees(name, role, hourly_rate) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET role=excluded.role, hourly_rate=excluded.hourly_rate')
      .run(String(name).trim(), role || null, Number(hourly_rate) || 0);
    res.json({ id: Number(r.lastInsertRowid) });
  });
  app.put('/api/employees/:id', (req, res) => {
    const { role, hourly_rate, active } = req.body;
    db.prepare('UPDATE employees SET role = ?, hourly_rate = ?, active = ? WHERE id = ?')
      .run(role || null, Number(hourly_rate) || 0, active === false || active === 0 ? 0 : 1, Number(req.params.id));
    res.json({ ok: true });
  });
  app.delete('/api/employees/:id', (req, res) => {
    db.prepare('DELETE FROM employees WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- expenses ----------
  app.get('/api/expenses', (req, res) => {
    const [from, to] = range(req);
    res.json(db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(from, to));
  });
  app.post('/api/expenses', (req, res) => {
    const { date, category, supplier, amount, note } = req.body;
    if (!DATE_RE.test(date || '') || !category || !(Number(amount) > 0)) return res.status(400).json({ error: 'תאריך, קטגוריה וסכום חובה' });
    const r = db.prepare('INSERT INTO expenses(date, category, supplier, amount, note) VALUES (?,?,?,?,?)').run(date, category, supplier || null, Number(amount), note || null);
    res.json({ id: Number(r.lastInsertRowid) });
  });
  app.delete('/api/expenses/:id', (req, res) => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- daily log ----------
  app.get('/api/log', (req, res) => {
    const [from, to] = range(req);
    res.json(db.prepare('SELECT * FROM daily_log WHERE date BETWEEN ? AND ? ORDER BY date DESC').all(from, to));
  });
  app.put('/api/log/:date', (req, res) => {
    const date = req.params.date;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'תאריך לא תקין' });
    const { note, cash_counted, weather } = req.body;
    db.prepare(`INSERT INTO daily_log(date, note, cash_counted, weather, updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(date) DO UPDATE SET note=excluded.note, cash_counted=excluded.cash_counted, weather=excluded.weather, updated_at=excluded.updated_at`)
      .run(date, note || null, cash_counted === '' || cash_counted == null ? null : Number(cash_counted), weather || null);
    res.json({ ok: true });
  });

  // ---------- inventory ----------
  app.get('/api/inventory/products', (req, res) => res.json(inventory.listProducts(db)));
  app.post('/api/inventory/products', (req, res) => res.json({ id: inventory.upsertProduct(db, req.body) }));
  app.put('/api/inventory/products/:id', (req, res) => res.json({ id: inventory.upsertProduct(db, { ...req.body, id: req.params.id }) }));
  app.delete('/api/inventory/products/:id', (req, res) => {
    db.prepare('DELETE FROM inv_products WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/inventory/deliveries', (req, res) => res.json(inventory.listDeliveries(db)));
  app.get('/api/inventory/deliveries/:id', (req, res) => {
    const d = inventory.getDelivery(db, Number(req.params.id));
    d ? res.json(d) : res.status(404).json({ error: 'לא נמצא' });
  });
  app.post('/api/inventory/deliveries', (req, res) => res.json(inventory.saveDelivery(db, req.body)));
  app.delete('/api/inventory/deliveries/:id', (req, res) => {
    db.prepare('DELETE FROM inv_deliveries WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/inventory/counts', (req, res) => res.json(inventory.listCounts(db)));
  app.get('/api/inventory/counts/:id', (req, res) => {
    const c = inventory.getCount(db, Number(req.params.id));
    c ? res.json(c) : res.status(404).json({ error: 'לא נמצא' });
  });
  app.post('/api/inventory/counts', (req, res) => res.json(inventory.saveCount(db, req.body)));
  app.delete('/api/inventory/counts/:id', (req, res) => {
    db.prepare('DELETE FROM inv_counts WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // supplier invoice / count sheet → lines for the UI to review before saving
  app.post('/api/inventory/parse', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
      const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      res.json(await inventory.parseLinesFile(db, req.file.buffer, filename));
    } catch (e) { next(e); }
  });

  app.get('/api/inventory/recipes', (req, res) => res.json(inventory.menuItems(db)));
  app.put('/api/inventory/recipes', (req, res) => res.json(inventory.setRecipe(db, req.body.item, req.body.lines)));

  app.get('/api/inventory/report', (req, res) => {
    res.json({ ...inventory.usageReport(db, req.query.count ? Number(req.query.count) : null), periods: inventory.periods(db) });
  });

  // ---------- connectors (email now, Beecomm API later) ----------
  app.get('/api/connectors', (req, res) => res.json(connectors.list(db)));
  app.post('/api/connectors/:id/run', async (req, res, next) => {
    try { res.json(await connectors.run(db, req.params.id)); } catch (e) { next(e); }
  });
  app.post('/api/connectors/email/test', async (req, res) => res.json(await emailConnector.testConnection()));
  // upload a saved email (.eml) to check (dry run) or import it
  app.post('/api/connectors/email/upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
      const dryRun = req.body.dryRun !== 'false';
      res.json(await emailConnector.processMessage(db, req.file.buffer, { dryRun, force: true }));
    } catch (e) { next(e); }
  });
  app.get('/api/connectors/email/messages', (req, res) => {
    res.json(db.prepare('SELECT id, message_id, sender, subject, sent_at, status, details, processed_at FROM email_messages ORDER BY id DESC LIMIT 100').all()
      .map(m => ({ ...m, details: JSON.parse(m.details || '[]') })));
  });
  app.post('/api/connectors/email/messages/:id/reprocess', async (req, res, next) => {
    try { res.json(await emailConnector.reprocess(db, Number(req.params.id))); } catch (e) { next(e); }
  });
  app.get('/api/connectors/runs', (req, res) => {
    res.json(db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50').all().map(r => ({ ...r, summary: JSON.parse(r.summary || 'null') })));
  });

  // ---------- settings ----------
  app.get('/api/settings', (req, res) => res.json(getSettings(db)));
  app.put('/api/settings', (req, res) => {
    const allowed = ['business_name', 'vat_percent', 'labor_target_percent', 'employer_cost_factor', 'weekly_sales_target', 'cancel_alert_percent',
      'email_enabled', 'email_interval_minutes', 'email_from_filter', 'email_subject_filter', 'email_source', 'email_mailbox', 'email_lookback_days',
      'beecomm_api_enabled', 'beecomm_api_interval_minutes'];
    const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of allowed) if (k in req.body) up.run(k, String(req.body[k]));
    res.json(getSettings(db));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'לא נמצא' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.message && /[֐-׿]/.test(err.message) ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'שגיאת שרת' : err.message });
  });

  return app;
}

function summarizeNorm(norm) {
  const dates = norm.rows.map(r => r.date).sort();
  return {
    valid: norm.rows.length,
    errors: norm.errors.slice(0, 20),
    errorCount: norm.errors.length,
    missing: norm.missing,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    sample: norm.rows.slice(0, 5),
    total: Math.round(norm.rows.reduce((a, r) => a + (r.amount ?? r.hours ?? 0), 0) * 100) / 100
  };
}

module.exports = { createApp };
