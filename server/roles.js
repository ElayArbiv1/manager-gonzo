'use strict';
/** Role pay settings: tips / per shift / per hour, with optional per-weekday overrides. */
const { syncRoles } = require('./db');

const PAY_TYPES = ['tips', 'shift', 'hourly'];
const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];   // 0 = Sunday

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }

/** "ה=350, ו=350" (also "ה׳: 350") → { d4: 350, d5: 350 }; empty → null */
function parseWeekdayRates(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const out = {};
  for (const part of s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^([אבגדהוש])['׳]?\s*[=:]\s*(\d+(?:\.\d+)?)$/);
    if (!m) throw bad(`לא הבנתי את "${part}". כותבים למשל: ה=350, ו=350`);
    out[`d${DAYS.indexOf(m[1])}`] = Number(m[2]);
  }
  return out;
}

function formatWeekdayRates(json) {
  if (!json) return '';
  let o; try { o = typeof json === 'string' ? JSON.parse(json) : json; } catch { return ''; }
  return Object.entries(o).sort().map(([k, v]) => `${DAYS[Number(k.slice(1))]}=${v}`).join(', ');
}

function listRoles(db) {
  syncRoles(db);
  return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM shifts s LEFT JOIN employees e ON e.name = s.employee
      WHERE COALESCE(NULLIF(s.role, ''), e.role) = r.name AND s.date >= date('now', '-60 day')) shifts_60d
    FROM roles r ORDER BY CASE pay_type WHEN 'tips' THEN 0 ELSE 1 END, name`).all()
    .map(r => ({ ...r, weekday_rates_text: formatWeekdayRates(r.weekday_rates) }));
}

function saveRole(db, { id, name, pay_type, rate, weekday_rates }) {
  if (!PAY_TYPES.includes(pay_type)) throw bad('סוג תשלום לא תקין');
  const r = rate === '' || rate == null ? null : Number(rate);
  if (r != null && !(r >= 0)) throw bad('עלות לא תקינה');
  const wd = pay_type === 'tips' ? null : (typeof weekday_rates === 'object' && weekday_rates ? weekday_rates : parseWeekdayRates(weekday_rates));
  const wdJson = wd && Object.keys(wd).length ? JSON.stringify(wd) : null;
  const rateVal = pay_type === 'tips' ? null : r;
  if (id) {
    db.prepare('UPDATE roles SET pay_type = ?, rate = ?, weekday_rates = ? WHERE id = ?').run(pay_type, rateVal, wdJson, Number(id));
  } else {
    if (!String(name || '').trim()) throw bad('שם תפקיד חובה');
    db.prepare(`INSERT INTO roles(name, pay_type, rate, weekday_rates) VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET pay_type = excluded.pay_type, rate = excluded.rate, weekday_rates = excluded.weekday_rates`)
      .run(String(name).trim(), pay_type, rateVal, wdJson);
  }
}

module.exports = { PAY_TYPES, DAYS, parseWeekdayRates, formatWeekdayRates, listRoles, saveRole };
