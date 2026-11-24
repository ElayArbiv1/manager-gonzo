'use strict';
/**
 * Checklists: templates (sections → items, optional/required photo) and runs (a filled checklist).
 * A run copies the template's items, so editing a template later never rewrites history.
 * Photos are stored on disk under <DATA_DIR>/photos/<run id>/.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const PHOTO_DIR = () => path.join(process.env.DATA_DIR || DATA_DIR, 'photos');
const PHOTO_OPTS = ['none', 'optional', 'required'];
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const hhmm = v => { const s = String(v ?? '').trim(); if (!s) return null; if (!TIME_RE.test(s)) throw bad(`שעה לא תקינה: ${s}`); return s.padStart(5, '0'); };
const mins = v => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))) || 0);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- templates ----------
function listTemplates(db, { all = false } = {}) {
  return db.prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM checklist_items i JOIN checklist_sections s ON s.id = i.section_id WHERE s.template_id = t.id) items,
      (SELECT COUNT(*) FROM checklist_items i JOIN checklist_sections s ON s.id = i.section_id WHERE s.template_id = t.id AND i.photo = 'required') photos_required,
      (SELECT SUM(i.minutes) FROM checklist_items i JOIN checklist_sections s ON s.id = i.section_id WHERE s.template_id = t.id) total_minutes,
      (SELECT MAX(date) FROM checklist_runs r WHERE r.template_id = t.id) last_run
    FROM checklist_templates t ${all ? '' : 'WHERE t.active = 1'} ORDER BY t.active DESC, t.name`).all();
}

function getTemplate(db, id) {
  const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(id);
  if (!t) return null;
  t.sections = db.prepare('SELECT id, title FROM checklist_sections WHERE template_id = ? ORDER BY position').all(id)
    .map(s => ({ ...s, items: db.prepare('SELECT id, text, details, photo, minutes FROM checklist_items WHERE section_id = ? ORDER BY position').all(s.id) }));
  return t;
}

/** Creates or replaces a template from { name, role, description, notes, active, sections: [{ title, items: [{ text, details, photo }] }] }. */
function saveTemplate(db, data, id = null) {
  const name = String(data?.name || '').trim();
  if (!name) throw bad('שם הרשימה חובה');
  const sections = (Array.isArray(data.sections) ? data.sections : [])
    .map(s => ({
      title: String(s.title || '').trim(),
      items: (Array.isArray(s.items) ? s.items : [])
        .map(i => (typeof i === 'string' ? { text: i } : i))
        .map(i => ({ text: String(i.text || '').trim(), details: String(i.details || '').trim() || null, photo: PHOTO_OPTS.includes(i.photo) ? i.photo : 'none', minutes: mins(i.minutes) }))
        .filter(i => i.text)
    }))
    .filter(s => s.title || s.items.length);
  if (!sections.some(s => s.items.length)) throw bad('צריך לפחות סעיף אחד עם משימה');

  return db.transaction(() => {
    const vals = [name, data.role || null, data.description || null, data.notes || null, data.active === false || data.active === 0 ? 0 : 1,
      hhmm(data.start_time), hhmm(data.deadline)];
    // importing a list with an existing name updates it instead of creating a copy
    if (!id && data.replace_by_name) id = db.prepare('SELECT id FROM checklist_templates WHERE name = ?').get(name)?.id || null;
    if (id) {
      if (!db.prepare('SELECT 1 FROM checklist_templates WHERE id = ?').get(id)) throw bad('הרשימה לא נמצאה', 404);
      db.prepare('UPDATE checklist_templates SET name=?, role=?, description=?, notes=?, active=?, start_time=?, deadline=? WHERE id=?').run(...vals, id);
      db.prepare('DELETE FROM checklist_sections WHERE template_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO checklist_templates(name, role, description, notes, active, start_time, deadline) VALUES (?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
    }
    const insS = db.prepare('INSERT INTO checklist_sections(template_id, position, title) VALUES (?,?,?)');
    const insI = db.prepare('INSERT INTO checklist_items(section_id, position, text, details, photo, minutes) VALUES (?,?,?,?,?,?)');
    sections.forEach((s, si) => {
      const sid = insS.run(id, si, s.title || `סעיף ${si + 1}`).lastInsertRowid;
      s.items.forEach((it, ii) => insI.run(sid, ii, it.text, it.details, it.photo, it.minutes));
    });
    return { id, sections: sections.length, items: sections.reduce((a, s) => a + s.items.length, 0) };
  })();
}

function deleteTemplate(db, id) {
  db.prepare('DELETE FROM checklist_templates WHERE id = ?').run(id);
}

// ---------- runs ----------
/** Opens today's run of this checklist for this employee, or creates it from the template. */
function startRun(db, { template_id, employee, date }) {
  const who = String(employee || '').trim();
  if (!who) throw bad('צריך לבחור שם');
  if (!DATE_RE.test(date || '')) throw bad('תאריך לא תקין');
  const t = getTemplate(db, Number(template_id));
  if (!t) throw bad('הרשימה לא נמצאה', 404);
  const existing = db.prepare('SELECT id FROM checklist_runs WHERE template_id = ? AND employee = ? AND date = ? ORDER BY id DESC LIMIT 1').get(t.id, who, date);
  if (existing) return { id: existing.id, resumed: true };
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO checklist_runs(template_id, template_name, date, employee, start_time, deadline) VALUES (?,?,?,?,?,?)')
      .run(t.id, t.name, date, who, t.start_time, t.deadline).lastInsertRowid);
    const ins = db.prepare('INSERT INTO checklist_run_items(run_id, position, section, text, details, photo, minutes) VALUES (?,?,?,?,?,?,?)');
    let pos = 0;
    for (const s of t.sections) for (const i of s.items) ins.run(id, pos++, s.title, i.text, i.details, i.photo, i.minutes);
    return { id, resumed: false };
  })();
}

const RUN_STATS = `
  (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id) total,
  (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id AND i.done = 1) done,
  (SELECT COUNT(*) FROM checklist_photos p JOIN checklist_run_items i ON i.id = p.run_item_id WHERE i.run_id = r.id) photos,
  (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id AND i.photo = 'required'
     AND NOT EXISTS (SELECT 1 FROM checklist_photos p WHERE p.run_item_id = i.id)) missing_photos,
  (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id AND i.note IS NOT NULL AND i.note <> '') notes,
  (SELECT SUM(i.minutes) FROM checklist_run_items i WHERE i.run_id = r.id) total_minutes`;

function listRuns(db, { from, to }) {
  return db.prepare(`SELECT r.*, ${RUN_STATS} FROM checklist_runs r WHERE r.date BETWEEN ? AND ? ORDER BY r.date DESC, r.started_at DESC`).all(from, to);
}

function getRun(db, id) {
  const r = db.prepare(`SELECT r.*, ${RUN_STATS} FROM checklist_runs r WHERE r.id = ?`).get(id);
  if (!r) return null;
  const notes = r.template_id ? db.prepare('SELECT notes, description FROM checklist_templates WHERE id = ?').get(r.template_id) : null;
  r.template_notes = notes?.notes || null;
  r.template_description = notes?.description || null;
  const photos = db.prepare(`SELECT p.id, p.run_item_id, p.created_at FROM checklist_photos p JOIN checklist_run_items i ON i.id = p.run_item_id
    WHERE i.run_id = ? ORDER BY p.id`).all(id);
  r.items = db.prepare('SELECT * FROM checklist_run_items WHERE run_id = ? ORDER BY position').all(id)
    .map(i => ({ ...i, done: Boolean(i.done), photos: photos.filter(p => p.run_item_id === i.id).map(p => ({ id: p.id, created_at: p.created_at })) }));
  return r;
}

function runItem(db, runId, itemId) {
  const item = db.prepare('SELECT * FROM checklist_run_items WHERE id = ? AND run_id = ?').get(itemId, runId);
  if (!item) throw bad('המשימה לא נמצאה', 404);
  return item;
}

function updateItem(db, runId, itemId, { done, note }) {
  runItem(db, runId, itemId);
  if (done !== undefined) {
    db.prepare(`UPDATE checklist_run_items SET done = ?, done_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?`).run(done ? 1 : 0, done ? 1 : 0, itemId);
  }
  if (note !== undefined) db.prepare('UPDATE checklist_run_items SET note = ? WHERE id = ?').run(String(note || '').trim() || null, itemId);
  // ticking items again after "finish" re-opens nothing; finishing is explicit
  return db.prepare('SELECT id, done, done_at, note FROM checklist_run_items WHERE id = ?').get(itemId);
}

function addPhoto(db, runId, itemId, file) {
  runItem(db, runId, itemId);
  const ext = IMAGE_TYPES[file?.mimetype];
  if (!ext) throw bad('אפשר להעלות רק תמונות');
  const dir = path.join(PHOTO_DIR(), String(runId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${itemId}-${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), file.buffer);
  const id = Number(db.prepare('INSERT INTO checklist_photos(run_item_id, file, mime, size) VALUES (?,?,?,?)')
    .run(itemId, path.join(String(runId), name), file.mimetype, file.size).lastInsertRowid);
  return { id };
}

function photoFile(db, id) {
  const p = db.prepare('SELECT * FROM checklist_photos WHERE id = ?').get(id);
  if (!p) return null;
  const full = path.resolve(PHOTO_DIR(), p.file);
  if (!full.startsWith(path.resolve(PHOTO_DIR()) + path.sep)) return null;   // never leave the photos folder
  return { path: full, mime: p.mime };
}

function deletePhoto(db, id) {
  const f = photoFile(db, id);
  db.prepare('DELETE FROM checklist_photos WHERE id = ?').run(id);
  if (f) fs.rmSync(f.path, { force: true });
}

function completeRun(db, id, { note } = {}) {
  const r = getRun(db, id);
  if (!r) throw bad('לא נמצא', 404);
  db.prepare("UPDATE checklist_runs SET completed_at = datetime('now'), note = ? WHERE id = ?").run(String(note || '').trim() || null, id);
  return { done: r.done, total: r.total, missing_photos: r.missing_photos };
}

function deleteRun(db, id) {
  db.prepare('DELETE FROM checklist_runs WHERE id = ?').run(id);
  fs.rmSync(path.join(PHOTO_DIR(), String(Number(id))), { recursive: true, force: true });
}

module.exports = {
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  startRun, listRuns, getRun, updateItem, addPhoto, photoFile, deletePhoto, completeRun, deleteRun, IMAGE_TYPES
};
