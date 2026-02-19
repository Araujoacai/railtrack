const CACHE_NAME = 'realtrack-v5';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/map.html',
    '/css/style.css',
    '/js/login.js',
    '/js/map.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/socket.io/socket.io.js'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
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

    // Ignorar requisições externas — deixar o browser lidar
    if (url.origin !== self.location.origin) {
        return;
    }

    const isJsOrHtml = url.pathname.endsWith('.js')
        || url.pathname.endsWith('.html')
        || url.pathname === '/'
        || url.pathname.startsWith('/map');

    if (isJsOrHtml) {
        // Network First para JS e HTML: sempre tenta a rede primeiro
        // Garante que atualizações de código apareçam imediatamente
        e.respondWith(
            fetch(e.request)
                .then((networkResp) => {
                    const clone = networkResp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    return networkResp;
                })
                .catch(() => caches.match(e.request)) // offline fallback
        );
    } else {
        // Cache First para CSS, imagens, etc.
        e.respondWith(
            caches.match(e.request).then((cached) => cached || fetch(e.request))
        );
    }
});
