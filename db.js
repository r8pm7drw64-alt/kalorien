// Lokale Datenbank (IndexedDB) – alles bleibt auf dem Gerät.

const DB_NAME = 'kalorien';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Lebensmittel: Schlüssel = EAN (bzw. "c<zeit>" für eigene ohne EAN)
      const foods = db.createObjectStore('foods', { keyPath: 'code' });
      foods.createIndex('t', 't', { multiEntry: true });
      // Eigene Lebensmittel separat, damit ein Neuimport der Datenbank sie nicht berührt
      const custom = db.createObjectStore('custom', { keyPath: 'code' });
      custom.createIndex('t', 't', { multiEntry: true });
      const entries = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
      entries.createIndex('date', 'date');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaktion abgebrochen'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---------- Text-Normalisierung für die Suche ----------
export function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
export function tokens(...parts) {
  const set = new Set();
  for (const p of parts) for (const w of normalize(p).split(' ')) if (w.length >= 2) set.add(w);
  return [...set];
}

// ---------- Meta ----------
export async function getMeta(key, fallback = null) {
  const v = await wrap((await store('meta')).get(key));
  return v === undefined ? fallback : v;
}
export async function setMeta(key, value) {
  return wrap((await store('meta', 'readwrite')).put(value, key));
}

// ---------- Lebensmittel ----------
// Feldnamen kurz gehalten (hunderttausende Datensätze):
// code, n=Name, b=Marke, k=kcal, p=Eiweiß, c=Kohlenhydrate, s=Zucker, f=Fett,
// sf=gesättigte Fettsäuren, fi=Ballaststoffe, sa=Salz, sq=Portion (g), q=Packungsgröße, r=Rang

export async function getFood(code) {
  const db = await openDB();
  const tx = db.transaction(['custom', 'foods']);
  const c = await wrap(tx.objectStore('custom').get(code));
  if (c) return c;
  return (await wrap(tx.objectStore('foods').get(code))) || null;
}

export async function saveCustomFood(food) {
  food.custom = true;
  food.t = tokens(food.n, food.b);
  if (food.r == null) food.r = 1e9; // eigene Lebensmittel zuerst
  await wrap((await store('custom', 'readwrite')).put(food));
  return food;
}
export async function deleteCustomFood(code) {
  return wrap((await store('custom', 'readwrite')).delete(code));
}
export async function listCustomFoods() {
  const all = await wrap((await store('custom')).getAll());
  return all.sort((a, b) => a.n.localeCompare(b.n, 'de'));
}

function searchStore(os, first, limit) {
  return new Promise((resolve, reject) => {
    const out = [];
    const req = os.index('t').openCursor(IDBKeyRange.bound(first, first + '￿'));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function searchFoods(query, max = 60) {
  const qt = normalize(query).split(' ').filter(w => w.length >= 2);
  if (!qt.length) return [];
  // Das längste Wort über den Index suchen, die übrigen danach filtern
  const sorted = [...qt].sort((a, b) => b.length - a.length);
  const db = await openDB();
  const tx = db.transaction(['custom', 'foods']);
  const [c, f] = await Promise.all([
    searchStore(tx.objectStore('custom'), sorted[0], 500),
    searchStore(tx.objectStore('foods'), sorted[0], 3000),
  ]);
  const seen = new Set();
  const res = [];
  for (const item of [...c, ...f]) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    if (!qt.every(q => item.t.some(w => w.startsWith(q)))) continue;
    res.push(item);
  }
  const nameStarts = item => normalize(item.n).startsWith(qt[0]) ? 1 : 0;
  res.sort((a, b) => (b.custom ? 1 : 0) - (a.custom ? 1 : 0) || nameStarts(b) - nameStarts(a) || (b.r || 0) - (a.r || 0));
  return res.slice(0, max);
}

export async function countFoods() {
  return wrap((await store('foods')).count());
}

/**
 * Importiert die komprimierte Datenbankdatei (data/foods.tsv.gz) in IndexedDB.
 * onProgress(done, total)
 */
export async function importFoodDatabase(url, onProgress) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('Datenbankdatei nicht gefunden (' + resp.status + ')');
  const buf0 = new Uint8Array(await resp.arrayBuffer());
  let stream = new Blob([buf0]).stream();
  // Gzip-Signatur prüfen: manche Server entpacken bereits selbst
  if (buf0[0] === 0x1f && buf0[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann die Datenbank nicht entpacken (iOS 16.4 oder neuer nötig).');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  stream = stream.pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();

  const db = await openDB();
  await done((() => { const tx = db.transaction('foods', 'readwrite'); tx.objectStore('foods').clear(); return tx; })());

  let buf = '', total = 0, count = 0, batch = [], header = true;
  const flush = async () => {
    if (!batch.length) return;
    const tx = db.transaction('foods', 'readwrite');
    const os = tx.objectStore('foods');
    for (const item of batch) os.put(item);
    batch = [];
    await done(tx);
    onProgress && onProgress(count, total);
  };
  const num = s => (s === '' ? null : +s);
  const handle = line => {
    if (!line) return;
    const f = line.split('\t');
    if (header) { header = false; total = +f[1] || 0; return; }
    const item = {
      code: f[0], n: f[1], b: f[2],
      k: num(f[3]), p: num(f[4]), c: num(f[5]), s: num(f[6]), f: num(f[7]),
      sf: num(f[8]), fi: num(f[9]), sa: num(f[10]), sq: num(f[11]), q: f[12] || '',
      r: total - count,
    };
    item.t = tokens(item.n, item.b);
    batch.push(item);
    count++;
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (batch.length >= 3000) await flush();
  }
  handle(buf);
  await flush();
  await setMeta('foodDb', { count, importedAt: Date.now() });
  return count;
}

// ---------- Tagebuch ----------
export async function entriesForDate(date) {
  return wrap((await store('entries')).index('date').getAll(date));
}
export async function entriesBetween(from, to) {
  return wrap((await store('entries')).index('date').getAll(IDBKeyRange.bound(from, to)));
}
export async function addEntry(e) {
  return wrap((await store('entries', 'readwrite')).add(e));
}
export async function putEntry(e) {
  return wrap((await store('entries', 'readwrite')).put(e));
}
export async function deleteEntry(id) {
  return wrap((await store('entries', 'readwrite')).delete(id));
}
export async function allEntries() {
  return wrap((await store('entries')).getAll());
}

// ---------- Backup ----------
export async function exportData() {
  const db = await openDB();
  const tx = db.transaction(['entries', 'custom', 'meta']);
  const [entries, custom, metaKeys, metaVals] = await Promise.all([
    wrap(tx.objectStore('entries').getAll()),
    wrap(tx.objectStore('custom').getAll()),
    wrap(tx.objectStore('meta').getAllKeys()),
    wrap(tx.objectStore('meta').getAll()),
  ]);
  const meta = {};
  metaKeys.forEach((k, i) => { if (k !== 'foodDb') meta[k] = metaVals[i]; });
  return { app: 'kalorien', version: 1, exportedAt: new Date().toISOString(), entries, custom, meta };
}

export async function importData(data) {
  if (!data || data.app !== 'kalorien') throw new Error('Das ist keine Backup-Datei dieser App.');
  const db = await openDB();
  const tx = db.transaction(['entries', 'custom', 'meta'], 'readwrite');
  tx.objectStore('entries').clear();
  tx.objectStore('custom').clear();
  for (const e of data.entries || []) tx.objectStore('entries').put(e);
  for (const c of data.custom || []) tx.objectStore('custom').put(c);
  for (const [k, v] of Object.entries(data.meta || {})) tx.objectStore('meta').put(v, k);
  await done(tx);
}
