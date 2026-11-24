'use strict';
/**
 * Email connector: reads report emails (e.g. Beecomm's nightly report after the Z)
 * from an IMAP mailbox and imports the attachments / HTML tables automatically.
 *
 * Credentials come from the environment only (never stored in the database):
 *   IMAP_HOST      e.g. imap.gmail.com
 *   IMAP_PORT      default 993
 *   IMAP_USER      the mailbox address
 *   IMAP_PASSWORD  for Gmail: an "App password", not the normal password
 *   IMAP_TLS       default true
 *
 * Filters and behaviour are regular settings (UI → חיבורים):
 *   email_from_filter, email_subject_filter, email_source, email_mailbox, email_lookback_days
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const { getSettings, DATA_DIR } = require('../db');
const { ingestFile, ingestTable } = require('./ingest');
const { extractTables } = require('./html-tables');
const imp = require('../importers');

const MAIL_DIR = () => path.join(process.env.DATA_DIR || DATA_DIR, 'mail');

function imapConfig() {
  return {
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: process.env.IMAP_TLS !== 'false',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false
  };
}

const configured = () => Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);

function settings(db) {
  const s = getSettings(db);
  return {
    from: (s.email_from_filter || '').trim(),
    subject: (s.email_subject_filter || '').trim(),
    source: (s.email_source || 'beecomm').trim().toLowerCase(),
    mailbox: (s.email_mailbox || 'INBOX').trim(),
    lookbackDays: Math.max(1, Number(s.email_lookback_days) || 7)
  };
}

function messageKey(parsed, raw) {
  return parsed.messageId || 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Processes one raw email (RFC 822 buffer). Used by the IMAP poller, by the
 * ".eml" upload in the UI and by tests.
 */
async function processMessage(db, raw, { source, dryRun = false, force = false } = {}) {
  const parsed = await simpleParser(raw);
  const key = messageKey(parsed, raw);
  const meta = {
    message_id: key,
    from: parsed.from?.text || '',
    subject: parsed.subject || '',
    date: parsed.date ? parsed.date.toISOString() : null
  };
  const src = source || settings(db).source;

  if (!dryRun && !force) {
    const seen = db.prepare('SELECT status FROM email_messages WHERE message_id = ?').get(key);
    if (seen) return { ...meta, status: 'duplicate', results: [] };
  }

  const results = [];
  for (const att of parsed.attachments || []) {
    if (!att.filename) continue;
    results.push(await ingestFile(db, { buffer: att.content, filename: att.filename, source: src, dryRun }));
  }

  // No usable attachment? Look for report tables inside the email body.
  if (!results.some(r => r.status === 'imported' || r.status === 'ok')) {
    const tables = extractTables(parsed.html || '');
    tables.forEach((t, i) => {
      const { headers, rows } = imp.locateHeader(t);
      const res = ingestTable(db, { headers, rows, source: src, filename: `גוף המייל, טבלה ${i + 1}`, dryRun });
      // layout tables in the body are expected; don't report them as failures
      if (res.status === 'failed' && /עמודות חובה/.test(res.reason)) res.status = 'skipped';
      results.push(res);
    });
  }

  const status = results.some(r => r.status === 'imported' || r.status === 'ok') ? (dryRun ? 'ok' : 'imported')
    : results.some(r => r.status === 'failed') ? 'failed' : 'no-data';

  if (!dryRun) {
    // keep the raw email so it can be re-processed after the import rules improve
    fs.mkdirSync(MAIL_DIR(), { recursive: true });
    const file = crypto.createHash('sha1').update(key).digest('hex') + '.eml';
    fs.writeFileSync(path.join(MAIL_DIR(), file), raw);
    db.prepare(`INSERT INTO email_messages(message_id, sender, subject, sent_at, status, details, raw_file)
      VALUES (@message_id, @from, @subject, @date, @status, @details, @file)
      ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, details = excluded.details, processed_at = datetime('now')`)
      .run({ ...meta, status, details: JSON.stringify(results), file });
  }
  return { ...meta, status, results };
}

/** Re-runs a stored email (after improving the import rules). */
async function reprocess(db, id) {
  const row = db.prepare('SELECT * FROM email_messages WHERE id = ?').get(id);
  if (!row || !row.raw_file) throw Object.assign(new Error('המייל לא נמצא'), { status: 404 });
  const raw = fs.readFileSync(path.join(MAIL_DIR(), path.basename(row.raw_file)));
  return processMessage(db, raw, { force: true });
}

/** Connects to the mailbox, finds matching emails from the last N days and processes new ones. */
async function sync(db, { log = () => {} } = {}) {
  if (!configured()) throw new Error('תיבת הדואר לא הוגדרה (IMAP_HOST, IMAP_USER, IMAP_PASSWORD)');
  const { ImapFlow } = require('imapflow');
  const cfg = settings(db);
  const client = new ImapFlow(imapConfig());
  const summary = { checked: 0, processed: 0, imported: 0, failed: 0, messages: [] };
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const query = { since: new Date(Date.now() - cfg.lookbackDays * 864e5) };
      if (cfg.from) query.from = cfg.from;
      if (cfg.subject) query.subject = cfg.subject;
      const uids = (await client.search(query, { uid: true })) || [];
      summary.checked = uids.length;

      // find which ones we have not handled yet (envelope only, cheap)
      const todo = [];
      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          const id = msg.envelope?.messageId;
          if (id && db.prepare('SELECT 1 FROM email_messages WHERE message_id = ?').get(id)) continue;
          todo.push(msg.uid);
        }
      }
      for (const uid of todo) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        const r = await processMessage(db, msg.source, { source: cfg.source });
        if (r.status === 'duplicate') continue;
        summary.processed++;
        if (r.status === 'imported') summary.imported++;
        if (r.status === 'failed') summary.failed++;
        summary.messages.push({ subject: r.subject, status: r.status });
        log(`${r.subject}: ${r.status}`);
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
  return summary;
}

/** Quick connection test for the settings screen. */
async function testConnection() {
  if (!configured()) return { ok: false, error: 'חסרים משתני סביבה: IMAP_HOST, IMAP_USER, IMAP_PASSWORD' };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow(imapConfig());
  try {
    await client.connect();
    const boxes = (await client.list()).map(b => b.path);
    await client.logout();
    return { ok: true, mailboxes: boxes };
  } catch (e) {
    return { ok: false, error: e.responseText || e.message };
  }
}

module.exports = {
  id: 'email',
  label: 'דוחות במייל (ביקום ועוד)',
  configured,
  account: () => (configured() ? process.env.IMAP_USER : null),
  sync, processMessage, reprocess, testConnection
};
