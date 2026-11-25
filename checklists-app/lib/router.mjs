/** All /api/* routes. Works with standard Request/Response (Netlify Functions v2, and the local dev server). */
import { getStores } from './store.mjs';
import { HttpError, readSession, checkRegistration, makeCookie, clearCookie, resolveRole, isOwner, normalizePhone } from './auth.mjs';
import * as cl from './checklists.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});

export async function handle(req) {
  try {
    return await route(req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500 && !(e instanceof HttpError)) console.error(e);
    return json({ error: status >= 500 && !(e instanceof HttpError) ? 'שגיאת שרת' : e.message, need: e.need }, status);
  }
}

async function route(req) {
  const url = new URL(req.url);
  // reached directly or through the /api/* rewrite to /.netlify/functions/api/*
  const p = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api').replace(/\/+$/, '');
  const m = req.method;
  let stores;
  try { stores = await getStores(); } catch (e) { if (p !== '/api/health') throw e; stores = { data: { list: async () => { throw e; } } }; }
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  const secure = url.protocol === 'https:';

  // ---- auth (no session needed) ----
  if (p === '/api/health' && m === 'GET') {
    let storage = 'ok';
    try { await stores.data.list({ prefix: 'health/' }); } catch (e) { storage = e.name || 'error'; }
    return json({ ok: storage === 'ok', storage, sessionSecret: Boolean(process.env.SESSION_SECRET), managers: Boolean(process.env.MANAGER_PHONES) });
  }
  if (p === '/api/auth/config' && m === 'GET') {
    return json({ teamCode: Boolean(process.env.TEAM_CODE), managersConfigured: Boolean(process.env.MANAGER_PHONES) });
  }
  if (p === '/api/auth/register' && m === 'POST') {
    const data = await body();
    const ph = normalizePhone(data.phone);
    const role = ph ? await resolveRole(stores.data, ph) : 'staff';
    const u = checkRegistration(data, () => role);
    const key = `users/${u.phone}`;
    const prev = await stores.data.get(key, { type: 'json' });
    const now = new Date().toISOString();
    const rec = { name: u.name, phone: u.phone, created_at: prev?.created_at || now, last_login: now };
    await stores.data.setJSON(key, rec);
    return json({ user: { name: rec.name, phone: rec.phone, role: u.role } }, 200, { 'Set-Cookie': makeCookie(rec, secure) });
  }
  if (p === '/api/auth/logout' && m === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });

  const user = readSession(req);
  if (!user) throw new HttpError(401, 'צריך להתחבר');
  user.role = await resolveRole(stores.data, user.phone);
  user.owner = isOwner(user.phone);
  const manager = () => { if (user.role !== 'manager') throw new HttpError(403, 'רק למנהלים'); };

  if (p === '/api/auth/me' && m === 'GET') return json({ user });

  let r;
  // ---- users (managers) ----
  if (p === '/api/users' && m === 'GET') {
    manager();
    const { blobs } = await stores.data.list({ prefix: 'users/' });
    const users = (await Promise.all(blobs.map(b => stores.data.get(b.key, { type: 'json' })))).filter(Boolean)
      .map(u => ({ ...u, owner: isOwner(u.phone) }));
    const roles = await Promise.all(users.map(u => resolveRole(stores.data, u.phone)));
    users.forEach((u, i) => { u.role = roles[i]; });
    users.sort((a, b) => (a.role === b.role ? 0 : a.role === 'manager' ? -1 : 1) || a.name.localeCompare(b.name, 'he'));
    return json(users);
  }

  if ((r = p.match(/^\/api\/users\/(\d+)$/)) && m === 'DELETE') {
    manager();
    if (r[1] === user.phone) throw new HttpError(400, 'אי אפשר למחוק את עצמך');
    if (await resolveRole(stores.data, r[1]) === 'manager') throw new HttpError(400, 'קודם מורידים את הרשאת המנהל, ואז אפשר להסיר');
    await stores.data.delete(`users/${r[1]}`);
    return json({ ok: true });
  }

  // managers add / remove other managers (owners from the site settings stay fixed)
  if ((r = p.match(/^\/api\/users\/(\d+)\/role$/)) && m === 'PUT') {
    manager();
    const phone = r[1];
    const { role } = await body();
    if (!['manager', 'staff'].includes(role)) throw new HttpError(400, 'הרשאה לא תקינה');
    if (!(await stores.data.get(`users/${phone}`, { type: 'json' }))) throw new HttpError(404, 'העובד לא רשום');
    if (isOwner(phone)) throw new HttpError(400, 'זה מנהל ראשי (מוגדר בהגדרות האתר ב-Netlify) ואי אפשר לשנות אותו מכאן');
    if (phone === user.phone) throw new HttpError(400, 'אי אפשר לשנות את ההרשאה של עצמך');
    if (role === 'manager') await stores.data.setJSON(`managers/${phone}`, { phone, added_by: user.phone, added_at: new Date().toISOString() });
    else await stores.data.delete(`managers/${phone}`);
    return json({ ok: true, role });
  }

  // ---- templates ----
  if (p === '/api/checklists/templates' && m === 'GET') return json(await cl.listTemplates(stores.data, { all: url.searchParams.get('all') === '1' && user.role === 'manager' }));
  if (p === '/api/checklists/templates' && m === 'POST') { manager(); return json(await cl.saveTemplate(stores.data, await body())); }
  if ((r = p.match(/^\/api\/checklists\/templates\/([\w-]+)$/))) {
    if (m === 'GET') { const t = await cl.getTemplate(stores.data, r[1]); return t ? json(t) : json({ error: 'לא נמצא' }, 404); }
    if (m === 'PUT') { manager(); return json(await cl.saveTemplate(stores.data, await body(), r[1])); }
    if (m === 'DELETE') { manager(); await cl.deleteTemplate(stores.data, r[1]); return json({ ok: true }); }
  }

  // ---- runs ----
  if (p === '/api/checklists/runs' && m === 'GET') {
    return json(await cl.listRuns(stores.data, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), phone: user.role === 'manager' ? null : user.phone }));
  }
  if (p === '/api/checklists/runs' && m === 'POST') {
    const b = await body();
    return json(await cl.startRun(stores.data, { template_id: b.template_id, date: b.date, user }));
  }
  if ((r = p.match(/^\/api\/checklists\/runs\/([\w-]+)$/))) {
    if (m === 'GET') { const run = await cl.checkAccess(stores.data, r[1], user); return json(await cl.getRun(stores.data, run.id)); }
    if (m === 'DELETE') { manager(); await cl.deleteRun(stores, r[1]); return json({ ok: true }); }
  }
  if ((r = p.match(/^\/api\/checklists\/runs\/([\w-]+)\/items\/(\d+)$/)) && m === 'PATCH') {
    return json(await cl.updateItem(stores.data, r[1], r[2], await body(), user));
  }
  if ((r = p.match(/^\/api\/checklists\/runs\/([\w-]+)\/items\/(\d+)\/photos$/)) && m === 'POST') {
    const form = await req.formData();
    return json(await cl.addPhoto(stores, r[1], r[2], form.get('photo'), user));
  }
  if ((r = p.match(/^\/api\/checklists\/runs\/([\w-]+)\/complete$/)) && m === 'POST') {
    return json(await cl.completeRun(stores.data, r[1], await body(), user));
  }
  if ((r = p.match(/^\/api\/checklists\/photos\/([\w~-]+)$/))) {
    if (m === 'GET') {
      const ph = await cl.getPhoto(stores, r[1], user);
      return new Response(ph.data, { headers: { 'Content-Type': ph.mime, 'Cache-Control': 'private, max-age=86400' } });
    }
    if (m === 'DELETE') { await cl.deletePhoto(stores, r[1], user); return json({ ok: true }); }
  }

  throw new HttpError(404, 'לא נמצא');
}
