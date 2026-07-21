/* Service worker : coquille hors ligne. Le CACHE porte la version pour
   qu'une nouvelle release invalide l'ancienne coquille. */
const CACHE = 'taches-app-v1.1.2';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'js/model.js', 'js/ha.js',
               'update-check.js', 'manifest.webmanifest',
               'img/icon-192.png', 'img/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  /* Home Assistant et GitHub ne doivent jamais être servis depuis le cache. */
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match('index.html')))
  );
});
