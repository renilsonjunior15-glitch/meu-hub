// Guarda o hub e os apps no aparelho para funcionar sem internet.
const CACHE = 'meu-hub-20261126145215';
const FONTS = 'meu-hub-fonts';
const ASSETS = ['./', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './apps/check.bin', './apps/treino.bin', './apps/alimentacao.bin', './apps/compra-pc.bin', './apps/compra-mobile.bin', './apps/financas.bin', './apps/dados.bin'];
const isHtml = r => /text\/html/.test(r.headers.get('content-type') || '');

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u =>
    fetch(u, { cache: 'no-cache' }).then(r => { if (r.ok && (u === './' || !isHtml(r))) return c.put(u, r); }).catch(() => {})
  ))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fontes do Google: cache primeiro
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }))));
    return;
  }
  if (url.origin !== location.origin) return;
  const path = url.pathname.replace(/\/index\.html$/, '/');
  const key = url.origin + path;
  const nav = req.mode === 'navigate';
  if (nav || path.endsWith('.bin')) {
    // Rede primeiro (versão nova); sem internet usa a cópia salva
    e.respondWith(fetch(req).then(r => {
      if (r.ok && r.type === 'basic' && !r.redirected && (nav || !isHtml(r))) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(nav ? url.origin + url.pathname.replace(/[^/]*$/, '') : key, cp)); }
      return r;
    }).catch(() => caches.match(nav ? url.origin + url.pathname.replace(/[^/]*$/, '') : key).then(h => h || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(key).then(hit => hit || fetch(req).then(r => {
    if (r.ok && !r.redirected && !isHtml(r)) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(key, cp)); }
    return r;
  })));
});
