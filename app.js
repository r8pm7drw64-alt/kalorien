import * as db from './db.js';
import { startScanner, normalizeCode } from './scanner.js';
import { recognizeImage } from './ocr.js';

const DB_URL = 'data/foods.tsv.gz';
const DB_FILE_VERSION = 1; // erhöhen, wenn eine neue foods.tsv.gz ausgeliefert wird

const MEALS = [
  { id: 'breakfast', name: 'Frühstück' },
  { id: 'lunch', name: 'Mittagessen' },
  { id: 'dinner', name: 'Abendessen' },
  { id: 'snack', name: 'Snacks' },
];
const DEFAULT_GOALS = { kcal: 2000, p: 100, c: 225, f: 67 };

const state = { tab: 'diary', date: todayStr(), goals: { ...DEFAULT_GOALS }, historyDays: 7 };
const $view = document.getElementById('view');
const $sheets = document.getElementById('sheets');

// ============ Hilfsfunktionen ============
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return todayStr(d); }
function dateLabel(s) {
  const t = todayStr();
  if (s === t) return 'Heute';
  if (s === addDays(t, -1)) return 'Gestern';
  if (s === addDays(t, 1)) return 'Morgen';
  return parseDate(s).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = v => Math.round(v || 0);
const r1 = v => { const x = Math.round((v || 0) * 10) / 10; return x.toLocaleString('de-DE'); };
const parseNum = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const fmtIn = v => (v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ','));

function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 8v8M8 12h8"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>',
};

// Nährwerte eines Eintrags (pro 100 g gespeichert, mal Menge)
function totals(entry) {
  const f = entry.g / 100, p = entry.per;
  return { k: (p.k || 0) * f, p: (p.p || 0) * f, c: (p.c || 0) * f, f: (p.f || 0) * f };
}
function sumTotals(list) {
  return list.reduce((a, e) => { const t = totals(e); a.k += t.k; a.p += t.p; a.c += t.c; a.f += t.f; return a; }, { k: 0, p: 0, c: 0, f: 0 });
}
function perFromFood(food) {
  return { k: food.k, p: food.p, c: food.c, s: food.s, f: food.f, sf: food.sf, fi: food.fi, sa: food.sa };
}
function amountLabel(e) {
  if (e.unit === 'portion' && e.sq) {
    const n = e.g / e.sq;
    return `${r1(n)} Portion${n === 1 ? '' : 'en'} (${r0(e.g)} g)`;
  }
  return `${r1(e.g)} g`;
}

// ============ Sheets (Vollbild-Dialoge) ============
function openSheet({ title, left = 'Abbrechen', right = '', body = '', onRight }) {
  const el = document.createElement('div');
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-head">
      <button class="btn-text" data-act="close">${esc(left)}</button>
      <h2>${esc(title)}</h2>
      <button class="btn-text right" data-act="right">${esc(right)}</button>
    </div>
    <div class="sheet-body">${body}</div>`;
  $sheets.appendChild(el);
  el.querySelector('[data-act=close]').onclick = () => closeSheet(el);
  const rb = el.querySelector('[data-act=right]');
  if (onRight) rb.onclick = () => onRight(el); else rb.style.visibility = 'hidden';
  document.body.style.overflow = 'hidden';
  return el;
}
function closeSheet(el) {
  el.remove();
  if (!$sheets.children.length) document.body.style.overflow = '';
}
function closeAllSheets() { [...$sheets.children].forEach(closeSheet); }

// ============ Tagebuch ============
async function renderDiary() {
  const entries = await db.entriesForDate(state.date);
  const t = sumTotals(entries);
  const g = state.goals;
  const left = g.kcal - t.k;
  const pct = Math.min(1, t.k / (g.kcal || 1));
  const C = 2 * Math.PI * 52;
  const macro = (label, val, goal, cls) => {
    const over = val > goal * 1.05;
    return `<div class="macro"><div class="row"><span>${label}</span><span>${r0(val)} / ${r0(goal)} g</span></div>
      <div class="bar ${over ? 'over' : ''}"><i class="${cls}" style="width:${Math.min(100, (val / (goal || 1)) * 100)}%"></i></div></div>`;
  };

  let html = `
    <div class="header">
      <div class="datenav">
        <button class="arrow" data-nav="-1" aria-label="Vorheriger Tag">${ICON.left}</button>
        <button class="arrow" data-nav="1" aria-label="Nächster Tag">${ICON.right}</button>
        <span class="label">${esc(dateLabel(state.date))}</span>
      </div>
      ${state.date !== todayStr() ? '<button class="today-link" data-today>Heute</button>' : ''}
    </div>
    <div class="card summary">
      <div class="ring ${left < 0 ? 'over' : ''}">
        <svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/>
          <circle class="val" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg>
        <div class="center"><div class="big">${r0(Math.abs(left))}</div><div class="small">${left < 0 ? 'kcal zu viel' : 'kcal übrig'}</div></div>
      </div>
      <div>
        <div class="kcal-line"><b>${r0(t.k)}</b> von ${r0(g.kcal)} kcal</div>
        ${macro('Eiweiß', t.p, g.p, 'c-p')}
        ${macro('Kohlenhydrate', t.c, g.c, 'c-c')}
        ${macro('Fett', t.f, g.f, 'c-f')}
      </div>
    </div>`;

  for (const m of MEALS) {
    const list = entries.filter(e => e.meal === m.id).sort((a, b) => a.ts - b.ts);
    const mt = sumTotals(list);
    html += `<section class="card">
      <div class="card-title"><h2>${m.name}</h2><span class="sum">${r0(mt.k)} kcal</span></div>
      ${list.length ? `<div class="meal-macros">E ${r0(mt.p)} g · K ${r0(mt.c)} g · F ${r0(mt.f)} g</div>` : ''}
      ${list.map(e => `<button class="entry" data-entry="${e.id}">
          <div class="info"><div class="name">${esc(e.n)}</div><div class="sub">${esc(amountLabel(e))}${e.b ? ' · ' + esc(e.b) : ''}</div></div>
          <div class="kcal">${r0(totals(e).k)} kcal</div></button>`).join('')}
      <button class="add-btn" data-add="${m.id}">${ICON.plus} Hinzufügen</button>
    </section>`;
  }
  $view.innerHTML = html;

  $view.querySelectorAll('[data-nav]').forEach(b => (b.onclick = () => { state.date = addDays(state.date, +b.dataset.nav); render(); }));
  const tb = $view.querySelector('[data-today]');
  if (tb) tb.onclick = () => { state.date = todayStr(); render(); };
  $view.querySelectorAll('[data-add]').forEach(b => (b.onclick = () => openAddSheet(b.dataset.add)));
  $view.querySelectorAll('[data-entry]').forEach(b => (b.onclick = () => {
    const e = entries.find(x => x.id === +b.dataset.entry);
    openFoodSheet({ entry: e });
  }));
}

// Wischen links/rechts wechselt den Tag
let touchX = null, touchY = null;
$view.addEventListener('touchstart', e => { if (state.tab === 'diary') { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } }, { passive: true });
$view.addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) { state.date = addDays(state.date, dx < 0 ? 1 : -1); render(); }
}, { passive: true });

// ============ Lebensmittel hinzufügen ============
async function getRecent() { return db.getMeta('recent', []); }
async function rememberFood(entry) {
  let recent = await getRecent();
  const old = recent.find(r => r.code === entry.code);
  recent = recent.filter(r => r.code !== entry.code);
  recent.unshift({ code: entry.code, n: entry.n, b: entry.b, per: entry.per, sq: entry.sq, lastG: entry.g, unit: entry.unit, count: (old?.count || 0) + 1, ts: Date.now() });
  await db.setMeta('recent', recent.slice(0, 80));
}

function foodRow(f, extra = '') {
  const k = f.per ? f.per.k : f.k;
  return `<button class="entry" data-code="${esc(f.code)}">
    <div class="info"><div class="name">${esc(f.n)}${f.custom ? '<span class="badge">Eigenes</span>' : ''}</div>
    <div class="sub">${[f.b, extra].filter(Boolean).map(esc).join(' · ')}</div></div>
    <div class="kcal">${r0(k)} kcal<br><span style="font-size:11px">pro 100 g</span></div></button>`;
}

function openAddSheet(meal) {
  const mealName = MEALS.find(m => m.id === meal).name;
  const el = openSheet({
    title: mealName,
    body: `
      <div class="searchbar">
        <input type="search" placeholder="Lebensmittel suchen" autocomplete="off" enterkeyhint="search">
        <button class="icon-btn" data-scan aria-label="Barcode scannen">${ICON.scan}</button>
      </div>
      <div class="chips"><button class="chip active" data-mode="recent">Zuletzt</button><button class="chip" data-mode="frequent">Häufig</button><button class="chip" data-mode="custom">Eigene</button></div>
      <div data-results></div>
      <button class="secondary" data-new>Eigenes Lebensmittel anlegen</button>
      <button class="secondary" data-photo-new>📷 Nährwerttabelle fotografieren</button>
      <button class="secondary" data-quick>Schnell eintragen (nur kcal &amp; Makros)</button>`,
  });
  const input = el.querySelector('input');
  const $res = el.querySelector('[data-results]');
  const $chips = el.querySelector('.chips');
  let mode = 'recent', items = [], seq = 0;

  const bindRows = () => $res.querySelectorAll('[data-code]').forEach(b => (b.onclick = async () => {
    const it = items.find(x => x.code === b.dataset.code);
    const food = it.per ? (await db.getFood(it.code)) || recentToFood(it) : it;
    openFoodSheet({ food, meal, date: state.date, preset: it.per ? { g: it.lastG, unit: it.unit } : null, onAdded: () => closeSheet(el) });
  }));

  async function showList() {
    $chips.hidden = false;
    if (mode === 'custom') {
      items = await db.listCustomFoods();
      $res.innerHTML = items.length ? `<div class="list">${items.map(f => foodRow(f)).join('')}</div>` : '<div class="empty">Noch keine eigenen Lebensmittel.</div>';
    } else {
      items = await getRecent();
      if (mode === 'frequent') items = [...items].sort((a, b) => b.count - a.count).slice(0, 30);
      $res.innerHTML = items.length
        ? `<div class="list">${items.map(f => foodRow(f, mode === 'frequent' ? `${f.count}×` : amountLabel({ g: f.lastG, unit: f.unit, sq: f.sq }))).join('')}</div>`
        : '<div class="empty">Hier erscheinen deine zuletzt gegessenen Lebensmittel.<br>Suche oben oder scanne einen Barcode.</div>';
    }
    bindRows();
  }

  async function doSearch() {
    const q = input.value.trim();
    if (q.length < 2) return showList();
    $chips.hidden = true;
    if (/^\d{8,14}$/.test(q)) {
      const f = await db.getFood(normalizeCode(q));
      items = f ? [f] : [];
    } else {
      const my = ++seq;
      const res = await db.searchFoods(q);
      if (my !== seq) return;
      items = res;
    }
    $res.innerHTML = items.length
      ? `<div class="list">${items.map(f => foodRow(f, f.q)).join('')}</div>`
      : `<div class="empty">Nichts gefunden.<br><button class="link-btn" data-new2>Als eigenes Lebensmittel anlegen</button></div>`;
    const n2 = $res.querySelector('[data-new2]');
    if (n2) n2.onclick = () => openCustomFoodSheet({ name: /^\d+$/.test(q) ? '' : q, code: /^\d+$/.test(q) ? normalizeCode(q) : '', meal, onAdded: () => closeSheet(el) });
    bindRows();
  }

  let deb;
  input.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(doSearch, 180); });
  $chips.querySelectorAll('[data-mode]').forEach(c => (c.onclick = () => {
    mode = c.dataset.mode;
    $chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
    showList();
  }));
  el.querySelector('[data-scan]').onclick = () => openScanner(code => handleScanned(code, meal, el));
  el.querySelector('[data-new]').onclick = () => openCustomFoodSheet({ meal, onAdded: () => closeSheet(el) });
  el.querySelector('[data-photo-new]').onclick = () => openCustomFoodSheet({ meal, photo: true, onAdded: () => closeSheet(el) });
  el.querySelector('[data-quick]').onclick = () => openQuickSheet(meal, () => closeSheet(el));
  showList();
}

function recentToFood(r) {
  return { code: r.code, n: r.n, b: r.b, sq: r.sq, ...r.per };
}

async function handleScanned(code, meal, addSheet) {
  const food = await db.getFood(code);
  if (food) {
    openFoodSheet({ food, meal, date: state.date, onAdded: () => addSheet && closeSheet(addSheet) });
  } else {
    toast('Produkt nicht in der Datenbank – bitte einmal eintragen', 3200);
    openCustomFoodSheet({ code, meal, onAdded: () => addSheet && closeSheet(addSheet) });
  }
}

// ============ Scanner ============
function openScanner(onCode) {
  const el = document.createElement('div');
  el.className = 'scanner';
  el.innerHTML = `
    <video playsinline muted autoplay></video>
    <div class="frame"></div>
    <div class="scan-top"><button data-close>Abbrechen</button></div>
    <div class="scan-msg">Kamera wird gestartet …</div>
    <form class="manual"><input inputmode="numeric" pattern="[0-9]*" placeholder="EAN manuell eingeben"><button>OK</button></form>`;
  document.body.appendChild(el);
  const msg = el.querySelector('.scan-msg');
  let scanner = null, closed = false;
  const close = () => { closed = true; scanner?.stop(); el.remove(); };
  el.querySelector('[data-close]').onclick = close;
  el.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    const v = el.querySelector('form input').value.replace(/\D/g, '');
    if (v.length >= 8) { close(); onCode(normalizeCode(v)); }
  };
  startScanner(el.querySelector('video'), code => { if (!closed) { close(); onCode(code); } }, m => (msg.textContent = m))
    .then(s => { if (closed) s.stop(); else { scanner = s; msg.textContent = 'Barcode in den Rahmen halten'; } })
    .catch(err => {
      msg.textContent = err.name === 'NotAllowedError'
        ? 'Kein Kamerazugriff. Erlaube die Kamera in den Einstellungen oder gib die EAN unten ein.'
        : (err.message || 'Kamera konnte nicht gestartet werden.');
    });
}

// ============ Lebensmittel-Detail / Menge ============
function openFoodSheet({ food, entry, meal, date, preset, onAdded }) {
  const editing = !!entry;
  const per = editing ? entry.per : perFromFood(food);
  const sq = editing ? entry.sq : food.sq;
  const name = editing ? entry.n : food.n;
  const brand = editing ? entry.b : food.b;
  let unit = editing ? entry.unit || 'g' : preset?.unit || 'g';
  if (unit === 'portion' && !sq) unit = 'g';
  let grams = editing ? entry.g : preset?.g || (sq && unit === 'portion' ? sq : 100);
  let curMeal = editing ? entry.meal : meal;

  const el = openSheet({
    title: editing ? 'Eintrag bearbeiten' : 'Hinzufügen',
    right: editing ? 'Sichern' : 'Fertig',
    body: `
      <div class="food-title">${esc(name)}</div>
      <div class="food-brand">${esc([brand, food?.q].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
      <div class="amount-row">
        <input data-amount inputmode="decimal" enterkeyhint="done">
        <select data-unit>
          <option value="g">g / ml</option>
          ${sq ? `<option value="portion">Portion (${r1(sq)} g)</option>` : ''}
        </select>
      </div>
      <div class="quick">
        ${[50, 100, 150, 200, 250].map(v => `<button class="chip" data-quick="${v}">${v} g</button>`).join('')}
        ${sq ? `<button class="chip" data-quick-portion>1 Portion</button>` : ''}
      </div>
      <div class="segmented" data-meals>${MEALS.map(m => `<button data-meal="${m.id}">${m.name.replace('essen', '')}</button>`).join('')}</div>
      <div class="nutri-grid" data-grid></div>
      <div class="list" style="padding:12px 16px"><table class="nutri-table" data-table></table></div>
      <button class="primary" data-save>${editing ? 'Änderung sichern' : 'Zum Tagebuch hinzufügen'}</button>
      ${editing ? '<button class="secondary danger" data-del>Eintrag löschen</button>' : ''}
      ${!editing && food?.custom ? '<button class="secondary" data-editfood>Eigenes Lebensmittel bearbeiten</button>' : ''}
      ${food?.code && !food.code.startsWith('c') ? `<div class="hint" style="text-align:center;margin-top:8px">EAN ${esc(food.code)}${food.custom ? '' : ' · Daten: Open Food Facts'}</div>` : ''}`,
    onRight: () => save(),
  });

  const $amount = el.querySelector('[data-amount]');
  const $unit = el.querySelector('[data-unit]');
  $unit.value = unit;
  const shown = () => (unit === 'portion' ? grams / sq : grams);
  $amount.value = fmtIn(shown());

  function update() {
    const f = grams / 100;
    const v = key => (per[key] == null ? null : per[key] * f);
    el.querySelector('[data-grid]').innerHTML = `
      <div><b>${r0(v('k'))}</b><span>kcal</span></div>
      <div><b>${r1(v('p'))}</b><span>Eiweiß</span></div>
      <div><b>${r1(v('c'))}</b><span>Kohlenh.</span></div>
      <div><b>${r1(v('f'))}</b><span>Fett</span></div>`;
    const row = (label, key, unitLabel = 'g', digits = r1) =>
      `<tr><td>${label}</td><td>${per[key] == null ? '–' : digits(per[key]) + ' ' + unitLabel}</td><td>${per[key] == null ? '–' : digits(per[key] * f) + ' ' + unitLabel}</td></tr>`;
    el.querySelector('[data-table]').innerHTML = `
      <tr><th>Nährwerte</th><th>pro 100 g</th><th>${r1(grams)} g</th></tr>
      ${row('Energie', 'k', 'kcal', r0)}${row('Fett', 'f')}${row('davon gesättigt', 'sf')}
      ${row('Kohlenhydrate', 'c')}${row('davon Zucker', 's')}${row('Ballaststoffe', 'fi')}
      ${row('Eiweiß', 'p')}${row('Salz', 'sa')}`;
    el.querySelectorAll('[data-meal]').forEach(b => b.classList.toggle('active', b.dataset.meal === curMeal));
    el.querySelector('[data-save]').disabled = !(grams > 0);
  }
  $amount.addEventListener('input', () => {
    const v = parseNum($amount.value);
    grams = v == null ? 0 : unit === 'portion' ? v * sq : v;
    update();
  });
  $amount.addEventListener('keydown', e => { if (e.key === 'Enter') $amount.blur(); });
  $unit.onchange = () => { unit = $unit.value; $amount.value = fmtIn(shown()); update(); };
  el.querySelectorAll('[data-quick]').forEach(b => (b.onclick = () => { unit = 'g'; $unit.value = 'g'; grams = +b.dataset.quick; $amount.value = fmtIn(grams); update(); }));
  const qp = el.querySelector('[data-quick-portion]');
  if (qp) qp.onclick = () => { unit = 'portion'; $unit.value = 'portion'; grams = sq; $amount.value = '1'; update(); };
  el.querySelectorAll('[data-meal]').forEach(b => (b.onclick = () => { curMeal = b.dataset.meal; update(); }));
  el.querySelector('[data-save]').onclick = save;
  const del = el.querySelector('[data-del]');
  if (del) del.onclick = async () => {
    if (!confirm('Eintrag löschen?')) return;
    await db.deleteEntry(entry.id); closeSheet(el); render(); toast('Gelöscht');
  };
  const ef = el.querySelector('[data-editfood]');
  if (ef) ef.onclick = () => { closeSheet(el); openCustomFoodSheet({ food, meal, onAdded }); };
  update();
  if (!editing) setTimeout(() => { $amount.focus(); $amount.select(); }, 250);

  async function save() {
    if (!(grams > 0)) return;
    if (editing) {
      await db.putEntry({ ...entry, g: grams, unit, meal: curMeal });
      await rememberFood({ ...entry, g: grams, unit });
      toast('Gesichert');
    } else {
      const e = { date: date || state.date, meal: curMeal, code: food.code, n: food.n, b: food.b || '', sq: sq || null, per, g: grams, unit, ts: Date.now() };
      await db.addEntry(e);
      await rememberFood(e);
      toast(`${r0(totals(e).k)} kcal zu ${MEALS.find(m => m.id === curMeal).name} hinzugefügt`);
      onAdded && onAdded();
    }
    closeSheet(el);
    render();
  }
}

// ============ Eigenes Lebensmittel ============
function openCustomFoodSheet({ food = null, code = '', name = '', meal, onAdded, photo = false } = {}) {
  const f = food || { code, n: name };
  const fields = [
    ['k', 'Energie', 'kcal'], ['f', 'Fett', 'g'], ['sf', 'davon gesättigt', 'g'], ['c', 'Kohlenhydrate', 'g'],
    ['s', 'davon Zucker', 'g'], ['fi', 'Ballaststoffe', 'g'], ['p', 'Eiweiß', 'g'], ['sa', 'Salz', 'g'],
  ];
  const el = openSheet({
    title: food ? 'Lebensmittel bearbeiten' : 'Eigenes Lebensmittel',
    right: 'Sichern',
    body: `
      <div class="list">
        <div class="field"><label>Name</label><input class="wide" data-f="n" value="${esc(f.n)}" placeholder="z. B. Haferflocken"></div>
        <div class="field"><label>Marke</label><input class="wide" data-f="b" value="${esc(f.b)}" placeholder="optional"></div>
        <div class="field"><label>EAN</label><input class="wide" data-f="code" inputmode="numeric" value="${esc(f.code && !String(f.code).startsWith('c') ? f.code : '')}" placeholder="optional"></div>
      </div>
      <div class="section-label">Nährwerte pro 100 g / ml</div>
      <button class="secondary" data-photo>📷 Nährwerttabelle fotografieren</button>
      <input type="file" accept="image/*" data-photo-file hidden>
      <div class="hint" data-ocr-status hidden></div>
      <div class="list">
        ${fields.map(([k, l, u]) => `<div class="field"><label>${l}</label><input data-f="${k}" inputmode="decimal" value="${fmtIn(f[k])}" placeholder="${k === 'k' || k === 'p' || k === 'c' || k === 'f' ? '0' : 'optional'}"><span class="unit">${u}</span></div>`).join('')}
      </div>
      <div class="hint">Die Werte stehen auf der Verpackung in der Nährwerttabelle.</div>
      <div class="list">
        <div class="field"><label>Portionsgröße</label><input data-f="sq" inputmode="decimal" value="${fmtIn(f.sq)}" placeholder="optional"><span class="unit">g</span></div>
      </div>
      <button class="primary" data-save>Sichern${meal ? ' und weiter' : ''}</button>
      ${food ? '<button class="secondary danger" data-del>Lebensmittel löschen</button>' : ''}`,
    onRight: () => save(),
  });
  el.querySelector('[data-save]').onclick = save;
  const del = el.querySelector('[data-del]');
  if (del) del.onclick = async () => {
    if (!confirm('Eigenes Lebensmittel löschen? Einträge im Tagebuch bleiben erhalten.')) return;
    await db.deleteCustomFood(food.code); closeSheet(el); toast('Gelöscht'); render();
  };
  if (!f.n && !photo && !code) setTimeout(() => el.querySelector('[data-f=n]').focus(), 250);

  // ---- Nährwerttabelle per Foto ----
  const $file = el.querySelector('[data-photo-file]');
  const $status = el.querySelector('[data-ocr-status]');
  const $photoBtn = el.querySelector('[data-photo]');
  $photoBtn.onclick = () => $file.click();
  if (photo) $file.click();
  $file.onchange = async () => {
    const file = $file.files[0];
    $file.value = '';
    if (!file) return;
    $photoBtn.disabled = true;
    $status.hidden = false;
    el.querySelectorAll('.ocr-filled').forEach(i => i.classList.remove('ocr-filled'));
    try {
      const { values, found, warning } = await recognizeImage(file, m => ($status.textContent = m));
      for (const [k, v] of Object.entries(values)) {
        const input = el.querySelector(`[data-f="${k}"]`);
        if (input) { input.value = fmtIn(v); input.classList.add('ocr-filled'); }
      }
      if (!found.length) {
        $status.textContent = 'Keine Nährwerte erkannt. Tipp: Tabelle gerade, nah und ohne Spiegelung fotografieren.';
      } else {
        $status.innerHTML = `<b>${found.length} von 8 Werten erkannt</b> (grün markiert) – bitte mit der Packung vergleichen.` +
          (warning ? `<br><span class="danger">${esc(warning)}</span>` : '');
        if (!el.querySelector('[data-f=n]').value) setTimeout(() => el.querySelector('[data-f=n]').focus(), 300);
      }
    } catch (e) {
      $status.textContent = 'Fehler bei der Texterkennung: ' + (e.message || e);
    } finally {
      $photoBtn.disabled = false;
    }
  };

  async function save() {
    const get = k => el.querySelector(`[data-f="${k}"]`).value;
    const n = get('n').trim();
    if (!n) { toast('Bitte einen Namen eingeben'); return; }
    const kcal = parseNum(get('k'));
    if (kcal == null) { toast('Bitte die Kalorien eingeben'); return; }
    const ean = get('code').replace(/\D/g, '');
    const item = {
      code: ean.length >= 8 ? normalizeCode(ean) : (food && String(food.code).startsWith('c') ? food.code : 'c' + Date.now()),
      n, b: get('b').trim(), q: '',
    };
    for (const [k] of fields) item[k] = parseNum(get(k));
    for (const k of ['p', 'c', 'f']) if (item[k] == null) item[k] = 0;
    item.sq = parseNum(get('sq'));
    if (food && food.custom && food.code !== item.code) await db.deleteCustomFood(food.code);
    await db.saveCustomFood(item);
    closeSheet(el);
    toast('Gesichert');
    if (meal) openFoodSheet({ food: item, meal, date: state.date, onAdded });
    else render();
  }
}

// ============ Schnelleintrag ============
function openQuickSheet(meal, onAdded) {
  const el = openSheet({
    title: 'Schnell eintragen',
    right: 'Fertig',
    body: `
      <div class="list">
        <div class="field"><label>Bezeichnung</label><input class="wide" data-f="n" placeholder="Schnelleintrag"></div>
        <div class="field"><label>Kalorien</label><input data-f="k" inputmode="decimal" placeholder="0"><span class="unit">kcal</span></div>
        <div class="field"><label>Eiweiß</label><input data-f="p" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
        <div class="field"><label>Kohlenhydrate</label><input data-f="c" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
        <div class="field"><label>Fett</label><input data-f="f" inputmode="decimal" placeholder="0"><span class="unit">g</span></div>
      </div>
      <div class="hint">Für Essen ohne Barcode, z. B. im Restaurant. Die Werte gelten für die ganze Mahlzeit.</div>
      <button class="primary" data-save>Hinzufügen</button>`,
    onRight: () => save(),
  });
  el.querySelector('[data-save]').onclick = save;
  setTimeout(() => el.querySelector('[data-f=k]').focus(), 250);
  async function save() {
    const g = k => parseNum(el.querySelector(`[data-f="${k}"]`).value);
    const k = g('k');
    if (k == null) { toast('Bitte Kalorien eingeben'); return; }
    const e = {
      date: state.date, meal, code: 'quick', n: el.querySelector('[data-f=n]').value.trim() || 'Schnelleintrag', b: '',
      sq: null, per: { k, p: g('p') || 0, c: g('c') || 0, f: g('f') || 0 }, g: 100, unit: 'quick', ts: Date.now(),
    };
    await db.addEntry(e);
    closeSheet(el); onAdded && onAdded(); render(); toast(`${r0(k)} kcal hinzugefügt`);
  }
}

// ============ Verlauf ============
async function renderHistory() {
  const n = state.historyDays;
  const to = todayStr(), from = addDays(to, -(n - 1));
  const entries = await db.entriesBetween(from, to);
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i);
    days.push({ d, ...sumTotals(entries.filter(e => e.date === d)) });
  }
  const logged = days.filter(d => d.k > 0);
  const avg = key => (logged.length ? logged.reduce((a, d) => a + d[key], 0) / logged.length : 0);
  const max = Math.max(state.goals.kcal * 1.15, ...days.map(d => d.k), 1);
  const H = n > 14 ? 150 : 170, area = H - 18;
  const goalPx = 18 + (state.goals.kcal / max) * area;

  $view.innerHTML = `
    <div class="header"><h1>Verlauf</h1></div>
    <div class="segmented">${[7, 14, 30].map(x => `<button data-days="${x}" class="${x === n ? 'active' : ''}">${x} Tage</button>`).join('')}</div>
    <div class="card">
      <div class="card-title"><h2>Kalorien</h2><span class="sum">Ø ${r0(avg('k'))} kcal</span></div>
      <div class="chart" style="height:${H}px">
        <div class="goal" style="bottom:${goalPx}px"><span>Ziel ${r0(state.goals.kcal)}</span></div>
        ${days.map(d => {
          const h = Math.max(2, (d.k / max) * area);
          const lbl = n <= 7 ? parseDate(d.d).toLocaleDateString('de-DE', { weekday: 'short' }).slice(0, 2) : (n <= 14 || parseDate(d.d).getDate() % 5 === 0 ? parseDate(d.d).getDate() : '');
          return `<div class="col" title="${d.d}: ${r0(d.k)} kcal"><i class="${d.k === 0 ? 'zero' : d.k > state.goals.kcal * 1.05 ? 'over' : ''}" style="height:${h}px"></i><span>${lbl}</span></div>`;
        }).join('')}
      </div>
    </div>
    <div class="section-label">Durchschnitt an ${logged.length} erfassten Tag${logged.length === 1 ? '' : 'en'}</div>
    <div class="stats">
      <div class="stat"><b>${r0(avg('k'))}</b><span>kcal / Tag (Ziel ${r0(state.goals.kcal)})</span></div>
      <div class="stat"><b>${r0(avg('p'))} g</b><span>Eiweiß (Ziel ${r0(state.goals.p)} g)</span></div>
      <div class="stat"><b>${r0(avg('c'))} g</b><span>Kohlenhydrate (Ziel ${r0(state.goals.c)} g)</span></div>
      <div class="stat"><b>${r0(avg('f'))} g</b><span>Fett (Ziel ${r0(state.goals.f)} g)</span></div>
    </div>`;
  $view.querySelectorAll('[data-days]').forEach(b => (b.onclick = () => { state.historyDays = +b.dataset.days; render(); }));
}

// ============ Einstellungen ============
async function renderSettings() {
  const g = state.goals;
  const meta = await db.getMeta('foodDb');
  const customCount = (await db.listCustomFoods()).length;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  const macroKcal = g.p * 4 + g.c * 4 + g.f * 9;

  $view.innerHTML = `
    <div class="header"><h1>Einstellungen</h1></div>
    <div class="section-label">Tagesziele</div>
    <div class="list">
      <div class="field"><label>Kalorien</label><input data-g="kcal" inputmode="numeric" value="${r0(g.kcal)}"><span class="unit">kcal</span></div>
      <div class="field"><label>Eiweiß</label><input data-g="p" inputmode="numeric" value="${r0(g.p)}"><span class="unit">g</span></div>
      <div class="field"><label>Kohlenhydrate</label><input data-g="c" inputmode="numeric" value="${r0(g.c)}"><span class="unit">g</span></div>
      <div class="field"><label>Fett</label><input data-g="f" inputmode="numeric" value="${r0(g.f)}"><span class="unit">g</span></div>
    </div>
    <div class="hint" data-macrohint>Makros ergeben ${r0(macroKcal)} kcal.</div>
    <button class="secondary" data-split>Makros aus Kalorien berechnen (20 / 50 / 30 %)</button>

    <div class="section-label">Eigene Lebensmittel</div>
    <button class="secondary" data-custom>${customCount} eigene Lebensmittel verwalten</button>

    <div class="section-label">Datensicherung</div>
    <button class="secondary" data-export>Backup exportieren</button>
    <button class="secondary" data-import>Backup importieren</button>
    <input type="file" accept="application/json,.json" data-file hidden>
    <div class="hint">Alle Daten liegen nur auf diesem iPhone. Exportiere ab und zu ein Backup (z. B. in die Dateien-App), falls du die App löschst oder das Handy wechselst.</div>

    <div class="section-label">Lebensmitteldatenbank</div>
    <div class="list" style="padding:12px 16px;font-size:15px">
      ${meta ? `${meta.count.toLocaleString('de-DE')} Produkte (DE/AT/CH)<br><span style="color:var(--muted);font-size:13px">Importiert am ${new Date(meta.importedAt).toLocaleDateString('de-DE')} · Quelle: Open Food Facts (ODbL)</span>` : 'Nicht geladen'}
      ${persisted === false ? '<br><span style="color:var(--muted);font-size:13px">Tipp: Zum Home-Bildschirm hinzufügen, damit iOS die Daten dauerhaft behält.</span>' : ''}
    </div>
    <button class="secondary" data-reimport>Datenbank neu laden</button>
    <div class="hint" style="text-align:center;margin-top:20px">Kalorien · läuft komplett offline</div>`;

  const saveGoals = async () => {
    for (const k of ['kcal', 'p', 'c', 'f']) {
      const v = parseNum($view.querySelector(`[data-g=${k}]`).value);
      if (v != null && v >= 0) state.goals[k] = v;
    }
    await db.setMeta('goals', state.goals);
    $view.querySelector('[data-macrohint]').textContent = `Makros ergeben ${r0(state.goals.p * 4 + state.goals.c * 4 + state.goals.f * 9)} kcal.`;
  };
  $view.querySelectorAll('[data-g]').forEach(i => i.addEventListener('change', saveGoals));
  $view.querySelector('[data-split]').onclick = async () => {
    await saveGoals();
    const k = state.goals.kcal;
    Object.assign(state.goals, { p: Math.round((k * 0.2) / 4), c: Math.round((k * 0.5) / 4), f: Math.round((k * 0.3) / 9) });
    await db.setMeta('goals', state.goals);
    render(); toast('Makroziele berechnet');
  };
  $view.querySelector('[data-custom]').onclick = openCustomListSheet;
  $view.querySelector('[data-export]').onclick = exportBackup;
  const fileIn = $view.querySelector('[data-file]');
  $view.querySelector('[data-import]').onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const file = fileIn.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm(`Backup vom ${new Date(data.exportedAt).toLocaleDateString('de-DE')} mit ${data.entries?.length || 0} Einträgen importieren? Die aktuellen Tagebuchdaten werden ersetzt.`)) return;
      await db.importData(data);
      state.goals = { ...DEFAULT_GOALS, ...(await db.getMeta('goals', {})) };
      toast('Backup importiert'); render();
    } catch (e) { alert('Import fehlgeschlagen: ' + e.message); }
    fileIn.value = '';
  };
  $view.querySelector('[data-reimport]').onclick = async () => {
    if (!confirm('Lebensmitteldatenbank neu laden? Deine Einträge und eigenen Lebensmittel bleiben erhalten.')) return;
    await runImport();
  };
}

async function openCustomListSheet() {
  const items = await db.listCustomFoods();
  const el = openSheet({
    title: 'Eigene Lebensmittel', left: 'Zurück',
    body: items.length ? `<div class="list">${items.map(f => foodRow(f, f.code.startsWith('c') ? '' : 'EAN ' + f.code)).join('')}</div>` : '<div class="empty">Noch keine eigenen Lebensmittel. Du kannst sie beim Hinzufügen anlegen.</div>',
  });
  el.querySelectorAll('[data-code]').forEach(b => (b.onclick = () => {
    closeSheet(el);
    openCustomFoodSheet({ food: items.find(f => f.code === b.dataset.code) });
  }));
}

async function exportBackup() {
  const data = await db.exportData();
  const name = `kalorien-backup-${todayStr()}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ============ Datenbank-Import (Ersteinrichtung) ============
async function runImport() {
  document.getElementById('tabbar').hidden = true;
  closeAllSheets();
  $view.innerHTML = `
    <div class="setup">
      <h1>Kalorien</h1>
      <p>Die Lebensmitteldatenbank wird einmalig auf dein iPhone geladen. Danach funktioniert alles offline.</p>
      <div class="progress"><i></i></div>
      <div class="num">Wird geladen …</div>
    </div>`;
  const bar = $view.querySelector('.progress i'), num = $view.querySelector('.num');
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const count = await db.importFoodDatabase(DB_URL, (d, t) => {
      bar.style.width = (t ? (d / t) * 100 : 0) + '%';
      num.textContent = `${d.toLocaleString('de-DE')} von ${t.toLocaleString('de-DE')} Produkten`;
    });
    await db.setMeta('foodDbVersion', DB_FILE_VERSION);
    toast(`${count.toLocaleString('de-DE')} Produkte geladen`);
  } catch (e) {
    $view.innerHTML = `<div class="setup"><h1>Fehler</h1><p>${esc(e.message)}</p><button class="primary" style="max-width:300px;margin:0 auto" data-retry>Nochmal versuchen</button>
      <p style="margin-top:16px"><button class="link-btn" data-skip>Ohne Datenbank fortfahren</button></p></div>`;
    $view.querySelector('[data-retry]').onclick = runImport;
    $view.querySelector('[data-skip]').onclick = () => { document.getElementById('tabbar').hidden = false; render(); };
    return;
  }
  document.getElementById('tabbar').hidden = false;
  render();
}

// ============ Navigation ============
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'diary') return renderDiary();
  if (state.tab === 'history') return renderHistory();
  return renderSettings();
}
document.querySelectorAll('.tabbar button').forEach(b => (b.onclick = () => {
  if (state.tab === b.dataset.tab && b.dataset.tab === 'diary') state.date = todayStr();
  state.tab = b.dataset.tab; window.scrollTo(0, 0); render();
}));

// Beim Zurückkehren in die App nach Mitternacht auf "Heute" springen
let lastToday = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = todayStr();
  if (t !== lastToday) { if (state.date === lastToday) state.date = t; lastToday = t; render(); }
});

async function init() {
  if ('serviceWorker' in navigator) {
    // Neue App-Version: einmal neu laden, damit sie sofort aktiv ist
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  }
  state.goals = { ...DEFAULT_GOALS, ...(await db.getMeta('goals', {})) };
  const ver = await db.getMeta('foodDbVersion', 0);
  if (ver < DB_FILE_VERSION) return runImport();
  render();
}
init();
