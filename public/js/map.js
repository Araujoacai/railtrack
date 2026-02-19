/**
 * map.js – Lógica principal do mapa em tempo real + Navegação
 */

// ── Estado Global ────────────────────────────────────────────
let map;
let socket;
let mySocketId;
let myUser;
let roomCode;
let watchId = null;
let gpsGranted = false;
let panelOpen = true;
let isHost = false;
let initialCenterDone = false;  // Centraliza apenas uma vez

const markers = {};   // socketId -> L.marker
const routes = {};    // socketId -> L.polyline (trilha percorrida)
const routePoints = {}; // socketId -> [[lat,lng], ...]

// ── Navegação ────────────────────────────────────────────────
let destination = null;       // { lat, lng, name }
let destMarker = null;        // L.marker do destino
let navRouteLine = null;      // L.polyline da rota de navegação
let navSteps = [];            // Instruções turn-by-turn
let lastRouteCalc = 0;        // Timestamp do último cálculo
let myLastLat = null;
let myLastLng = null;
let settingDestByClick = false; // Modo de clique no mapa

// ── TomTom – Radares e Pedágios ─────────────────────────────
const TOMTOM_KEY = 'nT07nUrsd6LfTWCGpzu31k6OyBK9nQoh';
let tomtomEnabled = true;
let speedCamMarkers = [];     // Array de L.marker para radares
let tollMarkers = [];         // Array de L.marker para pedágios
let lastTomtomFetch = 0;      // Debounce

// ── Inicialização ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const username = sessionStorage.getItem('username');
    const avatar = sessionStorage.getItem('avatar');
    const action = sessionStorage.getItem('action');

    if (!username || !action) {
        window.location.href = '/';
        return;
    }

    initMap();
    initSocket(username, avatar, action);
});

// ── Mapa Leaflet ─────────────────────────────────────────────
function initMap() {
    map = L.map('map', {
        zoomControl: true,
        attributionControl: false,
    }).setView([-15.7801, -47.9292], 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
    }).addTo(map);

    L.control.attribution({ prefix: false }).addTo(map);

    // Clique no mapa para definir destino (apenas host)
    map.on('click', onMapClick);

    // Buscar radares/pedágios ao mover o mapa
    map.on('moveend', onMapMoveEnd);
}

function onMapMoveEnd() {
    if (!tomtomEnabled) return;
    if (Date.now() - lastTomtomFetch < 5000) return; // Debounce 5s
    fetchTomTomData();
}

function onMapClick(e) {
    if (!isHost) return;
    if (!settingDestByClick) return;

    const { lat, lng } = e.latlng;

    // Geocoding reverso para obter o nome do local
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`)
        .then(r => r.json())
        .then(data => {
            const name = data.display_name ? data.display_name.split(',').slice(0, 3).join(',') : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            socket.emit('set_destination', { lat, lng, name });
        })
        .catch(() => {
            socket.emit('set_destination', { lat, lng, name: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
        });

    settingDestByClick = false;
    document.getElementById('navHint').textContent = 'Ou clique no mapa para definir o destino.';
    map.getContainer().style.cursor = '';
}

// ── Socket.IO ────────────────────────────────────────────────
function initSocket(username, avatar, action) {
    socket = io();

    socket.on('connect', () => {
        mySocketId = socket.id;

        if (action === 'create') {
            socket.emit('create_room', { username, avatar });
        } else {
            const code = sessionStorage.getItem('roomCode');
            socket.emit('join_room', { code, username, avatar });
        }
    });

    // Sala criada
    socket.on('room_created', (data) => {
        roomCode = data.code;
        myUser = data.user;
        isHost = data.isHost;
        onRoomReady(data.users, data.destination);
        showToast('🎉 Sala criada com sucesso!', 'success');
    });

    // Entrou em sala
    socket.on('room_joined', (data) => {
        roomCode = data.code;
        myUser = data.user;
        isHost = data.isHost;
        onRoomReady(data.users, data.destination);
        showToast(`✅ Entrou na sala ${data.code}`, 'success');
    });

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

    // Centralizar apenas no primeiro fix de GPS
    if (!initialCenterDone) {
        map.setView([lat, lng], 16);
        initialCenterDone = true;
    }

    // Recalcular rota se há destino (a cada 10 segundos)
    if (destination && Date.now() - lastRouteCalc > 10000) {
        calculateRoute(lat, lng, destination.lat, destination.lng);
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
    dot.className = 'gps-dot';
    if (state === 'active') dot.classList.add('active');
    if (state === 'error') dot.classList.add('error');
    label.textContent = text;
}

// ── Navegação: Destino no Mapa ───────────────────────────────
function showDestinationOnMap(dest) {
    // Remover marcador antigo
    if (destMarker) map.removeLayer(destMarker);

    const icon = L.divIcon({
        html: '<div class="dest-marker-icon">📍</div>',
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
    });

    destMarker = L.marker([dest.lat, dest.lng], { icon })
        .addTo(map)
        .bindPopup(`<b>🎯 Destino</b><br>${escapeHTML(dest.name)}`, { className: 'dark-popup' });

    // Mostrar painel de direções
    document.getElementById('directionsSection').style.display = '';
    document.getElementById('destInfo').innerHTML = `
        <span>📍</span>
        <span class="dest-name">${escapeHTML(dest.name)}</span>
        <span class="dest-distance" id="destDistance">Calculando...</span>
    `;

    // Botão remover (host only)
    if (isHost) {
        document.getElementById('btnClearDest').style.display = '';
        document.getElementById('navHint').style.display = 'none';
    }
}

function clearDestinationUI() {
    destination = null;
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    if (navRouteLine) { map.removeLayer(navRouteLine); navRouteLine = null; }
    navSteps = [];

    document.getElementById('directionsSection').style.display = 'none';
    document.getElementById('directionsList').innerHTML = '';
    document.getElementById('destInfo').innerHTML = '';

    if (isHost) {
        document.getElementById('btnClearDest').style.display = 'none';
        document.getElementById('navHint').style.display = '';
    }
}

// ── Navegação: OSRM Routing ─────────────────────────────────
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
    if (type === 'turn' || type === 'end of road') return name ? `Vire ${modText} em ${name}` : `Vire ${modText}`;
    if (type === 'new name' || type === 'continue') return name ? `Continue por ${name}` : `Continue ${modText}`;
    if (type === 'merge') return name ? `Entre em ${name}` : 'Mescle à via';
    if (type === 'roundabout' || type === 'rotary') return name ? `Na rotatória, saia em ${name}` : 'Siga pela rotatória';
    if (type === 'fork') return name ? `Pegue ${modText} em ${name}` : `Pegue ${modText}`;
    if (type === 'on ramp') return name ? `Pegue a rampa para ${name}` : 'Pegue a rampa';
    if (type === 'off ramp') return name ? `Saia pela rampa em ${name}` : 'Saia pela rampa';

    return name ? `Siga por ${name}` : `Siga ${modText}`;
}

// ── Navegação: Busca de Endereço (Nominatim) ─────────────────
async function searchDestination() {
    const input = document.getElementById('destSearch');
    const query = input.value.trim();
    if (!query) return;

    const resultsEl = document.getElementById('navResults');
    resultsEl.style.display = '';
    resultsEl.innerHTML = '<div class="nav-result-item">🔍 Buscando...</div>';

    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=br`);
        const data = await res.json();

        if (!data.length) {
            resultsEl.innerHTML = '<div class="nav-result-item">❌ Nenhum resultado</div>';
            return;
        }

        resultsEl.innerHTML = '';
        data.forEach(item => {
            const div = document.createElement('div');
            div.className = 'nav-result-item';
            div.textContent = item.display_name.split(',').slice(0, 4).join(',');
            div.onclick = () => {
                const lat = parseFloat(item.lat);
                const lng = parseFloat(item.lon);
                const name = item.display_name.split(',').slice(0, 3).join(',');
                socket.emit('set_destination', { lat, lng, name });
                resultsEl.style.display = 'none';
                input.value = '';
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
function createMarkerIcon(user) {
    const isMe = user.socketId === mySocketId;
    const div = document.createElement('div');
    div.className = `custom-marker${isMe ? ' my-marker' : ''}`;
    div.style.borderColor = user.color;
    div.style.color = user.color;
    div.style.boxShadow = `0 0 15px ${user.color}66`;
    div.textContent = user.avatar;
    return L.divIcon({
        html: div.outerHTML,
        className: '',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
        popupAnchor: [0, -26],
    });
}

function updateUserOnMap(socketId, user) {
    if (!user.location) return;
    const { lat, lng } = user.location;
    const isMe = socketId === mySocketId;

    if (markers[socketId]) {
        markers[socketId].setLatLng([lat, lng]);
        markers[socketId].setIcon(createMarkerIcon(user));
    } else {
        const marker = L.marker([lat, lng], { icon: createMarkerIcon(user) })
            .addTo(map)
            .bindPopup(`<b>${escapeHTML(user.avatar)} ${escapeHTML(user.username)}</b>${isMe ? ' (você)' : ''}`, {
                className: 'dark-popup',
            });
        markers[socketId] = marker;
    }

    // Trilha percorrida
    if (!routePoints[socketId]) routePoints[socketId] = [];
    routePoints[socketId].push([lat, lng]);

    if (routes[socketId]) {
        routes[socketId].setLatLngs(routePoints[socketId]);
    } else {
        routes[socketId] = L.polyline(routePoints[socketId], {
            color: user.color,
            weight: isMe ? 4 : 3,
            opacity: isMe ? 0.9 : 0.6,
            smoothFactor: 1,
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
    const myMarker = markers[mySocketId];
    if (myMarker) {
        map.setView(myMarker.getLatLng(), 16, { animate: true });
    } else {
        const allMarkers = Object.values(markers);
        if (allMarkers.length > 0) {
            const group = L.featureGroup(allMarkers);
            map.fitBounds(group.getBounds().pad(0.2));
        } else {
            showToast('📍 Nenhuma localização disponível ainda', 'info');
        }
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

// ── TomTom: Radares e Pedágios ──────────────────────────────
async function fetchTomTomData() {
    lastTomtomFetch = Date.now();
    const bounds = map.getBounds();
    const zoom = map.getZoom();

    // Só buscar se zoom >= 11 (evitar muitas chamadas em zoom longe)
    if (zoom < 11) {
        clearTomTomMarkers();
        return;
    }

    await Promise.all([
        fetchSpeedCameras(bounds),
        fetchTollBooths(bounds),
    ]);
}

async function fetchSpeedCameras(bounds) {
    try {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

        const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;

        const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${TOMTOM_KEY}&bbox=${bbox}&categoryFilter=14&language=pt-BR`;

        const res = await fetch(url);
        if (!res.ok) {
            console.warn("TomTom error:", res.status);
            return;
        }

        const data = await res.json();

        speedCamMarkers.forEach(m => map.removeLayer(m));
        speedCamMarkers = [];

        if (!data.incidents) return;

        data.incidents.forEach(incident => {
            if (!incident.geometry?.coordinates) return;

            const [lng, lat] = incident.geometry.coordinates;

            if (!isFinite(lat) || !isFinite(lng)) return;

            const icon = L.divIcon({
                html: '<div class="tomtom-marker radar-marker">📷</div>',
                className: '',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });

            const marker = L.marker([lat, lng], { icon })
                .addTo(map)
                .bindPopup('<b>📷 Radar de velocidade</b>', { className: 'dark-popup' });

            speedCamMarkers.push(marker);
        });

    } catch (err) {
        console.warn('TomTom Speed Cameras:', err.message);
    }
}

async function fetchTollBooths(bounds) {
    try {
        const center = bounds.getCenter();
        // Calcular raio em metros baseado no bounds
        const radius = Math.min(Math.round(center.distanceTo(bounds.getNorthEast())), 50000);

        const url = `https://api.tomtom.com/search/2/categorySearch/toll.json?key=${TOMTOM_KEY}&lat=${center.lat}&lon=${center.lng}&radius=${radius}&limit=50&language=pt-BR`;

        const res = await fetch(url);
        const data = await res.json();

        // Limpar marcadores antigos de pedágio
        tollMarkers.forEach(m => map.removeLayer(m));
        tollMarkers = [];

        if (!data.results) return;

        data.results.forEach(result => {
            const { lat, lon: lng } = result.position;

            const icon = L.divIcon({
                html: '<div class="tomtom-marker toll-marker">💰</div>',
                className: '',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });

            const name = result.poi?.name || 'Pedágio';
            const addr = result.address?.freeformAddress || '';

            const marker = L.marker([lat, lng], { icon })
                .addTo(map)
                .bindPopup(`<b>💰 ${escapeHTML(name)}</b>${addr ? '<br>' + escapeHTML(addr) : ''}`, { className: 'dark-popup' });

            tollMarkers.push(marker);
        });
    } catch (err) {
        console.warn('TomTom Toll Booths:', err.message);
    }
}

function clearTomTomMarkers() {
    speedCamMarkers.forEach(m => map.removeLayer(m));
    tollMarkers.forEach(m => map.removeLayer(m));
    speedCamMarkers = [];
    tollMarkers = [];
}

function toggleTomTom() {
    tomtomEnabled = !tomtomEnabled;
    const btn = document.getElementById('btnToggleTomTom');
    if (btn) {
        btn.textContent = tomtomEnabled ? '📷 Radares: ON' : '📷 Radares: OFF';
        btn.classList.toggle('active', tomtomEnabled);
    }
    if (tomtomEnabled) {
        fetchTomTomData();
    } else {
        clearTomTomMarkers();
    }
}
