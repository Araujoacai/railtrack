const CACHE_NAME = 'realtrack-v3-trigger';
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
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.socket.io/4.7.2/socket.io.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});
