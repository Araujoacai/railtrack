// SW v8: Bump de cache para forçar atualização do style.css (tema claro)
const CACHE_NAME = 'realtrack-v8';
const CACHEABLE_ASSETS = [
    '/css/style.css',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

// ── Instalar ──────────────────────────────────────────────────
self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHEABLE_ASSETS))
    );
});

// ── Ativar ────────────────────────────────────────────────────
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// ── Fetch Strategy ────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;

    const isJS = url.pathname.endsWith('.js');
    const isHTML = url.pathname.endsWith('.html') || url.pathname === '/'
        || url.pathname.startsWith('/map') || url.pathname.startsWith('/index');
    const isSocketIO = url.pathname.startsWith('/socket.io');
    const isKeepAlive = url.pathname === '/api/keep-alive';

    if (isJS || isHTML || isSocketIO || isKeepAlive) {
        e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
        return;
    }

    // Cache First para CSS, imagens, manifesto
    e.respondWith(
        caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
});

// ── Notificação Persistente de Background ─────────────────────
// Disparada pelo app quando GPS está ativo e página vai para background
self.addEventListener('message', (e) => {
    if (e.data?.type === 'START_BACKGROUND') {
        startBackgroundTracking(e.data.roomCode);
    }
    if (e.data?.type === 'STOP_BACKGROUND') {
        stopBackgroundTracking();
    }
    // Keep SW alive: responder pings da página
    if (e.data?.type === 'PING') {
        e.source?.postMessage({ type: 'PONG' });
    }
});

let keepAliveTimer = null;
let notificationShown = false;

async function startBackgroundTracking(roomCode) {
    if (notificationShown) return;

    const permission = await self.registration.showNotification('📍 RealTrack – GPS Ativo', {
        body: `Compartilhando localização na sala ${roomCode || ''}. Toque para voltar.`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'realtrack-gps',          // sobrescreve a mesma notificação
        renotify: false,
        silent: true,                   // sem som
        requireInteraction: true,       // não some sozinha
        actions: [
            { action: 'open', title: '📍 Abrir mapa' },
            { action: 'stop', title: '⏹ Parar GPS' }
        ]
    });

    notificationShown = true;

    // Keep-alive: pinga o servidor a cada 25s para manter a conexão Socket.IO
    keepAliveTimer = setInterval(() => {
        fetch('/api/keep-alive').catch(() => { });
    }, 25000);
}

function stopBackgroundTracking() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    self.registration.getNotifications({ tag: 'realtrack-gps' })
        .then(notifications => notifications.forEach(n => n.close()));
    notificationShown = false;
}

// ── Clique na notificação ─────────────────────────────────────
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    notificationShown = false;

    if (e.action === 'stop') {
        stopBackgroundTracking();
        // Notifica as abas para parar o GPS
        self.clients.matchAll({ type: 'window' }).then(clients => {
            clients.forEach(c => c.postMessage({ type: 'STOP_GPS' }));
        });
        return;
    }

    // Ação 'open' ou clique direto: foca a aba do mapa
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const mapClient = clients.find(c => c.url.includes('/map'));
            if (mapClient) return mapClient.focus();
            return self.clients.openWindow('/map.html');
        })
    );
});

// ── Fechar notificação se fechada manualmente ─────────────────
self.addEventListener('notificationclose', (e) => {
    if (e.notification.tag === 'realtrack-gps') {
        notificationShown = false;
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    }
});
