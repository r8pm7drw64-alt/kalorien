// Offline-Cache. Version erhöhen, wenn sich Dateien ändern.
const CACHE = 'kalorien-v5';
// App-Code: immer zuerst aus dem Netz (damit Updates sofort ankommen), offline aus dem Cache
const CODE = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'scanner.js', 'ocr.js', 'manifest.webmanifest'];
// Große, selten geänderte Dateien: zuerst aus dem Cache
const STATIC = [
  'vendor/zxing.min.js',
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/lang/deu.traineddata.gz',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' umgeht den HTTP-Cache des Browsers, sonst landen alte Dateien im neuen Cache.
    // Einzeln laden: fehlt eine Datei, scheitert nicht das ganze Update.
    await Promise.all([...CODE, ...STATIC].map(async url => {
      try {
        const resp = await fetch(new Request(url, { cache: 'reload' }));
        if (resp.ok) await c.put(url, resp);
      } catch { /* offline oder fehlt – später erneut */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('.tsv.gz')) return; // Datenbankdatei nur beim Import gebraucht
  const isStatic = url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isStatic) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const resp = await fetch(e.request);
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    }
    try {
      const resp = await Promise.race([fetch(e.request, { cache: 'no-cache' }), timeout(4000)]);
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      return hit || (await cache.match('index.html')) || Response.error();
    }
  })());
});
