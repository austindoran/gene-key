/* Time Clock: a home-screen time-in/time-out app.
 * Data lives in localStorage on the device. No server.
 * Billing rules mirror the TIME.numbers sheet:
 *   hours = end - start (wraps past midnight), every minute billed
 *   STANDARD $30/hr, DRIVING $20/hr            (configurable)
 */
(() => {
  'use strict';

  const VERSION = '1.1.0';
  const KEY = 'timeclock.v1';
  const HOUR = 3600000;
  const DAY = 86400000;

  const DEFAULT_SETTINGS = {
    payToName: '',
    payToAddr: '',
    billToName: '',
    billToAddr: '',
    rateStandard: 30,
    rateDriving: 20,
    roundMin: 15,
    periodAnchor: '2025-12-15',
    periodDays: 14,
    dueDays: 2,
    invoiceStart: 2,
    logo: null, // optional data URL
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
  function rateOf(type) { return type === 'DRIVING' ? Number(db.settings.rateDriving) : Number(db.settings.rateStandard); }
  // Punches are stored exactly; billing rounds start/end to the nearest roundMin.
  function rawHours(e, now = Date.now()) {
    const s = roundTime(e.start), en = roundTime(e.end ?? now);
    return Math.max(0, (en - s) / HOUR);
  }
  const billHours = (e, now) => rawHours(e, now);
  const qtyRound = h => Math.round(h * 100) / 100;
  function amount(e, now) { return Math.round(qtyRound(billHours(e, now)) * rateOf(e.rate) * 100) / 100; }
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
    selRate = r;
    $$('#rateSeg button').forEach(b => b.classList.toggle('on', b.dataset.rate === r));
  }

  function entryRow(e) {
    const s = new Date(roundTime(e.start)); const en = e.end != null ? new Date(roundTime(e.end)) : null;
    const q = billHours(e);
    return `<button class="entry ${en ? '' : 'running'}" data-id="${e.id}">
      <div class="e-desc"><span>${esc(e.desc || '(no description)')}</span><span class="pill ${e.rate}">${e.rate === 'DRIVING' ? 'DRIVE' : 'STD'}</span></div>
      <div class="e-amt">${money(amount(e))}</div>
      <div class="e-times">${clock12(s)} – ${en ? clock12(en) : 'now'}</div>
      <div class="e-qty">${fmtQty(q)} h</div>
    </button>`;
  }

  function renderHeader() {
    const p = periodByIndex(viewPeriod);
    const list = entriesIn(p);
    const hrs = list.reduce((a, e) => a + qtyRound(billHours(e)), 0);
    const tot = list.reduce((a, e) => a + amount(e), 0);
    const cur = viewPeriod === periodIndexFor(new Date());
    $('#periodRange').textContent = rangeLabel(p) + (cur ? '' : ` · #${padInv(invoiceNo(p))}`);
    $('#periodSummary').textContent = `${qtyRound(hrs)} h · ${money(tot)}${cur ? ' · this period' : ''}`;
  }

  function renderClock() {
    const r = running();
    $('#clockIdle').hidden = !!r; $('#clockActive').hidden = !r;
    if (r) {
      $('#activeRate').textContent = r.rate; $('#activeRate').className = 'pill ' + r.rate;
      $('#activeDesc').textContent = r.desc || '(no description)';
      $('#activeSince').textContent = 'Since ' + clock12(new Date(r.start)) + (roundTime(r.start) !== Math.floor(r.start / 60000) * 60000 ? ` (billed from ${clock12(new Date(roundTime(r.start)))})` : '');
      tick();
    } else {
      const chips = recentDescs();
      $('#recentChips').innerHTML = chips.map((c, i) => `<button class="chip" data-chip="${i}">${esc(c.desc)}</button>`).join('');
      $('#recentChips').querySelectorAll('.chip').forEach(b => b.onclick = () => {
        const c = chips[Number(b.dataset.chip)]; $('#descInput').value = c.desc; setRate(c.rate); haptic();
      });
      $('#clockInSub').textContent = 'at ' + clock12(new Date(roundTime(Date.now())));
    }
    const today = ymd(new Date());
    const list = db.entries.filter(e => ymd(new Date(e.start)) === today).sort((a, b) => a.start - b.start);
    $('#todayList').innerHTML = list.map(entryRow).join('');
  }

  function tick() {
    const r = running();
    if (!r) { if (!$('#clockIdle').hidden) $('#clockInSub').textContent = 'at ' + clock12(new Date(roundTime(Date.now()))); return; }
    $('#elapsed').textContent = fmtDur(Date.now() - r.start);
    $('#activeEarn').textContent = `${fmtQty(billHours(r))} h billable · ${money(amount(r))}`;
    $('#clockOutSub').textContent = 'at ' + clock12(new Date(roundTime(Date.now())));
    const row = document.querySelector(`.entry.running[data-id="${r.id}"]`);
    if (row) { row.querySelector('.e-amt').textContent = money(amount(r)); row.querySelector('.e-qty').textContent = fmtQty(billHours(r)) + ' h'; }
  }

  function renderLog() {
    const p = periodByIndex(viewPeriod);
    const list = entriesIn(p);
    const byDay = {};
    list.forEach(e => (byDay[ymd(new Date(e.start))] ||= []).push(e));
    const html = Object.keys(byDay).sort().reverse().map(k => {
      const d = parseYmd(k); const items = byDay[k];
      const tot = items.reduce((a, e) => a + amount(e), 0);
      return `<div class="day-h"><span>${DOW[d.getDay()]} ${Mon[d.getMonth()]} ${d.getDate()}</span><span>${money(tot)}</span></div>` + items.map(entryRow).join('');
    }).join('');
    $('#logList').innerHTML = html;
  }

  function invoiceModel(p) {
    const s = db.settings; const list = entriesIn(p).filter(e => e.end != null);
    const rows = list.map(e => {
      const unit = rateOf(e.rate);
      return {
        date: ymd(new Date(e.start)),
        desc: (e.desc || '').toUpperCase(),
        rate: e.rate === 'DRIVING' ? 'Driving' : 'Standard',
        qty: fmtQty(billHours(e)),
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
      title: `${MON[em]} INVOICE`, no: padInv(invoiceNo(p)), period,
      due: `${pad(due.getMonth() + 1)}.${pad(due.getDate())}.${String(due.getFullYear()).slice(2)}`,
      payTo: [s.payToName, s.payToAddr].filter(Boolean).join(', '),
      billTo: [s.billToName, s.billToAddr].filter(Boolean).join(', '),
      rows, total, logo: s.logo, open: entriesIn(p).length - list.length,
    };
  }

  const LOGO_SVG = `<svg class="inv-logo" viewBox="0 0 100 100" fill="none" stroke="#111" stroke-width="11" stroke-linejoin="miter" stroke-linecap="butt">
    <path d="M6 98 L42 6 L58 6 A40 46 0 0 1 58 94 L50 94"/><path d="M42 6 L78 98"/><path d="M22 60 L60 60"/></svg>`;

  function renderInvoice() {
    const p = periodByIndex(viewPeriod); const m = invoiceModel(p);
    if (document.activeElement !== $('#invNo')) $('#invNo').value = m.no;
    const logo = m.logo ? `<img class="inv-logo" src="${m.logo}" alt="">` : LOGO_SVG;
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
      ${m.open ? `<p style="color:#b00">${m.open} entry still clocked in, so it isn't on the invoice yet.</p>` : ''}
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
  function clockIn(at) {
    if (running()) return;
    const desc = $('#descInput').value.trim();
    const start = at ?? Date.now();
    db.entries.push({ id: uid(), rate: selRate, desc, start, end: null });
    save(); haptic(); $('#descInput').value = '';
    viewPeriod = periodIndexFor(new Date(start));
    toast(`Clocked in ${clock12(new Date(start))}`);
    renderAll();
  }
  function clockOut() {
    const r = running(); if (!r) return null;
    let end = Date.now(); if (end < r.start) end = r.start;
    r.end = end; save(); haptic();
    toast(`Clocked out · ${fmtQty(billHours(r))} h · ${money(amount(r))}`);
    renderAll(); return end;
  }

  // Edit sheet
  let editing = null; let entryRate = 'STANDARD';
  function setEntryRate(r) { entryRate = r; $$('#entryRateSeg button').forEach(b => b.classList.toggle('on', b.dataset.rate === r)); updateCalc(); }
  function openSheet(e, isNew) {
    editing = isNew ? null : e;
    const f = $('#entryForm');
    $('#sheetTitle').textContent = isNew ? 'Add entry' : (e.end == null ? 'Edit running entry' : 'Edit entry');
    f.elements.desc.value = e.desc || '';
    f.elements.date.value = ymd(new Date(e.start));
    f.elements.start.value = hm(new Date(roundTime(e.start)));
    f.elements.end.value = e.end != null ? hm(new Date(roundTime(e.end))) : '';
    $('#endLabel').hidden = !isNew && e.end == null;
    f.querySelector('[data-act="delete-entry"]').style.visibility = isNew ? 'hidden' : 'visible';
    setEntryRate(e.rate || 'STANDARD');
    $('#sheet').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; editing = null; }
  function formToTimes() {
    const f = $('#entryForm'); const date = f.elements.date.value;
    if (!date || !f.elements.start.value) return null;
    const start = atTime(date, f.elements.start.value).getTime();
    let end = null;
    if (!$('#endLabel').hidden) {
      if (!f.elements.end.value) return { start, end: null, missingEnd: true };
      end = atTime(date, f.elements.end.value).getTime();
      if (end <= start) end += DAY; // past midnight
    }
    return { start, end };
  }
  function updateCalc() {
    const t = formToTimes(); const out = $('#entryCalc');
    if (!t || t.end == null) { out.textContent = ''; return; }
    const e = { rate: entryRate, start: t.start, end: t.end };
    const raw = rawHours(e), bill = billHours(e);
    out.textContent = `${fmtQty(raw)} h worked` + (bill !== raw ? ` → ${fmtQty(bill)} h billed` : '') + ` · ${money(amount(e))}` + (t.end - t.start > 0 && new Date(t.end).getDate() !== new Date(t.start).getDate() ? ' · ends next day' : '');
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
      try { doc.addImage(m.logo, IR - 72, 70, 72, 72); } catch (e) { drawLogo(doc, IR - 72, 70, 72); }
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

  async function sharePdf(download) {
    try {
      const { doc, name } = buildPdf();
      const blob = doc.output('blob');
      const file = new File([blob], name, { type: 'application/pdf' });
      if (!download && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
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
      lines.push([ymd(new Date(e.start)), q(e.desc || ''), e.rate, fmtQty(billHours(e)), rateOf(e.rate), amount(e).toFixed(2), hm(new Date(roundTime(e.start))), hm(new Date(roundTime(e.end)))].join(','));
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
      id: e.id || uid(), rate: e.rate === 'DRIVING' ? 'DRIVING' : 'STANDARD', desc: e.desc || '',
      start: typeof e.start === 'number' ? e.start : new Date(e.start).getTime(),
      end: e.end == null ? null : (typeof e.end === 'number' ? e.end : new Date(e.end).getTime()),
    })).filter(e => !isNaN(e.start));
    const replace = db.entries.length === 0 || confirm(`Replace the ${db.entries.length} entries on this phone with ${entries.length} from the backup?\n\nCancel = merge instead.`);
    if (replace) db.entries = entries;
    else { const ids = new Set(db.entries.map(e => e.id)); entries.forEach(e => { if (!ids.has(e.id)) db.entries.push(e); }); }
    if (d.settings) db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...d.settings };
    if (d.invoiceNos) db.invoiceNos = { ...db.invoiceNos, ...d.invoiceNos };
    save(); viewPeriod = periodIndexFor(new Date()); renderSettings(); renderAll();
    toast(`Imported ${entries.length} entries`);
  }

  // ---------- wiring ----------
  $$('#rateSeg button').forEach(b => b.onclick = () => { setRate(b.dataset.rate); haptic(); });
  $$('#entryRateSeg button').forEach(b => b.onclick = () => setEntryRate(b.dataset.rate));
  $('#clockInBtn').onclick = () => clockIn();
  $('#clockOutBtn').onclick = () => clockOut();
  $('#descInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#descInput').blur(); } });
  $('#switchBtn').onclick = () => {
    const r = running(); if (!r) return;
    const nextRate = r.rate === 'DRIVING' ? 'STANDARD' : 'DRIVING';
    clockOut(); setRate(nextRate);
    toast(`Clocked out. Pick the next job, then Clock In (${nextRate.toLowerCase()} selected)`);
    setTimeout(() => $('#descInput').focus(), 50);
  };

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
      case 'edit-active': { const r = running(); if (r) openSheet(r, false); break; }
      case 'add-entry': {
        const p = periodByIndex(viewPeriod); const today = new Date();
        const base = (today >= p.start && today <= addDays(p.end, 1)) ? today : p.start;
        const s = atTime(ymd(base), '09:00').getTime();
        openSheet({ rate: 'STANDARD', desc: '', start: s, end: s + 8 * HOUR }, true); break;
      }
      case 'close-sheet': closeSheet(); break;
      case 'delete-entry':
        if (editing && confirm('Delete this entry?')) { db.entries = db.entries.filter(x => x !== editing); save(); closeSheet(); renderAll(); toast('Deleted'); }
        break;
      case 'share-pdf': sharePdf(false); break;
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
    if (editing) {
      const same = (orig, v) => orig != null && roundTime(orig) === v;
      Object.assign(editing, { desc: f.elements.desc.value.trim(), rate: entryRate, start: same(editing.start, t.start) ? editing.start : t.start });
      if (editing.end != null) editing.end = same(editing.end, t.end) ? editing.end : t.end;
    } else {
      db.entries.push({ id: uid(), desc: f.elements.desc.value.trim(), rate: entryRate, start: t.start, end: t.end });
    }
    save(); closeSheet(); renderAll(); toast('Saved');
  });

  $('#settingsForm').addEventListener('submit', e => {
    e.preventDefault(); const f = e.target;
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      const el = f.elements[k]; if (!el) return;
      db.settings[k] = el.type === 'number' ? Number(el.value) : el.value.trim();
    });
    if (!db.settings.periodAnchor) db.settings.periodAnchor = DEFAULT_SETTINGS.periodAnchor;
    save(); viewPeriod = periodIndexFor(new Date()); renderAll(); toast('Settings saved');
  });

  $('#invNo').addEventListener('change', e => {
    const p = periodByIndex(viewPeriod); const v = e.target.value.trim();
    if (v) db.invoiceNos[p.key] = v; else delete db.invoiceNos[p.key];
    save(); renderAll();
  });

  $('#restoreFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { restoreFrom(await file.text()); } catch (err) { toast('Import failed: ' + err.message); }
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
  $('#installHint').textContent = standalone ? '' : 'Tip: in Safari tap Share → Add to Home Screen so this opens full-screen like an app. The home-screen app keeps its own data, so set it up there.';
  $('#versionLine').textContent = 'Time Clock v' + VERSION;

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
  window.addEventListener('hashchange', hashImport);

  setRate('STANDARD');
  renderAll(); renderSettings();
  hashImport();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
