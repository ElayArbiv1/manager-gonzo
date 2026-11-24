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
  return { s, vat, factor };
}

// labor cost: explicit cost from the file wins; otherwise hours x rate x employer factor
const LABOR_COST = `COALESCE(sh.cost, sh.hours * COALESCE(NULLIF(sh.hourly_rate, 0), e.hourly_rate, 0) * @factor)`;
const LABOR_FROM = `FROM shifts sh LEFT JOIN employees e ON e.name = sh.employee`;

function dailyRows(db, from, to) {
  const { vat, factor } = ctx(db);
  const p = { from, to, factor };
  const sales = db.prepare(`SELECT date, SUM(amount) amount, SUM(orders) orders, SUM(guests) guests, SUM(discount) discount, SUM(tips) tips
    FROM sales WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const labor = db.prepare(`SELECT sh.date, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost, COUNT(DISTINCT sh.employee) staff
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY sh.date`).all(p);
  const canc = db.prepare(`SELECT date, COUNT(*) count, SUM(amount) amount FROM cancellations WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const exp = db.prepare(`SELECT date, SUM(amount) amount FROM expenses WHERE date BETWEEN @from AND @to GROUP BY date`).all(p);
  const by = (arr) => Object.fromEntries(arr.map(r => [r.date, r]));
  const S = by(sales), L = by(labor), C = by(canc), E = by(exp);

  return eachDate(from, to).map(date => {
    const gross = S[date]?.amount || 0;
    const net = gross / (1 + vat);
    const orders = S[date]?.orders || 0;
    const hours = L[date]?.hours || 0;
    const laborCost = L[date]?.cost || 0;
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
      tips: r2(S[date]?.tips),
      labor_hours: r2(hours),
      labor_cost: r2(laborCost),
      staff: L[date]?.staff || 0,
      labor_pct: pct(laborCost, net),
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
    for (const k of ['sales', 'sales_net', 'orders', 'guests', 'discount', 'tips', 'labor_hours', 'labor_cost', 'cancel_count', 'cancel_amount', 'expenses']) a[k] = (a[k] || 0) + (d[k] || 0);
    return a;
  }, {});
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  t.avg_ticket = t.orders ? r2(t.sales / t.orders) : 0;
  t.labor_pct = pct(t.labor_cost, t.sales_net);
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
    if (d.labor_hours > 0 && d.sales === 0) out.push({ level: 'info', text: `${fmtDate(d.date)}: יש משמרות אבל אין מכירות. אולי חסר קובץ מכירות?` });
    if (d.sales > 0 && d.labor_hours === 0) out.push({ level: 'info', text: `${fmtDate(d.date)}: יש מכירות אבל אין שעות עבודה. אולי חסר קובץ משמרות?` });
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
  const { factor } = ctx(db);
  const p = { from, to, factor };
  const byEmployee = db.prepare(`SELECT sh.employee, MAX(COALESCE(sh.role, e.role)) role, COUNT(*) shifts, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost,
      MAX(COALESCE(NULLIF(sh.hourly_rate,0), e.hourly_rate)) rate
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY sh.employee ORDER BY hours DESC`).all(p)
    .map(r => ({ ...r, hours: r2(r.hours), cost: r2(r.cost) }));
  const byRole = db.prepare(`SELECT COALESCE(sh.role, e.role, 'לא מוגדר') role, SUM(sh.hours) hours, SUM(${LABOR_COST}) cost
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to GROUP BY 1 ORDER BY cost DESC`).all(p)
    .map(r => ({ ...r, hours: r2(r.hours), cost: r2(r.cost) }));
  const list = db.prepare(`SELECT sh.date, sh.employee, COALESCE(sh.role, e.role) role, sh.start, sh.end, sh.hours, ${LABOR_COST} cost
    ${LABOR_FROM} WHERE sh.date BETWEEN @from AND @to ORDER BY sh.date, sh.start`).all(p)
    .map(r => ({ ...r, cost: r2(r.cost) }));
  const missingRates = byEmployee.filter(r => !r.rate && !list.some(l => l.employee === r.employee && l.cost)).map(r => r.employee);
  const days = dailyRows(db, from, to).map(d => ({ date: d.date, weekday: d.weekday, hours: d.labor_hours, cost: d.labor_cost, staff: d.staff, sales_net: d.sales_net, labor_pct: d.labor_pct, sales_per_labor_hour: d.sales_per_labor_hour }));
  return { from, to, days, byEmployee, byRole, list, missingRates };
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
    const costPerHour = ds.filter(d => d.labor_hours).reduce((a, d) => a + d.labor_cost / d.labor_hours, 0) / (ds.filter(d => d.labor_hours).length || 1);
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
