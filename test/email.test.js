'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gonzo-mail-'));
const { openDb } = require('../server/db');
const email = require('../server/connectors/email');
const { extractTables } = require('../server/connectors/html-tables');

function eml({ id, subject = 'דוח יומי', html = '<p>שלום</p>', attachments = [] }) {
  const b = 'BOUNDARY42';
  const parts = [
    `--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}\r\n`,
    ...attachments.map(a => `--${b}\r\nContent-Type: application/octet-stream; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(a.content).toString('base64')}\r\n`)
  ];
  return Buffer.from([
    'From: Beecomm <reports@beecomm.example>',
    'To: gonzo@example.com',
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Message-ID: <${id}@beecomm.example>`,
    'Date: Tue, 24 Nov 2026 02:00:00 +0200',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    parts.join('') + `--${b}--\r\n`
  ].join('\r\n'));
}

const zCsv = 'תאריך,מספר חשבונות,סה"כ כולל מע"מ\n23/11/2026,90,11500\n';
const cancCsv = 'תאריך,שם פריט,סכום,בוטל ע"י,סיבת ביטול\n23/11/2026,המבורגר,68,יוסי,טעות\n23/11/2026,צ\'יפס,22,דנה,\n';

test('email with CSV attachments is imported once (dedup by Message-ID)', async () => {
  const db = openDb(':memory:');
  const raw = eml({ id: 'a1', attachments: [{ name: 'z-report.csv', content: zCsv }, { name: 'cancellations.csv', content: cancCsv }, { name: 'logo.png', content: 'x' }] });
  const r = await email.processMessage(db, raw, { source: 'beecomm' });
  assert.equal(r.status, 'imported');
  assert.deepEqual(r.results.map(x => [x.kind, x.status]), [['sales', 'imported'], ['cancellations', 'imported'], [undefined, 'skipped']]);
  assert.equal(db.prepare('SELECT SUM(amount) t FROM sales').get().t, 11500);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cancellations').get().c, 2);

  const again = await email.processMessage(db, raw, { source: 'beecomm' });
  assert.equal(again.status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sales').get().c, 1);

  // reprocess re-imports from the stored .eml without duplicating rows
  const id = db.prepare('SELECT id FROM email_messages').get().id;
  const re = await email.reprocess(db, id);
  assert.equal(re.status, 'imported');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sales').get().c, 1);
});

test('report inside the HTML body is found, layout tables are ignored', async () => {
  const db = openDb(':memory:');
  const html = `<table><tr><td><img src="logo"></td><td>גונזו</td></tr><tr><td>x</td><td>y</td></tr></table>
    <table border="1">
      <tr><th colspan="3">דוח מכירות יומי</th></tr>
      <tr><th>תאריך</th><th>מספר חשבונות</th><th>סה&quot;כ כולל מע&quot;מ</th></tr>
      <tr><td>22/11/2026</td><td>80</td><td>9,800.50&nbsp;₪</td></tr>
    </table>`;
  const r = await email.processMessage(db, eml({ id: 'b1', html }), { source: 'beecomm' });
  assert.equal(r.status, 'imported');
  assert.equal(db.prepare('SELECT amount FROM sales').get().amount, 9800.5);
  assert.ok(r.results.some(x => x.status === 'skipped'));
});

test('dry run detects but writes nothing', async () => {
  const db = openDb(':memory:');
  const r = await email.processMessage(db, eml({ id: 'c1', attachments: [{ name: 'z.csv', content: zCsv }] }), { dryRun: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.results[0].rows, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sales').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM email_messages').get().c, 0);
});

test('unrecognised attachment is reported with the columns found', async () => {
  const db = openDb(':memory:');
  const r = await email.processMessage(db, eml({ id: 'd1', attachments: [{ name: 'weird.csv', content: 'foo,bar\n1,2\n' }] }));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.results[0].headers, ['foo', 'bar']);
});

test('html table extraction', () => {
  const t = extractTables('<table><tr><td>a &amp; b</td><td colspan="2">c</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>');
  assert.deepEqual(t, [[['a & b', 'c', ''], ['1', '2', '3']]]);
});
