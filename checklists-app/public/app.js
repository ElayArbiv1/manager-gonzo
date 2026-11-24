'use strict';
/* Shell of the standalone checklists app: login, routing and the helpers shared/checklists.js expects. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf1 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 });
const num = v => (v == null ? '-' : nf1.format(v));
const dmy = d => (d ? d.split('-').reverse().join('/') : '');
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(url, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) }, credentials: 'same-origin' };
  if (opts.body && !(opts.body instanceof FormData)) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('צריך להתחבר'); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'שגיאה'), { need: data.need });
  return data;
}

function table(cols, rows, { empty = 'אין נתונים' } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const th = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const td = r => cols.map(c => `<td>${c.html ? c.html(r[c.key], r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key] ?? '')}</td>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows.map(r => `<tr>${td(r)}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- state / routing ----------
const state = { from: addDays(iso(new Date()), -6), to: iso(new Date()) };
const q = () => `from=${state.from}&to=${state.to}`;
const views = {};

// managers: who signed up
views['cl-users'] = {
  title: 'עובדים רשומים',
  hideRange: true,
  async render(el) {
    const users = await api('/api/users');
    el.innerHTML = clTabs('cl-users') + `<div class="card">
      <p class="muted" style="margin-top:0">כל מי שנרשם לאפליקציה. מנהלים מוגדרים לפי מספר הטלפון בהגדרות האתר ב-Netlify (MANAGER_PHONES).</p>
      ${table([
        { key: 'name', label: 'שם' }, { key: 'phone', label: 'טלפון', html: v => `<a href="tel:${esc(v)}" dir="ltr">${esc(v)}</a>` },
        { key: 'role', label: 'הרשאה', html: v => (v === 'manager' ? '<span class="pill good">מנהל</span>' : '<span class="pill">צוות</span>') },
        { key: 'last_login', label: 'כניסה אחרונה', fmt: v => (v ? new Date(v).toLocaleString('he-IL') : '') }
      ], users, { empty: 'עוד אף אחד לא נרשם' })}</div>`;
  }
};

async function render() {
  const route = (location.hash || '#checklists').slice(1).split('?')[0];
  const view = views[route] || views.checklists;
  $('#page-title').textContent = view.title;
  $('#range').classList.toggle('hidden', Boolean(view.hideRange));
  $('#from').value = state.from; $('#to').value = state.to;
  const el = $('#view');
  el.innerHTML = '<div class="empty">טוען…</div>';
  try { await view.render(el); } catch (err) { el.innerHTML = `<div class="card empty error">${esc(err.message)}</div>`; }
}

function setRange(from, to) { state.from = from; state.to = to; render(); }
$$('#range [data-preset]').forEach(b => b.onclick = () => (b.dataset.preset === 'today' ? setRange(iso(new Date()), iso(new Date())) : setRange(addDays(iso(new Date()), -6), iso(new Date()))));
$('#from').onchange = () => setRange($('#from').value, $('#to').value < $('#from').value ? $('#from').value : $('#to').value);
$('#to').onchange = () => setRange($('#from').value > $('#to').value ? $('#to').value : $('#from').value, $('#to').value);

// ---------- login ----------
function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }

function enter(user) {
  window.CL_CONTEXT = { user };
  try { localStorage.setItem('gonzo-cl-name', user.name); } catch { /* ignore */ }
  $('#who').textContent = `${user.name}${user.role === 'manager' ? ' · מנהל' : ''}`;
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  render();
}

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api('/api/auth/register', { method: 'POST', body: f });
    enter(r.user);
  } catch (err) {
    if (err.need === 'pin') $('#pin-field').classList.remove('hidden');
    if (err.need === 'code') $('#code-field').classList.remove('hidden');
    $('#login-error').textContent = err.message;
  }
};
$('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.hash = ''; showLogin(); };

window.addEventListener('hashchange', () => { if (window.CL_CONTEXT) render(); });

window.addEventListener('DOMContentLoaded', async () => {
  try { $('#login-form').name.value = localStorage.getItem('gonzo-cl-name') || ''; } catch { /* ignore */ }
  try {
    const cfg = await api('/api/auth/config');
    if (cfg.teamCode) $('#code-field').classList.remove('hidden');
  } catch { /* ignore */ }
  try { enter((await api('/api/auth/me')).user); } catch { showLogin(); }
});
