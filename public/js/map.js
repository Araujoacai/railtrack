
// Estado Global
let map, myUser, roomCode, isHost;
let mySocketId = null;
let markers = {}; // socketId -> Marker (Leaflet)
let routes = {}; // socketId -> Polyline
let routePoints = {}; // socketId -> [[lat,lng], ...]
let destination = null; // {lat, lng, name}
let navRouteLine = null; // Linha da rota OSRM
let destMarker = null;   // Marcador 🏁 do destino no mapa
let watchId = null;
let myLastLat = null, myLastLng = null;
let lastRouteCalc = 0;
let gpsGranted = false;
let wakeLock = null;
const socket = io();

// Overpass API (Radares e Pedágios)
let overpassEnabled = false;
let speedCamMarkers = [];
let tollMarkers = [];
let lastOverpassFetch = 0;

// Estado da UI
let panelOpen = false;
let settingDestByClick = false;

// Controle de Navegação
let isNavigating = false;

// ── SmartCamera Pro ────────────────────────────────
const SmartCamera = {
    mode: 'FREE',
    initialized: false,
    throttle: 0,
    lastPosition: null,
    lastPositionTime: 0,
    lastSpeed: 0,
    lastHeading: null,
    smoothedBearing: 0,  // bearing interpolado (evita saltos)
    _cameraMoving: false, // flag para ignorar eventos programáticos

    enable() {
        this.mode = 'FOLLOW';
        updateFollowButtonUI();
    },
    disable() {
        this.mode = 'FREE';
        updateFollowButtonUI();
        // Resetar rotação suavemente ao sair do follow
        resetMapBearing();
    },
    shouldFollow() {
        return this.mode === 'FOLLOW';
    }
};

// Interpola bearing pelo caminho mais curto (resolve wrap 0°/360°)
function interpolateBearing(current, target, alpha) {
    let delta = ((target - current + 540) % 360) - 180;
    return (current + delta * alpha + 360) % 360;
}

// Reseta o mapa para Norte suavemente
function resetMapBearing() {
    if (map && map.setBearing) {
        const steps = 10;
        let i = 0;
        const interval = setInterval(() => {
            i++;
            SmartCamera.smoothedBearing = interpolateBearing(SmartCamera.smoothedBearing, 0, 0.3);
            // Negativo: bearing do mapa é o inverso do heading
            map.setBearing(-SmartCamera.smoothedBearing);
            if (i >= steps || Math.abs(SmartCamera.smoothedBearing) < 0.5) {
                SmartCamera.smoothedBearing = 0;
                map.setBearing(0);
                clearInterval(interval);
            }
        }, 30);
    }
}

function getDynamicZoom(speed) {
    if (speed > 80) return 15;
    if (speed > 40) return 16;
    if (speed > 15) return 17;
    return 18;
}

function calculateSpeed(newPos, oldPos, dt) {
    if (!oldPos || dt <= 0) return 0;
    const dist = map.distance(oldPos, newPos);  // metros
    return (dist / dt) * 3.6;                   // km/h
}


// ── Service Worker ───────────────────────────────────────────
let swRegistration = null;

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.log('[SW] Registrado:', swRegistration.scope);

        // Ouvir mensagens vindas do SW
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type === 'STOP_GPS') {
                stopGPSTracking();
                showToast('⏹ GPS parado pelo usuário', 'info');
            }
        });
    } catch (err) {
        console.warn('[SW] Falha no registro:', err);
    }
}

function sendToSW(message) {
    if (swRegistration?.active) {
        swRegistration.active.postMessage(message);
    }
}

// ── Wake Lock + Background ────────────────────────────────────
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock ativo');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock solto');
            });
        }
    } catch (err) {
        console.log('Erro Wake Lock:', err.name, err.message);
    }
}

// ── Gerenciar Background / Foreground ────────────────────────
let backgroundKeepAlive = null;

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
        // App foi minimizado — iniciar background tracking
        if (gpsGranted) {
            // Pedir permissão de notificação se ainda não tiver
            if ('Notification' in window && Notification.permission === 'default') {
                await Notification.requestPermission();
            }
            // Avisar SW para mostrar notificação persistente
            sendToSW({ type: 'START_BACKGROUND', roomCode });

            // Keep-alive local: pinga o servidor a cada 10s em background
            backgroundKeepAlive = setInterval(() => {
                fetch('/api/keep-alive').catch(() => { });
            }, 10000);
        }
    } else {
        // App voltou ao foco — parar background tracking
        sendToSW({ type: 'STOP_BACKGROUND' });

        if (backgroundKeepAlive) {
            clearInterval(backgroundKeepAlive);
            backgroundKeepAlive = null;
        }

        // Renovar Wake Lock
        if (wakeLock !== null) {
            await requestWakeLock();
        }

        // Reconectar GPS se o watchPosition foi perdido em background
        if (gpsGranted && watchId === null) {
            console.log('[GPS] Reconectando watchPosition após background...');
            restartGPSWatch();
        }
    }
});

function stopGPSTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    gpsGranted = false;
    setGPSStatus('error', '📍 GPS parado');
}

function restartGPSWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
        onLocationSuccess,
        onLocationError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
}

// ── Mapa Leaflet ─────────────────────────────────────────────
function initMap() {
    map = L.map('map', {
        zoomControl: true,
        attributionControl: false,
        rotate: true,        // habilita suporte a bearing (leaflet-rotate)
        rotateControl: false,// sem botão de bússola padrão
    }).setView([-15.7801, -47.9292], 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
    }).addTo(map);

    L.control.attribution({ prefix: false }).addTo(map);

    // Clique no mapa para definir destino (apenas host)
    map.on('click', onMapClick);

    // Parar follow APENAS ao arrastar manualmente (não em movimentos programáticos)
    map.on('dragstart', () => {
        if (SmartCamera.shouldFollow()) SmartCamera.disable();
    });

    // Ajustar mapa quando redimensionar
    setTimeout(() => map.invalidateSize(), 500);

    // Inicializar controles de Overpass
    initOverpassControls();
}

function onMapClick(e) {
    if (!isHost || !settingDestByClick) return;

    settingDestByClick = false;
    document.getElementById('navHint').textContent = '';
    map.getContainer().style.cursor = '';

    const { lat, lng } = e.latlng;

    // Reverse Geocoding (Nominatim) para pegar nome da rua
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
        .then(res => res.json())
        .then(data => {
            const name = data.display_name ? data.display_name.split(',')[0] : 'Destino Selecionado';
            socket.emit('set_destination', { lat, lng, name });
        })
        .catch(() => {
            socket.emit('set_destination', { lat, lng, name: 'Destino no Mapa' });
        });
}

// ── Socket.IO ────────────────────────────────────────────────
function initSocket() {
    socket.on('connect', () => {
        mySocketId = socket.id;
        console.log('Conectado, ID:', mySocketId);

        // Ler (ou gerar) userId persistente
        const saved = JSON.parse(localStorage.getItem('realtrack_user') || '{}');
        const userId = saved.userId || crypto.randomUUID();
        if (!saved.userId) {
            localStorage.setItem('realtrack_user', JSON.stringify({ ...saved, userId }));
        }

        // ── PRIORIDADE 1: Reconexão dentro da mesma sessão de página ──
        // Se roomCode já está definido em memória, é uma reconexão (queda de WiFi, etc.)
        // → Rejoin na mesma sala sem criar uma nova!
        if (roomCode) {
            console.log('Reconexão: voltando para sala', roomCode);
            socket.emit('join_room', {
                code: roomCode,
                username: myUser?.username || saved.username || 'Usuário',
                avatar: myUser?.avatar || saved.avatar || '😊',
                userId,
            });
            return;
        }

        // ── PRIORIDADE 2: Auto-reconnect via localStorage (volta ao app/reload) ──
        const username = sessionStorage.getItem('username');
        const avatar = sessionStorage.getItem('avatar');
        const action = sessionStorage.getItem('action');
        const code = sessionStorage.getItem('roomCode');

        if (!username || !avatar) {
            // Sem sessão de login – tentar auto-reconnect via localStorage
            if (saved.lastRoom && (Date.now() - (saved.lastRoomTime || 0)) < 5 * 60 * 60 * 1000) {
                socket.emit('join_room', {
                    code: saved.lastRoom,
                    username: saved.username || 'Usuário',
                    avatar: saved.avatar || '😊',
                    userId,
                });
            } else {
                window.location.href = '/';
            }
            return;
        }

        // ── PRIORIDADE 3: Nova sessão vinda do login.js ──
        if (action === 'create') {
            socket.emit('create_room', { username, avatar, userId });
        } else if (action === 'join' && code) {
            socket.emit('join_room', { code, username, avatar, userId });
        }
    });

    // Sala criada
    socket.on('room_created', (data) => {
        roomCode = data.code;
        myUser = data.user;
        isHost = data.isHost;
        saveLastRoom(roomCode);
        onRoomReady(data.users, data.destination);
        showToast('🎉 Sala criada! Código: ' + data.code, 'success');
    });

    // Entrou em sala
    socket.on('room_joined', (data) => {
        roomCode = data.code;
        myUser = data.user;
        isHost = data.isHost;
        saveLastRoom(roomCode); // Persistir sala
        onRoomReady(data.users, data.destination);
        showToast(`✅ Entrou na sala ${data.code}`, 'success');
    });

    // ── Persistência ─────────────────────────────────────────────
    function saveLastRoom(code) {
        const STORAGE_KEY = 'realtrack_user';
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, lastRoom: code, lastRoomTime: Date.now() }));
    }

    // ── Keep-Alive (Ping periódico a cada 25s – mesmo intervalo do pingInterval do Socket.IO)
    setInterval(() => {
        fetch('/api/keep-alive').catch(() => { });
    }, 25000);

    // Novo usuário entrou
    socket.on('user_joined', ({ user }) => {
        addOrUpdateUserInList(user);
        showToast(`👋 ${user.username} entrou na sala`, 'info');
    });

    // Atualização de localização
    socket.on('location_update', ({ socketId, user }) => {
        updateUserOnMap(socketId, user);
        updateUserInList(socketId, user);
    });

    // Usuário saiu
    socket.on('user_left', ({ socketId, username }) => {
        removeUserFromMap(socketId);
        removeUserFromList(socketId);
        showToast(`👋 ${username} saiu da sala`, 'info');
    });

    // Destino definido
    socket.on('destination_set', (dest) => {
        destination = dest;
        showDestinationOnMap(dest);
        showToast(`📌 Destino definido: ${dest.name}`, 'success');

        // Calcular rota se temos localização
        if (myLastLat !== null) {
            calculateRoute(myLastLat, myLastLng, dest.lat, dest.lng);
        }
    });

    // Destino removido
    socket.on('destination_cleared', () => {
        clearDestinationUI();
        showToast('📌 Destino removido', 'info');
    });

    // Transferência de host
    socket.on('host_changed', (data) => {
        isHost = data.isHost;
        updateNavUI();
        showToast('👑 Você agora é o anfitrião da sala!', 'success');
    });

    // Chat
    socket.on('new_message', (msg) => {
        addChatMessage(msg);
    });

    // Erro
    socket.on('error', ({ message }) => {
        showToast(`❌ ${message}`, 'error');
        setTimeout(() => window.location.href = '/', 2000);
    });

    socket.on('disconnect', () => {
        showToast('⚠️ Conexão perdida. Reconectando...', 'error');
    });

    socket.on('reconnect', () => {
        showToast('✅ Reconectado!', 'success');
    });
}

// ── Sala pronta ──────────────────────────────────────────────
function onRoomReady(users, dest) {
    document.getElementById('roomCodeDisplay').textContent = roomCode;
    document.title = `RealTrack – Sala ${roomCode}`;

    users.forEach(user => {
        addOrUpdateUserInList(user);
        if (user.location) {
            updateUserOnMap(user.socketId, user);
        }
    });

    updateUserCount();
    updateNavUI();

    // Se já há destino definido, mostrar
    if (dest) {
        destination = dest;
        showDestinationOnMap(dest);
    }

    showGPSModal();
}

function updateNavUI() {
    const navSection = document.getElementById('navSection');
    if (isHost) {
        navSection.style.display = '';
    } else {
        navSection.style.display = 'none';
    }
}

// ── GPS ──────────────────────────────────────────────────────
function showGPSModal() {
    document.getElementById('gpsModal').classList.remove('hidden');
}

function requestGPS() {
    document.getElementById('gpsModal').classList.add('hidden');

    if (!navigator.geolocation) {
        setGPSStatus('error', '❌ GPS não suportado neste dispositivo');
        return;
    }

    setGPSStatus('waiting', '⏳ Aguardando GPS...');

    watchId = navigator.geolocation.watchPosition(
        onLocationSuccess,
        onLocationError,
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 3000,
        }
    );
}

function denyGPS() {
    document.getElementById('gpsModal').classList.add('hidden');
    setGPSStatus('error', '📍 GPS desativado – apenas visualizando');
    showToast('⚠️ Sem GPS: você pode ver outros, mas não será visto.', 'info');
}

function onLocationSuccess(pos) {
    gpsGranted = true;
    const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;

    setGPSStatus('active', `📡 GPS ativo · ±${Math.round(accuracy)}m`);

    myLastLat = lat;
    myLastLng = lng;

    socket.emit('update_location', { lat, lng, accuracy, heading, speed });

    // Primeiro GPS fix: centralizar e ativar SmartCamera
    if (!SmartCamera.initialized) {
        map.setView([lat, lng], 18);
        SmartCamera.initialized = true;
        SmartCamera.enable();
    }

    // Recalcular rota se há destino (a cada 10 segundos)
    if (destination && Date.now() - lastRouteCalc > 10000) {
        calculateRoute(lat, lng, destination.lat, destination.lng);
        if (!isNavigating && !settingDestByClick) {
            startNavigation();
        }
    }
}

function onLocationError(err) {
    const msgs = {
        1: '❌ Permissão de GPS negada',
        2: '❌ Posição indisponível',
        3: '⏱️ Timeout do GPS',
    };
    setGPSStatus('error', msgs[err.code] || '❌ Erro de GPS');
    showToast(`GPS: ${msgs[err.code]}`, 'error');
}

function setGPSStatus(state, text) {
    const dot = document.getElementById('gpsDot');
    const label = document.getElementById('gpsText');
    if (!dot || !label) return;

    dot.className = 'gps-dot';
    if (state === 'active') dot.classList.add('active');
    if (state === 'error') dot.classList.add('error');
    label.textContent = text;
}

// ── Controle de Navegação ────────────────────────────────────
function startNavigation() {
    isNavigating = true;
    SmartCamera.enable();

    if (myLastLat && myLastLng) {
        map.flyTo([myLastLat, myLastLng], getDynamicZoom(SmartCamera.lastSpeed), {
            animate: true, duration: 1.5
        });
    }
}

function stopNavigation() {
    isNavigating = false;
}

function updateFollowButtonUI() {
    const btn = document.querySelector('.fab-center');
    if (!btn) return;
    btn.classList.toggle('active', SmartCamera.shouldFollow());
}

// Botão 🎯: recentra e reativa follow
function centerMap() {
    if (!myLastLat || !myLastLng) { requestGPS(); return; }
    SmartCamera.enable();
    // Usar setView para não disparar animação que poderia interferir no follow
    map.setView([myLastLat, myLastLng], getDynamicZoom(SmartCamera.lastSpeed), {
        animate: true
    });
}

// ── Bússola (Device Orientation) ─────────────────────────────
window.addEventListener('deviceorientation', (event) => {
    if (event.alpha !== null && myUser && myUser.socketId) {
        // Alpha é a direção da bússola (0 = Norte)
        // Precisamos inverter e compensar para CSS rotate
        const heading = event.webkitCompassHeading || (360 - event.alpha);
        updateMyMarkerHeading(heading);
    }
});

function updateMyMarkerHeading(heading) {
    if (!mySocketId || !markers[mySocketId]) return;

    const marker = markers[mySocketId];
    const el = marker.getElement();
    if (el) {
        const markerDiv = el.querySelector('.user-marker');
        const emojiDiv = el.querySelector('.user-emoji');

        // Com o mapa já rotacionado para a direção do usuário (setBearing = -heading),
        // a seta deve sempre apontar para CIMA (0°) — o mapa cuida da direção.
        // O emoji contra-rotaciona pelo bearing atual do mapa para ficar ereto.
        const mapBearing = -SmartCamera.smoothedBearing; // o que foi passado para o setBearing
        if (markerDiv) markerDiv.style.transform = `rotate(0deg)`;
        if (emojiDiv) emojiDiv.style.transform = `rotate(${-mapBearing}deg)`;
    }
}

// ── OSRM Routing ─────────────────────────────────────────────
// ── Utilitários de Ícone ─────────────────────────────────────
function createUserIcon(avatar, color) {
    return L.divIcon({
        html: `<div class="user-marker" style="background-color: ${color}">
                 <div class="marker-arrow"></div>
                 <div class="user-emoji">${avatar}</div>
               </div>`,
        className: 'custom-marker-container',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
        popupAnchor: [0, -22]
    });
}

// ── Roteamento (OSRM) ────────────────────────────────────────
async function calculateRoute(fromLat, fromLng, toLat, toLng) {
    lastRouteCalc = Date.now();

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
            console.warn('OSRM: nenhuma rota encontrada');
            return;
        }

        const route = data.routes[0];
        const coords = route.geometry.coordinates.map(c => [c[1], c[0]]); // [lng,lat] -> [lat,lng]

        // Desenhar rota no mapa
        if (navRouteLine) map.removeLayer(navRouteLine);
        navRouteLine = L.polyline(coords, {
            color: '#00D9FF',
            weight: 5,
            opacity: 0.8,
            dashArray: '12, 8',
            lineCap: 'round',
        }).addTo(map);

        // Distância e duração
        const distKm = (route.distance / 1000).toFixed(1);
        const durMin = Math.ceil(route.duration / 60);
        const distEl = document.getElementById('destDistance');
        if (distEl) distEl.textContent = `${distKm} km · ~${durMin} min`;

        // Instruções turn-by-turn
        const steps = route.legs[0].steps;
        renderDirections(steps);

    } catch (err) {
        console.error('Erro ao calcular rota:', err);
    }
}

function renderDirections(steps) {
    const list = document.getElementById('directionsList');
    list.innerHTML = '';

    steps.forEach((step, i) => {
        const icon = getManeuverIcon(step.maneuver.type, step.maneuver.modifier);
        const text = translateInstruction(step);
        const dist = step.distance >= 1000
            ? `${(step.distance / 1000).toFixed(1)} km`
            : `${Math.round(step.distance)} m`;

        const div = document.createElement('div');
        div.className = `direction-step${i === 0 ? ' active' : ''}`;
        div.innerHTML = `
            <span class="step-icon">${icon}</span>
            <span class="step-text">${escapeHTML(text)}</span>
            <span class="step-dist">${dist}</span>
        `;
        list.appendChild(div);
    });
}

function getManeuverIcon(type, modifier) {
    const icons = {
        'depart': '🚩',
        'arrive': '🏁',
        'turn': modifier?.includes('left') ? '⬅️' : modifier?.includes('right') ? '➡️' : '↗️',
        'new name': '⬆️',
        'continue': '⬆️',
        'merge': '↗️',
        'on ramp': '↗️',
        'off ramp': '↘️',
        'fork': modifier?.includes('left') ? '↙️' : '↘️',
        'roundabout': '🔄',
        'rotary': '🔄',
        'roundabout turn': '🔄',
        'end of road': modifier?.includes('left') ? '⬅️' : '➡️',
    };
    return icons[type] || '⬆️';
}

function translateInstruction(step) {
    const name = step.name || '';
    const type = step.maneuver.type;
    const mod = step.maneuver.modifier || '';

    const modMap = {
        'left': 'à esquerda',
        'right': 'à direita',
        'slight left': 'levemente à esquerda',
        'slight right': 'levemente à direita',
        'sharp left': 'acentuadamente à esquerda',
        'sharp right': 'acentuadamente à direita',
        'straight': 'em frente',
        'uturn': 'retorno',
    };
    const modText = modMap[mod] || '';

    if (type === 'depart') return name ? `Siga por ${name}` : 'Inicie a viagem';
    if (type === 'arrive') return 'Você chegou ao destino!';
    if (type === 'roundabout' || type === 'rotary') return `Na rotatória, pegue a saída ${step.maneuver.exit}`;

    if (name) return `Vire ${modText} na ${name}`;
    return `Vire ${modText}`;
}

function showDestinationOnMap(dest) {
    const icon = L.divIcon({
        html: '<div style="font-size:32px">🏁</div>',
        className: '',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });

    // Remove marcador anterior se existir
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }

    destMarker = L.marker([dest.lat, dest.lng], { icon })
        .bindPopup(`<b>Chegada:</b> ${dest.name}`)
        .addTo(map);

    const destInfoEl = document.getElementById('destInfo');
    if (destInfoEl) destInfoEl.textContent = `📌 ${dest.name}`;

    const dirSection = document.getElementById('directionsSection');
    if (dirSection) dirSection.style.display = '';

    updateNavUI();
}

function clearDestinationUI() {
    destination = null;
    if (navRouteLine) { map.removeLayer(navRouteLine); navRouteLine = null; }
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }

    const dirSection = document.getElementById('directionsSection');
    if (dirSection) dirSection.style.display = 'none';

    const dirList = document.getElementById('directionsList');
    if (dirList) dirList.innerHTML = '';

    const destInfoEl = document.getElementById('destInfo');
    if (destInfoEl) destInfoEl.textContent = '';

    updateNavUI();
}

// ── Busca de Local (Nominatim) ───────────────────────────────
let searchTimeout;
function onSearchInput(e) {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (query.length < 3) return;

    searchTimeout = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`)
            .then(res => res.json())
            .then(showSearchResults);
    }, 800);
}

function showSearchResults(data) {
    const resultsEl = document.getElementById('searchResults');
    resultsEl.innerHTML = '';
    resultsEl.style.display = 'block';

    if (data.length === 0) {
        resultsEl.innerHTML = '<div class="nav-result-item">Nenhum resultado</div>';
        return;
    }

    data.slice(0, 5).forEach(item => {
        const div = document.createElement('div');
        div.className = 'nav-result-item';
        div.textContent = item.display_name.split(',').slice(0, 4).join(',');
        div.onclick = () => {
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);
            const name = item.display_name.split(',').slice(0, 3).join(',');
            socket.emit('set_destination', { lat, lng, name });
            resultsEl.style.display = 'none';
            document.getElementById('searchInput').value = '';
        };
        resultsEl.appendChild(div);
    });
}

// Chamada pelo botão de busca no HTML (id="destSearch")
async function searchDestination() {
    const input = document.getElementById('destSearch');
    const query = input ? input.value.trim() : '';
    if (!query) return;

    const resultsEl = document.getElementById('navResults');
    if (!resultsEl) return;

    resultsEl.style.display = '';
    resultsEl.innerHTML = '<div class="nav-result-item">🔍 Buscando...</div>';

    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=br`
        );
        const data = await res.json();

        if (!data.length) {
            resultsEl.innerHTML = '<div class="nav-result-item">❌ Nenhum resultado encontrado</div>';
            return;
        }

        resultsEl.innerHTML = '';
        data.forEach(item => {
            const div = document.createElement('div');
            div.className = 'nav-result-item';
            div.textContent = item.display_name.split(',').slice(0, 4).join(', ');
            div.onclick = () => {
                const lat = parseFloat(item.lat);
                const lng = parseFloat(item.lon);
                const name = item.display_name.split(',').slice(0, 3).join(', ');
                socket.emit('set_destination', { lat, lng, name });
                resultsEl.style.display = 'none';
                if (input) input.value = '';
            };
            resultsEl.appendChild(div);
        });
    } catch (err) {
        resultsEl.innerHTML = '<div class="nav-result-item">❌ Erro na busca</div>';
    }
}

function enableMapClick() {
    settingDestByClick = true;
    document.getElementById('navHint').textContent = '👆 Clique no mapa para definir o destino...';
    map.getContainer().style.cursor = 'crosshair';
}

function clearDestination() {
    socket.emit('clear_destination');
}

// ── Marcadores no Mapa ───────────────────────────────────────
function updateUserOnMap(socketId, user) {
    if (!user.location) return;
    const { lat, lng } = user.location;
    const isMe = socketId === mySocketId;

    if (markers[socketId]) {
        const marker = markers[socketId];
        const newLatLng = [lat, lng];

        // Atualizar posição (apenas uma vez)
        marker.setLatLng(newLatLng);

        // Atualizar rotação (Bússola) se disponível
        if (user.location.heading !== undefined) {
            const el = marker.getElement();
            if (el) {
                const markerDiv = el.querySelector('.user-marker');
                const emojiDiv = el.querySelector('.user-emoji');
                if (markerDiv) markerDiv.style.transform = `rotate(${user.location.heading}deg)`;
                // Manter emoji em pé se desejar, ou girar junto
                if (emojiDiv) emojiDiv.style.transform = `rotate(${-user.location.heading}deg)`;
            }
        }

        // Adicionar ponto na trilha
        if (!routes[socketId]) {
            routes[socketId] = L.polyline([], { color: user.color, weight: 4 }).addTo(map);
            routePoints[socketId] = [];
        }
        routePoints[socketId].push(newLatLng);
        routes[socketId].setLatLngs(routePoints[socketId]);

        // ── SmartCamera Pro: follow inteligente ─────────────────
        if (socketId === mySocketId && SmartCamera.shouldFollow()) {
            const now = Date.now();
            const dt = (now - SmartCamera.lastPositionTime) / 1000; // segundos

            // Converter para L.latLng para ter acesso a .lat/.lng
            const currentLatLng = L.latLng(lat, lng);

            const speed = calculateSpeed(currentLatLng, SmartCamera.lastPosition, dt);
            SmartCamera.lastSpeed = speed;

            // Heading: preferir dado do GPS/Mapa (movimento), fallback para bússola
            const gpsHeading = user.location?.heading;
            if (gpsHeading !== null && gpsHeading !== undefined && speed > 2) {
                SmartCamera.lastHeading = gpsHeading;
            }

            // Throttle adaptativo: + rápido = + frequente (não interrompe o follow, só limita a taxa)
            const throttleMs = speed > 60 ? 300 : speed > 20 ? 500 : 800;
            const shouldUpdateCamera = (now - SmartCamera.throttle) >= throttleMs;

            // Sempre atualiza a posição de referência
            SmartCamera.lastPosition = currentLatLng;
            SmartCamera.lastPositionTime = now;

            if (shouldUpdateCamera) {
                SmartCamera.throttle = now;

                // Look-ahead: adiantar o ponto-alvo na direção do movimento
                let target = currentLatLng;
                if (SmartCamera.lastHeading != null && speed > 2) {
                    const headingRad = (SmartCamera.lastHeading * Math.PI) / 180;
                    const lookAhead = speed * 0.000008; // escala proporcional à velocidade
                    target = L.latLng(
                        lat + Math.cos(headingRad) * lookAhead,
                        lng + Math.sin(headingRad) * lookAhead
                    );
                }

                // Sempre seguir o usuário (sem condição de getBounds)
                const targetZoom = getDynamicZoom(speed);
                const currentZoom = map.getZoom();

                if (Math.abs(targetZoom - currentZoom) >= 1) {
                    map.flyTo(target, targetZoom, { animate: true, duration: 0.6, easeLinearity: 0.25 });
                } else {
                    map.panTo(target, { animate: true, duration: 0.5, easeLinearity: 0.25 });
                }

                // Rotação suave do mapa baseada em heading
                // Só rotaciona se estiver em movimento (> 3 km/h) e heading válido
                if (map.setBearing && speed > 3 && SmartCamera.lastHeading != null) {
                    SmartCamera.smoothedBearing = interpolateBearing(
                        SmartCamera.smoothedBearing,
                        SmartCamera.lastHeading,
                        0.15
                    );
                    // NEGATIVO: leaflet-rotate setBearing(X) gira o mapa X° horário
                    // Para o heading ficar no TOPO, precisamos girar o mapa no sentido CONTRÁRIO
                    map.setBearing(-SmartCamera.smoothedBearing);
                }
            }
        }

    } else {
        // Criar novo marcador
        const icon = createUserIcon(user.avatar, user.color);
        const marker = L.marker([lat, lng], { icon })
            .bindPopup(`<b>${user.username}</b>`)
            .addTo(map);

        markers[socketId] = marker;

        // Inicializar trilha
        routePoints[socketId] = [[lat, lng]];
        routes[socketId] = L.polyline(routePoints[socketId], {
            color: user.color,
            weight: 4
        }).addTo(map);
    }
}

function removeUserFromMap(socketId) {
    if (markers[socketId]) {
        map.removeLayer(markers[socketId]);
        delete markers[socketId];
    }
    if (routes[socketId]) {
        map.removeLayer(routes[socketId]);
        delete routes[socketId];
        delete routePoints[socketId];
    }
}

// ── Lista de Usuários ────────────────────────────────────────
function addOrUpdateUserInList(user) {
    const existing = document.getElementById(`user-${user.socketId}`);
    if (existing) {
        updateUserInList(user.socketId, user);
        return;
    }

    const el = document.createElement('div');
    el.className = 'user-item';
    el.id = `user-${user.socketId}`;
    el.innerHTML = buildUserItemHTML(user);
    document.getElementById('usersList').appendChild(el);
    updateUserCount();
}

function updateUserInList(socketId, user) {
    const el = document.getElementById(`user-${socketId}`);
    if (el) el.innerHTML = buildUserItemHTML(user);
}

function buildUserItemHTML(user) {
    const isMe = user.socketId === mySocketId;
    const coords = user.location
        ? `${user.location.lat.toFixed(4)}, ${user.location.lng.toFixed(4)}`
        : 'Aguardando GPS...';

    return `
    <div class="user-avatar" style="border-color:${escapeHTML(user.color)}">${escapeHTML(user.avatar)}</div>
    <div class="user-info">
      <div class="user-name">${escapeHTML(user.username)}${isMe ? ' <small>(você)</small>' : ''}</div>
      <div class="user-coords">${escapeHTML(coords)}</div>
    </div>
    <div class="user-dot" style="background:${escapeHTML(user.color)};box-shadow:0 0 6px ${escapeHTML(user.color)}"></div>
  `;
}

function removeUserFromList(socketId) {
    const el = document.getElementById(`user-${socketId}`);
    if (el) el.remove();
    updateUserCount();
}

function updateUserCount() {
    const count = document.getElementById('usersList').children.length;
    document.getElementById('userCount').textContent = count;
}

// ── Chat ─────────────────────────────────────────────────────
function sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('send_message', { text });
    input.value = '';
}

function addChatMessage(msg) {
    const isOwn = msg.socketId === mySocketId;
    const container = document.getElementById('chatMessages');

    const el = document.createElement('div');
    el.className = `chat-msg${isOwn ? ' own' : ''}`;
    el.innerHTML = `
    <div class="chat-msg-avatar">${escapeHTML(msg.avatar)}</div>
    <div class="chat-msg-body">
      <div class="chat-msg-name" style="color:${escapeHTML(msg.color)}">${escapeHTML(msg.username)}</div>
      <div class="chat-msg-text">${escapeHTML(msg.text)}</div>
    </div>
  `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Controles UI ─────────────────────────────────────────────
function copyCode() {
    navigator.clipboard.writeText(roomCode).then(() => {
        const btn = document.getElementById('btnCopy');
        btn.textContent = '✅ Copiado!';
        setTimeout(() => btn.textContent = '📋 Copiar', 2000);
        showToast('📋 Código copiado!', 'success');
    });
}

function centerMap() {
    if (myLastLat && myLastLng) {
        startNavigation(); // Retoma o "Follow Me" com zoom alto
    } else {
        requestGPS();
    }
}

function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById('sidePanel');
    const fab = document.getElementById('fabPanel');
    const toggle = document.getElementById('panelToggle');

    panel.classList.toggle('collapsed', !panelOpen);
    fab.style.display = panelOpen ? 'none' : 'flex';
    toggle.textContent = panelOpen ? '◀' : '▶';
}

function leaveRoom() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    socket.disconnect();
    sessionStorage.clear();
    window.location.href = '/';
}

// ── Toast ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}

// ── Overpass: Radares e Pedágios ────────────────────────────
let loadedNodes = new Set();  // Cache de IDs de nós já carregados
let lastFetchParams = { center: null, zoom: 0 }; // Cache de parâmetros da última busca

function initOverpassControls() {
    const btn = document.getElementById('btnToggleTomTom');
    if (btn) {
        btn.onclick = toggleOverpass;
    }
}

async function fetchOverpassData() {
    lastOverpassFetch = Date.now();
    const zoom = map.getZoom();
    const center = map.getCenter();

    // 1. Verificar Zoom Mínimo (Aumentado para 13 para evitar timeouts em áreas muito grandes)
    if (zoom < 13) {
        // Se der zoom out demais, talvez limpar? Por enquanto mantemos para não piscar.
        return;
    }

    // 2. Cache de Requisição: Se moveu pouco (< 2km) e zoom é similar, não busca de novo
    if (lastFetchParams.center) {
        const dist = center.distanceTo(lastFetchParams.center); // em metros
        const zoomDiff = Math.abs(zoom - lastFetchParams.zoom);

        if (dist < 2000 && zoomDiff === 0) {
            return;
        }
    }

    // Atualizar cache de params
    lastFetchParams = { center, zoom };

    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    // Overpass bbox: south,west,north,east
    const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`;

    const query = `
        [out:json][timeout:90];
        (
          node["highway"="speed_camera"](${bbox});
          node["barrier"="toll_booth"](${bbox});
        );
        out body;
    `;

    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 95000);

        // Tentar endpoint principal
        try {
            const res = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                body: query,
                signal: controller.signal
            });
            clearTimeout(id);
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const data = await res.json();
            processOverpassData(data);
        } catch (e) {
            console.warn("Overpass Main failed, trying backup...", e.message);
            // Backup: Kumi Systems (apenas se falhar o principal)
            const resBackup = await fetch('https://overpass.kumi.systems/api/interpreter', {
                method: 'POST',
                body: query
            });
            if (!resBackup.ok) throw new Error(`Backup Status ${resBackup.status}`);
            const dataBackup = await resBackup.json();
            processOverpassData(dataBackup);
        }
    } catch (err) {
        console.warn('Overpass API error:', err.message);
    }
}

function processOverpassData(data) {
    if (!data.elements) return;

    let newCount = 0;
    data.elements.forEach(el => {
        // 3. Cache de Marcadores
        if (loadedNodes.has(el.id)) return;

        const lat = el.lat;
        const lng = el.lon;
        const tags = el.tags || {};

        let type = '';
        let iconHtml = '';
        let popupTitle = '';

        if (tags.highway === 'speed_camera') {
            type = 'radar';
            iconHtml = '<div class="tomtom-marker radar-marker">📷</div>';
            popupTitle = '📷 Radar de velocidade';
            if (tags.maxspeed) popupTitle += `<br>Limite: ${tags.maxspeed}`;
        } else if (tags.barrier === 'toll_booth') {
            type = 'toll';
            iconHtml = '<div class="tomtom-marker toll-marker">💰</div>';
            popupTitle = `💰 ${escapeHTML(tags.name || 'Pedágio')}`;
            if (tags.fee) popupTitle += `<br>Tarifa: ${tags.fee}`;
        }

        if (!type) return;

        const icon = L.divIcon({
            html: iconHtml,
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });

        const marker = L.marker([lat, lng], { icon })
            .addTo(map)
            .bindPopup(popupTitle, { className: 'dark-popup' });

        if (type === 'radar') speedCamMarkers.push(marker);
        else tollMarkers.push(marker);

        loadedNodes.add(el.id);
        newCount++;
    });
}

function clearOverpassMarkers() {
    speedCamMarkers.forEach(m => map.removeLayer(m));
    tollMarkers.forEach(m => map.removeLayer(m));
    speedCamMarkers = [];
    tollMarkers = [];
    loadedNodes.clear();
    lastFetchParams = { center: null, zoom: 0 };
}

function toggleOverpass() {
    overpassEnabled = !overpassEnabled;
    const btn = document.getElementById('btnToggleTomTom');
    if (btn) {
        btn.textContent = overpassEnabled ? '📷 Radares: ON' : '📷 Radares: OFF';
        btn.classList.toggle('active', overpassEnabled);
    }
    if (overpassEnabled) {
        fetchOverpassData();
    } else {
        clearOverpassMarkers();
    }
}

// ── Inicialização ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    initMap();
    initSocket();
    requestWakeLock();
});
