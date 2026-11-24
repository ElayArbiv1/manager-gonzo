'use strict';
/**
 * Generates realistic demo files in sample-data/ (4 weeks):
 *  - beecomm-sales.csv          daily Z-report style, Hebrew headers
 *  - website-orders.csv         order level, English headers (WooCommerce / Shopify style)
 *  - beecomm-items.csv          sales by item
 *  - beecomm-cancellations.csv  cancellation report
 *  - shifts.csv                 clock-in / clock-out export
 * Usage: node scripts/make-sample-data.js [endDate YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'sample-data');
fs.mkdirSync(out, { recursive: true });

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const pad = n => String(n).padStart(2, '0');
const il = d => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
const csv = rows => '﻿' + rows.map(r => r.map(c => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';

const end = new Date((process.argv[2] || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
const start = new Date(end); start.setUTCDate(end.getUTCDate() - 27);

const dayFactor = [0.9, 0.7, 0.75, 0.85, 1.25, 1.1, 1.3]; // Sun..Sat
const menu = [
  ['המבורגר גונזו', 'עיקריות', 68], ['צ\'יפס', 'תוספות', 22], ['סלט קיסר', 'סלטים', 52], ['שניצל', 'עיקריות', 64],
  ['פיש אנד צ\'יפס', 'עיקריות', 72], ['בירה מהחבית', 'משקאות', 32], ['קוקה קולה', 'משקאות', 14], ['עוגת שוקולד', 'קינוחים', 38],
  ['כנפיים', 'ראשונות', 44], ['טבעות בצל', 'ראשונות', 28]
];
const staff = [
  ['דנה כהן', 'מלצר/ית', 42], ['יוסי לוי', 'מלצר/ית', 40], ['מאיה אברהם', 'ברמן/ית', 45], ['אבי מזרחי', 'טבח/ית', 55],
  ['רון פרץ', 'טבח/ית', 50], ['נועה ביטון', 'אחראי/ת משמרת', 60], ['עומר דהן', 'שוטף/ת', 36], ['שירה גולן', 'מלצר/ית', 40]
];
const reasons = ['טעות הקלדה', 'לקוח התחרט', 'מנה חזרה מהשולחן', 'עיכוב במטבח', 'הזמנה כפולה', ''];

const sales = [['תאריך', 'יום', 'מספר חשבונות', 'מספר סועדים', 'סה"כ הנחות', 'טיפים', 'סה"כ כולל מע"מ']];
const web = [['Order ID', 'Created At', 'Order Type', 'Payment Method', 'Discount', 'Total']];
const items = [['תאריך', 'שם פריט', 'קטגוריה', 'כמות', 'סה"כ']];
const canc = [['תאריך', 'שעה', 'שם פריט', 'כמות', 'סכום', 'בוטל ע"י', 'סיבת ביטול', 'אושר ע"י']];
const shifts = [['שם העובד', 'תפקיד', 'תאריך', 'שעת כניסה', 'שעת יציאה', 'סה"כ שעות']];
let orderId = 10000;

for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  const f = dayFactor[d.getUTCDay()] * (0.9 + rnd() * 0.2);
  const checks = Math.round(85 * f);
  const guests = Math.round(checks * 2.3);
  const gross = Math.round(checks * (118 + rnd() * 20));
  sales.push([il(d), ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][d.getUTCDay()], checks, guests, Math.round(gross * 0.03), Math.round(gross * 0.1), gross]);

  const webOrders = Math.round(14 * f);
  for (let i = 0; i < webOrders; i++) {
    const h = 11 + Math.floor(rnd() * 11);
    const total = Math.round((60 + rnd() * 160) * 100) / 100;
    web.push([++orderId, `${d.toISOString().slice(0, 10)} ${pad(h)}:${pad(Math.floor(rnd() * 60))}`, pick(['delivery', 'delivery', 'pickup']), pick(['credit card', 'credit card', 'bit', 'paypal']), rnd() < 0.15 ? 10 : 0, total]);
  }

  for (const [name, cat, price] of menu) {
    const qty = Math.round((5 + rnd() * 40) * f);
    items.push([il(d), name, cat, qty, qty * price]);
  }

  const nCanc = Math.floor(rnd() * 5 * f);
  for (let i = 0; i < nCanc; i++) {
    const [name, , price] = pick(menu);
    const who = pick(rnd() < 0.35 ? [staff[1]] : staff.filter(s => s[1] === 'מלצר/ית' || s[1] === 'ברמן/ית'));
    canc.push([il(d), `${pad(12 + Math.floor(rnd() * 10))}:${pad(Math.floor(rnd() * 60))}`, name, 1, price, who[0], pick(reasons), 'נועה ביטון']);
  }

  const busy = d.getUTCDay() >= 4 || d.getUTCDay() === 0;
  const crew = busy ? staff : staff.filter((_, i) => i % 3 !== 2);
  for (const [name, role] of crew) {
    const sh = role === 'טבח/ית' ? 10 : 11 + Math.floor(rnd() * 6);
    const len = 6 + Math.floor(rnd() * 4) + (rnd() < 0.5 ? 0.5 : 0);
    const endMin = Math.round((sh + len) * 60);
    const eh = Math.floor(endMin / 60) % 24, em = endMin % 60;
    shifts.push([name, role, il(d), `${pad(sh)}:00`, `${pad(eh)}:${pad(em)}`, `${Math.floor(len)}:${pad((len % 1) * 60)}`]);
  }
}

// a forgotten clock-out to show the alert
shifts.push(['יוסי לוי', 'מלצר/ית', il(end), '11:00', '02:30', '15:30']);

const write = (f, rows) => fs.writeFileSync(path.join(out, f), csv(rows));
write('beecomm-sales.csv', [['דוח מכירות יומי - גונזו'], [`מתאריך ${il(start)} עד ${il(end)}`], [], ...sales]);
write('website-orders.csv', web);
write('beecomm-items.csv', items);
write('beecomm-cancellations.csv', canc);
write('shifts.csv', shifts);
fs.writeFileSync(path.join(out, 'employees-rates.json'), JSON.stringify(staff.map(([name, role, rate]) => ({ name, role, hourly_rate: rate })), null, 2));
console.log(`נוצרו קבצי דוגמה ב-${out} (${il(start)} - ${il(end)})`);
