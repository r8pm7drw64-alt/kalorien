// Offline-Cache für die App-Dateien. Version erhöhen, wenn sich Dateien ändern.
const CACHE = 'kalorien-v1';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'scanner.js', 'vendor/zxing.min.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Die große Datenbankdatei wird nach dem Import nicht mehr gebraucht -> nicht cachen
  if (url.pathname.endsWith('.tsv.gz')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return resp;
    }))
  );
});
