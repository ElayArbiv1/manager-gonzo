'use strict';
/**
 * Shared ingestion pipeline used by every connector (email today, Beecomm API later).
 * A connector only has to produce a file (buffer + name) or a table (headers + rows);
 * detection, column mapping, normalisation and the safe "replace range" commit live here.
 */
const imp = require('../importers');

const SUPPORTED = /\.(csv|xlsx|xlsm|txt)$/i;

/**
 * Imports one table. Returns a result object, never throws for data problems.
 * dryRun: detect and validate only, write nothing.
 */
function ingestTable(db, { headers, rows, source, kind, filename, dryRun = false }) {
  if (!rows.length) return { filename, status: 'skipped', reason: 'אין שורות' };
  const k = kind && imp.KINDS[kind] ? kind : imp.detectKind(headers);
  const mapping = imp.guessMapping(k, headers);
  const norm = imp.normalizeRows(k, rows, mapping);
  if (norm.missing.length) {
    return { filename, kind: k, status: 'failed', reason: `לא זוהו עמודות חובה: ${norm.missing.join(', ')}`, headers, mapping };
  }
  if (!norm.rows.length) return { filename, kind: k, status: 'failed', reason: 'אין שורות תקינות', mapping, errors: norm.errors.slice(0, 5) };
  const dates = norm.rows.map(r => r.date).sort();
  if (dryRun) {
    return { filename, kind: k, status: 'ok', rows: norm.rows.length, from: dates[0], to: dates[dates.length - 1], mapping, skippedRows: norm.errors.length, sample: norm.rows.slice(0, 3) };
  }
  const r = imp.commitImport(db, { kind: k, source, filename, rows: norm.rows, replace: true });
  return { filename, kind: k, status: 'imported', rows: r.inserted, replaced: r.removed, from: r.from, to: r.to, skippedRows: norm.errors.length };
}

/** Imports one file buffer (CSV / Excel). */
async function ingestFile(db, { buffer, filename, source, kind, dryRun }) {
  if (/\.pdf$/i.test(filename)) return { filename, status: 'skipped', reason: 'קובצי PDF עדיין לא נתמכים. נוסיף תמיכה אחרי שנראה דוגמה' };
  if (!SUPPORTED.test(filename)) return { filename, status: 'skipped', reason: 'סוג קובץ לא נתמך' };
  try {
    const parsed = await imp.parseFile(buffer, filename);
    return ingestTable(db, { ...parsed, source, kind, filename, dryRun });
  } catch (e) {
    return { filename, status: 'failed', reason: e.message };
  }
}

module.exports = { ingestFile, ingestTable, SUPPORTED };
