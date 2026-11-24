#!/usr/bin/env node
'use strict';
/**
 * Command-line import, handy for automation (cron, email-to-folder, scheduled exports).
 *
 *   node scripts/import.js <file> --source beecomm [--kind sales|items|cancellations|shifts] [--append]
 *
 * Kind is auto-detected when omitted. By default rows of the same source in the file's
 * date range are replaced (safe to re-run).
 */
const fs = require('fs');
const path = require('path');
const { openDb } = require('../server/db');
const imp = require('../server/importers');

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' || args[i] === '--kind') i++;
    else if (!args[i].startsWith('--')) files.push(args[i]);
  }
  if (!files.length) {
    console.error('שימוש: node scripts/import.js <file...> --source <beecomm|website|shift|...> [--kind sales|items|cancellations|shifts] [--append]');
    process.exit(1);
  }
  const db = openDb();
  for (const file of files) {
    const parsed = await imp.parseFile(fs.readFileSync(file), path.basename(file));
    const kind = opt('kind') || imp.detectKind(parsed.headers);
    const source = (opt('source') || (kind === 'shifts' ? 'shift' : 'manual')).toLowerCase();
    const mapping = imp.guessMapping(kind, parsed.headers);
    const norm = imp.normalizeRows(kind, parsed.rows, mapping);
    if (norm.missing.length) {
      console.error(`${file}: לא נמצאו עמודות חובה (${norm.missing.join(', ')}). עמודות בקובץ: ${parsed.headers.join(' | ')}`);
      process.exitCode = 2;
      continue;
    }
    const r = imp.commitImport(db, { kind, source, filename: path.basename(file), rows: norm.rows, replace: !args.includes('--append') });
    console.log(`${path.basename(file)}: ${KIND(kind)} · ${r.inserted} שורות · ${r.from} עד ${r.to}${r.removed ? ` · הוחלפו ${r.removed}` : ''}${norm.errors.length ? ` · דולגו ${norm.errors.length}` : ''}`);
  }
}
const KIND = k => imp.KINDS[k].label;

main().catch(e => { console.error(e.message); process.exit(1); });
