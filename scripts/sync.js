#!/usr/bin/env node
'use strict';
/**
 * Runs a connector once, for cron / Task Scheduler setups where the web server is not always on.
 *   node scripts/sync.js email
 *   node scripts/sync.js beecomm-api
 *   node scripts/sync.js email --eml path/to/message.eml [--dry-run]   (process a saved email file)
 */
const fs = require('fs');
const { openDb } = require('../server/db');
const connectors = require('../server/connectors');
const email = require('../server/connectors/email');

(async () => {
  const [id = 'email', ...rest] = process.argv.slice(2);
  const db = openDb();
  const emlIdx = rest.indexOf('--eml');
  if (emlIdx >= 0) {
    const r = await email.processMessage(db, fs.readFileSync(rest[emlIdx + 1]), { dryRun: rest.includes('--dry-run'), force: true });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const r = await connectors.run(db, id);
  console.log(JSON.stringify(r, null, 2));
  if (r.status === 'error') process.exitCode = 1;
})().catch(e => { console.error(e.message); process.exit(1); });
