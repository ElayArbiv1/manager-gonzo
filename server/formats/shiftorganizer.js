'use strict';
/**
 * ShiftOrganizer / Tabit Shift "דוח מפורט" export: one sheet per employee.
 *   row: "שם עובד: <name> / בין התאריכים: dd/mm/yyyy - dd/mm/yyyy"
 *   header: יום | תאריך | תפקיד | כניסה | יציאה | הערות | [תפקיד | כניסה | יציאה | הערות]... | סיכום | עלות | טיפ מזומן | טיפ אשראי | סה"כ טיפ | השלמה
 * A day can hold several shift blocks (split shifts). "סיכום" (hours), "עלות" (cost to the business),
 * tips and "השלמה" (minimum-wage top-up) are day totals; they are split between the blocks by hours.
 * Blocks with a clock-in but no clock-out (shift still open) are skipped.
 */
const { sheetRows, findHeader, parseRange, text, num } = require('./sheet');
const { toDate, toTime } = require('../importers');

function detect(wb) {
  return wb.worksheets.some(ws => {
    const top = sheetRows(ws).slice(0, 4).flatMap(r => r.vals.map(text)).join(' ');
    return /דוח מפורט/.test(top) && /שם עובד/.test(top);
  });
}

const hoursBetween = (a, b) => (a instanceof Date && b instanceof Date ? (b - a) / 3600e3 : null);

function parse(wb) {
  const shifts = [];
  const notes = [];
  let range = null, open = 0, employees = 0;

  for (const ws of wb.worksheets) {
    const rows = sheetRows(ws);
    const top = rows.slice(0, 4).flatMap(r => r.vals.map(text));
    const nameCell = top.find(t => /שם עובד/.test(t));
    if (!nameCell) continue;
    const employee = nameCell.match(/שם עובד\s*:\s*([^\n]+)/)?.[1].trim();
    if (!employee) continue;
    employees++;
    range = range || parseRange(nameCell.match(/בין התאריכים[^\n]*/)?.[0] || '');

    const h = findHeader(rows, ['תאריך', 'תפקיד', 'כניסה', 'יציאה']);
    if (!h) continue;
    const roles = h.all('תפקיד'), ins = h.all('כניסה'), outs = h.all('יציאה'), notesCols = h.all('הערות');
    const c = { date: h.col('תאריך'), hours: h.col('סיכום'), cost: h.col('עלות'), tipCash: h.col('טיפ מזומן'),
      tipCard: h.col('טיפ אשראי'), tips: h.col('סה"כ טיפ'), topup: h.col('השלמה') };

    for (const r of rows.slice(h.index + 1)) {
      const date = toDate(r.vals[c.date]);
      if (!date) continue;                                   // summary rows ("סיכום מנהל" ...)
      const blocks = roles.map((rc, i) => ({
        role: text(r.vals[rc]) || null, in: r.vals[ins[i]], out: r.vals[outs[i]], note: text(r.vals[notesCols[i]]) || null
      })).filter(b => b.in instanceof Date || toTime(b.in));
      if (!blocks.length) continue;                          // planned only, not worked
      const done = blocks.filter(b => hoursBetween(b.in, b.out) != null || (toTime(b.in) && toTime(b.out)));
      open += blocks.length - done.length;
      if (!done.length) continue;

      const blockHours = done.map(b => hoursBetween(b.in, b.out) ?? 0);
      const sumBlocks = blockHours.reduce((a, x) => a + x, 0);
      const dayHours = num(r.vals[c.hours]);
      const totalHours = dayHours != null ? dayHours : sumBlocks;
      const share = i => (sumBlocks ? blockHours[i] / sumBlocks : 1 / done.length);
      const cost = c.cost >= 0 ? num(r.vals[c.cost]) : null;
      const tipCash = c.tipCash >= 0 ? num(r.vals[c.tipCash]) : null;
      const tipCard = c.tipCard >= 0 ? num(r.vals[c.tipCard]) : null;
      const tipsTotal = c.tips >= 0 && num(r.vals[c.tips]) != null ? num(r.vals[c.tips]) : (tipCash != null || tipCard != null ? (tipCash || 0) + (tipCard || 0) : null);
      const topup = c.topup >= 0 ? num(r.vals[c.topup]) : null;
      const split = (v, i) => (v == null ? null : Math.round(v * share(i) * 100) / 100);

      done.forEach((b, i) => shifts.push({
        date, employee, role: b.role,
        start: toTime(b.in), end: toTime(b.out),
        hours: Math.round(totalHours * share(i) * 100) / 100,
        cost: split(cost, i), tips: split(tipsTotal, i), topup: split(topup, i)
      }));
    }
  }
  if (!employees) throw new Error('לא נמצאו עובדים בדוח');
  if (open) notes.push(`${open} משמרות פתוחות (בלי יציאה) לא יובאו. הן ייכנסו בייבוא הבא, אחרי שייסגרו`);
  const withTips = shifts.filter(s => s.tips != null).length;
  if (!withTips) notes.push('אין עדיין טיפים בדוח, ולכן השעתי יחושב מהשירות בדוח של ביקום');
  const dates = shifts.map(s => s.date).sort();
  range = range || (dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null);
  return {
    format: 'shiftorganizer', label: 'דוח מפורט מ-ShiftOrganizer', source: 'shift', range,
    employees,
    parts: [{ kind: 'shifts', rows: shifts, range }],
    notes
  };
}

module.exports = { id: 'shiftorganizer', detect, parse };
