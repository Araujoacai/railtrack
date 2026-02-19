/**
 * Servidor Principal - Sistema de Localização em Tempo Real
 * HTTPS via mkcert (certificados locais confiáveis)
 * Segurança: helmet, validação, rate-limiting, CORS restrito
 */

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const helmet = require('helmet');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const RoomManager = require('./roomManager');

const app = express();

// ── Ambiente ─────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── HTTPS (local) ou HTTP (produção – o provedor cuida do SSL)
let server;
if (isProduction) {
    server = http.createServer(app);
} else {
    const sslOptions = {
        key: fs.readFileSync(path.join(__dirname, '../key.pem')),
        cert: fs.readFileSync(path.join(__dirname, '../cert.pem')),
    };
    server = https.createServer(sslOptions, app);
}

const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGIN },
    pingTimeout: 60000,
    pingInterval: 25000,
});

const roomManager = new RoomManager();

// ── Helmet – headers de segurança HTTP ───────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "https://*.basemaps.cartocdn.com", "data:"],
            connectSrc: ["'self'", "wss:", "ws:", "https://router.project-osrm.org", "https://nominatim.openstreetmap.org"],
        },
    },
}));

// ── Helpers de validação ─────────────────────────────────────
function sanitizeString(str, maxLen = 20) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>"'&\/\\]/g, '').trim().substring(0, maxLen);
}

function isValidEmoji(str) {
    if (typeof str !== 'string') return false;
    // Aceitar apenas emojis comuns (1–4 chars unicode)
    return str.length <= 4 && str.length >= 1 && !/[<>"'&\/\\]/.test(str);
}

function isValidCoord(lat, lng) {
    return typeof lat === 'number' && typeof lng === 'number'
        && isFinite(lat) && isFinite(lng)
        && lat >= -90 && lat <= 90
        && lng >= -180 && lng <= 180;
}

function isValidRoomCode(code) {
    return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

// ── Rate Limiter simples por socket ──────────────────────────
const rateLimiters = new Map();

function checkRateLimit(socketId, action, maxPerMinute) {
    const key = `${socketId}:${action}`;
    const now = Date.now();
    if (!rateLimiters.has(key)) {
        rateLimiters.set(key, []);
    }
    const timestamps = rateLimiters.get(key);
    // Remover entradas com mais de 60s
    while (timestamps.length > 0 && now - timestamps[0] > 60000) {
        timestamps.shift();
    }
    if (timestamps.length >= maxPerMinute) {
        return false; // Rate limit excedido
    }
    timestamps.push(now);
    return true;
}

// Limpar rate limiters de sockets desconectados periodicamente
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimiters) {
        while (timestamps.length > 0 && now - timestamps[0] > 60000) {
            timestamps.shift();
        }
        if (timestamps.length === 0) rateLimiters.delete(key);
    }
}, 60000);

// ── Detectar IP local ────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// ── Servir arquivos estáticos ────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/map', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/map.html'));
});

// API: verificar se sala existe
app.get('/api/room/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!isValidRoomCode(code)) {
        return res.json({ exists: false });
    }
    res.json({ exists: roomManager.roomExists(code) });
});

// API: estatísticas (protegida – apenas em dev)
app.get('/api/stats', (req, res) => {
    if (isProduction) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    res.json(roomManager.getRoomStats());
});

// =====================
// Socket.IO Events
// =====================

io.on('connection', (socket) => {
    console.log(`[+] Conectado: ${socket.id}`);

    // ── Criar sala ──────────────────────────────────────────
    socket.on('create_room', ({ username, avatar }) => {
        try {
            // Impedir múltiplas salas
            if (socket.data.roomCode) {
                socket.emit('error', { message: 'Você já está em uma sala.' });
                return;
            }

            // Rate limit: 3 criações por minuto
            if (!checkRateLimit(socket.id, 'create', 3)) {
                socket.emit('error', { message: 'Muitas tentativas. Aguarde um momento.' });
                return;
            }

            // Validar inputs
            const cleanName = sanitizeString(username, 20);
            if (!cleanName) {
                socket.emit('error', { message: 'Nome inválido.' });
                return;
            }
            if (!isValidEmoji(avatar)) {
                socket.emit('error', { message: 'Avatar inválido.' });
                return;
            }

            const code = roomManager.createRoom();
            if (!code) {
                socket.emit('error', { message: 'Limite de salas atingido. Tente mais tarde.' });
                return;
            }

            const user = roomManager.addUser(code, socket.id, cleanName, avatar);
            socket.join(code);
            socket.data.roomCode = code;

            socket.emit('room_created', {
                code,
                user: serializeUser(user),
                users: roomManager.getUsers(code).map(serializeUser),
                isHost: true,
                destination: null,
            });

            console.log(`[SALA] ${cleanName} criou sala ${code}`);
        } catch (err) {
            socket.emit('error', { message: 'Erro ao criar sala.' });
        }
    });

    // ── Entrar em sala ──────────────────────────────────────
    socket.on('join_room', ({ code, username, avatar }) => {
        // Impedir múltiplas salas
        if (socket.data.roomCode) {
            socket.emit('error', { message: 'Você já está em uma sala.' });
            return;
        }

        // Rate limit
        if (!checkRateLimit(socket.id, 'join', 5)) {
            socket.emit('error', { message: 'Muitas tentativas. Aguarde um momento.' });
            return;
        }

        // Validar code
        if (typeof code !== 'string') {
            socket.emit('error', { message: 'Código inválido.' });
            return;
        }
        const upperCode = code.toUpperCase();
        if (!isValidRoomCode(upperCode)) {
            socket.emit('error', { message: 'Código da sala inválido.' });
            return;
        }

        if (!roomManager.roomExists(upperCode)) {
            socket.emit('error', { message: 'Sala não encontrada. Verifique o código.' });
            return;
        }

        // Validar inputs
        const cleanName = sanitizeString(username, 20);
        if (!cleanName) {
            socket.emit('error', { message: 'Nome inválido.' });
            return;
        }
        if (!isValidEmoji(avatar)) {
            socket.emit('error', { message: 'Avatar inválido.' });
            return;
        }

        const user = roomManager.addUser(upperCode, socket.id, cleanName, avatar);
        if (!user) {
            socket.emit('error', { message: 'Sala cheia (máximo 15 usuários).' });
            return;
        }

        socket.join(upperCode);
        socket.data.roomCode = upperCode;

        const currentUsers = roomManager.getUsers(upperCode).map(serializeUser);
        const destination = roomManager.getDestination(upperCode);
        const isHost = roomManager.isHost(upperCode, socket.id);
        socket.emit('room_joined', {
            code: upperCode,
            user: serializeUser(user),
            users: currentUsers,
            isHost,
            destination,
        });

        socket.to(upperCode).emit('user_joined', {
            user: serializeUser(user),
        });

        console.log(`[SALA] ${cleanName} entrou na sala ${upperCode}`);
    });

    // ── Atualizar localização ───────────────────────────────
    socket.on('update_location', ({ lat, lng, accuracy, heading, speed }) => {
        const code = socket.data.roomCode;
        if (!code) return;

        // Rate limit: 60 updates por minuto (1/s)
        if (!checkRateLimit(socket.id, 'location', 60)) return;

        // Validar coordenadas
        if (!isValidCoord(lat, lng)) return;

        // Validar accuracy, heading, speed (opcionais)
        const safeAccuracy = typeof accuracy === 'number' && isFinite(accuracy) ? accuracy : null;
        const safeHeading = typeof heading === 'number' && isFinite(heading) ? heading : null;
        const safeSpeed = typeof speed === 'number' && isFinite(speed) ? speed : null;

        const user = roomManager.updateLocation(code, socket.id, lat, lng, safeAccuracy, safeHeading, safeSpeed);
        if (!user) return;

        io.to(code).emit('location_update', {
            socketId: socket.id,
            user: serializeUser(user),
        });
    });

    // ── Desconexão ──────────────────────────────────────────
    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        if (!code) return;

        // Limpar rate limiters do socket
        for (const [key] of rateLimiters) {
            if (key.startsWith(socket.id)) rateLimiters.delete(key);
        }

        const user = roomManager.removeUser(code, socket.id);
        if (user) {
            // Notificar novo host se houve transferência
            const newHost = roomManager.getHost(code);
            if (newHost) {
                io.to(newHost).emit('host_changed', { isHost: true });
            }

            io.to(code).emit('user_left', {
                socketId: socket.id,
                username: user.username,
            });
            console.log(`[-] ${user.username} saiu da sala ${code}`);
        }
    });

    // ── Mensagem de chat ────────────────────────────────────
    socket.on('send_message', ({ text }) => {
        const code = socket.data.roomCode;
        if (!code) return;
        if (typeof text !== 'string' || !text.trim()) return;

        // Rate limit: 30 mensagens por minuto
        if (!checkRateLimit(socket.id, 'message', 30)) {
            socket.emit('error', { message: 'Enviando mensagens rápido demais!' });
            return;
        }

        const result = roomManager.getUserBySocket(socket.id);
        if (!result) return;

        const cleanText = text.trim().substring(0, 300);

        io.to(code).emit('new_message', {
            socketId: socket.id,
            username: result.user.username,
            color: result.user.color,
            avatar: result.user.avatar,
            text: cleanText,
            timestamp: Date.now(),
        });
    });

    // ── Definir destino (apenas host) ────────────────────────
    socket.on('set_destination', ({ lat, lng, name }) => {
        const code = socket.data.roomCode;
        if (!code) return;

        // Rate limit
        if (!checkRateLimit(socket.id, 'destination', 10)) return;

        // Validar
        if (!isValidCoord(lat, lng)) {
            socket.emit('error', { message: 'Coordenadas de destino inválidas.' });
            return;
        }

        const cleanName = typeof name === 'string' ? name.replace(/[<>"'&\/\\]/g, '').trim().substring(0, 100) : 'Destino';

        const success = roomManager.setDestination(code, socket.id, { lat, lng, name: cleanName });
        if (!success) {
            socket.emit('error', { message: 'Apenas o anfitrião pode definir o destino.' });
            return;
        }

        // Broadcast para toda a sala
        io.to(code).emit('destination_set', { lat, lng, name: cleanName });
        console.log(`[NAV] Destino definido na sala ${code}: ${cleanName} (${lat}, ${lng})`);
    });

    // ── Limpar destino (apenas host) ─────────────────────────
    socket.on('clear_destination', () => {
        const code = socket.data.roomCode;
        if (!code) return;

        const success = roomManager.setDestination(code, socket.id, null);
        if (!success) return;

        io.to(code).emit('destination_cleared');
        console.log(`[NAV] Destino removido na sala ${code}`);
    });
});

// ── Helpers ─────────────────────────────────────────────────
function serializeUser(user) {
    return {
        socketId: user.socketId,
        username: user.username,
        avatar: user.avatar,
        color: user.color,
        location: user.location,
        route: user.route,
        online: user.online,
    };
}

// ── Iniciar servidor ─────────────────────────────────────────
server.listen(PORT, () => {
    const localIP = getLocalIP();
    const protocol = isProduction ? 'http' : 'https';
    console.log(`\n🗺️  Servidor ${protocol.toUpperCase()} (${isProduction ? 'produção' : 'mkcert'}): ${protocol}://localhost:${PORT}`);
    console.log(`📡 Socket.IO ativo`);
    console.log(`🔒 Helmet ativo | CORS: ${ALLOWED_ORIGIN}`);
    console.log(`\n💡 No PC use: ${protocol}://localhost:${PORT}`);
    if (!isProduction) {
        console.log(`📱 No celular (mesma rede Wi-Fi): ${protocol}://${localIP}:${PORT}`);
        console.log(`\n⚠️  Para o celular confiar no certificado, instale a CA raiz nele.`);
        console.log(`   Execute: .\\mkcert.exe -CAROOT para ver o caminho da CA\n`);
    }
});

