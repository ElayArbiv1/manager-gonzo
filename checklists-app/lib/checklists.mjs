/**
 * Checklists on a key/value store (Netlify Blobs). Same data shapes as the main app's SQLite
 * version (server/checklists.js), so the same screens (public/checklists.js) work on both.
 *
 * keys (store "checklists"):  templates/<id>   runs/<date>/<id>   users/<phone>
 * keys (store "photos"):      <photo id>  (binary, metadata: { mime, run, item })
 */
import crypto from 'node:crypto';
import { HttpError } from './auth.mjs';

const PHOTO_OPTS = ['none', 'optional', 'required'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');   // UTC, like SQLite datetime('now')
const bad = (msg, status = 400) => new HttpError(status, msg);
const hhmm = v => { const s = String(v ?? '').trim(); if (!s) return null; if (!TIME_RE.test(s)) throw bad(`שעה לא תקינה: ${s}`); return s.padStart(5, '0'); };
const mins = v => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))) || 0);

// ---------- templates ----------
function normalizeTemplate(data) {
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
    .filter(s => s.title || s.items.length)
    .map((s, si) => ({ ...s, title: s.title || `סעיף ${si + 1}` }));
  if (!sections.some(s => s.items.length)) throw bad('צריך לפחות סעיף אחד עם משימה');
  return {
    name, role: data.role || null, description: data.description || null, notes: data.notes || null,
    active: data.active === false || data.active === 0 ? 0 : 1, start_time: hhmm(data.start_time), deadline: hhmm(data.deadline), sections
  };
}

const summary = t => {
  const items = t.sections.flatMap(s => s.items);
  const { sections, ...rest } = t;
  return { ...rest, items: items.length, photos_required: items.filter(i => i.photo === 'required').length,
    total_minutes: items.some(i => i.minutes != null) ? items.reduce((a, i) => a + (i.minutes || 0), 0) : null, last_run: null };
};

async function allTemplates(store) {
  const { blobs } = await store.list({ prefix: 'templates/' });
  return (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);
}

export async function listTemplates(store, { all = false } = {}) {
  return (await allTemplates(store)).filter(t => all || t.active).map(summary)
    // lists with a start time (openings) first, then by that time, then by name
    .sort((a, b) => b.active - a.active || (a.start_time ? 0 : 1) - (b.start_time ? 0 : 1)
      || String(a.start_time || '').localeCompare(String(b.start_time || '')) || a.name.localeCompare(b.name, 'he'));
}

export async function getTemplate(store, id) {
  const t = await store.get(`templates/${id}`, { type: 'json' });
  if (!t) return null;
  let n = 0;   // item ids are only needed by the editor; give them stable numbers
  return { ...t, sections: t.sections.map((s, si) => ({ id: si + 1, ...s, items: s.items.map(i => ({ id: ++n, ...i })) })) };
}

export async function saveTemplate(store, data, id = null) {
  const t = normalizeTemplate(data);
  if (!id && data.replace_by_name) id = (await allTemplates(store)).find(x => x.name === t.name)?.id || null;
  if (id && !(await store.get(`templates/${id}`, { type: 'json' }))) throw bad('הרשימה לא נמצאה', 404);
  id = id || newId();
  await store.setJSON(`templates/${id}`, { id, ...t, updated_at: nowSql() });
  return { id, sections: t.sections.length, items: t.sections.reduce((a, s) => a + s.items.length, 0) };
}

export const deleteTemplate = (store, id) => store.delete(`templates/${id}`);

// ---------- runs ----------
const runKey = id => {
  const date = String(id).split('_')[0];
  if (!DATE_RE.test(date)) throw bad('לא נמצא', 404);
  return `runs/${date}/${id}`;
};

function withStats(r) {
  const items = r.items;
  return {
    ...r,
    total: items.length,
    done: items.filter(i => i.done).length,
    photos: items.reduce((a, i) => a + i.photos.length, 0),
    missing_photos: items.filter(i => i.photo === 'required' && !i.photos.length).length,
    notes: items.filter(i => i.note).length,
    total_minutes: items.some(i => i.minutes != null) ? items.reduce((a, i) => a + (i.minutes || 0), 0) : null
  };
}

async function loadRun(store, id) {
  const r = await store.get(runKey(id), { type: 'json' });
  if (!r) throw bad('הרשימה לא נמצאה', 404);
  return r;
}

export async function startRun(store, { template_id, date, user }) {
  if (!DATE_RE.test(date || '')) throw bad('תאריך לא תקין');
  const t = await store.get(`templates/${template_id}`, { type: 'json' });
  if (!t) throw bad('הרשימה לא נמצאה', 404);
  // one run per list + person + day: reopen it
  const { blobs } = await store.list({ prefix: `runs/${date}/` });
  for (const b of blobs) {
    const r = await store.get(b.key, { type: 'json' });
    if (r && r.template_id === t.id && r.employee_phone === user.phone) return { id: r.id, resumed: true };
  }
  const id = `${date}_${newId()}`;
  let pos = 0;
  const run = {
    id, template_id: t.id, template_name: t.name, date, employee: user.name, employee_phone: user.phone,
    started_at: nowSql(), completed_at: null, note: null, start_time: t.start_time || null, deadline: t.deadline || null,
    template_notes: t.notes || null, template_description: t.description || null,
    items: t.sections.flatMap(s => s.items.map(i => ({
      id: ++pos, position: pos, section: s.title, text: i.text, details: i.details, photo: i.photo, minutes: i.minutes ?? null,
      done: false, done_at: null, note: null, photos: []
    })))
  };
  await store.setJSON(runKey(id), run);
  return { id, resumed: false };
}

export async function listRuns(store, { from, to, phone = null }) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) throw bad('טווח תאריכים לא תקין');
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z') && days.length < 93; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const keys = (await Promise.all(days.map(day => store.list({ prefix: `runs/${day}/` })))).flatMap(x => x.blobs.map(b => b.key));
  const runs = (await Promise.all(keys.map(k => store.get(k, { type: 'json' })))).filter(Boolean);
  return runs.filter(r => !phone || r.employee_phone === phone)
    .map(r => { const { items, ...rest } = withStats(r); return rest; })
    .sort((a, b) => (b.date + b.started_at).localeCompare(a.date + a.started_at));
}

export async function getRun(store, id) {
  return withStats(await loadRun(store, id));
}

function canTouch(run, user) {
  if (user.role !== 'manager' && run.employee_phone !== user.phone) throw bad('אין הרשאה לרשימה הזו', 403);
}

export async function checkAccess(store, id, user) {
  const r = await loadRun(store, id);
  canTouch(r, user);
  return r;
}

export async function updateItem(store, id, itemId, { done, note }, user) {
  const r = await checkAccess(store, id, user);
  const it = r.items.find(i => i.id === Number(itemId));
  if (!it) throw bad('המשימה לא נמצאה', 404);
  if (done !== undefined) { it.done = Boolean(done); it.done_at = it.done ? nowSql() : null; }
  if (note !== undefined) it.note = String(note || '').trim() || null;
  await store.setJSON(runKey(id), r);
  return { id: it.id, done: it.done ? 1 : 0, done_at: it.done_at, note: it.note };
}

export async function addPhoto(stores, id, itemId, file, user) {
  const r = await checkAccess(stores.data, id, user);
  const it = r.items.find(i => i.id === Number(itemId));
  if (!it) throw bad('המשימה לא נמצאה', 404);
  if (!file || !IMAGE_TYPES.includes(file.type)) throw bad('אפשר להעלות רק תמונות');
  if (file.size > 8 * 1024 * 1024) throw bad('התמונה גדולה מדי');
  const pid = `${id}~${it.id}~${newId()}`;
  await stores.photos.set(pid, await file.arrayBuffer(), { metadata: { mime: file.type, run: id, item: it.id } });
  it.photos.push({ id: pid, created_at: nowSql() });
  await stores.data.setJSON(runKey(id), r);
  return { id: pid };
}

export async function getPhoto(stores, pid, user) {
  const [runId] = String(pid).split('~');
  await checkAccess(stores.data, runId, user);
  const p = await stores.photos.getWithMetadata(pid, { type: 'arrayBuffer' });
  if (!p) throw bad('לא נמצא', 404);
  return { data: p.data, mime: p.metadata?.mime || 'image/jpeg' };
}

export async function deletePhoto(stores, pid, user) {
  const [runId, itemId] = String(pid).split('~');
  const r = await checkAccess(stores.data, runId, user);
  const it = r.items.find(i => i.id === Number(itemId));
  if (it) it.photos = it.photos.filter(p => p.id !== pid);
  await stores.data.setJSON(runKey(runId), r);
  await stores.photos.delete(pid);
}

export async function completeRun(store, id, { note } = {}, user) {
  const r = await checkAccess(store, id, user);
  r.completed_at = nowSql();
  r.note = String(note || '').trim() || null;
  await store.setJSON(runKey(id), r);
  const s = withStats(r);
  return { done: s.done, total: s.total, missing_photos: s.missing_photos };
}

export async function deleteRun(stores, id) {
  const r = await loadRun(stores.data, id);
  await Promise.all(r.items.flatMap(i => i.photos.map(p => stores.photos.delete(p.id))));
  await stores.data.delete(runKey(id));
}
