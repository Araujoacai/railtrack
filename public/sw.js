const CACHE_NAME = 'realtrack-v4';
// Apenas recursos locais no cache de instalação (muito mais seguro com CSP)
const ASSETS = [
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
    self.skipWaiting(); // Ativar imediatamente sem aguardar aba antiga fechar
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // addAll faz fetch de cada item; só colocamos locais para evitar CSP
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', (e) => {
    // Limpar caches antigos
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Ignorar requisições de origens externas (Google Fonts, Leaflet CDN, etc.)
    // Deixamos elas irem direto à rede, sem interceptar
    if (url.origin !== self.location.origin) {
        return; // Não chama e.respondWith() — deixa o browser lidar normalmente
    }

    // Apenas recursos locais: Cache first, fallback à rede
    e.respondWith(
        caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
});
