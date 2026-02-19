// SW v6: JS e HTML sempre vêm da rede (Network First sem cache de install)
// CSS e imagens usam Cache First para performance offline
const CACHE_NAME = 'realtrack-v6';
const CACHEABLE_ASSETS = [
    '/css/style.css',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHEABLE_ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Ignorar requisições externas
    if (url.origin !== self.location.origin) {
        return;
    }

    const isJS = url.pathname.endsWith('.js');
    const isHTML = url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.startsWith('/map') || url.pathname.startsWith('/index');
    const isSocketIO = url.pathname.startsWith('/socket.io');

    if (isJS || isHTML || isSocketIO) {
        // Network Only para JS e HTML — NUNCA do cache
        // Garante que mudanças de código aparecem imediatamente
        e.respondWith(fetch(e.request));
        return;
    }

    // Cache First para CSS, imagens, manifesto
    e.respondWith(
        caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
});
