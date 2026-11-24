'use strict';
/**
 * Connector registry + scheduler.
 * Each connector exports: { id, label, configured(), account(), sync(db) }.
 * Settings per connector: `<prefix>_enabled` ('1'/'0') and `<prefix>_interval_minutes`.
 */
const { getSettings } = require('../db');

const CONNECTORS = {
  email: require('./email'),
  'beecomm-api': require('./beecomm-api')
};
const prefix = id => id.replace(/-/g, '_');
const running = new Set();

async function run(db, id) {
  const c = CONNECTORS[id];
  if (!c) throw Object.assign(new Error('חיבור לא מוכר'), { status: 404 });
  if (running.has(id)) return { status: 'busy' };
  running.add(id);
  const runId = db.prepare("INSERT INTO sync_runs(connector, status) VALUES (?, 'running')").run(id).lastInsertRowid;
  try {
    const summary = await c.sync(db);
    db.prepare("UPDATE sync_runs SET status = 'ok', finished_at = datetime('now'), summary = ? WHERE id = ?").run(JSON.stringify(summary), runId);
    return { status: 'ok', summary };
  } catch (e) {
    db.prepare("UPDATE sync_runs SET status = 'error', finished_at = datetime('now'), summary = ? WHERE id = ?").run(JSON.stringify({ error: e.message }), runId);
    return { status: 'error', error: e.message };
  } finally {
    running.delete(id);
  }
}

function list(db) {
  const s = getSettings(db);
  return Object.values(CONNECTORS).map(c => {
    const last = db.prepare('SELECT * FROM sync_runs WHERE connector = ? ORDER BY id DESC LIMIT 1').get(c.id);
    return {
      id: c.id,
      label: c.label,
      configured: c.configured(),
      account: c.account(),
      enabled: s[`${prefix(c.id)}_enabled`] === '1',
      interval_minutes: Number(s[`${prefix(c.id)}_interval_minutes`]) || 60,
      running: running.has(c.id),
      last: last ? { ...last, summary: safeJson(last.summary) } : null
    };
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** Checks every minute which enabled connectors are due, and runs them. */
function startScheduler(db, { tickMs = 60_000 } = {}) {
  // runs that were cut off by a restart
  db.prepare("UPDATE sync_runs SET status = 'error', summary = '{\"error\":\"הופסק (השרת הופעל מחדש)\"}' WHERE status = 'running'").run();
  const tick = async () => {
    for (const c of list(db)) {
      if (!c.enabled || !c.configured || c.running) continue;
      const lastStart = c.last ? new Date(c.last.started_at + 'Z').getTime() : 0;
      if (Date.now() - lastStart >= c.interval_minutes * 60_000) {
        const r = await run(db, c.id);
        if (r.status === 'error') console.error(`[${c.id}] ${r.error}`);
      }
    }
  };
  const timer = setInterval(() => tick().catch(e => console.error(e)), tickMs);
  timer.unref();
  setTimeout(() => tick().catch(e => console.error(e)), 5_000).unref();
  return timer;
}

module.exports = { CONNECTORS, run, list, startScheduler };
