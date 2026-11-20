/* Time Clock: a home-screen time-in/time-out app.
 * Data lives in localStorage on the device. No server.
 * Billing rules mirror the TIME.numbers sheet:
 *   hours = end - start (wraps past midnight), every minute billed
 *   STANDARD $30/hr, DRIVING $20/hr            (configurable)
 */
(() => {
  'use strict';

  const VERSION = '2.6.0';
  const KEY = 'timeclock.v1';
  const HOUR = 3600000;
  const DAY = 86400000;

  const DEFAULT_SETTINGS = {
    payToName: 'Austin Doran',
    payToAddr: '2201 Lamar St, Edgewater, CO 80214',
    billToName: 'Colorado Saunas',
    billToAddr: '7721 W 6th Ave Unit A, Lakewood, CO 80214',
    rateStandard: 35,
    rateDriving: 20,
    roundMin: 15,
    periodAnchor: '2025-12-15',
    periodDays: 14,
    dueDays: 2,
    invoiceStart: 2,
    logo: null, // cached logo as a data URL (so PDFs work offline)
    logoUrl: 'icons/ad-logo.png', // bundled AD logo; can point elsewhere in Setup
    emailTo: 'kylie@coloradosaunas.com, Amanda.k.aragon@gmail.com',
    emailBody: "Hi Kylie and Amanda,\n\nHere's my invoice for the pay period {period}.\nLet me know if you have any questions.\n\nThank you!",
  };

  // ---------- storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        return {
          settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
          entries: Array.isArray(d.entries) ? d.entries : [],
          invoiceNos: d.invoiceNos || {},
        };
      }
    } catch (e) { console.error(e); }
    return { settings: { ...DEFAULT_SETTINGS }, entries: [], invoiceNos: {} };
  }
  let db = load();
  // Fill in any blank names, addresses or email settings from the defaults.
  ['payToName', 'payToAddr', 'billToName', 'billToAddr', 'emailTo', 'emailBody'].forEach(k => { if (!String(db.settings[k] || '').trim()) db.settings[k] = DEFAULT_SETTINGS[k]; });
  // The AD logo now ships with the app, so replace an empty or website logo link with it.
  if (!db.settings.logoUrl || /squarespace-cdn/.test(db.settings.logoUrl)) { db.settings.logoUrl = 'icons/ad-logo.png'; db.settings.logo = null; }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('Could not save: ' + e.message); }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- date helpers (local time) ----------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function dayNum(d) { return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function atTime(dateStr, timeStr) {
    const d = parseYmd(dateStr); const [h, m] = timeStr.split(':').map(Number);
    d.setHours(h, m, 0, 0); return d;
  }
  const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const Mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function clock12(d) {
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${pad(d.getMinutes())} ${ap}`;
  }
  function roundTime(ms) {
    const r = Number(db.settings.roundMin) || 0;
    if (r <= 0) return Math.floor(ms / 60000) * 60000;
    const step = r * 60000; return Math.round(ms / step) * step;
  }

  // ---------- billing ----------
  function rateOf(type) { return type === 'DRIVING' ? Number(db.settings.rateDriving) : type === 'EXPENSE' ? 0 : Number(db.settings.rateStandard); }
  const isExp = e => e.rate === 'EXPENSE';
  // A row keeps the rate it was billed at once its pay period is over (e.unit); otherwise it uses today's rate.
  const unitOf = e => e.unit != null ? Number(e.unit) : rateOf(e.rate);
  // Before a rate changes, pin the old rate on rows from earlier pay periods so past invoices don't change.
  function lockRate(type, oldRate) {
    const cutoff = periodByIndex(periodIndexFor(new Date())).start.getTime();
    db.entries.forEach(e => { if (e.rate === type && e.unit == null && e.start < cutoff) e.unit = Number(oldRate); });
  }
  // Punches are stored exactly; billing rounds start/end to the nearest roundMin.
  function rawHours(e, now = Date.now()) {
    const s = roundTime(e.start), en = roundTime(e.end ?? now);
    return Math.max(0, (en - s) / HOUR);
  }
  const billHours = (e, now) => isExp(e) ? 0 : rawHours(e, now);
  const qtyRound = h => Math.round(h * 100) / 100;
  function amount(e, now) {
    if (isExp(e)) return Math.round((Number(e.amount) || 0) * 100) / 100;
    return Math.round(qtyRound(billHours(e, now)) * unitOf(e) * 100) / 100;
  }
  const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = q => String(qtyRound(q));
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  // ---------- pay periods ----------
  function periodIndexFor(date) {
    const a = parseYmd(db.settings.periodAnchor); const len = Number(db.settings.periodDays) || 14;
    return Math.floor((dayNum(date) - dayNum(a)) / len);
  }
  function periodByIndex(i) {
    const a = parseYmd(db.settings.periodAnchor); const len = Number(db.settings.periodDays) || 14;
    const start = addDays(a, i * len); const end = addDays(start, len - 1);
    return { i, start, end, key: ymd(start) };
  }
  let viewPeriod = periodIndexFor(new Date());
  function entriesIn(p) {
    const lo = dayNum(p.start), hi = dayNum(p.end);
    return db.entries.filter(e => { const n = dayNum(new Date(e.start)); return n >= lo && n <= hi; })
      .sort((a, b) => a.start - b.start);
  }
  function invoiceNo(p) {
    if (db.invoiceNos[p.key] != null && db.invoiceNos[p.key] !== '') return String(db.invoiceNos[p.key]);
    const anchorIdx = 0; // anchor period has index 0
    return String((Number(db.settings.invoiceStart) || 1) + (p.i - anchorIdx));
  }
  const padInv = n => (/^\d$/.test(n) ? '0' + n : n);
  function rangeLabel(p) {
    const s = p.start, e = p.end;
    const same = s.getMonth() === e.getMonth();
    return same ? `${Mon[s.getMonth()]} ${s.getDate()} – ${e.getDate()}` : `${Mon[s.getMonth()]} ${s.getDate()} – ${Mon[e.getMonth()]} ${e.getDate()}`;
  }

  // ---------- state ----------
  const running = () => db.entries.find(e => e.end == null);
  let selRate = 'STANDARD';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function recentDescs() {
    const seen = new Set(); const out = [];
    [...db.entries].sort((a, b) => b.start - a.start).forEach(e => {
      const d = (e.desc || '').trim(); const k = d.toLowerCase();
      if (d && !seen.has(k)) { seen.add(k); out.push({ desc: d, rate: e.rate }); }
    });
    return out.slice(0, 8);
  }

  // ---------- DOM ----------
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }
  function haptic() { if (navigator.vibrate) navigator.vibrate(15); }

  function setRate(r) {
    if (r !== selRate) { selRate = r; applyMode($('#addForm'), '#modeSeg', addMode()); }
    selRate = r;
    $$('#rateSeg button').forEach(b => b.classList.toggle('on', b.dataset.rate === r));
  }

  const ICON_TRUCK = '<svg viewBox="0 0 24 24"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>';
  const ICON_RECEIPT = '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>';
  const ICON_SAW = '<svg viewBox="0 0 24 24"><path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M10 20v-6h4v6"/></svg>';
  function entryRow(e) {
    const st = new Date(roundTime(e.start)); const en = e.end != null ? new Date(roundTime(e.end)) : null;
    const drive = e.rate === 'DRIVING'; const exp = isExp(e);
    const detail = exp ? 'Expense' : `${e.noTimes ? 'Hours only' : `${clock12(st)} to ${en ? clock12(en) : '…'}`} · ${fmtQty(billHours(e))} h`;
    return `<button class="row entry" data-id="${e.id}">
      <span class="badge">${exp ? ICON_RECEIPT : drive ? ICON_TRUCK : ICON_SAW}</span>
      <span class="nm"><b>${esc(e.desc || 'No name')}${drive ? '<span class="tag">Drive</span>' : exp ? '<span class="tag">Expense</span>' : ''}</b>
        <small>${detail}</small></span>
      <span class="amt">${money(amount(e))}</span>
    </button>`;
  }

  function renderHeader() {
    const p = periodByIndex(viewPeriod);
    const list = entriesIn(p);
    const hrs = list.reduce((a, e) => a + qtyRound(billHours(e)), 0);
    const tot = list.reduce((a, e) => a + amount(e), 0);
    const cur = viewPeriod === periodIndexFor(new Date());
    $('#heroEyebrow').textContent = `${cur ? 'This pay period' : 'Pay period'} · Invoice ${padInv(invoiceNo(p))}`;
    $('#periodRange').textContent = rangeLabel(p);
    $('#statHours').textContent = String(qtyRound(hrs));
    $('#statEarned').textContent = money(tot);
    const to = (db.settings.emailTo || '').trim();
    $('#emailHint').textContent = to ? `Send PDF attaches the invoice. Email opens a message to ${to}; attach the saved PDF from Files.` : 'Send PDF opens the share sheet. Pick Mail to attach it to an email.';
    $('#invNote').textContent = `${rangeLabel(p)} · ${list.length} ${list.length === 1 ? 'row' : 'rows'}`;
  }

  // ---------- add form (works like a row in the Numbers sheet) ----------
  const STEP = () => Number(db.settings.roundMin) > 0 ? Number(db.settings.roundMin) : 15;
  function fillTimeSelects(root) {
    const step = STEP(); let opts = '';
    for (let m = 0; m < 1440; m += step) {
      const v = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
      const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
      opts += `<option value="${v}">${clock12(d)}</option>`;
    }
    root.querySelectorAll('select.time-pick').forEach(sel => { const keep = sel.value; sel.innerHTML = opts; if (keep) sel.value = keep; });
  }
  function fillHourSelects(root) {
    const step = STEP(); let opts = '';
    for (let m = step; m <= 16 * 60; m += step) {
      opts += `<option value="${m}">${Math.floor(m / 60)}:${pad(m % 60)} · ${qtyRound(m / 60)} h</option>`;
    }
    root.querySelectorAll('select.hours-pick').forEach(sel => { const keep = sel.value; sel.innerHTML = opts; sel.value = keep || '60'; if (!sel.value) sel.value = String(step * Math.round(60 / step)); });
  }
  // Mode switch: 'times' (start and end) or 'hours' (just an amount, no time of day)
  function applyMode(form, segSel, mode) {
    const exp = (form.id === 'addForm' ? selRate : entryRate) === 'EXPENSE';
    document.querySelectorAll(segSel + ' button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    form.querySelectorAll('.times-only').forEach(el => el.hidden = exp || mode !== 'times');
    form.querySelectorAll('.hours-only').forEach(el => el.hidden = exp || mode !== 'hours');
    form.querySelectorAll('.not-expense').forEach(el => el.hidden = exp);
    form.querySelectorAll('.expense-only').forEach(el => el.hidden = !exp);
  }
  // Hours-only rows are stored from midnight of their date, flagged noTimes.
  function hoursEntryTimes(date, mins) { const start = atTime(date, '00:00').getTime(); return { start, end: start + Number(mins) * 60000, noTimes: true }; }
  const toMin = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const fromMin = m => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  function snap(v) { const st = STEP(); return fromMin(Math.round(toMin(v) / st) * st); }

  // Next start = end of the last entry that day (so a drive flows into the job), else 9:00 AM.
  function suggestTimes(date) {
    const day = db.entries.filter(e => e.end != null && !e.noTimes && ymd(new Date(e.start)) === date).sort((x, y) => y.end - x.end)[0];
    const start = day ? snap(hm(new Date(roundTime(day.end)))) : '09:00';
    return { start, end: fromMin(toMin(start) + 60) };
  }
  function resetAddForm(keepDate) {
    const f = $('#addForm');
    if (!keepDate || !f.elements.date.value) f.elements.date.value = ymd(new Date());
    const t = suggestTimes(f.elements.date.value);
    f.elements.start.value = t.start; f.elements.end.value = t.end;
    f.elements.desc.value = ''; f.elements.amount.value = '';
    updateAddCalc();
  }
  function addFormEntry() {
    const f = $('#addForm'); const date = f.elements.date.value;
    if (!date) return null;
    if (selRate === 'EXPENSE') {
      const start = atTime(date, '00:00').getTime();
      return { rate: 'EXPENSE', desc: f.elements.desc.value.trim(), start, end: start, noTimes: true, amount: Number(f.elements.amount.value) || 0 };
    }
    if (addMode() === 'hours') {
      if (!f.elements.hours.value) return null;
      return { rate: selRate, desc: f.elements.desc.value.trim(), ...hoursEntryTimes(date, f.elements.hours.value) };
    }
    if (!f.elements.start.value || !f.elements.end.value) return null;
    const start = atTime(date, f.elements.start.value).getTime();
    let end = atTime(date, f.elements.end.value).getTime();
    if (end <= start) end += DAY; // past midnight
    return { rate: selRate, desc: f.elements.desc.value.trim(), start, end };
  }
  const addMode = () => db.settings.addMode === 'hours' ? 'hours' : 'times';
  function updateAddCalc() {
    const e = addFormEntry(); const out = $('#addCalc'); if (!e) { out.textContent = ''; return; }
    if (isExp(e)) { out.innerHTML = `<span>Expense · goes on the invoice as qty 1</span><b>${money(amount(e))}</b>`; return; }
    const h = billHours(e);
    out.innerHTML = `<span>${fmtQty(h)} h × ${money(rateOf(e.rate))}</span><b>${money(amount(e))}</b>` + (!e.noTimes && new Date(e.end).getDate() !== new Date(e.start).getDate() ? '<small>ends next day</small>' : '');
  }

  function renderClock() {
    const chips = recentDescs();
    $('#recentChips').innerHTML = chips.map((c, i) => `<button type="button" class="chip" data-chip="${i}">${esc(c.desc)}</button>`).join('');
    $('#recentChips').querySelectorAll('.chip').forEach(b => b.onclick = () => {
      const c = chips[Number(b.dataset.chip)]; $('#addForm').elements.desc.value = c.desc; setRate(c.rate); updateAddCalc(); haptic();
    });
    const date = $('#addForm').elements.date.value || ymd(new Date());
    const d = parseYmd(date);
    $('#dayListH').textContent = date === ymd(new Date()) ? 'Today' : `${DOW[d.getDay()]} ${Mon[d.getMonth()]} ${d.getDate()}`;
    const list = db.entries.filter(e => ymd(new Date(e.start)) === date).sort((a, b) => a.start - b.start);
    $('#todayList').innerHTML = list.map(entryRow).join('');
    $('#dayTotal').textContent = list.length ? `${qtyRound(list.reduce((a, e) => a + qtyRound(billHours(e)), 0))} h · ${money(list.reduce((a, e) => a + amount(e), 0))}` : '';
    updateAddCalc();
  }

  function renderLog() {
    const p = periodByIndex(viewPeriod);
    const byDay = {};
    entriesIn(p).forEach(e => (byDay[ymd(new Date(e.start))] ||= []).push(e));
    $('#logList').innerHTML = Object.keys(byDay).sort().reverse().map(k => {
      const d = parseYmd(k); const items = byDay[k];
      const hrs = items.reduce((a, e) => a + qtyRound(billHours(e)), 0);
      const tot = items.reduce((a, e) => a + amount(e), 0);
      return `<div class="card"><div class="day-total"><span>${DOW[d.getDay()]} · ${Mon[d.getMonth()]} ${d.getDate()}</span><b>${qtyRound(hrs)} h · ${money(tot)}</b></div>${items.map(entryRow).join('')}</div>`;
    }).join('');
  }

  function invoiceModel(p) {
    const s = db.settings; const list = entriesIn(p).filter(e => e.end != null);
    const rows = list.map(e => {
      const unit = isExp(e) ? amount(e) : unitOf(e);
      return {
        date: ymd(new Date(e.start)),
        desc: (e.desc || '').toUpperCase(),
        rate: isExp(e) ? 'Expense' : e.rate === 'DRIVING' ? 'Driving' : 'Standard',
        qty: isExp(e) ? '1' : fmtQty(billHours(e)),
        unit: '$' + (Number.isInteger(unit) ? unit : unit.toFixed(2)),
        total: money(amount(e)),
        amt: amount(e),
      };
    });
    const total = rows.reduce((a, r) => a + r.amt, 0);
    const due = addDays(p.end, Number(s.dueDays) || 0);
    const sm = p.start.getMonth(), em = p.end.getMonth();
    const period = sm === em ? `${Mon[sm]} ${p.start.getDate()}-${p.end.getDate()}` : `${Mon[sm]} ${p.start.getDate()} - ${Mon[em]} ${p.end.getDate()}`;
    return {
      // Named for the month the period starts, like the old invoice creator.
      title: `${MON[sm]} INVOICE`, no: padInv(invoiceNo(p)), period,
      due: `${pad(due.getMonth() + 1)}.${pad(due.getDate())}.${String(due.getFullYear()).slice(2)}`,
      payTo: [s.payToName, s.payToAddr].filter(Boolean).join(', '),
      billTo: [s.billToName, s.billToAddr].filter(Boolean).join(', '),
      rows, total, logo: s.logo, logoSrc: s.logo || s.logoUrl || '', open: entriesIn(p).length - list.length,
    };
  }

  const LOGO_SVG = `<svg class="inv-logo" viewBox="0 0 100 100" fill="none" stroke="#111" stroke-width="11" stroke-linejoin="miter" stroke-linecap="butt">
    <path d="M6 98 L42 6 L58 6 A40 46 0 0 1 58 94 L50 94"/><path d="M42 6 L78 98"/><path d="M22 60 L60 60"/></svg>`;

  function renderInvoice() {
    const p = periodByIndex(viewPeriod); const m = invoiceModel(p);
    if (document.activeElement !== $('#invNo')) $('#invNo').value = m.no;
    const logo = m.logoSrc ? `<img class="inv-logo inv-logo-img" src="${esc(m.logoSrc)}" alt="">` : LOGO_SVG;
    $('#invoicePreview').innerHTML = `<div class="inv-frame">
      <div class="inv-head"><div class="inv-title">${esc(m.title)}</div>${logo}</div>
      <div class="inv-meta">
        <p><b>Pay To:</b> ${esc(m.payTo) || '<i>set in Settings</i>'}</p>
        <p><b>Issued To:</b> ${esc(m.billTo) || '<i>set in Settings</i>'}</p>
        <p class="gap"><b>Invoice No:</b> ${esc(m.no)}</p>
        <p><b>Pay Period:</b> ${esc(m.period)}</p>
        <p><b>Due Date:</b> ${esc(m.due)}</p>
      </div>
      <table class="inv-table"><thead><tr><th>Date</th><th>Description</th><th>Rate</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
      <tbody>${m.rows.map(r => `<tr><td>${r.date}</td><td>${esc(r.desc)}</td><td>${r.rate}</td><td>${r.qty}</td><td>${r.unit}</td><td>${r.total}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#888">No finished entries in this period</td></tr>'}</tbody></table>
      <div class="inv-total">TOTAL: ${money(m.total)}</div>
    </div>`;
  }

  function renderSettings() {
    const f = $('#settingsForm');
    Object.keys(DEFAULT_SETTINGS).forEach(k => { if (f.elements[k]) f.elements[k].value = db.settings[k] ?? ''; });
  }

  function renderAll() {
    renderHeader(); renderClock(); renderLog(); renderInvoice();
  }

  // ---------- actions ----------
  // Edit sheet
  let editing = null; let entryRate = 'STANDARD'; let entryMode = 'times';
  function setEntryRate(r) { entryRate = r; $$('#entryRateSeg button').forEach(b => b.classList.toggle('on', b.dataset.rate === r)); applyMode($('#entryForm'), '#entryModeSeg', entryMode); updateCalc(); }
  function openSheet(e, isNew) {
    editing = isNew ? null : e;
    const f = $('#entryForm');
    $('#sheetTitle').textContent = isNew ? 'Add a row' : 'Edit row';
    f.elements.desc.value = e.desc || '';
    f.elements.date.value = ymd(new Date(e.start));
    entryMode = e.noTimes ? 'hours' : 'times';
    if (e.noTimes) {
      const t = suggestTimes(ymd(new Date(e.start))); f.elements.start.value = t.start; f.elements.end.value = t.end;
      f.elements.hours.value = String(Math.round(rawHours(e) * 60));
    } else {
      f.elements.start.value = hm(new Date(roundTime(e.start)));
      f.elements.end.value = e.end != null ? hm(new Date(roundTime(e.end))) : '';
      f.elements.hours.value = String(Math.max(STEP(), Math.round(rawHours(e) * 60 / STEP()) * STEP()));
    }
    f.elements.amount.value = isExp(e) ? (Number(e.amount) || 0).toFixed(2) : '';
    entryRate = e.rate || 'STANDARD';
    applyMode(f, '#entryModeSeg', entryMode);
    const del = f.querySelector('[data-act="delete-entry"]');
    del.style.visibility = isNew ? 'hidden' : 'visible'; del.textContent = 'Delete'; delete del.dataset.armed;
    setEntryRate(e.rate || 'STANDARD');
    $('#sheet').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; editing = null; }
  function formToTimes() {
    const f = $('#entryForm'); const date = f.elements.date.value;
    if (!date) return null;
    if (entryRate === 'EXPENSE') { const start = atTime(date, '00:00').getTime(); return { start, end: start, noTimes: true, amount: Number(f.elements.amount.value) || 0 }; }
    if (entryMode === 'hours') return f.elements.hours.value ? hoursEntryTimes(date, f.elements.hours.value) : null;
    if (!f.elements.start.value) return null;
    const start = atTime(date, f.elements.start.value).getTime();
    if (!f.elements.end.value) return { start, end: null, missingEnd: true };
    let end = atTime(date, f.elements.end.value).getTime();
    if (end <= start) end += DAY; // past midnight
    return { start, end };
  }
  function updateCalc() {
    const t = formToTimes(); const out = $('#entryCalc');
    if (!t || t.end == null) { out.textContent = ''; return; }
    if (entryRate === 'EXPENSE') { out.textContent = `Expense · ${money(Math.round(t.amount * 100) / 100)}`; return; }
    const e = { rate: entryRate, start: t.start, end: t.end };
    const raw = rawHours(e), bill = billHours(e);
    out.textContent = `${fmtQty(raw)} h worked` + (bill !== raw ? ` → ${fmtQty(bill)} h billed` : '') + ` · ${money(amount(e))}` + (!t.noTimes && new Date(t.end).getDate() !== new Date(t.start).getDate() ? ' · ends next day' : '');
  }

  // PDF
  function buildPdf() {
    const { jsPDF } = window.jspdf;
    const p = periodByIndex(viewPeriod); const m = invoiceModel(p);
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const L = 48, R = 564, W = R - L;
    const IL = L + 26, IR = R - 26; // inner margins
    const cols = [ // x positions inside IL..IR
      { k: 'date', x: IL + 8, a: 'left', h: 'Date', hx: IL + 55 },
      { k: 'desc', x: IL + 110, a: 'left', h: 'Description', hx: IL + 186 },
      { k: 'rate', x: IL + 287, a: 'center', h: 'Rate' },
      { k: 'qty', x: IL + 344, a: 'center', h: 'Qty' },
      { k: 'unit', x: IL + 390, a: 'center', h: 'Unit' },
      { k: 'total', x: IR - 6, a: 'right', h: 'Total' },
    ];
    const pages = [];
    let pageTop = 48;

    // Title
    doc.setFont('helvetica', 'bold'); doc.setFontSize(32); doc.setTextColor(17);
    doc.setCharSpace(2.5); doc.text(m.title, IL, 112); doc.setCharSpace(0);
    // Logo
    if (m.logo) {
      try {
        const ratio = (db.settings.logoRatio || 1); const lw = Math.min(130, 72 * ratio); const lh = lw / ratio;
        doc.addImage(m.logo, IR - lw, 70, lw, lh);
      } catch (e) { drawLogo(doc, IR - 72, 70, 72); }
    } else drawLogo(doc, IR - 72, 70, 72);

    let y = 160;
    doc.setFontSize(10.5);
    const meta = (label, val, gap) => {
      if (gap) y += 8;
      doc.setFont('courier', 'bold'); doc.text(label, IL, y);
      const w = doc.getTextWidth(label + ' ');
      doc.setFont('courier', 'normal'); doc.text(String(val || ''), IL + w, y, { maxWidth: IR - IL - w });
      y += 16;
    };
    meta('Pay To:', m.payTo); meta('Issued To:', m.billTo);
    meta('Invoice No:', m.no, true); meta('Pay Period:', m.period); meta('Due Date:', m.due);

    const header = () => {
      y += 8;
      doc.setFillColor(17, 17, 17); doc.rect(IL, y, IR - IL, 28, 'F');
      doc.setTextColor(255); doc.setFont('courier', 'bold'); doc.setFontSize(9);
      cols.forEach(c => {
        const hx = c.hx ?? c.x; const al = c.hx ? 'center' : c.a;
        doc.text(c.h, hx, y + 17.5, { align: al });
      });
      doc.setTextColor(17); y += 28;
    };
    header();
    doc.setFont('courier', 'normal'); doc.setFontSize(9.5);
    const rowH = 28;
    m.rows.forEach(r => {
      if (y + rowH > 720) {
        pages.push({ top: pageTop, bottom: y + 20 });
        doc.addPage(); pageTop = 48; y = 70; header(); doc.setFont('courier', 'normal'); doc.setFontSize(9.5);
      }
      cols.forEach(c => {
        let v = r[c.k];
        if (c.k === 'desc') v = doc.splitTextToSize(v, 165)[0];
        doc.text(String(v), c.x, y + 18, { align: c.a });
      });
      doc.setDrawColor(220); doc.setLineWidth(0.75); doc.line(IL, y + rowH, IR, y + rowH);
      y += rowH;
    });
    if (y + 70 > 750) { pages.push({ top: pageTop, bottom: y + 20 }); doc.addPage(); pageTop = 48; y = 60; }
    y += 52;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(30);
    const totalText = `TOTAL: ${money(m.total)}`, cs = 1.5;
    const tw = doc.getTextWidth(totalText) + cs * (totalText.length - 1);
    doc.setCharSpace(cs); doc.text(totalText, IR - 4 - tw, y); doc.setCharSpace(0);
    pages.push({ top: pageTop, bottom: y + 50 });
    // frames
    pages.forEach((pg, i) => {
      doc.setPage(i + 1); doc.setDrawColor(17); doc.setLineWidth(2.5);
      doc.rect(L, pg.top, W, pg.bottom - pg.top);
    });
    return { doc, name: `Invoice-${m.no}.pdf` };
  }
  // Monogram: A with a D bowl (approximation; upload your own logo in a future version)
  function drawLogo(doc, x, y, size) {
    const s = size / 100; const P = (px, py) => [x + px * s, y + py * s];
    doc.setDrawColor(17); doc.setLineWidth(11 * s); doc.setLineCap('butt'); doc.setLineJoin('miter');
    const seg = (a, b) => { const [x1, y1] = P(...a), [x2, y2] = P(...b); doc.line(x1, y1, x2, y2); };
    seg([6, 98], [42, 6]); seg([42, 6], [58, 6]); seg([42, 6], [78, 98]); seg([22, 60], [60, 60]); seg([58, 94], [50, 94]);
    // D bowl: half-ellipse from (58,6) to (58,94), rx 40, ry 44 using two bezier quarters
    const k = 0.5523, rx = 40 * s, ry = 44 * s; const [cx, cy] = P(58, 50);
    doc.lines([
      [rx * k, 0, rx, ry - ry * k, rx, ry],
      [0, ry * k, -rx + rx * k, ry, -rx, ry],
    ], cx, cy - ry, [1, 1], 'S', false);
  }

  // Fetch the logo once and keep it as a data URL so PDFs have it, even offline.
  async function ensureLogo(force) {
    if (!db.settings.logoUrl || /squarespace-cdn/.test(db.settings.logoUrl)) db.settings.logoUrl = 'icons/ad-logo.png';
    const url = (db.settings.logoUrl || '').trim();
    if (!url || (db.settings.logo && !force && db.settings.logoFrom === url)) return;
    try {
      const res = await fetch(url, { mode: 'cors' }); if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const dataUrl = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });
      const img = new Image(); await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = dataUrl; });
      db.settings.logo = dataUrl; db.settings.logoFrom = url; db.settings.logoRatio = img.naturalWidth / img.naturalHeight;
      save(); renderInvoice();
    } catch (e) { console.warn('Logo not loaded', e); }
  }

  function emailParts() {
    const p = periodByIndex(viewPeriod); const m = invoiceModel(p);
    const fill = t => String(t || '').replace(/\{period\}/g, m.period).replace(/\{no\}/g, m.no);
    return { subject: `Invoice ${m.no} - ${m.period}`, body: fill(db.settings.emailBody), to: (db.settings.emailTo || '').trim() };
  }

  async function sharePdf(download) {
    try {
      const { doc, name } = buildPdf();
      const blob = doc.output('blob');
      const file = new File([blob], name, { type: 'application/pdf' });
      if (!download && navigator.canShare && navigator.canShare({ files: [file] })) {
        const em = emailParts();
        await navigator.share({ files: [file], title: em.subject, text: em.body });
      } else {
        doc.save(name);
      }
    } catch (e) { if (e.name !== 'AbortError') toast('PDF failed: ' + e.message); }
  }

  async function shareText(text, name, type) {
    const file = new File([text], name, { type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportCsv() {
    const p = periodByIndex(viewPeriod);
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [['DATE', 'DESCRIPTION', 'RATE', 'QTY', 'UNIT', 'TOTAL', 'START', 'END'].join(',')];
    entriesIn(p).filter(e => e.end != null).forEach(e => {
      lines.push([ymd(new Date(e.start)), q(e.desc || ''), e.rate, isExp(e) ? 1 : fmtQty(billHours(e)), isExp(e) ? amount(e) : unitOf(e), amount(e).toFixed(2), e.noTimes ? '' : hm(new Date(roundTime(e.start))), e.noTimes ? '' : hm(new Date(roundTime(e.end)))].join(','));
    });
    shareText(lines.join('\n'), `Time-${p.key}.csv`, 'text/csv');
  }

  function backup() {
    shareText(JSON.stringify({ app: 'timeclock', version: VERSION, exported: new Date().toISOString(), ...db }, null, 2),
      `timeclock-backup-${ymd(new Date())}.json`, 'application/json');
  }
  function restoreFrom(text) {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.entries)) throw new Error('Not a Time Clock backup');
    const entries = d.entries.map(e => ({
      id: e.id || uid(), rate: ['DRIVING', 'EXPENSE'].includes(e.rate) ? e.rate : 'STANDARD', desc: e.desc || '',
      ...(e.rate === 'EXPENSE' ? { amount: Number(e.amount) || 0 } : {}),
      start: typeof e.start === 'number' ? e.start : new Date(e.start).getTime(),
      end: e.end == null ? null : (typeof e.end === 'number' ? e.end : new Date(e.end).getTime()),
      ...(e.noTimes ? { noTimes: true } : {}),
      ...(e.unit != null && e.rate !== 'EXPENSE' ? { unit: Number(e.unit) } : {}),
    })).filter(e => !isNaN(e.start));
    const replace = db.entries.length === 0;
    if (replace) db.entries = entries;
    else { const ids = new Set(db.entries.map(e => e.id)); entries.forEach(e => { if (!ids.has(e.id)) db.entries.push(e); }); }
    if (d.settings) db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...d.settings };
    if (d.invoiceNos) db.invoiceNos = { ...db.invoiceNos, ...d.invoiceNos };
    save(); viewPeriod = periodIndexFor(new Date()); renderSettings(); renderAll();
    toast(`Imported ${entries.length} entries`);
  }

  // CSV from Numbers or the old invoice creator: DATE, DESCRIPTION, RATE, QTY, optional UNIT, START, END.
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
  }
  function csvDate(v) {
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${pad(+m[1])}-${pad(+m[2])}`; }
    const d = new Date(v); return isNaN(d) ? null : ymd(d);
  }
  function csvTime(v) {
    const m = String(v || '').match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/); if (!m) return null;
    let h = +m[1]; const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
    return `${pad(h)}:${m[2]}`;
  }
  function importCsv(text) {
    const rows = parseCsv(text); if (rows.length < 2) throw new Error('No rows in that CSV');
    const head = rows[0].map(x => x.toUpperCase());
    const col = (...names) => head.findIndex(x => names.some(n => x.startsWith(n)));
    const iD = col('DATE'), iDesc = col('DESC'), iR = col('RATE'), iQ = col('QTY', 'HOURS'), iU = col('UNIT'), iS = col('START'), iE = col('END');
    if (iD < 0 || iDesc < 0) throw new Error('Needs DATE and DESCRIPTION columns');
    const key = e => [ymd(new Date(e.start)), e.desc.toLowerCase(), e.rate, e.start, e.end, e.amount || ''].join('|');
    const have = new Set(db.entries.map(key)); let added = 0;
    rows.slice(1).forEach(r => {
      const date = csvDate(r[iD] || ''); if (!date) return;
      const rt = (r[iR] || '').toUpperCase();
      const rate = rt.includes('DRIV') ? 'DRIVING' : rt.includes('EXP') ? 'EXPENSE' : 'STANDARD';
      const qty = parseFloat(r[iQ]) || 0; const unit = parseFloat(String(r[iU] || '').replace(/[$,]/g, ''));
      let e;
      if (rate === 'EXPENSE') {
        const start = atTime(date, '00:00').getTime();
        e = { rate, desc: r[iDesc] || '', start, end: start, noTimes: true, amount: Math.round((isNaN(unit) ? qty : (qty || 1) * unit) * 100) / 100 };
      } else {
        const st = iS >= 0 ? csvTime(r[iS]) : null, en = iE >= 0 ? csvTime(r[iE]) : null;
        if (st && en) {
          const start = atTime(date, st).getTime(); let end = atTime(date, en).getTime(); if (end <= start) end += DAY;
          e = { rate, desc: r[iDesc] || '', start, end };
        } else if (qty > 0) e = { rate, desc: r[iDesc] || '', ...hoursEntryTimes(date, Math.round(qty * 60)) };
        else return;
        if (!isNaN(unit) && unit > 0) e.unit = unit;
      }
      if (have.has(key(e))) return;
      have.add(key(e)); db.entries.push({ id: uid(), ...e }); added++;
    });
    save(); renderAll(); toast(`Imported ${added} ${added === 1 ? 'row' : 'rows'}`);
  }

  // ---------- wiring ----------
  $$('#rateSeg button').forEach(b => b.onclick = () => { setRate(b.dataset.rate); updateAddCalc(); haptic(); });
  $$('#entryRateSeg button').forEach(b => b.onclick = () => setEntryRate(b.dataset.rate));
  $('#addForm').addEventListener('input', e => {
    if (e.target.name === 'date') { const t = suggestTimes(e.target.value); $('#addForm').elements.start.value = t.start; $('#addForm').elements.end.value = t.end; renderClock(); }
    updateAddCalc();
  });
  $('#addForm').addEventListener('change', updateAddCalc);
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => {
    db.settings.addMode = b.dataset.mode; save(); applyMode($('#addForm'), '#modeSeg', addMode()); updateAddCalc(); haptic();
  });
  document.querySelectorAll('#entryModeSeg button').forEach(b => b.onclick = () => {
    entryMode = b.dataset.mode; applyMode($('#entryForm'), '#entryModeSeg', entryMode); updateCalc();
  });
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault(); const en = addFormEntry(); if (!en) return;
    if (!en.desc) { toast(isExp(en) ? 'Say what the expense was' : 'Add a client or job'); $('#addForm').elements.desc.focus(); return; }
    if (isExp(en) && !(en.amount > 0)) { toast('Add the amount'); return; }
    db.entries.push({ id: uid(), ...en }); save(); haptic();
    toast(isExp(en) ? `Added ${en.desc} · ${money(amount(en))}` : `Added ${en.desc} · ${fmtQty(billHours(en))} h · ${money(amount(en))}`);
    viewPeriod = periodIndexFor(new Date(en.start));
    resetAddForm(true); renderAll();
  });
  $('#addForm').elements.desc.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  $$('.tabs button').forEach(b => b.onclick = () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.tab));
    if (b.dataset.tab === 'settings') renderSettings();
    $('main').scrollTop = 0;
  });

  document.addEventListener('click', e => {
    const row = e.target.closest('.entry');
    if (row) { const en = db.entries.find(x => x.id === row.dataset.id); if (en) openSheet(en, false); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    switch (act) {
      case 'prev-period': viewPeriod--; renderAll(); break;
      case 'next-period': viewPeriod++; renderAll(); break;
      case 'add-entry': {
        const p = periodByIndex(viewPeriod); const today = new Date();
        const base = (today >= p.start && today <= addDays(p.end, 1)) ? today : p.start;
        const s = atTime(ymd(base), '09:00').getTime();
        openSheet({ rate: 'STANDARD', desc: '', start: s, end: s + 8 * HOUR }, true); break;
      }
      case 'close-sheet': if (e.target === $('#sheet') || e.target.closest('.mini')) closeSheet(); break;
      case 'this-period': viewPeriod = periodIndexFor(new Date()); renderAll(); break;
      case 'delete-entry':
        {
          const del = e.target.closest('[data-act]');
          if (!editing) break;
          if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; break; }
          db.entries = db.entries.filter(x => x !== editing); save(); closeSheet(); renderAll(); toast('Row deleted');
        }
        break;
      case 'share-pdf': sharePdf(false); break;
      case 'email': {
        const em = emailParts();
        if (!em.to) { toast('Add who to email in Setup'); break; }
        location.href = `mailto:${em.to.replace(/\s+/g, '')}?subject=${encodeURIComponent(em.subject)}&body=${encodeURIComponent(em.body)}`;
        break;
      }
      case 'download-pdf': sharePdf(true); break;
      case 'export-csv': exportCsv(); break;
      case 'backup': backup(); break;
      case 'restore': $('#restoreFile').click(); break;
    }
  });

  $('#entryForm').addEventListener('input', updateCalc);
  $('#entryForm').addEventListener('submit', e => {
    e.preventDefault();
    const t = formToTimes(); if (!t) return;
    if (t.missingEnd) { toast('Add an end time'); return; }
    const f = $('#entryForm');
    const extra = t.noTimes ? { noTimes: true } : {};
    if (editing) {
      const same = (orig, v) => orig != null && roundTime(orig) === v;
      const keep = !t.noTimes && !editing.noTimes;
      Object.assign(editing, { desc: f.elements.desc.value.trim(), rate: entryRate,
        start: keep && same(editing.start, t.start) ? editing.start : t.start,
        end: keep && same(editing.end, t.end) ? editing.end : t.end });
      if (t.noTimes) editing.noTimes = true; else delete editing.noTimes;
      if (entryRate === 'EXPENSE') editing.amount = t.amount; else delete editing.amount;
    } else {
      db.entries.push({ id: uid(), desc: f.elements.desc.value.trim(), rate: entryRate, start: t.start, end: t.end, ...extra, ...(entryRate === 'EXPENSE' ? { amount: t.amount } : {}) });
    }
    save(); closeSheet(); renderAll(); toast('Saved');
  });

  $('#settingsForm').addEventListener('submit', e => {
    e.preventDefault(); const f = e.target;
    const oldStd = Number(db.settings.rateStandard), oldDrv = Number(db.settings.rateDriving);
    if (Number(f.elements.rateStandard.value) !== oldStd) lockRate('STANDARD', oldStd);
    if (Number(f.elements.rateDriving.value) !== oldDrv) lockRate('DRIVING', oldDrv);
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      const el = f.elements[k]; if (!el) return;
      db.settings[k] = el.type === 'number' ? Number(el.value) : el.value.trim();
    });
    if (db.settings.logoUrl !== db.settings.logoFrom) { db.settings.logo = null; ensureLogo(true); }
    if (!db.settings.periodAnchor) db.settings.periodAnchor = DEFAULT_SETTINGS.periodAnchor;
    save(); fillTimeSelects(document); fillHourSelects(document); viewPeriod = periodIndexFor(new Date()); renderAll(); toast('Settings saved');
  });

  $('#invNo').addEventListener('change', e => {
    const p = periodByIndex(viewPeriod); const v = e.target.value.trim();
    if (v) db.invoiceNos[p.key] = v; else delete db.invoiceNos[p.key];
    save(); renderAll();
  });

  $('#restoreFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await file.text();
      if (/\.csv$/i.test(file.name) || !text.trim().startsWith('{')) importCsv(text); else restoreFrom(text);
      ensureLogo();
    } catch (err) { toast('Import failed: ' + err.message); }
    e.target.value = '';
  });

  // Import from link hash: #import=<base64 json> (never sent to the server)
  function hashImport() {
    const m = location.hash.match(/^#import=(.+)$/); if (!m) return;
    try {
      const json = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
      restoreFrom(json);
    } catch (err) { toast('Import link failed: ' + err.message); }
    history.replaceState(null, '', location.pathname);
  }

  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('#installHint').textContent = standalone ? '' : 'In Safari tap Share, then Add to Home Screen. The home screen app keeps its own data, so set it up there.';
  $('#versionLine').textContent = 'Saved on this phone · v' + VERSION;

  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
  window.addEventListener('hashchange', hashImport);

  if (!db.settings.rate35) {
    if (Number(db.settings.rateStandard) === 30) { lockRate('STANDARD', 30); db.settings.rateStandard = 35; }
    db.settings.rate35 = true; save();
  }
  setRate('STANDARD');
  fillTimeSelects(document); fillHourSelects(document); applyMode($('#addForm'), '#modeSeg', addMode()); resetAddForm(false);
  renderAll(); renderSettings();
  hashImport();
  ensureLogo();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
