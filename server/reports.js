'use strict';
const { getSettings } = require('./db');

const r2 = n => Math.round((n || 0) * 100) / 100;
const pct = (a, b) => (b ? r2((a / b) * 100) : null);

function eachDate(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end && out.length < 1000) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function shiftDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();

function ctx(db) {
  const s = getSettings(db);
  const vat = Number(s.vat_percent || 0) / 100;
  const factor = Number(s.employer_cost_factor || 1);
  const minWage = Number(s.min_hourly_wage) || 0;
  return { s, vat, factor, minWage };
}

/*
 * Business labor cost per shift row, in order of precedence:
 *   1. role paid from tips (waiters / bartenders)        → 0 (the tips pay them)
 *   2. explicit cost column in the shift file            → as is
 *   3. personal hourly wage on the employee              → hours × wage × employer factor
 *   4. role rate: per shift                              → rate (full cost to the business)
 *               per hour                                 → hours × rate
 * Tip-funded hours get a minimum-wage top-up per day, see dailyRows().
 */
const ROLE = `COALESCE(NULLIF(sh.role, ''), e.role)`;
const PERSONAL_RATE = `COALESCE(NULLIF(sh.hourly_rate, 0), NULLIF(e.hourly_rate, 0))`;
const IS_TIPS = `(r.pay_type = 'tips')`;
const LABOR_COST = `((CASE
  WHEN sh.cost IS NOT NULL THEN sh.cost
  WHEN ${IS_TIPS} THEN 0
  WHEN ${PERSONAL_RATE} IS NOT NULL THEN sh.hours * ${PERSONAL_RATE} * @factor
  WHEN r.pay_type = 'shift' THEN COALESCE(r.rate, 0)
  WHEN r.pay_type = 'hourly' THEN sh.hours * COALESCE(r.rate, 0)
  ELSE 0 END) + COALESCE(sh.topup, 0))`;
const NO_RATE = `(r.pay_type IS NULL OR NOT ${IS_TIPS}) AND sh.cost IS NULL AND ${PERSONAL_RATE} IS NULL AND r.rate IS NULL`;
const LABOR_FROM = `FROM shifts sh LEFT JOIN employees e ON e.name = sh.employee LEFT JOIN roles r ON r.name = ${ROLE}`;

function dailyRows(db, from, to) {
  const { vat, factor, minWage } = ctx(db);
  const p = { from, to, factor };
  const sales = db.prepare(`SELECT date, SUM(amount) amount, SUM(orders) orders, SUM(guests) guests, SUM(discount) discount, SUM(tips) tips
    FROM sales WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const labor = db.prepare(`SELECT sh.date, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost, COUNT(DISTINCT sh.employee) staff,
      SUM(CASE WHEN ${IS_TIPS} THEN sh.hours ELSE 0 END) tip_hours,
      COUNT(DISTINCT CASE WHEN ${IS_TIPS} THEN sh.employee END) tip_staff,
      SUM(CASE WHEN ${IS_TIPS} THEN sh.tips END) shift_tips,
      SUM(CASE WHEN sh.topup IS NOT NULL THEN 1 ELSE 0 END) app_topup_rows,
      SUM(CASE WHEN sh.tips_per_hour IS NOT NULL THEN sh.tips_per_hour * sh.hours END) / SUM(CASE WHEN sh.tips_per_hour IS NOT NULL THEN sh.hours END) shift_tph
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY sh.date`).all(p);
  // "השעתי" as calculated by the shift app (ShiftOrganizer), hours-weighted when a day has several rows
  const tipsDaily = db.prepare(`SELECT date,
      COALESCE(SUM(tips_per_hour * hours) / SUM(hours), AVG(tips_per_hour)) tph, SUM(tips) tips, SUM(hours) hours
    FROM tips_daily WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const canc = db.prepare(`SELECT date, COUNT(*) count, SUM(amount) amount FROM cancellations WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const exp = db.prepare(`SELECT date, SUM(amount) amount FROM expenses WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const by = (arr) => Object.fromEntries(arr.map(r => [r.date, r]));
  const S = by(sales), L = by(labor), C = by(canc), E = by(exp), T = by(tipsDaily);

  // Sales imported as period totals (e.g. a weekly Beecomm report) sit on one day. For the days they cover:
  // no daily sales split exists, and the period's service/tips are spread by each day's tip-funded hours.
  const periods = db.prepare(`SELECT period_from, date, SUM(tips) tips FROM sales
    WHERE period_from IS NOT NULL AND date >= @from AND period_from <= @to GROUP BY period_from, date`).all(p);
  const inPeriod = {};
  for (const per of periods) {
    const ph = db.prepare(`SELECT SUM(CASE WHEN ${IS_TIPS} THEN sh.hours ELSE 0 END) h ${LABOR_FROM} WHERE sh.date BETWEEN ? AND ?`)
      .get(per.period_from, per.date).h || 0;
    const tph = ph ? per.tips / ph : null;
    for (const d of eachDate(per.period_from, per.date)) inPeriod[d] = { from: per.period_from, to: per.date, tph };
  }

  return eachDate(from, to).map(date => {
    const gross = S[date]?.amount || 0;
    const net = gross / (1 + vat);
    const orders = S[date]?.orders || 0;
    const hours = L[date]?.hours || 0;
    const tipHours = L[date]?.tip_hours || T[date]?.hours || 0;
    // השעתי: taken from the shift app when available; calculating it is only a fallback
    const appTph = T[date]?.tph ?? L[date]?.shift_tph ?? null;
    const knownTips = T[date]?.tips ?? L[date]?.shift_tips ?? null;
    const per = inPeriod[date];
    const salesTips = per ? (per.tph != null ? per.tph * tipHours : 0) : (S[date]?.tips || 0);
    const tips = knownTips != null ? knownTips : appTph != null ? appTph * tipHours : salesTips;
    const tipsPerHour = appTph != null ? appTph : per && knownTips == null ? (tipHours ? per.tph : null) : tipHours ? tips / tipHours : null;
    // tips that came from the shift app (per employee) count as the app's numbers, not our estimate
    const tphSource = appTph != null || L[date]?.shift_tips != null ? 'shift_app' : tipsPerHour != null ? (per ? 'calculated_period' : 'calculated') : null;
    // the business tops tip-funded staff up to minimum wage
    // the shift app's own top-up ("השלמה") is already inside the shift cost; only estimate when it has none
    const topup = !L[date]?.app_topup_rows && minWage && tipHours && tipsPerHour < minWage ? (minWage - tipsPerHour) * tipHours * factor : 0;
    const laborCost = (L[date]?.cost || 0) + topup;
    const cancelAmount = C[date]?.amount || 0;
    return {
      date,
      weekday: DAY_NAMES[weekday(date)],
      sales: r2(gross),
      sales_net: r2(net),
      orders,
      guests: S[date]?.guests || 0,
      avg_ticket: orders ? r2(gross / orders) : 0,
      discount: r2(S[date]?.discount),
      tips: r2(tips),
      labor_hours: r2(hours),
      tip_hours: r2(tipHours),
      business_hours: r2(hours - tipHours),
      tip_staff: L[date]?.tip_staff || 0,
      tips_per_hour: tipsPerHour == null ? null : r2(tipsPerHour),
      tips_per_hour_source: tphSource,
      tip_topup: r2(topup),
      labor_cost: r2(laborCost),
      staff: L[date]?.staff || 0,
      labor_pct: per ? null : pct(laborCost, net),          // no daily sales inside a period report
      sales_period: per ? { from: per.from, to: per.to } : null,
      sales_per_labor_hour: hours ? r2(net / hours) : null,
      cancel_count: C[date]?.count || 0,
      cancel_amount: r2(cancelAmount),
      cancel_pct: pct(cancelAmount, gross),
      expenses: r2(E[date]?.amount)
    };
  });
}

function totalsOf(days) {
  const t = days.reduce((a, d) => {
    for (const k of ['sales', 'sales_net', 'orders', 'guests', 'discount', 'tips', 'labor_hours', 'tip_hours', 'business_hours', 'tip_topup', 'labor_cost', 'cancel_count', 'cancel_amount', 'expenses']) a[k] = (a[k] || 0) + (d[k] || 0);
    return a;
  }, {});
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  t.avg_ticket = t.orders ? r2(t.sales / t.orders) : 0;
  t.labor_pct = pct(t.labor_cost, t.sales_net);
  t.tips_per_hour = t.tip_hours ? r2(t.tips / t.tip_hours) : null;
  t.cancel_pct = pct(t.cancel_amount, t.sales);
  t.sales_per_labor_hour = t.labor_hours ? r2(t.sales_net / t.labor_hours) : null;
  t.prime_cost_pct = pct(t.labor_cost + t.expenses, t.sales_net);
  t.days_with_sales = days.filter(d => d.sales > 0).length;
  t.avg_daily_sales = t.days_with_sales ? r2(t.sales / t.days_with_sales) : 0;
  return t;
}

function summary(db, from, to) {
  const { s } = ctx(db);
  const days = dailyRows(db, from, to);
  const totals = totalsOf(days);
  const len = days.length;
  const prevFrom = shiftDays(from, -len), prevTo = shiftDays(from, -1);
  const prevTotals = totalsOf(dailyRows(db, prevFrom, prevTo));
  const bySource = db.prepare(`SELECT source, SUM(amount) amount, SUM(orders) orders FROM sales WHERE date BETWEEN ? AND ? GROUP BY source ORDER BY amount DESC`).all(from, to)
    .map(r => ({ ...r, amount: r2(r.amount) }));
  return {
    from, to, prev: { from: prevFrom, to: prevTo, totals: prevTotals },
    totals, days, bySource,
    targets: {
      labor_pct: Number(s.labor_target_percent) || null,
      weekly_sales: Number(s.weekly_sales_target) || null,
      cancel_pct: Number(s.cancel_alert_percent) || null
    },
    alerts: alerts(db, from, to, days, totals, s)
  };
}

function alerts(db, from, to, days, totals, s) {
  const out = [];
  const laborTarget = Number(s.labor_target_percent);
  const cancelAlert = Number(s.cancel_alert_percent);
  if (laborTarget && totals.labor_pct != null && totals.labor_pct > laborTarget) {
    out.push({ level: 'warn', text: `עלות העבודה ${totals.labor_pct}% מהמכירות (נטו), מעל היעד של ${laborTarget}%` });
  }
  for (const d of days) {
    if (laborTarget && d.labor_pct != null && d.sales > 0 && d.labor_pct > laborTarget * 1.25) {
      out.push({ level: 'info', text: `יום ${d.weekday} ${fmtDate(d.date)}: עבודה ${d.labor_pct}% מהמכירות, כדאי לבדוק את סידור המשמרות` });
    }
    if (d.sales_period) continue;
    if (d.labor_hours > 0 && d.sales === 0) out.push({ level: 'info', text: `${fmtDate(d.date)}: יש משמרות אבל אין מכירות. אולי חסר קובץ מכירות?` });
    if (d.sales > 0 && d.labor_hours === 0) out.push({ level: 'info', text: `${fmtDate(d.date)}: יש מכירות אבל אין שעות עבודה. אולי חסר קובץ משמרות?` });
  }
  const topupDays = days.filter(d => d.tip_topup > 0);
  if (topupDays.length) {
    out.push({ level: 'warn', text: `ב-${topupDays.length} ימים השעתי היה מתחת לשכר המינימום (${topupDays.map(d => `${fmtDate(d.date)}: ₪${d.tips_per_hour}`).join(', ')}). ההשלמה, ₪${Math.round(totals.tip_topup)}, נכללה בעלות העבודה` });
  }
  if (cancelAlert && totals.cancel_pct != null && totals.cancel_pct > cancelAlert) {
    out.push({ level: 'warn', text: `הביטולים הם ${totals.cancel_pct}% מהמכירות, מעל סף ההתראה של ${cancelAlert}%` });
  }
  const topCancel = db.prepare(`SELECT employee, COUNT(*) c, SUM(amount) a FROM cancellations WHERE date BETWEEN ? AND ? AND employee IS NOT NULL GROUP BY employee ORDER BY a DESC`).all(from, to);
  if (topCancel.length >= 3) {
    const avg = topCancel.reduce((x, r) => x + r.a, 0) / topCancel.length;
    for (const r of topCancel) if (r.a > avg * 2 && r.a > 100) out.push({ level: 'warn', text: `${r.employee}: ${r.c} ביטולים בסך ₪${Math.round(r.a)}, יותר מפי 2 מהממוצע` });
  }
  const long = db.prepare(`SELECT date, employee, hours FROM shifts WHERE date BETWEEN ? AND ? AND hours > 12`).all(from, to);
  for (const l of long) out.push({ level: 'info', text: `${l.employee} עבד/ה ${l.hours} שעות ב-${fmtDate(l.date)}. בדקו שלא נשכחה החתמת יציאה` });
  return out;
}

function fmtDate(d) { const [y, m, day] = d.split('-'); return `${day}/${m}`; }

function labor(db, from, to) {
  const { factor, minWage } = ctx(db);
  const p = { from, to, factor };
  const payType = `CASE WHEN ${IS_TIPS} THEN 'tips' WHEN sh.cost IS NOT NULL THEN 'file' WHEN ${PERSONAL_RATE} IS NOT NULL THEN 'personal' ELSE r.pay_type END`;
  const byEmployee = db.prepare(`SELECT sh.employee, MAX(${ROLE}) role, COUNT(*) shifts, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost,
      MAX(${PERSONAL_RATE}) rate, MAX(${payType}) pay_type, SUM(sh.tips) tips
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY sh.employee ORDER BY hours DESC`).all(p)
    .map(r => ({ ...r, hours: r2(r.hours), cost: r2(r.cost), tips: r.tips == null ? null : r2(r.tips) }));
  const byRole = db.prepare(`SELECT COALESCE(${ROLE}, 'לא מוגדר') role,
      CASE WHEN MAX(r.pay_type) = 'tips' THEN 'tips' WHEN SUM(CASE WHEN sh.cost IS NULL THEN 1 ELSE 0 END) = 0 THEN 'file' ELSE MAX(r.pay_type) END pay_type, MAX(r.rate) rate, COUNT(*) shifts, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY 1 ORDER BY cost DESC`).all(p)
    .map(r => ({ ...r, hours: r2(r.hours), cost: r2(r.cost) }));
  const list = db.prepare(`SELECT sh.date, sh.employee, ${ROLE} role, sh.start, sh.end, sh.hours, ${LABOR_COST} cost, ${IS_TIPS} AS tip_funded, sh.tips
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to ORDER BY sh.date, sh.start`).all(p)
    .map(r => ({ ...r, cost: r2(r.cost), tip_funded: Boolean(r.tip_funded) }));
  // roles whose shifts have no way to compute a cost yet
  const missingRates = db.prepare(`SELECT DISTINCT COALESCE(${ROLE}, 'ללא תפקיד') role ${LABOR_FROM}
    WHERE sh.date BETWEEN @from AND @to AND ${NO_RATE}`).all(p).map(r => r.role);
  const days = dailyRows(db, from, to).map(d => ({
    date: d.date, weekday: d.weekday, hours: d.labor_hours, business_hours: d.business_hours, tip_hours: d.tip_hours, tip_staff: d.tip_staff,
    tips: d.tips, tips_per_hour: d.tips_per_hour, tips_per_hour_source: d.tips_per_hour_source, tip_topup: d.tip_topup, cost: d.labor_cost, staff: d.staff, sales_net: d.sales_net,
    labor_pct: d.labor_pct, sales_per_labor_hour: d.sales_per_labor_hour
  }));
  return { from, to, days, byEmployee, byRole, list, missingRates, minWage: minWage || null };
}

function cancellations(db, from, to) {
  const q = (sql) => db.prepare(sql).all(from, to).map(r => ({ ...r, amount: r2(r.amount) }));
  return {
    from, to,
    days: dailyRows(db, from, to).map(d => ({ date: d.date, weekday: d.weekday, count: d.cancel_count, amount: d.cancel_amount, sales: d.sales, pct: d.cancel_pct })),
    byEmployee: q(`SELECT COALESCE(employee,'לא ידוע') employee, COUNT(*) count, SUM(amount) amount FROM cancellations WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC`),
    byReason: q(`SELECT COALESCE(reason,'ללא סיבה') reason, COUNT(*) count, SUM(amount) amount FROM cancellations WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC`),
    byItem: q(`SELECT COALESCE(item,'לא ידוע') item, COUNT(*) count, SUM(amount) amount FROM cancellations WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC LIMIT 20`),
    list: q(`SELECT date, time, item, qty, amount, employee, reason, approved_by, source FROM cancellations WHERE date BETWEEN ? AND ? ORDER BY date, time`)
  };
}

function sales(db, from, to) {
  const q = (sql) => db.prepare(sql).all(from, to);
  const days = dailyRows(db, from, to);
  const bySourceDay = q(`SELECT date, source, SUM(amount) amount FROM sales WHERE date BETWEEN ? AND ? GROUP BY date, source`);
  const sources = [...new Set(bySourceDay.map(r => r.source))];
  const byHour = q(`SELECT hour, SUM(amount) amount, SUM(orders) orders FROM sales WHERE date BETWEEN ? AND ? AND hour IS NOT NULL GROUP BY hour ORDER BY hour`)
    .map(r => ({ ...r, amount: r2(r.amount) }));
  const byChannel = q(`SELECT COALESCE(channel,'לא מוגדר') channel, SUM(amount) amount, SUM(orders) orders FROM sales WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC`)
    .map(r => ({ ...r, amount: r2(r.amount) }));
  const byPayment = q(`SELECT COALESCE(payment,'לא מוגדר') payment, SUM(amount) amount FROM sales WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC`)
    .map(r => ({ ...r, amount: r2(r.amount) }));
  const topItems = q(`SELECT item, MAX(category) category, SUM(qty) qty, SUM(amount) amount FROM items WHERE date BETWEEN ? AND ? GROUP BY item ORDER BY amount DESC LIMIT 25`)
    .map(r => ({ ...r, amount: r2(r.amount) }));
  const byCategory = q(`SELECT COALESCE(category,'אחר') category, SUM(qty) qty, SUM(amount) amount FROM items WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY amount DESC`)
    .map(r => ({ ...r, amount: r2(r.amount) }));

  // weekday averages over the last 8 weeks (for comparison / forecasting)
  const histFrom = shiftDays(to, -55);
  const hist = dailyRows(db, histFrom, to).filter(d => d.sales > 0);
  const weekdayAvg = DAY_NAMES.map((name, i) => {
    const ds = hist.filter(d => weekday(d.date) === i);
    return { weekday: name, avg_sales: ds.length ? r2(ds.reduce((a, d) => a + d.sales, 0) / ds.length) : 0, samples: ds.length };
  });

  return {
    from, to, sources,
    days: days.map(d => ({ date: d.date, weekday: d.weekday, sales: d.sales, orders: d.orders, avg_ticket: d.avg_ticket, guests: d.guests, discount: d.discount, tips: d.tips,
      bySource: Object.fromEntries(sources.map(s => [s, r2(bySourceDay.find(r => r.date === d.date && r.source === s)?.amount)])) })),
    byHour, byChannel, byPayment, topItems, byCategory, weekdayAvg
  };
}

/** Simple forecast for the next 7 days: weekday average from the last 8 weeks, with suggested labor hours. */
function forecast(db, fromDate) {
  const { s, vat } = ctx(db);
  const start = fromDate;
  const hist = dailyRows(db, shiftDays(start, -56), shiftDays(start, -1)).filter(d => d.sales > 0);
  const target = Number(s.labor_target_percent) || 28;
  return eachDate(start, shiftDays(start, 6)).map(date => {
    const ds = hist.filter(d => weekday(d.date) === weekday(date));
    const avg = ds.length ? ds.reduce((a, d) => a + d.sales, 0) / ds.length : 0;
    const splh = ds.filter(d => d.sales_per_labor_hour).map(d => d.sales_per_labor_hour);
    const avgSplh = splh.length ? splh.reduce((a, b) => a + b, 0) / splh.length : null;
    const costPerHour = ds.filter(d => d.business_hours).reduce((a, d) => a + d.labor_cost / d.business_hours, 0) / (ds.filter(d => d.business_hours).length || 1);
    const budget = (avg / (1 + vat)) * target / 100;
    return {
      date, weekday: DAY_NAMES[weekday(date)], samples: ds.length,
      expected_sales: r2(avg),
      labor_budget: r2(budget),
      suggested_hours: costPerHour ? r2(budget / costPerHour) : null,
      hist_sales_per_labor_hour: avgSplh ? r2(avgSplh) : null
    };
  });
}

module.exports = { summary, labor, cancellations, sales, forecast, dailyRows, totalsOf, eachDate, shiftDays, DAY_NAMES };
