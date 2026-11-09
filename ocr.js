// Nährwerttabelle per Foto auslesen – komplett offline mit Tesseract (deutsches Sprachmodell).

const BASE = new URL('vendor/tesseract/', location.href).href;
let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Texterkennung konnte nicht geladen werden.'));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(BASE + 'tesseract.min.js');
      const w = await window.Tesseract.createWorker('deu', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE,
        langPath: BASE + 'lang',
        workerBlobURL: false,
        logger: m => getWorker.onProgress && getWorker.onProgress(m),
      });
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
      return w;
    })().catch(e => { workerPromise = null; throw e; });
  }
  getWorker.onProgress = onProgress;
  return workerPromise;
}

// Foto verkleinern, Graustufen, Kontrast strecken, Tabellenlinien entfernen.
// Liefert ein Canvas; invert=true kehrt hell/dunkel um (für helle Schrift auf dunklem Grund).
async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    return img;
  }
}

function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  return th;
}

// Lange (auch leicht schräge) dunkle Linien verfolgen und weiß übermalen
function removeLines(gray, w, h, dark) {
  const isDark = i => gray[i] < dark;
  const erase = new Uint8Array(w * h);
  const minH = Math.max(80, w * 0.22), minV = Math.max(80, h * 0.12);
  // waagrecht
  const seenH = new Uint8Array(w * h);
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const i0 = y0 * w + x0;
      if (seenH[i0] || !isDark(i0)) continue;
      const path = [];
      let x = x0, y = y0, gap = 0;
      while (x < w) {
        let ny = -1;
        for (const dy of [0, -1, 1]) { const yy = y + dy; if (yy >= 0 && yy < h && isDark(yy * w + x)) { ny = yy; break; } }
        if (ny < 0) { if (++gap > 3) break; } else { gap = 0; y = ny; path.push(y * w + x); seenH[y * w + x] = 1; }
        x++;
      }
      if (path.length >= minH) for (const i of path) erase[i] = 1;
    }
  }
  // senkrecht
  const seenV = new Uint8Array(w * h);
  for (let x0 = 0; x0 < w; x0++) {
    for (let y0 = 0; y0 < h; y0++) {
      const i0 = y0 * w + x0;
      if (seenV[i0] || !isDark(i0)) continue;
      const path = [];
      let x = x0, y = y0, gap = 0;
      while (y < h) {
        let nx = -1;
        for (const dx of [0, -1, 1]) { const xx = x + dx; if (xx >= 0 && xx < w && isDark(y * w + xx)) { nx = xx; break; } }
        if (nx < 0) { if (++gap > 3) break; } else { gap = 0; x = nx; path.push(y * w + x); seenV[y * w + x] = 1; }
        y++;
      }
      if (path.length >= minV) for (const i of path) erase[i] = 1;
    }
  }
  // Linienpixel samt Dicke (zusammenhängend dunkle Nachbarn bis 6 px) löschen
  const out = gray.slice();
  for (let i = 0; i < erase.length; i++) {
    if (!erase[i]) continue;
    const x = i % w, y = (i / w) | 0;
    out[i] = 255;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      for (let k = 1; k <= 6; k++) {
        const xx = x + dx * k, yy = y + dy * k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
        const j = yy * w + xx;
        if (!isDark(j)) break;
        out[j] = 255;
      }
    }
  }
  return out;
}

async function prepareImage(file, invert) {
  const bmp = await loadBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const total = w * h, hist = new Uint32Array(256);
  let gray = new Uint8ClampedArray(total);
  for (let i = 0; i < total; i++) {
    const g = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
    gray[i] = invert ? 255 - g : g;
  }
  for (let i = 0; i < total; i++) hist[gray[i]]++;
  // Kontrast strecken (2 %/98 %-Perzentil)
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  hist.fill(0);
  for (let i = 0; i < total; i++) { const g = Math.max(0, Math.min(255, ((gray[i] - lo) * 255) / range)) | 0; gray[i] = g; hist[g]++; }
  gray = removeLines(gray, w, h, otsu(hist, total));
  for (let i = 0; i < total; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = gray[i]; d[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function recognizeImage(file, onStatus) {
  onStatus && onStatus('Texterkennung wird geladen …');
  const worker = await getWorker(m => {
    if (m.status === 'recognizing text' && onStatus) onStatus(`Text wird erkannt … ${Math.round(m.progress * 100)} %`);
  });
  onStatus && onStatus('Bild wird vorbereitet …');
  const run = async invert => (await worker.recognize(await prepareImage(file, invert))).data.text || '';
  let text = await run(false);
  let result = parseNutrition(text);
  // Wenig erkannt? Vielleicht helle Schrift auf dunklem Grund -> invertiert nochmal versuchen
  if (result.found.length < 5) {
    onStatus && onStatus('Zweiter Versuch …');
    const text2 = await run(true);
    const result2 = parseNutrition(text2);
    if (result2.found.length > result.found.length) { text = text2; result = result2; }
  }
  window.__lastOcrText = text; // zur Fehlersuche
  return result;
}

// ---------- Text auswerten ----------
const fold = s => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

// Reihenfolge wichtig: spezifischere Begriffe zuerst
const LABELS = [
  ['sf', /(gesaett|gesatt|gesaitt|saturat|fettsaeur|fettsaur|fettsiur)/],
  ['s', /(zucker|zuck|sugar)/],
  ['fi', /(ballast|fibre|fiber|ballaststoff)/],
  ['c', /(kohlenhydr|kohlenh|kohlehydr|ohlenhydr|carbohydr|glucide)/],
  ['p', /(eiweiss|eiweis|eiwei|elweiss|protein)/],
  ['sa', /(\bsalz|\bsalt|\bsel\b)/],
  ['f', /(\bfett\b|\bfett\s|^fett|\bfat\b|\bfett$|matieres grasses)/],
];

function numbersIn(s) {
  // OCR-Verwechsler in Zahlen korrigieren (O->0, l/I->1)
  s = s.replace(/(?<=\d)[oO](?=\d|\s*g)/g, '0').replace(/(?<=\d[.,]?)[lI](?=\d)/g, '1');
  const out = [];
  const re = /(\d{1,4}(?:[.,]\d{1,3})?)/g;
  let m;
  while ((m = re.exec(s))) out.push({ raw: m[1], v: parseFloat(m[1].replace(',', '.')), rest: s.slice(m.index + m[1].length) });
  return out;
}

function fixGrams(n, rest) {
  if (!n) return null;
  let raw = n.raw;
  const unitFollows = /^\s*(g|mg|9g)\b/.test(rest);
  // OCR liest "g" oft als "9": "6,79" = "6,7 g", "0,029" = "0,02 g", "129g" = "12 g"
  if (/^\s*g/.test(rest) && /\d9$/.test(raw) && parseFloat(raw.replace(',', '.')) > 100) raw = raw.slice(0, -1);
  else if (!unitFollows && /[.,]\d{1,}9$/.test(raw) && raw.split(/[.,]/)[1].length >= 2) raw = raw.slice(0, -1);
  let v = parseFloat(raw.replace(',', '.'));
  if (v > 100 && !/[.,]/.test(raw) && /9$/.test(raw)) v = parseFloat(raw.slice(0, -1));
  if (v > 100 && !/[.,]/.test(raw)) v = v / 10; // fehlendes Komma
  return v >= 0 && v <= 100 ? v : null;
}

export function parseNutrition(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const res = {};
  const flat = fold(text).replace(/\s+/g, ' ');

  // Energie: alle kcal- und kJ-Angaben sammeln, die erste ist normalerweise "pro 100 g"
  const kcals = [...flat.matchAll(/(\d{1,4}(?:[.,]\d)?)\s*\)?\s*(kcal|kca1|kcai|keal|kcel)/g)].map(m => parseFloat(m[1].replace(',', '.'))).filter(v => v >= 0 && v <= 950);
  const kjs = [...flat.matchAll(/(\d{2,4}(?:[.,]\d)?)\s*(kj|k j)\b/g)].map(m => Math.round(parseFloat(m[1].replace(',', '.')) / 4.184)).filter(v => v >= 0 && v <= 950);
  const energyCandidates = [...new Set([kcals[0], kjs[0], ...kcals.slice(1)].filter(v => v != null))];
  if (energyCandidates.length) res.k = energyCandidates[0];

  for (const line of lines) {
    const fl = fold(line);
    for (const [key, re] of LABELS) {
      if (res[key] != null) continue;
      const m = fl.match(re);
      if (!m) continue;
      if (key === 'f' && LABELS[0][1].test(fl)) continue; // Zeile mit gesättigten FS ist nicht "Fett"
      const after = fl.slice(m.index + m[0].length);
      const first = numbersIn(after)[0];
      const v = first ? fixGrams(first, first.rest) : null;
      if (v != null) res[key] = v;
      break;
    }
  }

  if (energyCandidates.length > 1 && res.p != null && res.c != null && res.f != null) {
    const calc = res.p * 4 + res.c * 4 + res.f * 9 + (res.fi || 0) * 2;
    // Nur wechseln, wenn der erste Wert deutlich danebenliegt (z. B. kcal der Portionsspalte erwischt)
    if (Math.abs(res.k - calc) > Math.max(25, calc * 0.15)) {
      res.k = energyCandidates.reduce((best, v) => (Math.abs(v - calc) < Math.abs(best - calc) ? v : best));
    }
  }

  // Portionsgröße, z. B. "pro Portion (30 g)", "je Portion 250 ml", "1 Portion = 40 g"
  const sqM = flat.match(/portion\D{0,12}?(\d{1,4}(?:[.,]\d)?)\s*(g|ml)\b/);
  if (sqM) {
    const v = parseFloat(sqM[1].replace(',', '.'));
    if (v > 0 && v <= 2000 && v !== 100) res.sq = v;
  }

  // Plausibilität: Kalorien aus Makros vs. gelesene Kalorien
  const found = Object.keys(res).filter(k => k !== 'sq');
  let warning = '';
  if (res.sf != null && res.f != null && res.sf > res.f) warning = 'Gesättigte Fettsäuren größer als Fett – bitte prüfen.';
  if (res.s != null && res.c != null && res.s > res.c) warning = 'Zucker größer als Kohlenhydrate – bitte prüfen.';
  if (res.k != null && res.p != null && res.c != null && res.f != null) {
    const calc = res.p * 4 + res.c * 4 + res.f * 9 + (res.fi || 0) * 2;
    if (Math.abs(calc - res.k) > Math.max(25, res.k * 0.15)) warning = `Die Werte passen nicht ganz zusammen (aus Makros ≈ ${Math.round(calc)} kcal) – bitte prüfen.`;
  }
  return { values: res, found, warning };
}
