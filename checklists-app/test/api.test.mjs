import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gonzo-cl-app-'));
process.env.MANAGER_PHONES = '050-111-2222, +972 52 333 4444';
process.env.MANAGER_PIN = '2468';
process.env.TEAM_CODE = 'gonzo';
const { handle } = await import('../lib/router.mjs');

/** tiny client that keeps the session cookie */
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const init = { method, headers: { cookie } };
    if (body instanceof FormData) init.body = body;
    else if (body) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await handle(new Request('https://cl.test' + url, init));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
}

const TEMPLATE = {
  name: 'פתיחה מלצרים', start_time: '17:30', deadline: '19:00', notes: 'עומדים מ-19:00',
  sections: [{ title: 'עמדות', items: [{ text: 'למלא עמדה', photo: 'required', minutes: 10 }, { text: 'לסדר שולחנות', minutes: 5 }] }]
};

test('sign-up rules: team code for staff, PIN for managers, phone normalisation', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/checklists/templates')).status, 401);
  let r = await c('POST', '/api/auth/register', { name: 'דנה', phone: '054-555-6666' });
  assert.deepEqual([r.status, r.body.need], [401, 'code']);
  r = await c('POST', '/api/auth/register', { name: 'דנה', phone: '0545556666', code: 'wrong' });
  assert.equal(r.status, 401);
  r = await c('POST', '/api/auth/register', { name: 'ד', phone: '0545556666', code: 'gonzo' });
  assert.match(r.body.error, /שם/);
  r = await c('POST', '/api/auth/register', { name: 'דנה כהן', phone: '+972-54-555-6666', code: 'gonzo' });
  assert.deepEqual(r.body.user, { name: 'דנה כהן', phone: '0545556666', role: 'staff' });

  const m = client();
  r = await m('POST', '/api/auth/register', { name: 'המנהל', phone: '0501112222' });
  assert.deepEqual([r.status, r.body.need], [401, 'pin']);                 // manager number without PIN
  r = await m('POST', '/api/auth/register', { name: 'המנהל', phone: '0501112222', pin: '2468' });
  assert.equal(r.body.user.role, 'manager');
  assert.equal((await m('GET', '/api/users')).body.length, 2);
  assert.equal((await c('GET', '/api/users')).status, 403);                // staff can't see users
});

test('manager creates lists; staff fill, photo, finish; staff only see their own', async () => {
  const m = client(), a = client(), b = client();
  await m('POST', '/api/auth/register', { name: 'מנהלת', phone: '0523334444', pin: '2468' });
  await a('POST', '/api/auth/register', { name: 'אבי', phone: '0521110000', code: 'gonzo' });
  await b('POST', '/api/auth/register', { name: 'בתיה', phone: '0521110001', code: 'gonzo' });

  assert.equal((await a('POST', '/api/checklists/templates', TEMPLATE)).status, 403);
  const t = (await m('POST', '/api/checklists/templates', TEMPLATE)).body;
  await m('POST', '/api/checklists/templates', { ...TEMPLATE, replace_by_name: true });   // re-import: no duplicate
  const list = (await a('GET', '/api/checklists/templates')).body;
  assert.deepEqual(list.map(x => [x.name, x.items, x.total_minutes, x.photos_required]), [['פתיחה מלצרים', 2, 15, 1]]);

  const run = (await a('POST', '/api/checklists/runs', { template_id: list[0].id, date: '2026-11-24' })).body;
  assert.equal((await a('POST', '/api/checklists/runs', { template_id: list[0].id, date: '2026-11-24' })).body.resumed, true);
  assert.equal((await a('PATCH', `/api/checklists/runs/${run.id}/items/2`, { done: true, note: 'שולחן 12 מתנדנד' })).body.done, 1);

  const fd = new FormData();
  fd.append('photo', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg');
  const photo = (await a('POST', `/api/checklists/runs/${run.id}/items/1/photos`, fd)).body;
  const bad = new FormData(); bad.append('photo', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await a('POST', `/api/checklists/runs/${run.id}/items/1/photos`, bad)).status, 400);

  // another staff member can't open or change it
  assert.equal((await b('GET', `/api/checklists/runs/${run.id}`)).status, 403);
  assert.equal((await b('PATCH', `/api/checklists/runs/${run.id}/items/1`, { done: true })).status, 403);
  assert.equal((await b('GET', `/api/checklists/photos/${photo.id}`)).status, 403);
  assert.equal((await b('GET', '/api/checklists/runs?from=2026-11-24&to=2026-11-24')).body.length, 0);

  await a('POST', `/api/checklists/runs/${run.id}/complete`, { note: 'סיימתי' });
  const r = (await m('GET', `/api/checklists/runs/${run.id}`)).body;
  assert.deepEqual([r.employee, r.done, r.total, r.photos, r.missing_photos, r.notes, r.total_minutes, r.deadline],
    ['אבי', 1, 2, 1, 0, 1, 15, '19:00']);
  assert.ok(r.completed_at);
  const img = await m('GET', `/api/checklists/photos/${photo.id}`);
  assert.equal(img.body.byteLength, 3);
  const all = (await m('GET', '/api/checklists/runs?from=2026-11-20&to=2026-11-30')).body;
  assert.equal(all.length, 1);
  assert.equal(all[0].items, undefined);                                   // list view is light

  await m('DELETE', `/api/checklists/runs/${run.id}`);
  assert.equal((await m('GET', `/api/checklists/runs/${run.id}`)).status, 404);
  assert.equal((await m('GET', `/api/checklists/photos/${photo.id}`)).status, 404);
  assert.equal(t.items, 2);
});

test('production refuses to run without SESSION_SECRET', async () => {
  const saved = process.env.LOCAL_STORE_DIR;
  delete process.env.LOCAL_STORE_DIR;
  const { checkRegistration, makeCookie } = await import('../lib/auth.mjs');
  assert.throws(() => makeCookie(checkRegistration({ name: 'x y', phone: '0541234567', code: 'gonzo' }), true), /SESSION_SECRET/);
  process.env.LOCAL_STORE_DIR = saved;
});

test('health, and managers can remove staff (not themselves)', async () => {
  const m = client(), s = client();
  assert.equal((await m('GET', '/api/health')).body.ok, true);
  await m('POST', '/api/auth/register', { name: 'מנהל', phone: '0501112222', pin: '2468' });
  await s('POST', '/api/auth/register', { name: 'עובד זמני', phone: '0549998888', code: 'gonzo' });
  assert.equal((await s('DELETE', '/api/users/0501112222')).status, 403);
  assert.equal((await m('DELETE', '/api/users/0501112222')).status, 400);
  assert.equal((await m('DELETE', '/api/users/0549998888')).status, 200);
  assert.ok(!(await m('GET', '/api/users')).body.some(u => u.phone === '0549998888'));
  // the function's own path works as well as /api/*
  assert.equal((await m('GET', '/.netlify/functions/api/auth/me')).body.user.role, 'manager');
});

test('managers can promote staff to manager and back; owners are fixed', async () => {
  const owner = client(), s = client(), other = client();
  await owner('POST', '/api/auth/register', { name: 'בעלים', phone: '0501112222', pin: '2468' });
  await s('POST', '/api/auth/register', { name: 'נועה', phone: '0547770001', code: 'gonzo' });
  await other('POST', '/api/auth/register', { name: 'רון', phone: '0547770002', code: 'gonzo' });

  assert.equal((await s('PUT', '/api/users/0547770002/role', { role: 'manager' })).status, 403);   // staff can't
  assert.equal((await owner('PUT', '/api/users/0547770001/role', { role: 'manager' })).body.role, 'manager');
  // takes effect on her current session right away
  assert.equal((await s('GET', '/api/auth/me')).body.user.role, 'manager');
  assert.equal((await s('GET', '/api/users')).status, 200);
  // a promoted manager needs the PIN next time she signs in
  const again = client();
  assert.equal((await again('POST', '/api/auth/register', { name: 'נועה', phone: '0547770001', code: 'gonzo' })).body.need, 'pin');
  assert.equal((await again('POST', '/api/auth/register', { name: 'נועה', phone: '0547770001', pin: '2468' })).body.user.role, 'manager');

  // she can't touch the owner, herself, or delete a manager
  assert.equal((await s('PUT', '/api/users/0501112222/role', { role: 'staff' })).status, 400);
  assert.equal((await s('PUT', '/api/users/0547770001/role', { role: 'staff' })).status, 400);
  assert.equal((await owner('DELETE', '/api/users/0547770001')).status, 400);
  const list = (await owner('GET', '/api/users')).body;
  const mine = ['0501112222', '0547770001', '0547770002'];
  assert.deepEqual(list.filter(u => mine.includes(u.phone)).map(u => [u.name, u.role, Boolean(u.owner)]).sort(),
    [['בעלים', 'manager', true], ['נועה', 'manager', false], ['רון', 'staff', false]]);

  assert.equal((await owner('PUT', '/api/users/0547770001/role', { role: 'staff' })).status, 200);
  assert.equal((await s('GET', '/api/auth/me')).body.user.role, 'staff');
  assert.equal((await owner('PUT', '/api/users/0549999999/role', { role: 'manager' })).status, 404);   // not registered
});
