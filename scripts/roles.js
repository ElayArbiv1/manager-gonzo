#!/usr/bin/env node
'use strict';
/**
 * Role costs from the terminal (same as the "תפקידים ועלויות" table in the app).
 *   npm run roles                                   list roles
 *   npm run roles -- "מטבח" hourly 50               cost per hour
 *   npm run roles -- "מנהל" shift 400 "ה=350,ו=350"  cost per shift, Thursday & Friday 350
 *   npm run roles -- "מלצר" tips                    paid from tips
 * Works while the server is running; the app picks the change up on the next page load.
 */
const { openDb } = require('../server/db');
const roles = require('../server/roles');

const LABEL = { tips: 'מטיפים', shift: 'למשמרת', hourly: 'לשעה' };
const [name, payType, rate, days] = process.argv.slice(2);
const db = openDb();
try {
  if (name) {
    roles.saveRole(db, { name, pay_type: payType, rate, weekday_rates: days });
    console.log(`נשמר: ${name}`);
  }
  for (const r of roles.listRoles(db)) {
    const cost = r.pay_type === 'tips' ? '' : r.rate == null ? 'לא הוזן' : `₪${r.rate}`;
    console.log(`${r.name.padEnd(18)} ${LABEL[r.pay_type].padEnd(8)} ${cost}${r.weekday_rates_text ? `  (${r.weekday_rates_text})` : ''}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
