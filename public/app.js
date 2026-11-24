'use strict';
/* Gonzo Manager - client. Vanilla JS, hash routing, Chart.js. */

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 });
const money = v => (v == null ? '-' : '₪' + nf.format(v));
const num = v => (v == null ? '-' : nf1.format(v));
const pctf = v => (v == null ? '-' : nf1.format(v) + '%');
const dmy = d => (d ? d.split('-').reverse().join('/') : '');
const dm = d => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '');
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(url, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, init);
  if (res.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('נדרשת התחברות'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'שגיאה');
  return data;
}

// ---------- state ----------
const state = {
  from: null, to: null, settings: {},
  charts: []
};
try { const saved = JSON.parse(localStorage.getItem('gonzo-range') || 'null'); if (saved) Object.assign(state, saved); } catch { /* ignore */ }

function weekRange(offsetWeeks = 0) {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - now.getDay() + offsetWeeks * 7); // Sunday
  return [iso(start), addDays(iso(start), 6)];
}
if (!state.from) [state.from, state.to] = weekRange(0);

function setRange(from, to) {
  state.from = from; state.to = to;
  try { localStorage.setItem('gonzo-range', JSON.stringify({ from, to })); } catch { /* ignore */ }
  $('#from').value = from; $('#to').value = to;
  render();
}
const q = () => `from=${state.from}&to=${state.to}`;

// ---------- charts ----------
function destroyCharts() { state.charts.forEach(c => c.destroy()); state.charts = []; }
function chart(canvas, config) {
  Chart.defaults.font.family = 'Heebo, Arial, sans-serif';
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--border');
  config.options = {
    maintainAspectRatio: false, responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', rtl: true, labels: { boxWidth: 12 } }, tooltip: { rtl: true } },
    ...config.options
  };
  const c = new Chart(canvas, config);
  state.charts.push(c);
  return c;
}
const series = i => css(`--series-${(i % 4) + 1}`);

// ---------- UI pieces ----------
function kpi(label, value, { prev, inverse = false, fmt = money, bar } = {}) {
  let delta = '';
  if (prev != null && value != null && prev !== 0) {
    const ch = ((value - prev) / Math.abs(prev)) * 100;
    const dir = ch > 0.5 ? 'up' : ch < -0.5 ? 'down' : '';
    delta = `<div class="delta ${dir} ${inverse ? 'inverse' : ''}">${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${nf1.format(Math.abs(ch))}% מול תקופה קודמת (${fmt(prev)})</div>`;
  } else if (prev != null) {
    delta = `<div class="delta">תקופה קודמת: ${fmt(prev)}</div>`;
  }
  const barHtml = bar ? `<div class="bar" title="${esc(bar.title)}"><span style="width:${Math.min(100, Math.max(0, bar.value))}%"></span></div>` : '';
  return `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${fmt(value)}</div>${delta}${barHtml}</div>`;
}

function table(cols, rows, { foot, empty = 'אין נתונים לתקופה' } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const th = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const td = r => cols.map(c => {
    const v = r[c.key];
    const cls = c.cls ? c.cls(v, r) : '';
    return `<td class="${cls}">${c.html ? c.html(v, r) : esc(c.fmt ? c.fmt(v, r) : v ?? '')}</td>`;
  }).join('');
  const tf = foot ? `<tfoot><tr>${cols.map(c => `<td>${esc(foot[c.key] != null ? (c.fmt ? c.fmt(foot[c.key], foot) : foot[c.key]) : '')}</td>`).join('')}</tr></tfoot>` : '';
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows.map(r => `<tr>${td(r)}</tr>`).join('')}</tbody>${tf}</table></div>`;
}

const noData = (what = 'נתונים') => `<div class="card empty">אין ${esc(what)} לתקופה הזו.<br><a class="btn primary" href="#import">📥 לייבוא דוחות</a></div>`;

// ---------- views ----------
const views = {};

views.dashboard = {
  title: 'לוח בקרה',
  async render(el) {
    const d = await api(`/api/reports/summary?${q()}`);
    const t = d.totals, p = d.prev.totals;
    const laborTarget = d.targets.labor_pct;
    const weeklyTarget = d.targets.weekly_sales;
    if (!t.sales && !t.labor_hours && !t.cancel_count) { el.innerHTML = noData('נתוני מכירות או משמרות'); return; }

    el.innerHTML = `
      ${d.alerts.length ? `<div class="alerts" style="margin-bottom:16px">${d.alerts.map(a => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('')}</div>` : ''}
      <div class="grid kpis">
        ${kpi('מכירות (כולל מע״מ)', t.sales, { prev: p.sales, bar: weeklyTarget ? { value: t.sales / weeklyTarget * 100, title: `יעד שבועי ${money(weeklyTarget)}` } : null })}
        ${kpi('הזמנות', t.orders, { prev: p.orders, fmt: num })}
        ${kpi('ממוצע להזמנה', t.avg_ticket, { prev: p.avg_ticket })}
        ${kpi('שעות עבודה', t.labor_hours, { prev: p.labor_hours, fmt: num, inverse: true })}
        ${kpi('עלות עבודה', t.labor_cost, { prev: p.labor_cost, inverse: true })}
        ${kpi(`עלות עבודה מהמכירות${laborTarget ? ` (יעד ${laborTarget}%)` : ''}`, t.labor_pct, { prev: p.labor_pct, fmt: pctf, inverse: true })}
        ${kpi('מכירות נטו לשעת עבודה', t.sales_per_labor_hour, { prev: p.sales_per_labor_hour })}
        ${kpi('ביטולים', t.cancel_amount, { prev: p.cancel_amount, inverse: true })}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>מכירות מול עלות עבודה לפי יום</h3><div class="chart-box"><canvas id="c1"></canvas></div></div>
        <div class="card"><h3>מכירות לפי מקור</h3>${d.bySource.length ? '<div class="chart-box"><canvas id="c2"></canvas></div>' : '<div class="empty">אין מכירות</div>'}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>פירוט יומי</h3>
        ${table([
          { key: 'weekday', label: 'יום' },
          { key: 'date', label: 'תאריך', fmt: dmy },
          { key: 'sales', label: 'מכירות', fmt: money },
          { key: 'orders', label: 'הזמנות', fmt: num },
          { key: 'avg_ticket', label: 'ממוצע', fmt: money },
          { key: 'labor_hours', label: 'שעות', fmt: num },
          { key: 'labor_cost', label: 'עלות עבודה', fmt: money },
          { key: 'labor_pct', label: '% עבודה', fmt: pctf, cls: v => (laborTarget && v > laborTarget ? 'bad' : '') },
          { key: 'sales_per_labor_hour', label: 'מכירות/שעה', fmt: money },
          { key: 'cancel_count', label: 'ביטולים', fmt: num },
          { key: 'cancel_amount', label: '₪ ביטולים', fmt: money }
        ], d.days, { foot: { ...t, weekday: 'סה״כ', date: '', avg_ticket: t.avg_ticket } })}
      </div>`;

    chart($('#c1'), {
      type: 'bar',
      data: {
        labels: d.days.map(x => `${x.weekday} ${dm(x.date)}`),
        datasets: [
          { label: 'מכירות', data: d.days.map(x => x.sales), backgroundColor: series(0), borderRadius: 4 },
          { label: 'עלות עבודה', data: d.days.map(x => x.labor_cost), backgroundColor: series(1), borderRadius: 4 },
          { label: 'ביטולים', data: d.days.map(x => x.cancel_amount), backgroundColor: series(3), borderRadius: 4 }
        ]
      },
      options: { scales: { y: { ticks: { callback: v => '₪' + nf.format(v) } } } }
    });
    if (d.bySource.length) chart($('#c2'), {
      type: 'doughnut',
      data: { labels: d.bySource.map(s => sourceLabel(s.source)), datasets: [{ data: d.bySource.map(s => s.amount), backgroundColor: d.bySource.map((_, i) => series(i)), borderWidth: 0 }] },
      options: { interaction: {}, cutout: '60%' }
    });
  }
};

const SOURCE_LABELS = { website: 'אתר', beecomm: 'ביקום (קופה)', shift: 'אפליקציית משמרות', manual: 'הזנה ידנית', wolt: 'וולט', tenbis: 'תן ביס' };
const sourceLabel = s => SOURCE_LABELS[s] || s;

views.sales = {
  title: 'מכירות',
  async render(el) {
    const d = await api(`/api/reports/sales?${q()}`);
    if (!d.days.some(x => x.sales)) { el.innerHTML = noData('מכירות'); return; }
    const tot = d.days.reduce((a, x) => ({ sales: a.sales + x.sales, orders: a.orders + x.orders, discount: a.discount + x.discount, tips: a.tips + x.tips, guests: a.guests + x.guests }), { sales: 0, orders: 0, discount: 0, tips: 0, guests: 0 });
    el.innerHTML = `
      <div class="grid kpis">
        ${kpi('סה״כ מכירות', tot.sales)}
        ${kpi('הזמנות', tot.orders, { fmt: num })}
        ${kpi('ממוצע להזמנה', tot.orders ? tot.sales / tot.orders : 0)}
        ${tot.guests ? kpi('סועדים', tot.guests, { fmt: num }) : ''}
        ${kpi('הנחות', tot.discount)}
        ${kpi('טיפים', tot.tips)}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>מכירות יומיות לפי מקור</h3><div class="chart-box"><canvas id="s1"></canvas></div></div>
        <div class="card"><h3>מכירות לפי שעה ביום</h3>${d.byHour.length ? '<div class="chart-box"><canvas id="s2"></canvas></div>' : '<div class="empty">כדי לראות פילוח לפי שעה צריך קובץ שבו יש שעת הזמנה</div>'}</div>
        <div class="card"><h3>ממוצע מכירות לפי יום בשבוע (8 שבועות אחרונים)</h3><div class="chart-box"><canvas id="s3"></canvas></div></div>
        <div class="card"><h3>ערוצי מכירה ואמצעי תשלום</h3>
          ${table([{ key: 'channel', label: 'ערוץ' }, { key: 'orders', label: 'הזמנות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.byChannel)}
          <div style="height:12px"></div>
          ${table([{ key: 'payment', label: 'אמצעי תשלום' }, { key: 'amount', label: 'סכום', fmt: money }], d.byPayment)}
        </div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>פריטים מובילים</h3>${table([{ key: 'item', label: 'פריט' }, { key: 'category', label: 'קטגוריה' }, { key: 'qty', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.topItems, { empty: 'אין עדיין נתוני פריטים. אפשר לייבא דוח "מכירות לפי פריט" מהקופה' })}</div>
        <div class="card"><h3>לפי קטגוריה</h3>${table([{ key: 'category', label: 'קטגוריה' }, { key: 'qty', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.byCategory, { empty: 'אין נתוני קטגוריות' })}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>פירוט יומי</h3>
        ${table([
          { key: 'weekday', label: 'יום' }, { key: 'date', label: 'תאריך', fmt: dmy },
          ...d.sources.map(s => ({ key: 's_' + s, label: sourceLabel(s), fmt: money })),
          { key: 'sales', label: 'סה״כ', fmt: money }, { key: 'orders', label: 'הזמנות', fmt: num }, { key: 'avg_ticket', label: 'ממוצע', fmt: money },
          { key: 'discount', label: 'הנחות', fmt: money }, { key: 'tips', label: 'טיפים', fmt: money }
        ], d.days.map(x => ({ ...x, ...Object.fromEntries(Object.entries(x.bySource).map(([k, v]) => ['s_' + k, v])) })))}
      </div>`;

    chart($('#s1'), {
      type: 'bar',
      data: { labels: d.days.map(x => `${x.weekday} ${dm(x.date)}`), datasets: d.sources.map((s, i) => ({ label: sourceLabel(s), data: d.days.map(x => x.bySource[s] || 0), backgroundColor: series(i), borderRadius: 4 })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => '₪' + nf.format(v) } } } }
    });
    if (d.byHour.length) chart($('#s2'), {
      type: 'bar',
      data: { labels: d.byHour.map(h => `${String(h.hour).padStart(2, '0')}:00`), datasets: [{ label: 'מכירות', data: d.byHour.map(h => h.amount), backgroundColor: series(0), borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } } }
    });
    chart($('#s3'), {
      type: 'bar',
      data: { labels: d.weekdayAvg.map(w => w.weekday), datasets: [{ label: 'ממוצע מכירות', data: d.weekdayAvg.map(w => w.avg_sales), backgroundColor: series(1), borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } } }
    });
  }
};

views.labor = {
  title: 'שעות ועלות עבודה',
  async render(el) {
    const d = await api(`/api/reports/labor?${q()}`);
    if (!d.list.length) { el.innerHTML = noData('משמרות'); return; }
    const tot = d.days.reduce((a, x) => ({ hours: a.hours + x.hours, cost: a.cost + x.cost, sales_net: a.sales_net + x.sales_net }), { hours: 0, cost: 0, sales_net: 0 });
    el.innerHTML = `
      ${d.missingRates.length ? `<div class="alert warn" style="margin-bottom:16px">לעובדים הבאים אין שכר לשעה, ולכן העלות שלהם מחושבת כ-0: ${d.missingRates.map(esc).join(', ')}. <a href="#employees">להגדרת שכר</a></div>` : ''}
      <div class="grid kpis">
        ${kpi('סה״כ שעות', tot.hours, { fmt: num })}
        ${kpi('עלות עבודה', tot.cost)}
        ${kpi('% מהמכירות נטו', tot.sales_net ? tot.cost / tot.sales_net * 100 : null, { fmt: pctf })}
        ${kpi('עלות ממוצעת לשעה', tot.hours ? tot.cost / tot.hours : null)}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>שעות ועלות לפי יום</h3><div class="chart-box"><canvas id="l1"></canvas></div></div>
        <div class="card"><h3>לפי תפקיד</h3>${table([{ key: 'role', label: 'תפקיד' }, { key: 'hours', label: 'שעות', fmt: num }, { key: 'cost', label: 'עלות', fmt: money }], d.byRole)}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>שעתי יומי</h3>
        ${table([{ key: 'weekday', label: 'יום' }, { key: 'date', label: 'תאריך', fmt: dmy }, { key: 'staff', label: 'עובדים', fmt: num }, { key: 'hours', label: 'שעות', fmt: num }, { key: 'cost', label: 'עלות', fmt: money }, { key: 'sales_net', label: 'מכירות נטו', fmt: money }, { key: 'labor_pct', label: '% עבודה', fmt: pctf }, { key: 'sales_per_labor_hour', label: 'מכירות/שעה', fmt: money }], d.days, { foot: { weekday: 'סה״כ', hours: tot.hours, cost: tot.cost, sales_net: tot.sales_net } })}
      </div>
      <div class="card" style="margin-top:16px"><h3>לפי עובד</h3>
        ${table([{ key: 'employee', label: 'עובד' }, { key: 'role', label: 'תפקיד' }, { key: 'shifts', label: 'משמרות', fmt: num }, { key: 'hours', label: 'שעות', fmt: num }, { key: 'rate', label: 'שכר לשעה', fmt: money }, { key: 'cost', label: 'עלות', fmt: money }], d.byEmployee)}
      </div>
      <div class="card" style="margin-top:16px"><h3>כל המשמרות</h3>
        ${table([{ key: 'date', label: 'תאריך', fmt: dmy }, { key: 'employee', label: 'עובד' }, { key: 'role', label: 'תפקיד' }, { key: 'start', label: 'כניסה' }, { key: 'end', label: 'יציאה' }, { key: 'hours', label: 'שעות', fmt: num, cls: v => (v > 12 ? 'bad' : '') }, { key: 'cost', label: 'עלות', fmt: money }], d.list)}
      </div>`;
    chart($('#l1'), {
      data: {
        labels: d.days.map(x => `${x.weekday} ${dm(x.date)}`),
        datasets: [
          { type: 'bar', label: 'עלות (₪)', data: d.days.map(x => x.cost), backgroundColor: series(1), borderRadius: 4, yAxisID: 'y', order: 1 },
          { type: 'line', label: 'שעות', data: d.days.map(x => x.hours), borderColor: series(0), backgroundColor: series(0), yAxisID: 'y1', tension: .3, order: 0 }
        ]
      },
      options: { scales: { y: { position: 'right' }, y1: { position: 'left', grid: { drawOnChartArea: false } } } }
    });
  }
};

views.cancellations = {
  title: 'ביטולים',
  async render(el) {
    const d = await api(`/api/reports/cancellations?${q()}`);
    if (!d.list.length) { el.innerHTML = noData('ביטולים'); return; }
    const tot = d.days.reduce((a, x) => ({ count: a.count + x.count, amount: a.amount + x.amount, sales: a.sales + x.sales }), { count: 0, amount: 0, sales: 0 });
    el.innerHTML = `
      <div class="grid kpis">
        ${kpi('מספר ביטולים', tot.count, { fmt: num })}
        ${kpi('סכום ביטולים', tot.amount)}
        ${kpi('% מהמכירות', tot.sales ? tot.amount / tot.sales * 100 : null, { fmt: pctf })}
        ${kpi('ממוצע לביטול', tot.count ? tot.amount / tot.count : null)}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>ביטולים לפי יום</h3><div class="chart-box"><canvas id="x1"></canvas></div></div>
        <div class="card"><h3>לפי עובד</h3>${table([{ key: 'employee', label: 'עובד' }, { key: 'count', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.byEmployee)}</div>
        <div class="card"><h3>לפי סיבה</h3>${table([{ key: 'reason', label: 'סיבה' }, { key: 'count', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.byReason)}</div>
        <div class="card"><h3>פריטים שבוטלו הכי הרבה</h3>${table([{ key: 'item', label: 'פריט' }, { key: 'count', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.byItem)}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>רשימת ביטולים</h3>
        ${table([{ key: 'date', label: 'תאריך', fmt: dmy }, { key: 'time', label: 'שעה' }, { key: 'item', label: 'פריט' }, { key: 'qty', label: 'כמות', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }, { key: 'employee', label: 'עובד' }, { key: 'reason', label: 'סיבה' }, { key: 'approved_by', label: 'אושר ע״י' }], d.list)}
      </div>`;
    chart($('#x1'), {
      type: 'bar',
      data: { labels: d.days.map(x => `${x.weekday} ${dm(x.date)}`), datasets: [{ label: 'סכום ביטולים', data: d.days.map(x => x.amount), backgroundColor: series(3), borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } } }
    });
  }
};

views.forecast = {
  title: 'תחזית ותכנון משמרות',
  async render(el) {
    const start = state.from;
    const d = await api(`/api/reports/forecast?from=${start}`);
    const hasData = d.some(x => x.samples);
    el.innerHTML = `
      <div class="card">
        <h3>תחזית ל-7 ימים מ-${dmy(start)}</h3>
        <p class="muted">התחזית מבוססת על ממוצע אותו יום בשבוע ב-8 השבועות שלפני. תקציב העבודה מחושב לפי יעד אחוז העבודה מההגדרות, והשעות המומלצות לפי העלות הממוצעת לשעה בעבר. לבנות סידור עבודה לפי זה.</p>
        ${hasData ? table([
          { key: 'weekday', label: 'יום' }, { key: 'date', label: 'תאריך', fmt: dmy },
          { key: 'expected_sales', label: 'מכירות צפויות', fmt: money },
          { key: 'labor_budget', label: 'תקציב עבודה', fmt: money },
          { key: 'suggested_hours', label: 'שעות מומלצות', fmt: num },
          { key: 'hist_sales_per_labor_hour', label: 'מכירות/שעה בעבר', fmt: money },
          { key: 'samples', label: 'שבועות בחישוב' }
        ], d) : '<div class="empty">צריך לפחות שבוע אחד של נתונים כדי לחשב תחזית</div>'}
      </div>`;
  }
};

views.import = {
  title: 'ייבוא דוחות',
  hideRange: true,
  async render(el) {
    const [kinds, imports] = await Promise.all([api('/api/import/kinds'), api('/api/imports')]);
    el.innerHTML = `
      <div class="grid two">
        <div class="card">
          <h3>העלאת קובץ</h3>
          <div class="row" style="margin-bottom:12px">
            <label>סוג הדוח
              <select id="imp-kind"><option value="">זיהוי אוטומטי</option>${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
            </label>
            <label>מקור
              <select id="imp-source">
                <option value="beecomm">ביקום (קופה)</option>
                <option value="website">אתר</option>
                <option value="shift">אפליקציית משמרות</option>
                <option value="wolt">וולט</option>
                <option value="tenbis">תן ביס</option>
                <option value="manual">אחר</option>
              </select>
            </label>
          </div>
          <div id="drop" class="dropzone">
            <div style="font-size:32px">📄</div>
            <div><b>גררו לכאן קובץ CSV או Excel</b> או לחצו לבחירה</div>
            <div class="muted" style="font-size:13px">ייצוא מביקום, מהאתר או מאפליקציית המשמרות</div>
            <input type="file" id="file" accept=".csv,.xlsx,.xlsm,.txt" hidden>
          </div>
        </div>
        <div class="card">
          <h3>איך זה עובד</h3>
          <ol class="steps">
            <li>מייצאים את הדוח מהמערכת (ביקום / אתר / משמרות) כקובץ Excel או CSV</li>
            <li>מעלים כאן. המערכת מזהה את העמודות לבד, גם בעברית</li>
            <li>בודקים שהשיוך נכון ולוחצים "ייבוא"</li>
            <li>העלאה חוזרת של אותו טווח תאריכים <b>מחליפה</b> את הנתונים הקודמים מאותו מקור, כך שאין כפילויות</li>
          </ol>
          <p class="muted" style="font-size:13px">טיפ: ייבאו קודם את דוח המשמרות. כך העובדים נוספים אוטומטית, ואז אפשר להגדיר להם שכר לשעה.</p>
          <h3 style="margin-top:16px">הזנה ידנית מהירה</h3>
          <form id="manual" class="row">
            <label>תאריך <input type="date" name="date" required value="${iso(new Date())}"></label>
            <label>סכום מכירות <input type="number" name="amount" step="0.01" min="0" required style="width:120px"></label>
            <label>הזמנות <input type="number" name="orders" min="0" style="width:80px"></label>
            <label>מקור <select name="source"><option value="website">אתר</option><option value="beecomm">ביקום</option><option value="manual">אחר</option></select></label>
            <button class="btn">שמירה</button>
          </form>
        </div>
      </div>
      <div id="imp-preview"></div>
      <div class="card" style="margin-top:16px"><h3>היסטוריית ייבוא</h3>
        ${table([
          { key: 'created_at', label: 'הועלה', fmt: v => new Date(v + 'Z').toLocaleString('he-IL') },
          { key: 'kind', label: 'סוג', fmt: v => kinds[v]?.label || v },
          { key: 'source', label: 'מקור', fmt: sourceLabel },
          { key: 'filename', label: 'קובץ' },
          { key: 'date_from', label: 'מתאריך', fmt: dmy }, { key: 'date_to', label: 'עד', fmt: dmy },
          { key: 'rows', label: 'שורות', fmt: num },
          { key: 'id', label: '', html: id => `<button class="btn small danger" data-del="${id}">מחיקה</button>` }
        ], imports, { empty: 'עדיין לא יובאו קבצים' })}
      </div>`;

    const drop = $('#drop'), file = $('#file');
    drop.onclick = () => file.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
    file.onchange = () => file.files[0] && upload(file.files[0]);
    $('#imp-kind').onchange = () => {
      const k = $('#imp-kind').value;
      if (k === 'shifts') $('#imp-source').value = 'shift';
    };

    $$('[data-del]', el).forEach(b => b.onclick = async () => {
      if (!confirm('למחוק את הייבוא הזה ואת כל הנתונים שנכנסו ממנו?')) return;
      await api(`/api/imports/${b.dataset.del}`, { method: 'DELETE' });
      toast('נמחק'); render();
    });

    $('#manual').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('/api/sales/manual', { method: 'POST', body: f }); toast('נשמר'); render(); } catch (err) { toast(err.message); }
    };

    async function upload(f) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('kind', $('#imp-kind').value);
      try {
        const p = await api('/api/import/preview', { method: 'POST', body: fd });
        if (p.kind === 'shifts' && $('#imp-source').value !== 'shift' && !$('#imp-kind').value) $('#imp-source').value = 'shift';
        showPreview(p, kinds);
      } catch (err) { toast(err.message, 5000); }
    }
  }
};

function showPreview(p, kinds) {
  const box = $('#imp-preview');
  const render = () => {
    const def = kinds[p.kind];
    box.innerHTML = `
      <div class="card" style="margin-top:16px">
        <h3>תצוגה מקדימה: ${esc(p.filename)} <span class="pill">${p.totalRows} שורות</span></h3>
        <div class="row" style="margin-bottom:12px">
          <label>הקובץ הוא
            <select id="pv-kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
          </label>
        </div>
        <p class="muted" style="margin:0 0 8px">שיוך עמודות מהקובץ לשדות במערכת:</p>
        <div class="mapping">
          ${Object.entries(def.fields).map(([f, fd]) => `
            <label class="${fd.required ? 'req' : ''}"><span>${esc(fd.label)}</span>
              <select data-field="${f}"><option value="">(לא קיים)</option>${p.headers.map(h => `<option value="${esc(h)}" ${p.mapping[f] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>
            </label>`).join('')}
        </div>
        <div id="pv-check" style="margin-top:14px"></div>
        <details style="margin-top:12px"><summary class="muted">שורות מהקובץ המקורי</summary>
          ${table(p.headers.map(h => ({ key: h, label: h })), p.sample)}
        </details>
        <div class="row" style="margin-top:14px">
          <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="checkbox" id="pv-replace" checked> להחליף נתונים קיימים מאותו מקור בטווח התאריכים</label>
          <button class="btn primary" id="pv-commit">ייבוא</button>
          <button class="btn ghost" id="pv-cancel">ביטול</button>
        </div>
      </div>`;
    showCheck(p.preview);
    $('#pv-kind').onchange = async () => {
      p.kind = $('#pv-kind').value;
      const c = await api('/api/import/check', { method: 'POST', body: { token: p.token, kind: p.kind, guess: true } });
      p.mapping = c.mapping;
      p.preview = c;
      render();
    };
    $$('[data-field]', box).forEach(s => s.onchange = () => { p.mapping[s.dataset.field] = s.value || undefined; recheck(); });
    $('#pv-cancel').onclick = () => { box.innerHTML = ''; };
    $('#pv-commit').onclick = async () => {
      try {
        const r = await api('/api/import/commit', { method: 'POST', body: { token: p.token, kind: p.kind, mapping: clean(p.mapping), source: $('#imp-source').value, replace: $('#pv-replace').checked } });
        toast(`יובאו ${r.inserted} שורות (${dmy(r.from)} עד ${dmy(r.to)})${r.removed ? `, הוחלפו ${r.removed} קודמות` : ''}${r.skipped ? `, ${r.skipped} שורות דולגו` : ''}`, 5000);
        setRange(r.from, r.to);
        location.hash = p.kind === 'shifts' ? '#labor' : p.kind === 'cancellations' ? '#cancellations' : p.kind === 'items' ? '#sales' : '#dashboard';
      } catch (err) { toast(err.message, 5000); }
    };
  };
  const clean = m => Object.fromEntries(Object.entries(m).filter(([, v]) => v));
  async function recheck() {
    const c = await api('/api/import/check', { method: 'POST', body: { token: p.token, kind: p.kind, mapping: clean(p.mapping) } });
    p.preview = c;
    showCheck(c);
  }
  function showCheck(c) {
    const el = $('#pv-check');
    if (!el) return;
    const isShift = p.kind === 'shifts';
    el.innerHTML = `
      ${c.missing.length ? `<div class="alert warn">חסר שיוך לשדות חובה: ${c.missing.map(esc).join(', ')}</div>` : ''}
      <div class="alert info">${c.valid} שורות תקינות${c.from ? ` · ${dmy(c.from)} עד ${dmy(c.to)}` : ''} · סה״כ ${isShift ? num(c.total) + ' שעות' : money(c.total)}${c.errorCount ? ` · ${c.errorCount} שורות ידולגו` : ''}</div>
      ${c.errors.length ? `<details><summary class="muted">שורות שידולגו</summary><ul>${c.errors.map(e => `<li>שורה ${e.line}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}`;
  }
  render();
  box.scrollIntoView({ behavior: 'smooth' });
}

views.employees = {
  title: 'עובדים',
  hideRange: true,
  async render(el) {
    const list = await api('/api/employees');
    el.innerHTML = `
      <div class="card">
        <h3>הוספת עובד</h3>
        <form id="emp-add" class="row">
          <label>שם <input name="name" required></label>
          <label>תפקיד <input name="role" list="roles"></label>
          <label>שכר לשעה (ברוטו) <input name="hourly_rate" type="number" step="0.01" min="0" style="width:120px"></label>
          <button class="btn primary">הוספה</button>
        </form>
        <datalist id="roles"><option>מלצר/ית</option><option>ברמן/ית</option><option>טבח/ית</option><option>שוטף/ת</option><option>אחראי/ת משמרת</option><option>מארח/ת</option><option>שליח/ה</option></datalist>
        <p class="muted" style="font-size:13px">עלות מעביד מחושבת כשכר לשעה כפול מקדם עלות המעביד מההגדרות (כרגע ${esc(state.settings.employer_cost_factor || '1.25')}). אם דוח המשמרות כולל עמודת עלות, המערכת משתמשת בה.</p>
      </div>
      <div class="card" style="margin-top:16px">
        ${list.length ? `<div class="table-wrap"><table><thead><tr><th>שם</th><th>תפקיד</th><th>שכר לשעה</th><th>פעיל</th><th></th></tr></thead><tbody>
          ${list.map(e => `<tr data-id="${e.id}">
            <td>${esc(e.name)}</td>
            <td><input data-k="role" value="${esc(e.role || '')}" list="roles" style="width:140px"></td>
            <td><input data-k="hourly_rate" type="number" step="0.01" min="0" value="${e.hourly_rate || ''}" style="width:100px" class="${e.hourly_rate ? '' : 'error'}"></td>
            <td><input data-k="active" type="checkbox" ${e.active ? 'checked' : ''}></td>
            <td><button class="btn small" data-save>שמירה</button> <button class="btn small danger" data-del>מחיקה</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">אין עובדים. הם יתווספו אוטומטית כשתייבאו דוח משמרות</div>'}
      </div>`;
    $('#emp-add').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/employees', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('נוסף'); render(); } catch (err) { toast(err.message); }
    };
    $$('tr[data-id]', el).forEach(tr => {
      $('[data-save]', tr).onclick = async () => {
        await api(`/api/employees/${tr.dataset.id}`, { method: 'PUT', body: { role: $('[data-k=role]', tr).value, hourly_rate: $('[data-k=hourly_rate]', tr).value, active: $('[data-k=active]', tr).checked } });
        toast('נשמר');
      };
      $('[data-del]', tr).onclick = async () => {
        if (!confirm('למחוק את העובד? המשמרות שלו יישארו')) return;
        await api(`/api/employees/${tr.dataset.id}`, { method: 'DELETE' }); render();
      };
    });
  }
};

views.expenses = {
  title: 'הוצאות',
  async render(el) {
    const [list, sum] = await Promise.all([api(`/api/expenses?${q()}`), api(`/api/reports/summary?${q()}`)]);
    const byCat = {};
    for (const x of list) byCat[x.category] = (byCat[x.category] || 0) + x.amount;
    const t = sum.totals;
    el.innerHTML = `
      <div class="grid kpis">
        ${kpi('סה״כ הוצאות', t.expenses)}
        ${kpi('עבודה + הוצאות (Prime cost)', t.labor_cost + t.expenses)}
        ${kpi('Prime cost מהמכירות נטו', t.prime_cost_pct, { fmt: pctf })}
        ${kpi('רווח גולמי משוער', t.sales_net - t.labor_cost - t.expenses)}
      </div>
      <div class="card" style="margin-top:16px">
        <h3>הוספת הוצאה / חשבונית ספק</h3>
        <form id="exp-add" class="row">
          <label>תאריך <input type="date" name="date" required value="${iso(new Date())}"></label>
          <label>קטגוריה <select name="category"><option>חומרי גלם</option><option>משקאות</option><option>חד פעמי ואריזות</option><option>ניקיון</option><option>תחזוקה</option><option>שכירות</option><option>חשמל ומים</option><option>שיווק</option><option>אחר</option></select></label>
          <label>ספק <input name="supplier"></label>
          <label>סכום (לפני מע״מ) <input name="amount" type="number" step="0.01" min="0" required style="width:120px"></label>
          <label>הערה <input name="note"></label>
          <button class="btn primary">הוספה</button>
        </form>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>לפי קטגוריה</h3>${table([{ key: 'category', label: 'קטגוריה' }, { key: 'amount', label: 'סכום', fmt: money }, { key: 'pct', label: '% מהמכירות נטו', fmt: pctf }], Object.entries(byCat).map(([category, amount]) => ({ category, amount, pct: t.sales_net ? amount / t.sales_net * 100 : null })))}</div>
        <div class="card"><h3>רשימה</h3>${table([{ key: 'date', label: 'תאריך', fmt: dmy }, { key: 'category', label: 'קטגוריה' }, { key: 'supplier', label: 'ספק' }, { key: 'amount', label: 'סכום', fmt: money }, { key: 'note', label: 'הערה' }, { key: 'id', label: '', html: id => `<button class="btn small danger" data-del="${id}">מחיקה</button>` }], list)}</div>
      </div>`;
    $('#exp-add').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/expenses', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('נוסף'); render(); } catch (err) { toast(err.message); }
    };
    $$('[data-del]', el).forEach(b => b.onclick = async () => { await api(`/api/expenses/${b.dataset.del}`, { method: 'DELETE' }); render(); });
  }
};

views.log = {
  title: 'יומן משמרת',
  async render(el) {
    const [logs, sum] = await Promise.all([api(`/api/log?${q()}`), api(`/api/reports/summary?${q()}`)]);
    const L = Object.fromEntries(logs.map(l => [l.date, l]));
    el.innerHTML = `<p class="muted">רשמו כאן מה קרה בכל יום: אירועים, תקלות, חוסרים, מזג אוויר, ספירת קופה. זה עוזר להבין חריגות במכירות ובעלויות.</p>
      <div class="stack">${sum.days.slice().reverse().map(d => {
        const l = L[d.date] || {};
        return `<form class="card" data-date="${d.date}">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
            <b>${d.weekday} ${dmy(d.date)}</b>
            <span class="muted">מכירות ${money(d.sales)} · עבודה ${pctf(d.labor_pct)} · ביטולים ${money(d.cancel_amount)}</span>
          </div>
          <textarea name="note" placeholder="מה קרה היום?">${esc(l.note || '')}</textarea>
          <div class="row" style="margin-top:8px">
            <label>ספירת מזומן בקופה <input name="cash_counted" type="number" step="0.01" value="${l.cash_counted ?? ''}" style="width:130px"></label>
            <label>מזג אוויר / אירוע <input name="weather" value="${esc(l.weather || '')}"></label>
            <button class="btn small">שמירה</button>
          </div>
        </form>`;
      }).join('')}</div>`;
    $$('form[data-date]', el).forEach(f => f.onsubmit = async e => {
      e.preventDefault();
      await api(`/api/log/${f.dataset.date}`, { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
      toast('נשמר');
    });
  }
};

views.settings = {
  title: 'הגדרות',
  hideRange: true,
  async render(el) {
    const s = await api('/api/settings');
    const field = (k, label, help, attrs = 'type="number" step="0.01"') => `<label>${esc(label)}<input name="${k}" value="${esc(s[k] ?? '')}" ${attrs}><span class="muted" style="font-size:12px">${esc(help)}</span></label>`;
    el.innerHTML = `
      <form id="settings" class="card stack" style="max-width:640px">
        ${field('business_name', 'שם העסק', '', 'type="text"')}
        ${field('vat_percent', 'מע״מ (%)', 'לחישוב מכירות נטו')}
        ${field('labor_target_percent', 'יעד עלות עבודה (% מהמכירות נטו)', 'במסעדות מקובל 25%-32%')}
        ${field('employer_cost_factor', 'מקדם עלות מעביד', 'שכר לשעה כפול המקדם הזה = עלות אמיתית (ביטוח לאומי, פנסיה, הבראה...). מקובל 1.2 עד 1.3')}
        ${field('weekly_sales_target', 'יעד מכירות שבועי (₪)', '0 = ללא יעד')}
        ${field('cancel_alert_percent', 'סף התראה לביטולים (% מהמכירות)', '')}
        <div><button class="btn primary">שמירה</button></div>
      </form>
      <div class="card" style="margin-top:16px;max-width:640px">
        <h3>חיבור אוטומטי לביקום ולאפליקציית המשמרות</h3>
        <p class="muted">כרגע הנתונים נכנסים דרך העלאת קבצים. לחיבור אוטומטי צריך גישת API מהספקים. ראו את קובץ README בפרויקט, בפרק "חיבורים אוטומטיים".</p>
      </div>`;
    $('#settings').onsubmit = async e => {
      e.preventDefault();
      state.settings = await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      $('#brand-name').textContent = state.settings.business_name || 'Gonzo';
      toast('ההגדרות נשמרו');
    };
  }
};

// ---------- router ----------
let renderSeq = 0;
async function render() {
  const route = (location.hash || '#dashboard').slice(1);
  const view = views[route] || views.dashboard;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  $('#page-title').textContent = view.title;
  $('#range').classList.toggle('hidden', !!view.hideRange);
  $('#export').href = `/api/reports/export.xlsx?${q()}`;
  $('#from').value = state.from; $('#to').value = state.to;
  destroyCharts();
  const el = $('#view');
  const seq = ++renderSeq;
  el.innerHTML = '<div class="empty">טוען…</div>';
  try {
    await view.render(el);
  } catch (err) {
    if (seq === renderSeq) el.innerHTML = `<div class="card empty error">${esc(err.message)}</div>`;
  }
}

function bindRange() {
  $$('#range [data-preset]').forEach(b => b.onclick = () => {
    const p = b.dataset.preset;
    if (p === 'week') return setRange(...weekRange(0));
    if (p === 'month') { const n = new Date(); return setRange(iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(new Date(n.getFullYear(), n.getMonth() + 1, 0))); }
    const len = Math.round((new Date(state.to) - new Date(state.from)) / 864e5) + 1;
    const shift = p === 'prev' ? -len : len;
    setRange(addDays(state.from, shift), addDays(state.to, shift));
  });
  $('#from').onchange = () => { if ($('#from').value) setRange($('#from').value, $('#to').value < $('#from').value ? $('#from').value : $('#to').value); };
  $('#to').onchange = () => { if ($('#to').value) setRange($('#from').value > $('#to').value ? $('#to').value : $('#from').value, $('#to').value); };
}

// ---------- auth / boot ----------
function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
async function boot() {
  const st = await api('/api/auth/status');
  if (!st.loggedIn) return showLogin();
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#logout').classList.toggle('hidden', !st.authEnabled);
  state.settings = await api('/api/settings');
  $('#brand-name').textContent = state.settings.business_name || 'Gonzo';
  render();
}
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); boot(); }
  catch (err) { $('#login-error').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); showLogin(); };
window.addEventListener('hashchange', render);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
bindRange();
boot();
