'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gonzo-cl-'));
const { openDb } = require('../server/db');
const cl = require('../server/checklists');

const TEMPLATE = {
  name: 'פתיחה', role: 'מלצרים', notes: 'כלל ברזל',
  sections: [
    { title: 'עמדות', items: [{ text: 'למלא עמדה', details: 'מזלגות\nסכינים', photo: 'required' }, 'לסדר שולחנות'] },
    { title: '', items: [{ text: '  ' }] }   // empty items / sections are dropped
  ]
};

test('template → run → tick, note, photo → complete; history survives template edits', () => {
  const db = openDb(':memory:');
  const t = cl.saveTemplate(db, TEMPLATE);
  assert.deepEqual([t.sections, t.items], [1, 2]);
  assert.equal(cl.listTemplates(db)[0].photos_required, 1);

  const run = cl.startRun(db, { template_id: t.id, employee: 'דנה', date: '2026-11-24' });
  assert.equal(cl.startRun(db, { template_id: t.id, employee: 'דנה', date: '2026-11-24' }).resumed, true);
  let r = cl.getRun(db, run.id);
  assert.equal(r.template_notes, 'כלל ברזל');
  const [station, tables] = r.items;
  cl.updateItem(db, run.id, tables.id, { done: true, note: 'שולחן 12 מתנדנד' });
  cl.addPhoto(db, run.id, station.id, { mimetype: 'image/jpeg', buffer: Buffer.from('jpg'), size: 3 });
  assert.throws(() => cl.addPhoto(db, run.id, station.id, { mimetype: 'application/pdf', buffer: Buffer.from('x') }), /רק תמונות/);
  assert.throws(() => cl.updateItem(db, run.id + 99, station.id, { done: true }), /לא נמצאה/);

  r = cl.getRun(db, run.id);
  assert.deepEqual([r.done, r.total, r.photos, r.missing_photos, r.notes], [1, 2, 1, 0, 1]);
  const f = cl.photoFile(db, r.items[0].photos[0].id);
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'jpg');

  cl.completeRun(db, run.id, { note: 'הכל טוב' });
  // editing the template afterwards does not change what was filled
  cl.saveTemplate(db, { ...TEMPLATE, sections: [{ title: 'חדש', items: ['משימה אחרת'] }] }, t.id);
  r = cl.getRun(db, run.id);
  assert.deepEqual(r.items.map(i => i.text), ['למלא עמדה', 'לסדר שולחנות']);
  assert.ok(r.completed_at);
  assert.equal(cl.listRuns(db, { from: '2026-11-24', to: '2026-11-24' }).length, 1);

  cl.deleteRun(db, run.id);
  assert.equal(fs.existsSync(f.path), false);
});

test('validation', () => {
  const db = openDb(':memory:');
  assert.throws(() => cl.saveTemplate(db, { name: '', sections: [] }), /שם/);
  assert.throws(() => cl.saveTemplate(db, { name: 'x', sections: [{ title: 'a', items: [] }] }), /לפחות/);
  const t = cl.saveTemplate(db, TEMPLATE);
  assert.throws(() => cl.startRun(db, { template_id: t.id, employee: ' ', date: '2026-11-24' }), /שם/);
});
