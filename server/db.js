'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function openDb(file) {
  const target = file || process.env.DB_FILE || path.join(DATA_DIR, 'gonzo.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,             -- sales | items | cancellations | shifts
      source TEXT NOT NULL,           -- website | beecomm | shift | manual ...
      filename TEXT,
      date_from TEXT,
      date_to TEXT,
      rows INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per order or per day (depends on the source file). Reports aggregate by date.
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      date TEXT NOT NULL,             -- YYYY-MM-DD
      hour INTEGER,                   -- 0-23 when known
      amount REAL NOT NULL DEFAULT 0, -- gross incl. VAT
      orders INTEGER NOT NULL DEFAULT 1,
      guests INTEGER,
      discount REAL NOT NULL DEFAULT 0,
      tips REAL NOT NULL DEFAULT 0,
      channel TEXT,                   -- dine-in / delivery / takeaway / website ...
      payment TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      date TEXT NOT NULL,
      item TEXT NOT NULL,
      category TEXT,
      qty REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_items_date ON items(date);

    CREATE TABLE IF NOT EXISTS cancellations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT,
      item TEXT,
      qty REAL NOT NULL DEFAULT 1,
      amount REAL NOT NULL DEFAULT 0,
      employee TEXT,
      reason TEXT,
      approved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cancel_date ON cancellations(date);

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      role TEXT,
      hourly_rate REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      date TEXT NOT NULL,
      employee TEXT NOT NULL,
      role TEXT,
      start TEXT,                     -- HH:MM
      end TEXT,
      hours REAL NOT NULL DEFAULT 0,
      hourly_rate REAL,
      cost REAL                       -- NULL = compute from employee rate
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,         -- goods / rent / utilities / other
      supplier TEXT,
      amount REAL NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_log (
      date TEXT PRIMARY KEY,
      note TEXT,
      cash_counted REAL,
      weather TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ---------- inventory ----------
    CREATE TABLE IF NOT EXISTS inv_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'יח׳',  -- kg / liter / unit / bottle ...
      category TEXT,
      supplier TEXT,
      unit_cost REAL NOT NULL DEFAULT 0,   -- last known cost per unit (before VAT)
      par_level REAL,                      -- desired stock after delivery
      active INTEGER NOT NULL DEFAULT 1
    );

    -- supply received (usually Monday morning)
    CREATE TABLE IF NOT EXISTS inv_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      supplier TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inv_delivery_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL REFERENCES inv_deliveries(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
      qty REAL NOT NULL,
      unit_cost REAL
    );

    -- stock counts (usually Saturday night after closing); one count per date
    CREATE TABLE IF NOT EXISTS inv_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inv_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL REFERENCES inv_counts(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
      qty REAL NOT NULL,
      UNIQUE(count_id, product_id)
    );

    -- how much of each product one menu item uses (menu item name = item name in the sales-by-item report)
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES inv_products(id) ON DELETE CASCADE,
      qty REAL NOT NULL,
      UNIQUE(menu_item, product_id)
    );

    -- emails handled by the email connector (dedup + audit log)
    CREATE TABLE IF NOT EXISTS email_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      sender TEXT,
      subject TEXT,
      sent_at TEXT,
      status TEXT NOT NULL,           -- imported | failed | no-data
      details TEXT,                   -- JSON: per attachment / table result
      raw_file TEXT,                  -- stored .eml under data/mail for re-processing
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector TEXT NOT NULL,
      status TEXT NOT NULL,           -- running | ok | error
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const defaults = {
    business_name: 'Gonzo',
    vat_percent: '18',
    labor_target_percent: '28',
    employer_cost_factor: '1.25',   // social benefits on top of gross hourly rate
    week_start: '0',                // 0 = Sunday
    weekly_sales_target: '0',
    cancel_alert_percent: '2',
    // email connector
    email_enabled: '0',
    email_interval_minutes: '60',
    email_from_filter: '',
    email_subject_filter: '',
    email_source: 'beecomm',
    email_mailbox: 'INBOX',
    email_lookback_days: '7',
    // Beecomm API connector (stage 2)
    beecomm_api_enabled: '0',
    beecomm_api_interval_minutes: '360'
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { openDb, getSettings, DATA_DIR };
