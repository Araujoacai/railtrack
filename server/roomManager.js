/**
 * Gerenciador de Salas - Sistema de Localização em Tempo Real
 */

const COLORS = [
    '#00D9FF', // Ciano
    '#B24BF3', // Roxo
    '#FF6B6B', // Vermelho
    '#4ECDC4', // Verde água
    '#FFE66D', // Amarelo
    '#FF6F91', // Rosa
    '#06FFA5', // Verde neon
    '#FF9A3C', // Laranja
    '#A8FF3E', // Lima
    '#FF3CAC', // Magenta
];

const MAX_ROOMS = 10;
const MAX_USERS_PER_ROOM = 15;

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomCode -> { users: Map, createdAt, lastActivity }

        // Limpeza de salas inativas a cada minuto
        setInterval(() => this.cleanupRooms(), 60 * 1000);
    }

    // ... (rest of constructor/methods) ...

    cleanupRooms() {
        const now = Date.now();
        const MAX_INACTIVE_TIME = 5 * 60 * 60 * 1000; // 5 horas

        for (const [code, room] of this.rooms) {
            // Se a sala está vazia E inativa há muito tempo
            if (room.users.size === 0 && (now - room.lastActivity > MAX_INACTIVE_TIME)) {
                this.rooms.delete(code);
                console.log(`Sala ${code} removida por inatividade.`);
            }
        }
    }

    generateCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code;
        do {
            code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        } while (this.rooms.has(code));
        return code;
    }

    createRoom() {
        if (this.rooms.size >= MAX_ROOMS) {
            // Tentar limpar antes de negar
            this.cleanupRooms();
            if (this.rooms.size >= MAX_ROOMS) return null;
        }
        const code = this.generateCode();
        this.rooms.set(code, {
            users: new Map(),
            host: null,
            destination: null,
            createdAt: Date.now(),
            lastActivity: Date.now(),
        });
        return code;
    }

    // ... methods ...

    removeUser(code, socketId) {
        const room = this.rooms.get(code);
        if (!room) return null;

        const user = room.users.get(socketId);
        room.users.delete(socketId);
        room.lastActivity = Date.now(); // Atualizar atividade

        // Se o host saiu, transferir para o próximo (se houver)
        if (room.host === socketId && room.users.size > 0) {
            room.host = room.users.keys().next().value;
        }

        // NÃO deletar a sala imediatamente se estiver vazia. 
        // Ela será limpa pelo cleanupRooms se ficar vazia por 5h.

        return user;
    }

    roomExists(code) {
        return this.rooms.has(code);
    }

    getUsedColors(code) {
        const room = this.rooms.get(code);
        if (!room) return [];
        return Array.from(room.users.values()).map(u => u.color);
    }

    assignColor(code) {
        const used = this.getUsedColors(code);
        const available = COLORS.filter(c => !used.includes(c));
        if (available.length > 0) return available[0];
        return COLORS[Math.floor(Math.random() * COLORS.length)];
    }

    addUser(code, socketId, username, avatar, userId) {
        if (!this.rooms.has(code)) return null;

        const room = this.rooms.get(code);

        // Verificar se usuário já existe pelo userId (reconectar)
        let existingUser = null;
        if (userId) {
            for (const [sid, u] of room.users.entries()) {
                if (u.userId === userId) {
                    existingUser = { sid, user: u };
                    break;
                }
            }
        }

        // Limite de usuários
        if (room.users.size >= MAX_USERS_PER_ROOM && !existingUser) return null;

        const color = existingUser ? existingUser.user.color : this.assignColor(code);

        // Se encontrou usuário antigo, remover socket antigo e atualiza para o novo
        if (existingUser) {
            room.users.delete(existingUser.sid);
        }

        const user = {
            socketId, // Keep socketId as the primary identifier in the map
            username,
            avatar,
            color,
            location: existingUser ? existingUser.user.location : null, // Manter localização se possível, ou null
            route: existingUser ? existingUser.user.route : [], // Manter rota se possível
            joinedAt: existingUser ? existingUser.user.joinedAt : Date.now(), // Manter data de entrada
            online: true,
            userId: userId // Guardar para futuro
        };

        room.users.set(socketId, user);
        room.lastActivity = Date.now();

        // Se a sala não tinha host ou o host era o socket antigo, atualizar
        if (!room.host || (existingUser && room.host === existingUser.sid)) {
            room.host = socketId;
        }

        return user;
    }

    isHost(code, socketId) {
        const room = this.rooms.get(code);
        return room && room.host === socketId;
    }

    setDestination(code, socketId, destination) {
        const room = this.rooms.get(code);
        if (!room || room.host !== socketId) return false;
        room.destination = destination; // { lat, lng, name }
        return true;
    }

    getDestination(code) {
        const room = this.rooms.get(code);
        return room ? room.destination : null;
    }

    getHost(code) {
        const room = this.rooms.get(code);
        return room ? room.host : null;
    }

    updateLocation(code, socketId, lat, lng, accuracy, heading, speed) {
        const room = this.rooms.get(code);
        if (!room) return null;

        const user = room.users.get(socketId);
        if (!user) return null;

        user.location = { lat, lng, accuracy, heading, speed, timestamp: Date.now() };

        // Manter histórico de rota (máximo 100 pontos)
        user.route.push({ lat, lng, timestamp: Date.now() });
        if (user.route.length > 100) user.route.shift();

        return user;
    }

    removeUser(code, socketId) {
        const room = this.rooms.get(code);
        if (!room) return null;

        const user = room.users.get(socketId);
        room.users.delete(socketId);

        // Se o host saiu, transferir para o próximo
        if (room.host === socketId && room.users.size > 0) {
            room.host = room.users.keys().next().value;
        }

        // Remover sala se vazia
        if (room.users.size === 0) {
            this.rooms.delete(code);
        }

        return user;
    }

    getUsers(code) {
        const room = this.rooms.get(code);
        if (!room) return [];
        return Array.from(room.users.values());
    }

    getUserBySocket(socketId) {
        for (const [code, room] of this.rooms) {
            if (room.users.has(socketId)) {
                return { code, user: room.users.get(socketId) };
            }
        }
        return null;
    }

    getRoomStats() {
        return {
            totalRooms: this.rooms.size,
            totalUsers: Array.from(this.rooms.values()).reduce((sum, r) => sum + r.users.size, 0),
        };
    }
}

module.exports = RoomManager;
