/**
 * map.js – Lógica principal do mapa em tempo real
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

const markers = {};   // socketId -> L.marker
const routes = {};    // socketId -> L.polyline
const routePoints = {}; // socketId -> [[lat,lng], ...]

// ── Inicialização ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const username = sessionStorage.getItem('username');
    const avatar = sessionStorage.getItem('avatar');
    const action = sessionStorage.getItem('action');

    // Redirecionar se não logado
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
    }).setView([-15.7801, -47.9292], 13); // Brasil central

    // Tile escuro (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
    }).addTo(map);

    // Atribuição discreta
    L.control.attribution({ prefix: false }).addTo(map);
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
    socket.on('room_created', ({ code, user, users }) => {
        roomCode = code;
        myUser = user;
        onRoomReady(users);
        showToast('🎉 Sala criada com sucesso!', 'success');
    });

    // Entrou em sala
    socket.on('room_joined', ({ code, user, users }) => {
        roomCode = code;
        myUser = user;
        onRoomReady(users);
        showToast(`✅ Entrou na sala ${code}`, 'success');
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

    // Nova mensagem de chat
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
function onRoomReady(users) {
    document.getElementById('roomCodeDisplay').textContent = roomCode;
    document.title = `RealTrack – Sala ${roomCode}`;

    // Renderizar usuários existentes
    users.forEach(user => {
        addOrUpdateUserInList(user);
        if (user.location) {
            updateUserOnMap(user.socketId, user);
        }
    });

    updateUserCount();

    // Solicitar GPS
    showGPSModal();
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

    socket.emit('update_location', { lat, lng, accuracy, heading, speed });

    // Centralizar no primeiro fix
    if (!myUser?.location) {
        map.setView([lat, lng], 16);
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

    // Atualizar ou criar marcador
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

    // Atualizar rota
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
        // Centralizar em todos os usuários
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
