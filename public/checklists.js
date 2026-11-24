'use strict';
/* Checklists UI: fill (employee), review (manager), manage lists. Loaded after app.js; uses its helpers. */

const CL_TABS = [['checklists', 'מילוי'], ['cl-review', 'מעקב מנהל'], ['cl-templates', 'ניהול רשימות']];
const clTabs = active => `<div class="tabs">${CL_TABS.map(([r, l]) => `<a href="#${r}" class="${r === active ? 'active' : ''}">${l}</a>`).join('')}</div>`;
const PHOTO_LABEL = { none: 'בלי תמונה', optional: 'תמונה אופציונלית', required: 'חובה תמונה' };
const hm = ts => (ts ? new Date(ts.replace(' ', 'T') + 'Z').toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '');
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
const pctOf = r => (r.total ? Math.round((r.done / r.total) * 100) : 0);
const addMin = (t, m) => { const [h, mm] = t.split(':').map(Number); const x = h * 60 + mm + m; return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const durText = m => (m >= 60 ? `${Math.floor(m / 60)} ש׳${m % 60 ? ` ו-${m % 60} דק׳` : ''}` : `${m} דק׳`);
/** Target finish time for each task: list start time + the estimates of all tasks up to it. */
function schedule(items, start) {
  let acc = 0;
  return Object.fromEntries(items.map(i => { acc += i.minutes || 0; return [i.id, start && i.minutes != null ? addMin(start, acc) : null]; }));
}
const atLocal = (date, t) => new Date(`${date}T${t}:00`);
/** Finished vs. deadline: "בזמן" / "איחור N דק׳" / null */
function vsDeadline(r) {
  if (!r.deadline) return null;
  const dl = atLocal(r.date, r.deadline);
  if (r.completed_at) {
    const late = Math.round((new Date(r.completed_at.replace(' ', 'T') + 'Z') - dl) / 60000);
    return late > 0 ? { late: true, text: `איחור ${durText(late)}` } : { late: false, text: 'בזמן' };
  }
  return Date.now() > dl ? { late: true, text: 'לא הסתיים בזמן' } : null;
}

/** Shrinks a photo in the browser before upload (phones take 4-12MB photos). */
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }   // e.g. HEIC the browser can't decode: send as is
}

function lightbox(src) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = `<img src="${esc(src)}" alt="">`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}

// ---------- fill: choose a list ----------
views.checklists = {
  title: "צ'ק ליסטים",
  hideRange: true,
  async render(el) {
    const today = iso(new Date());
    const [templates, employees, runs] = await Promise.all([
      api('/api/checklists/templates'), api('/api/employees'), api(`/api/checklists/runs?from=${today}&to=${today}`)
    ]);
    let me = '';
    try { me = localStorage.getItem('gonzo-me') || ''; } catch { /* ignore */ }
    el.innerHTML = clTabs('checklists') + `
      <div class="card">
        <div class="row">
          <label style="flex:1;min-width:200px">השם שלי
            <input id="cl-me" list="cl-emps" value="${esc(me)}" placeholder="בחרו או הקלידו שם" autocomplete="off">
          </label>
          <label>תאריך <input type="date" id="cl-date" value="${today}"></label>
        </div>
        <datalist id="cl-emps">${employees.filter(e => e.active).map(e => `<option value="${esc(e.name)}">`).join('')}</datalist>
      </div>
      ${templates.length ? `<div class="cl-grid">${templates.map(t => `
        <button class="card cl-card" data-t="${t.id}">
          <div class="cl-card-title">${esc(t.name)}</div>
          <div class="muted">${t.role ? esc(t.role) + ' · ' : ''}${t.items} משימות${t.photos_required ? ` · ${t.photos_required} תמונות חובה` : ''}</div>
          ${t.start_time || t.total_minutes ? `<div class="muted" style="margin-top:4px">⏱ ${t.start_time ? `${esc(t.start_time)}–${esc(t.deadline || addMin(t.start_time, t.total_minutes || 0))}` : `כ-${durText(t.total_minutes)}`}</div>` : ''}
        </button>`).join('')}</div>`
        : `<div class="card empty" style="margin-top:16px">עוד אין רשימות. <a href="#cl-templates">להוספת רשימה</a></div>`}
      ${runs.length ? `<div class="card" style="margin-top:16px"><h3>היום</h3>${runs.map(r => `
        <a class="cl-run-row" href="#cl-run?id=${r.id}">
          <span><b>${esc(r.template_name)}</b> · ${esc(r.employee)}</span>
          <span class="muted">${r.completed_at ? '✅ הושלם' : `${r.done}/${r.total}`}</span>
        </a>`).join('')}</div>` : ''}`;

    $$('[data-t]', el).forEach(b => b.onclick = async () => {
      const name = $('#cl-me').value.trim();
      if (!name) { $('#cl-me').focus(); return toast('קודם בוחרים שם'); }
      try { localStorage.setItem('gonzo-me', name); } catch { /* ignore */ }
      try {
        const r = await api('/api/checklists/runs', { method: 'POST', body: { template_id: b.dataset.t, employee: name, date: $('#cl-date').value } });
        if (r.resumed) toast('ממשיכים את הרשימה שהתחלת');
        location.hash = `#cl-run?id=${r.id}`;
      } catch (err) { toast(err.message); }
    });
  }
};

// ---------- fill / view one run ----------
views['cl-run'] = {
  title: "צ'ק ליסט",
  hideRange: true,
  async render(el) {
    const id = hashParams().get('id');
    const r = await api(`/api/checklists/runs/${id}`);
    const sections = [];
    for (const it of r.items) {
      let s = sections[sections.length - 1];
      if (!s || s.title !== it.section) sections.push(s = { title: it.section, items: [] });
      s.items.push(it);
    }
    const due = schedule(r.items, r.start_time);
    const totalMin = r.items.reduce((a, i) => a + (i.minutes || 0), 0);
    const isToday = r.date === iso(new Date());
    const draw = () => {
      const done = r.items.filter(i => i.done).length;
      const missing = r.items.filter(i => i.photo === 'required' && !i.photos.length).length;
      // where we should be by now according to the schedule
      const now = new Date();
      const expected = isToday && r.start_time ? r.items.filter(i => due[i.id] && atLocal(r.date, due[i.id]) <= now).length : null;
      const behind = expected != null && !r.completed_at ? expected - r.items.filter(i => i.done && due[i.id] && atLocal(r.date, due[i.id]) <= now).length : 0;
      $('#cl-progress-text').innerHTML = esc(`${done} מתוך ${r.items.length} משימות${missing ? ` · חסרות ${missing} תמונות חובה` : ''}`)
        + (expected != null && !r.completed_at ? (behind > 0 ? ` · <span class="error">${behind} משימות מאחרות לפי הלו״ז</span>` : ' · <span style="color:var(--good)">בזמן ✓</span>') : '');
      $$('.cl-item', el).forEach(itemEl => {
        const it = r.items.find(i => i.id === Number(itemEl.dataset.item));
        itemEl.classList.toggle('late', Boolean(isToday && !it.done && due[it.id] && atLocal(r.date, due[it.id]) < now && !r.completed_at));
      });
      $('#cl-bar').style.width = `${r.items.length ? (done / r.items.length) * 100 : 0}%`;
      sections.forEach((s, si) => {
        const n = s.items.filter(i => i.done).length;
        const badge = $(`[data-sbadge="${si}"]`);
        if (badge) { badge.textContent = `${n}/${s.items.length}`; badge.classList.toggle('good', n === s.items.length); }
      });
    };

    el.innerHTML = `
      <div class="card cl-head">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div><b style="font-size:18px">${esc(r.template_name)}</b>
            <div class="muted">${esc(r.employee)} · ${dmy(r.date)} · התחיל ${hm(r.started_at)}${r.completed_at ? ` · ✅ הושלם ${hm(r.completed_at)}` : ''}</div>
            ${totalMin ? `<div class="muted">⏱ ${r.start_time ? `${esc(r.start_time)}–${esc(r.deadline || addMin(r.start_time, totalMin))} · ` : ''}הערכה ${durText(totalMin)}${vsDeadline(r) ? ` · <span class="${vsDeadline(r).late ? 'error' : ''}">${vsDeadline(r).text}</span>` : ''}</div>` : ''}</div>
          <a class="btn small ghost" href="#checklists">← לרשימות</a>
        </div>
        <div class="progress"><span id="cl-bar"></span></div>
        <div id="cl-progress-text" class="muted" style="font-size:13px"></div>
      </div>
      ${r.template_notes ? `<div class="alert warn" style="margin-top:12px;white-space:pre-line">${esc(r.template_notes)}</div>` : ''}
      ${sections.map((s, si) => `
        <details class="card cl-section" open style="margin-top:12px">
          <summary><span>${esc(s.title)}</span><span class="pill" data-sbadge="${si}"></span></summary>
          ${s.items.map(it => `
            <div class="cl-item ${it.done ? 'done' : ''}" data-item="${it.id}">
              <label class="cl-check"><input type="checkbox" ${it.done ? 'checked' : ''}><span class="cl-box"></span>
                <span class="cl-text">${esc(it.text)}${it.photo === 'required' ? ' <span class="pill bad">📷 חובה</span>' : ''}
                  ${it.minutes != null ? `<span class="cl-eta">⏱ ${durText(it.minutes)}${due[it.id] ? ` · עד ${due[it.id]}` : ''}</span>` : ''}
                  ${it.done_at ? `<span class="muted cl-time">✓ ${hm(it.done_at)}</span>` : ''}</span></label>
              ${it.details ? `<div class="cl-details">${esc(it.details).split('\n').map(l => `<div>${l}</div>`).join('')}</div>` : ''}
              <div class="cl-photos">${it.photos.map(p => `<img src="/api/checklists/photos/${p.id}" data-photo="${p.id}" loading="lazy" alt="">`).join('')}</div>
              <div class="cl-actions">
                ${it.photo !== 'none' || it.photos.length ? `<label class="btn small">📷 תמונה<input type="file" accept="image/*" capture="environment" hidden data-upload></label>` : `<label class="btn small ghost">📷<input type="file" accept="image/*" capture="environment" hidden data-upload></label>`}
                <button class="btn small ghost" data-note>💬 ${it.note ? 'הערה' : 'הוספת הערה'}</button>
              </div>
              <textarea class="cl-note ${it.note ? '' : 'hidden'}" placeholder="הערה למנהל (למשל: חסר מלאי, תקלה)">${esc(it.note || '')}</textarea>
            </div>`).join('')}
        </details>`).join('')}
      <div class="save-bar">
        <input id="cl-final-note" placeholder="הערה כללית (לא חובה)" value="${esc(r.note || '')}" style="flex:1;min-width:160px">
        <button class="btn primary" id="cl-finish">${r.completed_at ? 'עדכון סיום' : '✅ סיום'}</button>
      </div>`;
    draw();
    // keep "late" markers current while the page is open
    const timer = setInterval(() => { if (!document.body.contains(el) || !$('#cl-progress-text')) return clearInterval(timer); draw(); }, 60000);

    const find = itemEl => r.items.find(i => i.id === Number(itemEl.dataset.item));
    $$('.cl-item', el).forEach(itemEl => {
      const it = find(itemEl);
      $('input[type=checkbox]', itemEl).onchange = async e => {
        const want = e.target.checked;
        try {
          const u = await api(`/api/checklists/runs/${r.id}/items/${it.id}`, { method: 'PATCH', body: { done: want } });
          it.done = Boolean(u.done); it.done_at = u.done_at;
          itemEl.classList.toggle('done', it.done);
          draw();
        } catch (err) { e.target.checked = !want; toast(err.message); }
      };
      $('[data-note]', itemEl).onclick = () => { const t = $('.cl-note', itemEl); t.classList.remove('hidden'); t.focus(); };
      $('.cl-note', itemEl).onchange = async e => {
        await api(`/api/checklists/runs/${r.id}/items/${it.id}`, { method: 'PATCH', body: { note: e.target.value } });
        it.note = e.target.value; toast('ההערה נשמרה');
      };
      $('[data-upload]', itemEl).onchange = async e => {
        const f = e.target.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('photo', await shrinkImage(f));
        toast('מעלה תמונה…');
        try {
          const p = await api(`/api/checklists/runs/${r.id}/items/${it.id}/photos`, { method: 'POST', body: fd });
          it.photos.push({ id: p.id });
          $('.cl-photos', itemEl).insertAdjacentHTML('beforeend', `<img src="/api/checklists/photos/${p.id}" data-photo="${p.id}" alt="">`);
          toast('התמונה נשמרה');
          // a photo is the proof for a photo task: tick it too
          if (it.photo !== 'none' && !it.done) {
            const u = await api(`/api/checklists/runs/${r.id}/items/${it.id}`, { method: 'PATCH', body: { done: true } });
            it.done = true; it.done_at = u.done_at;
            $('input[type=checkbox]', itemEl).checked = true;
            itemEl.classList.add('done');
          }
          draw();
        } catch (err) { toast(err.message, 5000); }
        e.target.value = '';
      };
    });
    el.addEventListener('click', e => { if (e.target.matches('[data-photo]')) lightbox(e.target.src); });
    $('#cl-finish').onclick = async () => {
      const left = r.items.filter(i => !i.done).length;
      const missing = r.items.filter(i => i.photo === 'required' && !i.photos.length).length;
      if ((left || missing) && !confirm(`${left ? `${left} משימות לא סומנו. ` : ''}${missing ? `חסרות ${missing} תמונות חובה. ` : ''}לסיים בכל זאת? המנהל יראה מה חסר.`)) return;
      await api(`/api/checklists/runs/${r.id}/complete`, { method: 'POST', body: { note: $('#cl-final-note').value } });
      toast('הרשימה נשלחה למנהל ✅');
      location.hash = '#checklists';
    };
  }
};

// ---------- manager review ----------
views['cl-review'] = {
  title: "מעקב צ'ק ליסטים",
  async render(el) {
    const runs = await api(`/api/checklists/runs?${q()}`);
    const byDate = {};
    for (const r of runs) (byDate[r.date] ||= []).push(r);
    el.innerHTML = clTabs('cl-review') + (runs.length ? Object.entries(byDate).map(([date, rs]) => `
      <div class="card" style="margin-top:12px"><h3>${esc(DAY_NAMES_HE[new Date(date + 'T12:00:00').getDay()])} ${dmy(date)}</h3>
        <div class="table-wrap"><table><thead><tr><th>רשימה</th><th>עובד</th><th>התחיל</th><th>סיים</th><th>מול היעד</th><th>ביצוע</th><th>תמונות</th><th>הערות</th><th></th></tr></thead><tbody>
          ${rs.map(r => `<tr>
            <td><b>${esc(r.template_name)}</b></td><td>${esc(r.employee)}</td><td>${hm(r.started_at)}</td>
            <td>${r.completed_at ? hm(r.completed_at) : '<span class="pill">בתהליך</span>'}</td>
            <td>${(v => (v ? `<span class="pill ${v.late ? 'bad' : 'good'}">${esc(v.text)}</span>` : (r.deadline ? `<span class="muted">יעד ${esc(r.deadline)}</span>` : '')))(vsDeadline(r))}</td>
            <td class="${pctOf(r) < 100 ? 'bad' : 'good'}">${pctOf(r)}% (${r.done}/${r.total})</td>
            <td>${r.photos}${r.missing_photos ? ` <span class="pill bad">חסרות ${r.missing_photos}</span>` : ''}</td>
            <td>${r.notes || r.note ? `💬 ${r.notes + (r.note ? 1 : 0)}` : ''}</td>
            <td><a class="btn small" href="#cl-run?id=${r.id}">צפייה</a> <button class="btn small danger" data-del="${r.id}">מחיקה</button></td></tr>`).join('')}
        </tbody></table></div></div>`).join('')
      : '<div class="card empty">אין רשימות שמולאו בתקופה הזו</div>');
    $$('[data-del]', el).forEach(b => b.onclick = async () => {
      if (!confirm('למחוק את הרשימה שמולאה, כולל התמונות?')) return;
      await api(`/api/checklists/runs/${b.dataset.del}`, { method: 'DELETE' }); render();
    });
  }
};
const DAY_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ---------- manage lists ----------
views['cl-templates'] = {
  title: "ניהול צ'ק ליסטים",
  hideRange: true,
  async render(el) {
    const editId = hashParams().get('edit');
    if (editId) return editTemplate(el, editId === 'new' ? null : editId);
    const list = await api('/api/checklists/templates?all=1');
    el.innerHTML = clTabs('cl-templates') + `
      <div class="card">
        <div class="row">
          <a class="btn primary" href="#cl-templates?edit=new">+ רשימה חדשה</a>
          <label class="btn">📄 ייבוא רשימה מקובץ (JSON)<input type="file" id="cl-import" accept=".json,application/json" hidden></label>
        </div>
      </div>
      <div class="card" style="margin-top:12px">${table([
        { key: 'name', label: 'רשימה', html: (v, t) => `<b>${esc(v)}</b>${t.active ? '' : ' <span class="pill">לא פעילה</span>'}` },
        { key: 'role', label: 'למי' }, { key: 'items', label: 'משימות', fmt: num }, { key: 'photos_required', label: 'תמונות חובה', fmt: num },
        { key: 'total_minutes', label: 'זמן משוער', html: (v, t) => (v ? esc(durText(v)) + (t.start_time ? ` <span class="muted">(${esc(t.start_time)}–${esc(t.deadline || addMin(t.start_time, v))})</span>` : '') : '-') },
        { key: 'last_run', label: 'מולאה לאחרונה', fmt: dmy },
        { key: 'id', label: '', html: id => `<a class="btn small" href="#cl-templates?edit=${id}">עריכה</a> <button class="btn small" data-export="${id}">ייצוא</button> <button class="btn small danger" data-del="${id}">מחיקה</button>` }
      ], list, { empty: 'אין רשימות עדיין' })}</div>`;
    $('#cl-import').onchange = async e => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        const arr = Array.isArray(data) ? data : [data];
        // a list with the same name is updated, not duplicated
        for (const t of arr) await api('/api/checklists/templates', { method: 'POST', body: { ...t, replace_by_name: true } });
        toast(`יובאו ${arr.length} רשימות (רשימות קיימות באותו שם עודכנו)`); render();
      } catch (err) { toast(err.message || 'הקובץ לא תקין', 5000); }
    };
    $$('[data-export]', el).forEach(b => b.onclick = async () => {
      const t = await api(`/api/checklists/templates/${b.dataset.export}`);
      const clean = { name: t.name, role: t.role, description: t.description, notes: t.notes, start_time: t.start_time, deadline: t.deadline,
        sections: t.sections.map(s => ({ title: s.title, items: s.items.map(i => ({ text: i.text, details: i.details, photo: i.photo, minutes: i.minutes })) })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' }));
      a.download = `${t.name}.json`; a.click();
    });
    $$('[data-del]', el).forEach(b => b.onclick = async () => {
      if (!confirm('למחוק את הרשימה? רשימות שכבר מולאו יישארו במעקב')) return;
      await api(`/api/checklists/templates/${b.dataset.del}`, { method: 'DELETE' }); render();
    });
  }
};

async function editTemplate(el, id) {
  const t = id ? await api(`/api/checklists/templates/${id}`) : { name: '', role: '', notes: '', active: 1, sections: [{ title: '', items: [{ text: '', details: '', photo: 'none' }] }] };
  const itemHtml = i => `
    <div class="cl-edit-item">
      <div class="row" style="align-items:center">
        <input data-f="text" value="${esc(i.text)}" placeholder="משימה" style="flex:1;min-width:200px">
        <label class="cl-min" title="הערכת זמן בדקות"><input data-f="minutes" type="number" min="0" step="1" value="${i.minutes ?? ''}" placeholder="דק׳" style="width:64px"> דק׳</label>
        <select data-f="photo">${Object.entries(PHOTO_LABEL).map(([k, v]) => `<option value="${k}" ${i.photo === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button type="button" class="btn small ghost" data-mv="-1" title="למעלה">↑</button><button type="button" class="btn small ghost" data-mv="1" title="למטה">↓</button>
        <button type="button" class="btn small danger" data-rm>✕</button>
      </div>
      <textarea data-f="details" placeholder="פרטים / תתי-סעיפים, שורה לכל אחד (לא חובה)" rows="2">${esc(i.details || '')}</textarea>
    </div>`;
  const sectionHtml = s => `
    <div class="card cl-edit-section" style="margin-top:12px">
      <div class="row" style="align-items:center">
        <input data-f="title" value="${esc(s.title)}" placeholder="שם הסעיף" style="flex:1;font-weight:700">
        <button type="button" class="btn small ghost" data-smv="-1">↑</button><button type="button" class="btn small ghost" data-smv="1">↓</button>
        <button type="button" class="btn small danger" data-srm>מחיקת סעיף</button>
      </div>
      <div class="cl-edit-items">${s.items.map(itemHtml).join('')}</div>
      <button type="button" class="btn small" data-additem>+ משימה</button>
    </div>`;
  el.innerHTML = clTabs('cl-templates') + `
    <div class="card">
      <div class="row">
        <label style="flex:1;min-width:200px">שם הרשימה <input id="te-name" value="${esc(t.name)}"></label>
        <label>למי <input id="te-role" value="${esc(t.role || '')}" placeholder="מלצרים / בר / מטבח"></label>
        <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="checkbox" id="te-active" ${t.active ? 'checked' : ''}> פעילה</label>
      </div>
      <div class="row" style="margin-top:10px">
        <label>שעת התחלה <input type="time" id="te-start" value="${esc(t.start_time || '')}"></label>
        <label>יעד סיום <input type="time" id="te-deadline" value="${esc(t.deadline || '')}"></label>
        <div id="te-total" class="muted" style="align-self:center"></div>
      </div>
      <label style="margin-top:10px">כללים / הדגשים שיופיעו בראש הרשימה <textarea id="te-notes" rows="3">${esc(t.notes || '')}</textarea></label>
    </div>
    <div id="te-sections">${t.sections.map(sectionHtml).join('')}</div>
    <div class="save-bar">
      <button type="button" class="btn" id="te-addsec">+ סעיף</button>
      <span style="flex:1"></span>
      <a class="btn ghost" href="#cl-templates">ביטול</a>
      <button class="btn primary" id="te-save">💾 שמירה</button>
    </div>`;
  const root = $('#te-sections');
  const showTotal = () => {
    const total = $$('[data-f=minutes]', root).reduce((a, i) => a + (Number(i.value) || 0), 0);
    const start = $('#te-start').value, dl = $('#te-deadline').value;
    let txt = total ? `סה״כ הערכה: ${durText(total)}` : 'אין עדיין הערכות זמן';
    if (start && total) {
      const end = addMin(start, total);
      txt += ` · מסתיים ב-${end}`;
      if (dl) { const diff = (atLocal('2000-01-01', dl) - atLocal('2000-01-01', end)) / 60000; txt += diff >= 0 ? ` · ${durText(diff)} מרווח עד היעד` : ` · ⚠️ ${durText(-diff)} יותר מהזמן עד היעד`; }
    }
    $('#te-total').textContent = txt;
  };
  root.addEventListener('input', e => { if (e.target.matches('[data-f=minutes]')) showTotal(); });
  $('#te-start').oninput = $('#te-deadline').oninput = showTotal;
  showTotal();
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const item = b.closest('.cl-edit-item'), sec = b.closest('.cl-edit-section');
    if (b.matches('[data-rm]')) item.remove();
    else if (b.matches('[data-mv]')) { const sib = b.dataset.mv === '-1' ? item.previousElementSibling : item.nextElementSibling?.nextElementSibling; item.parentNode.insertBefore(item, sib || (b.dataset.mv === '1' ? null : item)); }
    else if (b.matches('[data-additem]')) $('.cl-edit-items', sec).insertAdjacentHTML('beforeend', itemHtml({ text: '', details: '', photo: 'none' }));
    else if (b.matches('[data-srm]')) { if (confirm('למחוק את הסעיף וכל המשימות שבו?')) sec.remove(); }
    else if (b.matches('[data-smv]')) { const sib = b.dataset.smv === '-1' ? sec.previousElementSibling : sec.nextElementSibling?.nextElementSibling; root.insertBefore(sec, sib || (b.dataset.smv === '1' ? null : sec)); }
  });
  $('#te-addsec').onclick = () => { root.insertAdjacentHTML('beforeend', sectionHtml({ title: '', items: [{ text: '', details: '', photo: 'none' }] })); root.lastElementChild.scrollIntoView({ behavior: 'smooth' }); };
  $('#te-save').onclick = async () => {
    const body = {
      name: $('#te-name').value, role: $('#te-role').value, notes: $('#te-notes').value, active: $('#te-active').checked,
      start_time: $('#te-start').value, deadline: $('#te-deadline').value,
      sections: $$('.cl-edit-section', root).map(s => ({
        title: $('[data-f=title]', s).value,
        items: $$('.cl-edit-item', s).map(i => ({ text: $('[data-f=text]', i).value, details: $('[data-f=details]', i).value, photo: $('[data-f=photo]', i).value, minutes: $('[data-f=minutes]', i).value }))
      }))
    };
    try {
      await api(id ? `/api/checklists/templates/${id}` : '/api/checklists/templates', { method: id ? 'PUT' : 'POST', body });
      toast('נשמר'); location.hash = '#cl-templates';
    } catch (err) { toast(err.message, 5000); }
  };
}
