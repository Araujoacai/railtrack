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
        this.rooms = new Map(); // roomCode -> { users: Map, createdAt }
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
            return null; // Limite de salas atingido
        }
        const code = this.generateCode();
        this.rooms.set(code, {
            users: new Map(),
            createdAt: Date.now(),
        });
        return code;
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

    addUser(code, socketId, username, avatar) {
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.users.size >= MAX_USERS_PER_ROOM) return null; // Limite de usuários

        const color = this.assignColor(code);
        const user = {
            socketId,
            username,
            avatar,
            color,
            location: null,
            route: [],
            joinedAt: Date.now(),
            online: true,
        };
        room.users.set(socketId, user);
        return user;
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
