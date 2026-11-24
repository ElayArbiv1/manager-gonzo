'use strict';
/** Builds an Excel workbook (RTL) from report data. */
const ExcelJS = require('exceljs');

const HEADERS = {
  date: 'תאריך', weekday: 'יום', sales: 'מכירות (ברוטו)', sales_net: 'מכירות (נטו)', orders: 'הזמנות', guests: 'סועדים',
  avg_ticket: 'ממוצע להזמנה', discount: 'הנחות', tips: 'טיפים', labor_hours: 'שעות עבודה', labor_cost: 'עלות עבודה',
  staff: 'עובדים', labor_pct: '% עבודה', sales_per_labor_hour: 'מכירות לשעת עבודה', cancel_count: 'ביטולים',
  cancel_amount: 'סכום ביטולים', cancel_pct: '% ביטולים', expenses: 'הוצאות', employee: 'עובד', role: 'תפקיד',
  shifts: 'משמרות', hours: 'שעות', cost: 'עלות', rate: 'שכר לשעה', start: 'כניסה', end: 'יציאה', item: 'פריט',
  qty: 'כמות', amount: 'סכום', reason: 'סיבה', approved_by: 'אושר ע״י', time: 'שעה', source: 'מקור', count: 'כמות',
  pct: '%', category: 'קטגוריה',
  tip_hours: 'שעות מלצרים/בר', business_hours: 'שעות עסק', tip_staff: 'מלצרים/בר', tips_per_hour: 'שעתי (טיפ לשעה)',
  tips_per_hour_source: 'מקור השעתי', tip_topup: 'השלמה למינימום', pay_type: 'אופן תשלום', tip_funded: 'משולם מטיפים'
};

function addSheet(wb, name, rows, cols) {
  if (!rows || !rows.length) return;
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const keys = cols || Object.keys(rows[0]).filter(k => typeof rows[0][k] !== 'object' || rows[0][k] === null);
  ws.columns = keys.map(k => ({ header: HEADERS[k] || k, key: k, width: Math.max(10, (HEADERS[k] || k).length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  for (const r of rows) ws.addRow(Object.fromEntries(keys.map(k => [k, r[k]])));
}

async function buildWorkbook({ summary, labor, cancellations, sales }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gonzo Manager';
  if (summary) {
    const t = summary.totals;
    const ws = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
    ws.columns = [{ width: 28 }, { width: 18 }, { width: 18 }];
    ws.addRow([`סיכום ${summary.from} עד ${summary.to}`]).font = { bold: true, size: 14 };
    ws.addRow([]);
    ws.addRow(['מדד', 'תקופה נוכחית', 'תקופה קודמת']).font = { bold: true };
    const p = summary.prev.totals;
    for (const k of ['sales', 'sales_net', 'orders', 'avg_ticket', 'labor_hours', 'labor_cost', 'labor_pct', 'sales_per_labor_hour', 'cancel_count', 'cancel_amount', 'cancel_pct', 'expenses']) {
      ws.addRow([HEADERS[k], t[k], p[k]]);
    }
    if (summary.alerts.length) {
      ws.addRow([]);
      ws.addRow(['התראות']).font = { bold: true };
      for (const a of summary.alerts) ws.addRow([a.text]);
    }
    addSheet(wb, 'פירוט יומי', summary.days);
  }
  if (labor) {
    addSheet(wb, 'שעות לפי יום', labor.days);
    addSheet(wb, 'שעות לפי עובד', labor.byEmployee);
    addSheet(wb, 'משמרות', labor.list);
  }
  if (cancellations) {
    addSheet(wb, 'ביטולים לפי עובד', cancellations.byEmployee);
    addSheet(wb, 'ביטולים לפי סיבה', cancellations.byReason);
    addSheet(wb, 'רשימת ביטולים', cancellations.list);
  }
  if (sales) {
    addSheet(wb, 'פריטים מובילים', sales.topItems);
    addSheet(wb, 'מכירות לפי ערוץ', sales.byChannel);
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
