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
        ${kpi('שעתי ממוצע (טיפ לשעה)', t.tips_per_hour, { prev: p.tips_per_hour })}
        ${kpi('ביטולים', t.cancel_amount, { prev: p.cancel_amount, inverse: true })}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>מכירות מול עלות עבודה לפי יום</h3><div class="chart-box"><canvas id="c1"></canvas></div></div>
        <div class="card"><h3>מכירות לפי מקור</h3>${d.bySource.length ? '<div class="chart-box"><canvas id="c2"></canvas></div>' : '<div class="empty">אין מכירות</div>'}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>פירוט יומי</h3>
        ${d.days.some(x => x.sales_period) ? `<div class="alert info" style="margin-bottom:10px">חלק מהמכירות הגיעו מדוח ביקום שבועי בלי פירוט יומי, ולכן הן מופיעות כסיכום ביום אחד (מסומן ב-Σ). הסיכום השבועי למעלה מדויק. ה"שעתי" לימים האלה מחושב מסך השירות בשבוע.</div>` : ''}
        ${table([
          { key: 'weekday', label: 'יום' },
          { key: 'date', label: 'תאריך', fmt: dmy },
          { key: 'sales', label: 'מכירות', fmt: money, html: (v, r) => (r.sales_period ? (v ? `Σ ${esc(money(v))} <span class="muted" style="font-size:12px">(${esc(dm(r.sales_period.from))}–${esc(dm(r.sales_period.to))})</span>` : '<span class="muted">בסיכום</span>') : esc(money(v))) },
          { key: 'orders', label: 'הזמנות', fmt: num },
          { key: 'avg_ticket', label: 'ממוצע', fmt: money },
          { key: 'labor_hours', label: 'שעות', fmt: num },
          { key: 'tips_per_hour', label: 'שעתי', fmt: money },
          { key: 'labor_cost', label: 'עלות עבודה', fmt: money },
          { key: 'labor_pct', label: '% עבודה', fmt: pctf, cls: v => (laborTarget && v > laborTarget ? 'bad' : '') },
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
    const tot = d.days.reduce((a, x) => ({ hours: a.hours + x.hours, business_hours: a.business_hours + x.business_hours, tip_hours: a.tip_hours + x.tip_hours, tips: a.tips + x.tips, topup: a.topup + x.tip_topup, cost: a.cost + x.cost, sales_net: a.sales_net + x.sales_net }), { hours: 0, business_hours: 0, tip_hours: 0, tips: 0, topup: 0, cost: 0, sales_net: 0 });
    const tphDays = d.days.filter(x => x.tips_per_hour != null);
    const avgTph = tot.tip_hours && tphDays.length ? tphDays.reduce((a, x) => a + x.tips_per_hour * x.tip_hours, 0) / tphDays.reduce((a, x) => a + x.tip_hours, 0) : null;
    const tphCell = (v, r) => (v == null ? '-' : `${esc(money(v))}${r.tips_per_hour_source === 'calculated' ? ' <span class="muted" title="חושב מהטיפים בדוח המכירות, כי אין שעתי מאפליקציית המשמרות">*</span>' : r.tips_per_hour_source === 'calculated_period' ? ' <span class="muted" title="חושב מסך השירות בדוח ביקום השבועי חלקי שעות המלצרים והבר באותו שבוע">*Σ</span>' : ''}`);
    el.innerHTML = `
      ${d.missingRates.length ? `<div class="alert warn" style="margin-bottom:16px">לתפקידים הבאים עוד לא הוזנה עלות, ולכן הם מחושבים כ-0: ${d.missingRates.map(esc).join(', ')}. <a href="#employees">להזנת עלויות לפי תפקיד</a></div>` : ''}
      ${!d.minWage ? '<div class="alert info" style="margin-bottom:16px">כדי לחשב השלמה לשכר מינימום כשהשעתי נמוך, הזינו שכר מינימום לשעה ב<a href="#settings">הגדרות</a>.</div>' : ''}
      <div class="grid kpis">
        ${kpi('עלות עבודה לעסק', tot.cost)}
        ${kpi('% מהמכירות נטו', tot.sales_net ? tot.cost / tot.sales_net * 100 : null, { fmt: pctf })}
        ${kpi('שעות (בתשלום העסק)', tot.business_hours, { fmt: num })}
        ${kpi('שעות מלצרים וברמנים', tot.tip_hours, { fmt: num })}
        ${kpi('שעתי ממוצע', avgTph)}
        ${kpi('סה״כ טיפים', tot.tips)}
        ${tot.topup ? kpi('השלמה לשכר מינימום', tot.topup) : ''}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>שעות ועלות לפי יום</h3><div class="chart-box"><canvas id="l1"></canvas></div></div>
        <div class="card"><h3>לפי תפקיד</h3>${table([{ key: 'role', label: 'תפקיד' }, { key: 'pay_type', label: 'תשלום', fmt: v => ({ tips: 'מטיפים', shift: 'למשמרת', hourly: 'לשעה', file: 'מהדוח' }[v] || '-') }, { key: 'shifts', label: 'משמרות', fmt: num }, { key: 'hours', label: 'שעות', fmt: num }, { key: 'cost', label: 'עלות לעסק', fmt: money }], d.byRole)}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>שעתי יומי</h3>
        ${table([{ key: 'weekday', label: 'יום' }, { key: 'date', label: 'תאריך', fmt: dmy },
          { key: 'tips_per_hour', label: 'שעתי', fmt: money, html: tphCell, cls: v => (d.minWage && v != null && v < d.minWage ? 'bad' : '') },
          { key: 'tip_hours', label: 'שעות מלצרים/בר', fmt: num }, { key: 'tips', label: 'טיפים', fmt: money },
          { key: 'business_hours', label: 'שעות עסק', fmt: num }, { key: 'tip_topup', label: 'השלמה', fmt: v => (v ? money(v) : '-') },
          { key: 'cost', label: 'עלות לעסק', fmt: money }, { key: 'sales_net', label: 'מכירות נטו', fmt: money }, { key: 'labor_pct', label: '% עבודה', fmt: pctf }],
          d.days, { foot: { weekday: 'סה״כ', tips_per_hour: avgTph, tip_hours: tot.tip_hours, tips: tot.tips, business_hours: tot.business_hours, tip_topup: tot.topup, cost: tot.cost, sales_net: tot.sales_net } })}
        <p class="muted" style="font-size:12px;margin-bottom:0">שעתי = טיפים לשעה, כפי שמגיע מאפליקציית המשמרות. * = לא היה שעתי בדוח, ולכן חושב מהטיפים בדוח המכירות. *Σ = חושב מסך השירות בדוח ביקום השבועי.</p>
      </div>
      <div class="card" style="margin-top:16px"><h3>לפי עובד</h3>
        ${table([{ key: 'employee', label: 'עובד' }, { key: 'role', label: 'תפקיד' }, { key: 'pay_type', label: 'תשלום', fmt: v => ({ tips: 'מטיפים', shift: 'לפי תפקיד (משמרת)', hourly: 'לפי תפקיד (שעה)', personal: 'שכר אישי', file: 'מהקובץ' }[v] || 'לא הוזן') }, { key: 'shifts', label: 'משמרות', fmt: num }, { key: 'hours', label: 'שעות', fmt: num }, { key: 'cost', label: 'עלות לעסק', fmt: money }], d.byEmployee)}
      </div>
      <div class="card" style="margin-top:16px"><h3>כל המשמרות</h3>
        ${table([{ key: 'date', label: 'תאריך', fmt: dmy }, { key: 'employee', label: 'עובד' }, { key: 'role', label: 'תפקיד' }, { key: 'start', label: 'כניסה' }, { key: 'end', label: 'יציאה' }, { key: 'hours', label: 'שעות', fmt: num, cls: v => (v > 12 ? 'bad' : '') }, { key: 'cost', label: 'עלות לעסק', html: (v, r) => (r.tip_funded ? '<span class="muted">מטיפים</span>' : esc(money(v))) }], d.list)}
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
      if (k === 'shifts' || k === 'tips_daily') $('#imp-source').value = 'shift';
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
        if (p.format) return showFormatPreview(p);
        if ((p.kind === 'shifts' || p.kind === 'tips_daily') && !$('#imp-kind').value) $('#imp-source').value = 'shift';
        showPreview(p, kinds);
      } catch (err) { toast(err.message, 5000); }
    }
  }
};

/** A recognised report (Beecomm workbook / ShiftOrganizer detailed report): show what's inside and import it as a whole. */
function showFormatPreview(p) {
  const box = $('#imp-preview');
  const detail = x => (x.kind === 'shifts'
    ? `${num(x.employees)} עובדים · ${num(x.rows)} משמרות · ${num(x.hours)} שעות · עלות ${money(x.cost)}${x.tips ? ` · טיפים ${money(x.tips)}` : ''}`
    : x.kind === 'sales'
      ? `${money(x.amount)} · ${num(x.orders)} הזמנות · ${num(x.guests)} סועדים · שירות ${money(x.tips)} · הנחות ${money(x.discount)}`
      : `${num(x.rows)} פריטים · ${num(x.qty)} יחידות · ${money(x.amount)}`);
  box.innerHTML = `
    <div class="card" style="margin-top:16px">
      <h3>✅ זוהה: ${esc(p.label)} <span class="pill">${esc(p.filename)}</span></h3>
      <div class="muted" style="margin-bottom:10px">${p.range ? `${dmy(p.range.from)} עד ${dmy(p.range.to)}` : ''}${p.branch ? ` · ${esc(p.branch)}` : ''}</div>
      <div class="stack" style="gap:8px">${p.parts.map(x => `<div class="alert info"><b>${esc(x.label)}:</b> ${detail(x)}</div>`).join('')}</div>
      ${p.notes.length ? `<div class="stack" style="gap:8px;margin-top:8px">${p.notes.map(n => `<div class="alert warn">${esc(n)}</div>`).join('')}</div>` : ''}
      <p class="muted" style="font-size:13px">הייבוא מחליף נתונים קודמים מאותו מקור בטווח התאריכים של הדוח, כך שאפשר להעלות את אותו שבוע שוב בלי כפילויות.</p>
      <div class="row"><button class="btn primary" id="fmt-commit">ייבוא</button><button class="btn ghost" id="fmt-cancel">ביטול</button></div>
    </div>`;
  $('#fmt-cancel').onclick = () => { box.innerHTML = ''; };
  $('#fmt-commit').onclick = async () => {
    try {
      const r = await api('/api/import/commit-format', { method: 'POST', body: { token: p.token } });
      toast(`יובא: ${r.results.map(x => `${x.inserted} ${({ sales: 'מכירות', items: 'פריטים', cancellations: 'ביטולים', shifts: 'משמרות' })[x.kind] || x.kind}`).join(', ')}`, 5000);
      if (r.range) setRange(r.range.from, r.range.to);
      location.hash = r.format === 'shiftorganizer' ? '#labor' : '#dashboard';
    } catch (err) { toast(err.message, 5000); }
  };
  box.scrollIntoView({ behavior: 'smooth' });
}

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
        location.hash = p.kind === 'shifts' || p.kind === 'tips_daily' ? '#labor' : p.kind === 'cancellations' ? '#cancellations' : p.kind === 'items' ? '#sales' : '#dashboard';
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
    const [list, roles] = await Promise.all([api('/api/employees'), api('/api/roles')]);
    const PAY = { tips: 'משולם מהטיפים', shift: 'עלות למשמרת', hourly: 'עלות לשעה' };
    el.innerHTML = `
      <div class="card">
        <h3>תפקידים ועלויות</h3>
        <p class="muted" style="margin-top:0;font-size:13px">מלצרים וברמנים משולמים מהטיפים, ולכן הם לא נספרים בעלות העבודה של העסק. מה שנספר עבורם הוא רק השלמה לשכר מינימום, אם השעתי יצא נמוך ממנו. לשאר התפקידים: אם דוח ShiftOrganizer כולל עמודת עלות, היא נלקחת ממנו ואין צורך להזין כאן. אחרת מזינים את <b>העלות המלאה לעסק</b>, למשמרת או לשעה. תפקידים נוספים לכאן אוטומטית מדוח המשמרות.</p>
        ${roles.length ? `<div class="table-wrap"><table class="edit-table"><thead><tr><th>תפקיד</th><th>אופן תשלום</th><th>עלות לעסק (₪)</th><th>חריגים לפי יום</th><th>משמרות ב-60 יום</th><th></th></tr></thead><tbody>
          ${roles.map(r => `<tr data-role="${r.id}">
            <td><b>${esc(r.name)}</b></td>
            <td><select data-k="pay_type">${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${r.pay_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
            <td><input data-k="rate" type="number" step="0.01" min="0" value="${r.rate ?? ''}" style="width:110px" placeholder="${r.pay_type === 'tips' ? '—' : 'לא הוזן'}" ${r.pay_type === 'tips' ? 'disabled' : ''}></td>
            <td><input data-k="weekday_rates" value="${esc(r.weekday_rates_text || '')}" style="width:130px" placeholder="${r.pay_type === 'tips' ? '—' : 'למשל ה=350, ו=350'}" title="עלות שונה בימים מסוימים. א=ראשון … ש=שבת" ${r.pay_type === 'tips' ? 'disabled' : ''}></td>
            <td>${r.shifts_60d}</td>
            <td><button class="btn small" data-saverole>שמירה</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">אין תפקידים עדיין. הם יתווספו מדוח המשמרות, או הוסיפו ידנית</div>'}
        <form id="role-add" class="row" style="margin-top:10px">
          <label>תפקיד חדש <input name="name" required></label>
          <label>אופן תשלום <select name="pay_type">${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${k === 'shift' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>עלות (₪) <input name="rate" type="number" step="0.01" min="0" style="width:100px"></label>
          <button class="btn">הוספה</button>
        </form>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>הוספת עובד</h3>
        <form id="emp-add" class="row">
          <label>שם <input name="name" required></label>
          <label>תפקיד <input name="role" list="roles"></label>
          <label>שכר אישי לשעה (לא חובה) <input name="hourly_rate" type="number" step="0.01" min="0" style="width:120px"></label>
          <button class="btn primary">הוספה</button>
        </form>
        <datalist id="roles"><option>מלצר/ית</option><option>ברמן/ית</option><option>טבח/ית</option><option>שוטף/ת</option><option>אחראי/ת משמרת</option><option>מארח/ת</option><option>שליח/ה</option></datalist>
        <p class="muted" style="font-size:13px">בדרך כלל מספיקה העלות לפי תפקיד. שכר אישי לשעה גובר על העלות של התפקיד, ומוכפל במקדם עלות המעביד (כרגע ${esc(state.settings.employer_cost_factor || '1.25')}). לעובדים בתפקיד שמשולם מטיפים לא מחושבת עלות.</p>
      </div>
      <div class="card" style="margin-top:16px">
        ${list.length ? `<div class="table-wrap"><table><thead><tr><th>שם</th><th>תפקיד</th><th>שכר אישי לשעה</th><th>פעיל</th><th></th></tr></thead><tbody>
          ${list.map(e => `<tr data-id="${e.id}">
            <td>${esc(e.name)}</td>
            <td><input data-k="role" value="${esc(e.role || '')}" list="roles" style="width:140px"></td>
            <td><input data-k="hourly_rate" type="number" step="0.01" min="0" value="${e.hourly_rate || ''}" style="width:100px" placeholder="לפי תפקיד"></td>
            <td><input data-k="active" type="checkbox" ${e.active ? 'checked' : ''}></td>
            <td><button class="btn small" data-save>שמירה</button> <button class="btn small danger" data-del>מחיקה</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">אין עובדים. הם יתווספו אוטומטית כשתייבאו דוח משמרות</div>'}
      </div>`;
    $$('tr[data-role]', el).forEach(tr => {
      const sel = $('[data-k=pay_type]', tr), rate = $('[data-k=rate]', tr), days = $('[data-k=weekday_rates]', tr);
      sel.onchange = () => { rate.disabled = days.disabled = sel.value === 'tips'; rate.placeholder = sel.value === 'tips' ? '—' : 'לא הוזן'; };
      $('[data-saverole]', tr).onclick = async () => {
        try {
          await api(`/api/roles/${tr.dataset.role}`, { method: 'PUT', body: { pay_type: sel.value, rate: sel.value === 'tips' ? '' : rate.value, weekday_rates: sel.value === 'tips' ? '' : days.value } });
          toast('נשמר');
        } catch (err) { toast(err.message); }
      };
    });
    $('#role-add').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/roles', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('נוסף'); render(); } catch (err) { toast(err.message); }
    };
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

// ================= inventory =================
const INV_TABS = [['inventory', 'צריכה ופחת'], ['inv-count', 'ספירת מלאי'], ['inv-delivery', 'קבלת סחורה'], ['inv-products', 'מוצרים'], ['inv-recipes', 'מתכונים']];
const invTabs = active => `<div class="tabs">${INV_TABS.map(([r, l]) => `<a href="#${r}" class="${r === active ? 'active' : ''}">${l}</a>`).join('')}</div>`;
const lastWeekday = (wd) => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7)); return iso(d); };
const qtyf = v => (v == null ? '-' : new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(v));
const UNITS = ['יח׳', 'ק״ג', 'גרם', 'ליטר', 'בקבוק', 'קרטון', 'חבית', 'ארגז', 'שקית'];

async function uploadLines(file) {
  const fd = new FormData(); fd.append('file', file);
  return api('/api/inventory/parse', { method: 'POST', body: fd });
}

views.inventory = {
  title: 'מלאי ופחת',
  hideRange: true,
  async render(el) {
    const sel = new URLSearchParams(location.hash.split('?')[1] || '').get('count');
    const [d, counts] = await Promise.all([api(`/api/inventory/report${sel ? `?count=${sel}` : ''}`), api('/api/inventory/counts')]);
    if (d.status !== 'ok') {
      el.innerHTML = invTabs('inventory') + `<div class="card empty">
        ${d.status === 'no-counts' ? 'עוד אין ספירות מלאי.' : `יש ספירה אחת (${dmy(d.closing.date)}). צריך עוד ספירה כדי לחשב צריכה ופחת לתקופה ביניהן.`}
        <ol class="steps" style="text-align:right;max-width:520px;margin:16px auto">
          <li>מגדירים <a href="#inv-products">מוצרים</a> (או שהם נוצרים לבד מהספירה / החשבונית הראשונה)</li>
          <li>מגדירים <a href="#inv-recipes">מתכונים</a>: כמה מכל מוצר נכנס בכל מנה</li>
          <li>מוצאי שבת: <a href="#inv-count">ספירת מלאי</a></li>
          <li>שני בבוקר: <a href="#inv-delivery">קבלת סחורה</a></li>
          <li>בשבת הבאה סופרים שוב, והדוח מוכן</li>
        </ol>
        <a class="btn primary" href="#inv-count">🔢 להתחיל ספירה</a></div>`;
      return;
    }
    const t = d.totals;
    const rows = d.rows.slice().sort((a, b) => (b.waste_cost ?? -1e9) - (a.waste_cost ?? -1e9));
    el.innerHTML = invTabs('inventory') + `
      <div class="row" style="margin-bottom:16px">
        <label>תקופה (בין ספירות)
          <select id="inv-period">${counts.slice(0, -1).map((c, i) => `<option value="${c.id}" ${c.id === d.closing.id ? 'selected' : ''}>${dmy(counts[i + 1].date)} → ${dmy(c.date)}</option>`).join('')}</select>
        </label>
        <span class="muted">מכירות מ-${dmy(addDays(d.opening.date, 1))} עד ${dmy(d.closing.date)} (כולל)</span>
      </div>
      <div class="grid kpis">
        ${kpi('פחת / חוסר (₪)', t.waste_cost)}
        ${kpi('פחת כ-% מהמכירות נטו', t.waste_pct_of_sales, { fmt: pctf })}
        ${kpi('עלות מזון בפועל', t.food_cost_pct, { fmt: pctf })}
        ${kpi('עלות מזון תיאורטית (לפי מתכונים)', t.theoretical_food_cost_pct, { fmt: pctf })}
        ${kpi('סחורה שהתקבלה', t.received_cost)}
        ${kpi('שווי מלאי בסגירה', t.closing_value)}
      </div>
      ${d.itemSalesDays < d.periodDays ? `<div class="alert warn" style="margin-top:16px">⚠️ יש דוח "מכירות לפי פריט" רק ל-${d.itemSalesDays} מתוך ${d.periodDays} הימים בתקופה. בלי הדוח, מה שנמכר ייספר כפחת. <a href="#import">לייבוא הדוח</a></div>` : ''}
      ${d.itemsWithoutRecipe.length ? `<div class="alert warn" style="margin-top:16px">${d.itemsWithoutRecipe.length} מנות שנמכרו בתקופה בלי מתכון, ולכן הצריכה שלהן לא נספרת כ"נמכר" ומופיעה כפחת: ${d.itemsWithoutRecipe.slice(0, 8).map(x => esc(x.item)).join(', ')}${d.itemsWithoutRecipe.length > 8 ? '…' : ''}. <a href="#inv-recipes">להגדרת מתכונים</a></div>` : ''}
      <div class="card" style="margin-top:16px"><h3>צריכה ופחת לפי מוצר</h3>
        <p class="muted" style="margin-top:0;font-size:13px">שימוש בפועל = פתיחה + התקבל − סגירה. נמכר = מכירות המנות × המתכון. פחת = שימוש בפועל − נמכר. ערך שלילי = נמכר יותר ממה שנצרך (בדרך כלל מתכון לא מדויק או טעות בספירה).</p>
        ${table([
          { key: 'product', label: 'מוצר' }, { key: 'unit', label: 'יחידה' },
          { key: 'opening', label: 'פתיחה', fmt: qtyf }, { key: 'received', label: 'התקבל', fmt: qtyf }, { key: 'closing', label: 'סגירה', fmt: qtyf },
          { key: 'used', label: 'שימוש בפועל', fmt: qtyf },
          { key: 'sold', label: 'נמכר', html: (v, r) => (r.no_recipe ? '<a href="#inv-recipes" class="muted">אין מתכון</a>' : esc(qtyf(v))) },
          { key: 'waste', label: 'פחת', fmt: qtyf, cls: (v, r) => (r.waste_pct > 10 ? 'bad' : '') },
          { key: 'waste_pct', label: '% פחת', fmt: pctf, cls: v => (v > 10 ? 'bad' : v < -5 ? 'good' : '') },
          { key: 'waste_cost', label: 'פחת ₪', fmt: money, cls: v => (v > 0 ? 'bad' : '') },
          { key: 'suggested_order', label: 'להזמין', fmt: qtyf }
        ], rows.map(r => (r.missing_count ? { ...r, product: r.product + ' (חסרה ספירה)' } : r)))}
      </div>
      ${d.itemsWithoutRecipe.length ? `<div class="card" style="margin-top:16px"><h3>מנות שנמכרו בלי מתכון</h3>${table([{ key: 'item', label: 'מנה' }, { key: 'qty', label: 'נמכרו', fmt: num }, { key: 'amount', label: 'סכום', fmt: money }], d.itemsWithoutRecipe)}</div>` : ''}
      <div class="card" style="margin-top:16px"><h3>מגמה לפי שבועות</h3>
        ${table([{ key: 'from', label: 'מ', fmt: dmy }, { key: 'to', label: 'עד', fmt: dmy }, { key: 'received_cost', label: 'התקבל', fmt: money }, { key: 'used_cost', label: 'שימוש', fmt: money }, { key: 'waste_cost', label: 'פחת ₪', fmt: money }, { key: 'waste_pct_of_sales', label: 'פחת % ממכירות', fmt: pctf }, { key: 'food_cost_pct', label: 'עלות מזון בפועל', fmt: pctf }, { key: 'theoretical_food_cost_pct', label: 'תיאורטית', fmt: pctf }], d.periods)}
      </div>`;
    $('#inv-period').onchange = e => { location.hash = `#inventory?count=${e.target.value}`; };
  }
};

views['inv-count'] = {
  title: 'ספירת מלאי',
  hideRange: true,
  async render(el) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const date = params.get('date') || lastWeekday(6);
    const [products, counts] = await Promise.all([api('/api/inventory/products'), api('/api/inventory/counts')]);
    const existing = counts.find(c => c.date === date);
    const prev = counts.find(c => c.date < date);
    const [cur, last] = await Promise.all([existing ? api(`/api/inventory/counts/${existing.id}`) : null, prev ? api(`/api/inventory/counts/${prev.id}`) : null]);
    const lastQty = Object.fromEntries((last?.lines || []).map(l => [l.product_id, l.qty]));
    const draftKey = `gonzo-count-${date}`;
    let values = Object.fromEntries((cur?.lines || []).map(l => [l.product_id, l.qty]));
    let extra = [];   // products added during this count: {name, unit}
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (draft) { values = { ...values, ...draft.values }; extra = draft.extra || []; }
    } catch { /* ignore */ }
    const saveDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify({ values, extra })); } catch { /* ignore */ } };

    const active = products.filter(p => p.active);
    const groups = {};
    for (const p of active) (groups[p.category || 'כללי'] ||= []).push(p);

    el.innerHTML = invTabs('inv-count') + `
      <div class="card count-head">
        <div class="row">
          <label>תאריך הספירה <input type="date" id="cnt-date" value="${date}"></label>
          <label style="flex:1;min-width:160px">חיפוש <input id="cnt-search" placeholder="שם מוצר…"></label>
        </div>
        <div class="muted" style="font-size:13px;margin-top:8px">
          ${existing ? `⚠️ כבר יש ספירה לתאריך הזה. שמירה תעדכן אותה.` : prev ? `ספירה קודמת: ${dmy(prev.date)}. הכמות שלה מופיעה באפור ליד כל מוצר.` : 'זו הספירה הראשונה.'}
        </div>
        <div class="progress"><span id="cnt-bar"></span></div>
        <div id="cnt-progress" class="muted" style="font-size:13px"></div>
      </div>
      ${active.length ? '' : `<div class="card empty" style="margin-top:16px">אין עדיין מוצרים. הוסיפו מוצרים למטה, <a href="#inv-products">במסך המוצרים</a>, או העלו קובץ ספירה.</div>`}
      <div id="cnt-list">
        ${Object.entries(groups).map(([g, ps]) => `
          <div class="card count-group" style="margin-top:12px"><h3>${esc(g)}</h3>
            ${ps.map(p => `
              <div class="count-row" data-name="${esc(p.name.toLowerCase())}">
                <div class="count-name"><b>${esc(p.name)}</b><span class="muted"> · ${esc(p.unit)}${p.id in lastQty ? ` · קודם: ${qtyf(lastQty[p.id])}` : ''}</span></div>
                <div class="count-input">
                  <button type="button" class="btn step" data-step="-1" data-id="${p.id}">−</button>
                  <input type="number" inputmode="decimal" step="any" min="0" data-id="${p.id}" value="${values[p.id] ?? ''}" placeholder="—">
                  <button type="button" class="btn step" data-step="1" data-id="${p.id}">+</button>
                </div>
              </div>`).join('')}
          </div>`).join('')}
      </div>
      <div class="card" style="margin-top:12px">
        <h3>מוצר שלא ברשימה</h3>
        <div id="cnt-extra">${extra.map((x, i) => `<div class="count-row"><div class="count-name"><b>${esc(x.name)}</b><span class="muted"> · ${esc(x.unit)} · חדש</span></div><div class="count-input"><input type="number" inputmode="decimal" step="any" min="0" data-extra="${i}" value="${x.qty ?? ''}"></div></div>`).join('')}</div>
        <form id="cnt-add" class="row">
          <label>שם <input name="name" required></label>
          <label>יחידה <select name="unit">${UNITS.map(u => `<option>${u}</option>`).join('')}</select></label>
          <button class="btn">הוספה</button>
        </form>
        <div class="row" style="margin-top:12px">
          <label>או העלאת קובץ ספירה (Excel/CSV עם מוצר + כמות) <input type="file" id="cnt-file" accept=".csv,.xlsx,.xlsm"></label>
        </div>
      </div>
      <div class="save-bar">
        <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="checkbox" id="cnt-zero"> מוצר שלא מולא = 0</label>
        <button class="btn primary" id="cnt-save">💾 שמירת ספירה</button>
      </div>`;

    const total = () => active.length + extra.length;
    const filled = () => active.filter(p => values[p.id] !== undefined && values[p.id] !== '').length + extra.filter(x => x.qty !== undefined && x.qty !== '').length;
    const progress = () => {
      const f = filled(), tt = total();
      $('#cnt-progress').textContent = `נספרו ${f} מתוך ${tt} מוצרים`;
      $('#cnt-bar').style.width = tt ? `${(f / tt) * 100}%` : '0';
    };
    progress();

    $('#cnt-date').onchange = e => { location.hash = `#inv-count?date=${e.target.value}`; };
    $('#cnt-search').oninput = e => {
      const s = e.target.value.trim().toLowerCase();
      $$('.count-row[data-name]', el).forEach(r => r.classList.toggle('hidden', s && !r.dataset.name.includes(s)));
      $$('.count-group', el).forEach(g => g.classList.toggle('hidden', !$$('.count-row:not(.hidden)', g).length));
    };
    $$('input[data-id]', el).forEach(inp => inp.oninput = () => { values[inp.dataset.id] = inp.value === '' ? undefined : Number(inp.value); saveDraft(); progress(); });
    $$('input[data-extra]', el).forEach(inp => inp.oninput = () => { extra[inp.dataset.extra].qty = inp.value === '' ? undefined : Number(inp.value); saveDraft(); progress(); });
    $$('[data-step]', el).forEach(b => b.onclick = () => {
      const inp = $(`input[data-id="${b.dataset.id}"]`, el);
      inp.value = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.step));
      inp.dispatchEvent(new Event('input'));
    });
    $('#cnt-add').onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      extra.push({ name: f.name.trim(), unit: f.unit });
      saveDraft(); render();
    };
    $('#cnt-file').onchange = async e => {
      try {
        const r = await uploadLines(e.target.files[0]);
        for (const l of r.lines) {
          if (l.product_id) values[l.product_id] = l.qty;
          else extra.push({ name: l.product, unit: l.unit || 'יח׳', qty: l.qty });
        }
        saveDraft(); toast(`נטענו ${r.lines.length} שורות מהקובץ. בדקו ושמרו`); render();
      } catch (err) { toast(err.message, 5000); }
    };
    $('#cnt-save').onclick = async () => {
      const zero = $('#cnt-zero').checked;
      const lines = [
        ...active.map(p => ({ product_id: p.id, qty: values[p.id] ?? (zero ? 0 : null) })),
        ...extra.map(x => ({ product: x.name, unit: x.unit, qty: x.qty ?? (zero ? 0 : null) }))
      ].filter(l => l.qty != null);
      const missing = total() - lines.length;
      if (missing && !confirm(`${missing} מוצרים לא נספרו ולא ייכללו בספירה. לשמור בכל זאת?`)) return;
      try {
        const r = await api('/api/inventory/counts', { method: 'POST', body: { date: $('#cnt-date').value, lines } });
        try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
        toast(`הספירה נשמרה (${r.lines} מוצרים)`);
        location.hash = '#inventory';
      } catch (err) { toast(err.message, 5000); }
    };
  }
};

views['inv-delivery'] = {
  title: 'קבלת סחורה',
  hideRange: true,
  async render(el) {
    const editId = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
    const [products, list, editing] = await Promise.all([
      api('/api/inventory/products'), api('/api/inventory/deliveries'), editId ? api(`/api/inventory/deliveries/${editId}`) : null
    ]);
    const byName = Object.fromEntries(products.map(p => [p.name, p]));
    let lines = editing ? editing.lines.map(l => ({ product: l.product, qty: l.qty, unit: l.unit, unit_cost: l.unit_cost })) : [];
    if (!lines.length) lines = [{}];

    el.innerHTML = invTabs('inv-delivery') + `
      <div class="card">
        <h3>${editing ? `עריכת קבלת סחורה מ-${dmy(editing.date)}` : 'קבלת סחורה חדשה'}</h3>
        <div class="row">
          <label>תאריך <input type="date" id="dl-date" value="${editing?.date || lastWeekday(1)}"></label>
          <label>ספק <input id="dl-supplier" value="${esc(editing?.supplier || '')}" list="dl-suppliers"></label>
          <label style="flex:1">הערה <input id="dl-note" value="${esc(editing?.note || '')}"></label>
          <label>מילוי מחשבונית (Excel/CSV) <input type="file" id="dl-file" accept=".csv,.xlsx,.xlsm"></label>
        </div>
        <datalist id="dl-suppliers">${[...new Set(products.map(p => p.supplier).filter(Boolean))].map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
        <datalist id="dl-products">${products.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
        <div class="table-wrap" style="margin-top:12px"><table class="edit-table">
          <thead><tr><th>מוצר</th><th>כמות</th><th>יחידה</th><th>מחיר ליחידה (לפני מע״מ)</th><th>סה״כ</th><th></th></tr></thead>
          <tbody id="dl-lines"></tbody>
          <tfoot><tr><td colspan="4">סה״כ</td><td id="dl-total"></td><td></td></tr></tfoot>
        </table></div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="dl-add">+ שורה</button>
          <button class="btn" id="dl-par" title="ממלא לפי רמת מלאי רצויה פחות הספירה האחרונה">מילוי לפי הזמנה מומלצת</button>
          <span style="flex:1"></span>
          ${editing ? '<a class="btn ghost" href="#inv-delivery">ביטול</a>' : ''}
          <button class="btn primary" id="dl-save">💾 שמירה</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><h3>קבלות קודמות</h3>
        ${table([{ key: 'date', label: 'תאריך', fmt: dmy }, { key: 'supplier', label: 'ספק' }, { key: 'lines', label: 'שורות', fmt: num }, { key: 'total', label: 'סה״כ', fmt: money }, { key: 'note', label: 'הערה' },
          { key: 'id', label: '', html: id => `<a class="btn small" href="#inv-delivery?id=${id}">עריכה</a> <button class="btn small danger" data-del="${id}">מחיקה</button>` }], list, { empty: 'עוד לא נקלטה סחורה' })}
      </div>`;

    const drawLines = () => {
      $('#dl-lines').innerHTML = lines.map((l, i) => `<tr data-i="${i}">
        <td><input data-k="product" list="dl-products" value="${esc(l.product || '')}" style="min-width:180px"></td>
        <td><input data-k="qty" type="number" inputmode="decimal" step="any" value="${l.qty ?? ''}" style="width:90px"></td>
        <td><select data-k="unit">${UNITS.map(u => `<option ${(l.unit || byName[l.product]?.unit) === u ? 'selected' : ''}>${u}</option>`).join('')}${l.unit && !UNITS.includes(l.unit) ? `<option selected>${esc(l.unit)}</option>` : ''}</select></td>
        <td><input data-k="unit_cost" type="number" inputmode="decimal" step="any" value="${l.unit_cost ?? ''}" style="width:110px"></td>
        <td>${money((Number(l.qty) || 0) * (Number(l.unit_cost) || 0))}</td>
        <td><button class="btn small danger" data-rm="${i}">✕</button></td></tr>`).join('');
      $('#dl-total').textContent = money(lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0));
      $$('#dl-lines input, #dl-lines select').forEach(inp => inp.onchange = () => {
        const l = lines[inp.closest('tr').dataset.i];
        l[inp.dataset.k] = inp.value;
        if (inp.dataset.k === 'product' && byName[inp.value]) { l.unit = byName[inp.value].unit; if (!l.unit_cost) l.unit_cost = byName[inp.value].unit_cost || ''; }
        drawLines();
      });
      $$('[data-rm]').forEach(b => b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); if (!lines.length) lines.push({}); drawLines(); });
    };
    drawLines();

    $('#dl-add').onclick = () => { lines.push({}); drawLines(); };
    $('#dl-par').onclick = async () => {
      const r = await api('/api/inventory/report');
      const sug = (r.rows || []).filter(x => x.suggested_order > 0);
      if (!sug.length) return toast('אין הזמנה מומלצת. צריך להגדיר "מלאי רצוי" למוצרים ולבצע ספירה');
      lines = sug.map(x => ({ product: x.product, qty: x.suggested_order, unit: x.unit, unit_cost: x.unit_cost || '' }));
      drawLines();
    };
    $('#dl-file').onchange = async e => {
      try {
        const r = await uploadLines(e.target.files[0]);
        lines = r.lines.map(l => ({ product: l.product, qty: l.qty, unit: l.unit, unit_cost: l.unit_cost ?? byName[l.product]?.unit_cost ?? '' }));
        const nNew = r.lines.filter(l => l.is_new).length;
        toast(`נטענו ${r.lines.length} שורות${nNew ? `, מתוכן ${nNew} מוצרים חדשים שייווצרו בשמירה` : ''}`, 5000);
        drawLines();
      } catch (err) { toast(err.message, 5000); }
    };
    $('#dl-save').onclick = async () => {
      const body = { id: editing?.id, date: $('#dl-date').value, supplier: $('#dl-supplier').value, note: $('#dl-note').value, lines: lines.filter(l => l.product && l.qty !== '' && l.qty != null) };
      try { await api('/api/inventory/deliveries', { method: 'POST', body }); toast('נשמר'); location.hash = '#inv-delivery'; render(); } catch (err) { toast(err.message, 5000); }
    };
    $$('[data-del]', el).forEach(b => b.onclick = async () => {
      if (!confirm('למחוק את קבלת הסחורה?')) return;
      await api(`/api/inventory/deliveries/${b.dataset.del}`, { method: 'DELETE' }); render();
    });
  }
};

views['inv-products'] = {
  title: 'מוצרי מלאי',
  hideRange: true,
  async render(el) {
    const products = await api('/api/inventory/products');
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
    el.innerHTML = invTabs('inv-products') + `
      <div class="card">
        <h3>הוספת מוצר</h3>
        <form id="pr-add" class="row">
          <label>שם <input name="name" required></label>
          <label>יחידה <select name="unit">${UNITS.map(u => `<option>${u}</option>`).join('')}</select></label>
          <label>קטגוריה <input name="category" list="pr-cats" placeholder="ירקות, בשר, משקאות…"></label>
          <label>ספק <input name="supplier"></label>
          <label>מחיר ליחידה <input name="unit_cost" type="number" step="any" style="width:100px"></label>
          <label>מלאי רצוי <input name="par_level" type="number" step="any" style="width:90px" title="כמה רוצים שיהיה אחרי קבלת סחורה"></label>
          <button class="btn primary">הוספה</button>
        </form>
        <datalist id="pr-cats">${cats.map(c => `<option>${esc(c)}</option>`).join('')}</datalist>
        <p class="muted" style="font-size:13px">"מלאי רצוי" משמש לחישוב הזמנה מומלצת: מלאי רצוי פחות מה שנספר בשבת. המחיר מתעדכן אוטומטית מכל קבלת סחורה.</p>
      </div>
      <div class="card" style="margin-top:16px">
        ${products.length ? `<div class="table-wrap"><table class="edit-table"><thead><tr><th>שם</th><th>יחידה</th><th>קטגוריה</th><th>ספק</th><th>מחיר</th><th>מלאי רצוי</th><th>פעיל</th><th></th></tr></thead><tbody>
          ${products.map(p => `<tr data-id="${p.id}">
            <td><input data-k="name" value="${esc(p.name)}" style="min-width:150px"></td>
            <td><input data-k="unit" value="${esc(p.unit)}" list="pr-units" style="width:80px"></td>
            <td><input data-k="category" value="${esc(p.category || '')}" list="pr-cats" style="width:110px"></td>
            <td><input data-k="supplier" value="${esc(p.supplier || '')}" style="width:110px"></td>
            <td><input data-k="unit_cost" type="number" step="any" value="${p.unit_cost ?? ''}" style="width:90px"></td>
            <td><input data-k="par_level" type="number" step="any" value="${p.par_level ?? ''}" style="width:80px"></td>
            <td><input data-k="active" type="checkbox" ${p.active ? 'checked' : ''}></td>
            <td><button class="btn small" data-save>שמירה</button> <button class="btn small danger" data-del>מחיקה</button></td></tr>`).join('')}
        </tbody></table></div><datalist id="pr-units">${UNITS.map(u => `<option>${u}</option>`).join('')}</datalist>` : '<div class="empty">אין מוצרים עדיין</div>'}
      </div>`;
    $('#pr-add').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/inventory/products', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('נוסף'); render(); } catch (err) { toast(err.message); }
    };
    $$('tr[data-id]', el).forEach(tr => {
      $('[data-save]', tr).onclick = async () => {
        const body = Object.fromEntries($$('[data-k]', tr).map(i => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.value]));
        try { await api(`/api/inventory/products/${tr.dataset.id}`, { method: 'PUT', body }); toast('נשמר'); } catch (err) { toast(err.message); }
      };
      $('[data-del]', tr).onclick = async () => {
        if (!confirm('למחוק את המוצר? הוא יימחק גם מכל הספירות, ההזמנות והמתכונים. אפשר במקום זה לסמן אותו כלא פעיל')) return;
        await api(`/api/inventory/products/${tr.dataset.id}`, { method: 'DELETE' }); render();
      };
    });
  }
};

views['inv-recipes'] = {
  title: 'מתכונים',
  hideRange: true,
  async render(el) {
    const [items, products] = await Promise.all([api('/api/inventory/recipes'), api('/api/inventory/products')]);
    const done = items.filter(i => i.lines.length).length;
    el.innerHTML = invTabs('inv-recipes') + `
      <div class="card">
        <p style="margin-top:0">לכל מנה שנמכרת מגדירים כמה מכל מוצר מלאי היא צורכת, ביחידת המידה של המוצר. לדוגמה: המבורגר = לחמנייה 1 יח׳ + בשר 0.18 ק״ג + צ׳דר 0.02 ק״ג. משקה שנמכר כמו שהוא (בקבוק בירה) = 1 יח׳ מאותו מוצר.</p>
        <div class="muted">הוגדרו ${done} מתוך ${items.length} מנות. רשימת המנות מגיעה מדוח "מכירות לפי פריט" של ביקום.</div>
        <div class="row" style="margin-top:12px">
          <label style="flex:1">חיפוש <input id="rc-search" placeholder="שם מנה…"></label>
          <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="checkbox" id="rc-missing"> רק מנות בלי מתכון</label>
        </div>
        <form id="rc-new" class="row" style="margin-top:8px"><label>מנה שלא ברשימה <input name="item" required></label><button class="btn">הוספה</button></form>
      </div>
      <datalist id="rc-products">${products.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
      <div id="rc-list">${items.map((it, n) => recipeCard(it, n, products)).join('')}</div>`;

    const filter = () => {
      const s = $('#rc-search').value.trim().toLowerCase(), m = $('#rc-missing').checked;
      $$('.recipe', el).forEach(c => c.classList.toggle('hidden', (s && !c.dataset.item.toLowerCase().includes(s)) || (m && c.dataset.has === '1')));
    };
    $('#rc-search').oninput = filter; $('#rc-missing').onchange = filter;
    $('#rc-new').onsubmit = e => {
      e.preventDefault();
      const item = new FormData(e.target).get('item').trim();
      items.unshift({ item, lines: [], sold_90d: 0 });
      $('#rc-list').insertAdjacentHTML('afterbegin', recipeCard(items[0], 'new', products));
      bind($('#rc-list .recipe'));
      e.target.reset();
    };
    const bind = card => {
      $('[data-addline]', card).onclick = () => $('.rc-lines', card).insertAdjacentHTML('beforeend', recipeLine({}, products));
      $('[data-same]', card)?.addEventListener('click', () => $('.rc-lines', card).insertAdjacentHTML('beforeend', recipeLine({ product: card.dataset.item, qty: 1 }, products)));
      card.addEventListener('click', e => { if (e.target.matches('[data-rmline]')) e.target.closest('.rc-line').remove(); });
      card.addEventListener('input', e => { if (e.target.matches('[data-k=product]')) { const p = products.find(x => x.name === e.target.value); const u = $('.rc-unit', e.target.closest('.rc-line')); if (u) u.textContent = p ? p.unit : 'חדש'; } });
      $('[data-saverc]', card).onclick = async () => {
        const lines = $$('.rc-line', card).map(r => ({ product: $('[data-k=product]', r).value.trim(), qty: $('[data-k=qty]', r).value })).filter(l => l.product && Number(l.qty) > 0);
        try {
          await api('/api/inventory/recipes', { method: 'PUT', body: { item: card.dataset.item, lines } });
          card.dataset.has = lines.length ? '1' : '0';
          $('.rc-status', card).innerHTML = lines.length ? '<span class="pill good">מוגדר</span>' : '<span class="pill">אין מתכון</span>';
          toast('המתכון נשמר');
        } catch (err) { toast(err.message, 5000); }
      };
    };
    $$('.recipe', el).forEach(bind);
  }
};

function recipeLine(l, products) {
  const unit = products.find(p => p.name === l.product)?.unit || (l.product ? 'חדש' : '');
  return `<div class="rc-line row">
    <input data-k="product" list="rc-products" value="${esc(l.product || '')}" placeholder="מוצר מלאי" style="flex:1;min-width:150px">
    <input data-k="qty" type="number" inputmode="decimal" step="any" min="0" value="${l.qty ?? ''}" placeholder="כמות" style="width:90px">
    <span class="rc-unit muted" style="min-width:40px">${esc(unit)}</span>
    <button type="button" class="btn small danger" data-rmline>✕</button></div>`;
}
function recipeCard(it, n, products) {
  return `<div class="card recipe" style="margin-top:12px" data-item="${esc(it.item)}" data-has="${it.lines.length ? 1 : 0}">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div><b>${esc(it.item)}</b> <span class="muted">${it.category ? esc(it.category) + ' · ' : ''}${it.sold_90d ? `נמכרו ${num(it.sold_90d)} ב-90 יום` : ''}</span></div>
      <span class="rc-status">${it.lines.length ? '<span class="pill good">מוגדר</span>' : '<span class="pill">אין מתכון</span>'}</span>
    </div>
    <div class="rc-lines stack" style="gap:6px;margin-top:10px">${it.lines.map(l => recipeLine(l, products)).join('')}</div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="btn small" data-addline>+ מוצר</button>
      ${products.some(p => p.name === it.item) ? '<button type="button" class="btn small" data-same>נמכר כמו שהוא (1:1)</button>' : ''}
      <span style="flex:1"></span>
      <button type="button" class="btn small primary" data-saverc>שמירה</button>
    </div></div>`;
}

const STATUS_LABELS = {
  imported: ['יובא', 'good'], ok: ['תקין', 'good'], failed: ['נכשל', 'bad'], skipped: ['דולג', ''], 'no-data': ['אין נתונים', ''],
  duplicate: ['כבר טופל', ''], error: ['שגיאה', 'bad'], running: ['רץ…', '']
};
const statusHtml = s => { const [t, c] = STATUS_LABELS[s] || [s, '']; return `<span class="pill ${c}">${esc(t)}</span>`; };
const kindLabel = k => ({ sales: 'מכירות', items: 'פריטים', cancellations: 'ביטולים', shifts: 'משמרות', tips_daily: 'שעתי', beecomm: 'דוח ביקום', shiftorganizer: 'דוח ShiftOrganizer' }[k] || k || '');

function resultsHtml(results) {
  if (!results?.length) return '<span class="muted">לא נמצאו קבצים או טבלאות במייל</span>';
  return results.map(r => `<div>${statusHtml(r.status)} <b>${esc(r.filename)}</b>
    ${r.kind ? ` · ${esc(kindLabel(r.kind))}` : ''}
    ${r.rows ? ` · ${r.rows} שורות` : ''}${r.from ? ` · ${dmy(r.from)}${r.to !== r.from ? '–' + dmy(r.to) : ''}` : ''}
    ${r.reason ? ` · <span class="muted">${esc(r.reason)}</span>` : ''}
    ${r.headers ? `<div class="muted" style="font-size:12px">עמודות שנמצאו: ${r.headers.map(esc).join(' | ')}</div>` : ''}</div>`).join('');
}

views.connectors = {
  title: 'חיבורים אוטומטיים',
  hideRange: true,
  async render(el) {
    const [list, s, messages] = await Promise.all([api('/api/connectors'), api('/api/settings'), api('/api/connectors/email/messages')]);
    const email = list.find(c => c.id === 'email');
    const bapi = list.find(c => c.id === 'beecomm-api');
    const lastRun = c => c.last ? `${statusHtml(c.last.status)} ${new Date(c.last.started_at + 'Z').toLocaleString('he-IL')}
      ${c.last.summary?.error ? ` · <span class="error">${esc(c.last.summary.error)}</span>` : ''}
      ${c.last.summary?.processed != null ? ` · נבדקו ${c.last.summary.checked} מיילים, טופלו ${c.last.summary.processed}, יובאו ${c.last.summary.imported}` : ''}` : '<span class="muted">עוד לא רץ</span>';

    el.innerHTML = `
      <div class="grid two">
        <div class="card">
          <h3>📧 שלב 1: ייבוא דוחות מהמייל</h3>
          <p class="muted" style="margin-top:0">האפליקציה בודקת תיבת דואר, מוצאת את הדוחות שביקום שולחת אחרי ה-Z, ומייבאת אותם לבד: קבצים מצורפים (Excel/CSV) או טבלאות בגוף המייל.</p>
          <div class="alert ${email.configured ? 'info' : 'warn'}" style="margin-bottom:12px">
            ${email.configured ? `תיבת דואר מחוברת: <b>${esc(email.account)}</b>` : 'תיבת הדואר עוד לא הוגדרה. צריך להגדיר בשרת את IMAP_HOST, IMAP_USER, IMAP_PASSWORD (הסבר ב-README). בינתיים אפשר לבדוק מייל לדוגמה למטה.'}
          </div>
          <form id="email-form" class="stack">
            <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)"><input type="checkbox" name="email_enabled" ${s.email_enabled === '1' ? 'checked' : ''}> בדיקה אוטומטית של המייל</label>
            <div class="row">
              <label>כל כמה דקות <input name="email_interval_minutes" type="number" min="5" value="${esc(s.email_interval_minutes)}" style="width:100px"></label>
              <label>כמה ימים אחורה לחפש <input name="email_lookback_days" type="number" min="1" max="60" value="${esc(s.email_lookback_days)}" style="width:100px"></label>
              <label>תיקייה <input name="email_mailbox" value="${esc(s.email_mailbox)}" style="width:120px"></label>
            </div>
            <div class="row">
              <label>רק ממייל של השולח (מכיל) <input name="email_from_filter" value="${esc(s.email_from_filter)}" placeholder="beecomm"></label>
              <label>רק כשהנושא מכיל <input name="email_subject_filter" value="${esc(s.email_subject_filter)}" placeholder="דוח יומי"></label>
              <label>לשמור כמקור <select name="email_source">${['beecomm', 'website', 'shift', 'wolt', 'tenbis', 'manual'].map(x => `<option value="${x}" ${s.email_source === x ? 'selected' : ''}>${esc(sourceLabel(x))}</option>`).join('')}</select></label>
            </div>
            <div class="row">
              <button class="btn primary">שמירה</button>
              <button type="button" class="btn" id="email-test" ${email.configured ? '' : 'disabled'}>בדיקת חיבור</button>
              <button type="button" class="btn" id="email-run" ${email.configured ? '' : 'disabled'}>${email.running ? 'רץ…' : 'לבדוק מיילים עכשיו'}</button>
            </div>
            <div class="muted" style="font-size:13px">ריצה אחרונה: ${lastRun(email)}</div>
            <div id="email-test-result"></div>
          </form>
        </div>

        <div class="card">
          <h3>🧪 בדיקת מייל לדוגמה</h3>
          <p class="muted" style="margin-top:0">שמרו את המייל מביקום כקובץ <b>.eml</b> וגררו אותו לכאן. ב-Gmail: פותחים את המייל, ⋮ ואז "הורדת ההודעה". ב-Outlook: גוררים את המייל לשולחן העבודה. המערכת תראה מה היא מזהה בו, בלי לשמור כלום.</p>
          <div id="eml-drop" class="dropzone">
            <div style="font-size:28px">✉️</div>
            <div><b>גררו לכאן קובץ ‎.eml</b> או לחצו לבחירה</div>
            <input type="file" id="eml-file" accept=".eml,message/rfc822" hidden>
          </div>
          <div id="eml-result" style="margin-top:12px"></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>🔗 שלב 2: חיבור ישיר ל-API של ביקום</h3>
        <div class="alert ${bapi.configured ? 'info' : 'warn'}">${bapi.configured ? 'פרטי API הוגדרו. המחבר מוכן למימוש לפי התיעוד של ביקום.' : 'ממתין לגישת API ותיעוד מביקום. כשיגיעו, נשלים את המחבר. הנתונים ימשיכו להיכנס לאותם דוחות, בלי כפילויות מול המייל.'}</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>יומן מיילים שטופלו</h3>
        ${messages.length ? `<div class="table-wrap"><table><thead><tr><th>טופל</th><th>שולח</th><th>נושא</th><th>סטטוס</th><th>מה נמצא</th><th></th></tr></thead><tbody>
          ${messages.map(m => `<tr>
            <td>${esc(new Date(m.processed_at + 'Z').toLocaleString('he-IL'))}</td>
            <td style="white-space:normal;max-width:180px;word-break:break-all">${esc(m.sender)}</td><td style="white-space:normal;max-width:200px">${esc(m.subject)}</td><td>${statusHtml(m.status)}</td>
            <td style="white-space:normal;min-width:240px">${resultsHtml(m.details)}</td>
            <td><button class="btn small" data-reprocess="${m.id}">עיבוד מחדש</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">עוד לא טופלו מיילים</div>'}
      </div>`;

    $('#email-form').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      f.email_enabled = e.target.email_enabled.checked ? '1' : '0';
      await api('/api/settings', { method: 'PUT', body: f });
      toast('נשמר'); render();
    };
    $('#email-test').onclick = async () => {
      $('#email-test-result').innerHTML = '<span class="muted">מתחבר…</span>';
      const r = await api('/api/connectors/email/test', { method: 'POST' });
      $('#email-test-result').innerHTML = r.ok
        ? `<div class="alert info">החיבור הצליח. תיקיות: ${r.mailboxes.slice(0, 15).map(esc).join(', ')}</div>`
        : `<div class="alert warn">החיבור נכשל: ${esc(r.error)}</div>`;
    };
    $('#email-run').onclick = async () => {
      $('#email-run').textContent = 'בודק…'; $('#email-run').disabled = true;
      const r = await api('/api/connectors/email/run', { method: 'POST' });
      toast(r.status === 'ok' ? `טופלו ${r.summary.processed} מיילים, יובאו ${r.summary.imported}` : r.error || r.status, 5000);
      render();
    };
    $$('[data-reprocess]', el).forEach(b => b.onclick = async () => {
      const r = await api(`/api/connectors/email/messages/${b.dataset.reprocess}/reprocess`, { method: 'POST' });
      toast(`עובד מחדש: ${STATUS_LABELS[r.status]?.[0] || r.status}`); render();
    });

    const drop = $('#eml-drop'), file = $('#eml-file');
    drop.onclick = () => file.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) checkEml(e.dataTransfer.files[0]); };
    file.onchange = () => file.files[0] && checkEml(file.files[0]);

    async function checkEml(f, dryRun = true) {
      const fd = new FormData(); fd.append('file', f); fd.append('dryRun', String(dryRun));
      try {
        const r = await api('/api/connectors/email/upload', { method: 'POST', body: fd });
        $('#eml-result').innerHTML = `
          <div class="muted" style="font-size:13px">מאת: ${esc(r.from)} · נושא: ${esc(r.subject)}</div>
          <div style="margin:8px 0">${resultsHtml(r.results)}</div>
          ${dryRun && r.status === 'ok' ? '<button class="btn primary" id="eml-import">לייבא את המייל הזה</button>' : ''}
          ${dryRun && r.status !== 'ok' ? '<div class="alert warn">המערכת לא זיהתה דוח שאפשר לייבא. שלחו את הקובץ למפתח כדי להתאים את הזיהוי.</div>' : ''}
          ${!dryRun ? `<div class="alert info">${r.status === 'imported' ? 'יובא בהצלחה' : 'הסתיים: ' + esc(r.status)}</div>` : ''}`;
        const b = $('#eml-import');
        if (b) b.onclick = async () => { await checkEml(f, false); toast('יובא'); setTimeout(render, 1500); };
      } catch (err) { toast(err.message, 5000); }
    }
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
        ${field('min_hourly_wage', 'שכר מינימום לשעה (₪)', 'אם השעתי של המלצרים יוצא נמוך מזה, ההפרש נספר כעלות לעסק. ריק = לא לחשב השלמה. כדאי לוודא את הסכום העדכני')}
        <div><button class="btn primary">שמירה</button></div>
      </form>
      <div class="card" style="margin-top:16px;max-width:640px">
        <h3>חיבור אוטומטי לביקום ולאפליקציית המשמרות</h3>
        <p class="muted">ייבוא אוטומטי מהמייל, ובהמשך חיבור API, מוגדרים במסך <a href="#connectors">חיבורים אוטומטיים</a>.</p>
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
  const route = (location.hash || '#dashboard').slice(1).split('?')[0];
  const navRoute = route.startsWith('inv-') && route !== 'inv-count' ? 'inventory' : route.startsWith('cl-') ? 'checklists' : route;
  const view = views[route] || views.dashboard;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navRoute));
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
window.addEventListener('DOMContentLoaded', boot);
