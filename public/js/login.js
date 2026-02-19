/**
 * login.js – Lógica da página de login
 */

let selectedEmoji = '😊';
const STORAGE_KEY = 'realtrack_user';

// Carregar dados salvos
document.addEventListener('DOMContentLoaded', () => {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

    if (saved.username) document.getElementById('username').value = saved.username;

    if (saved.avatar) {
        selectedEmoji = saved.avatar;
        document.getElementById('avatarEmoji').textContent = selectedEmoji;
        document.querySelectorAll('.emoji-opt').forEach(e => {
            if (e.dataset.emoji === selectedEmoji) e.classList.add('selected');
            else e.classList.remove('selected');
        });
    } else {
        document.querySelector('.emoji-opt')?.classList.add('selected');
    }

    // Sugerir reconexão se houver última sala
    if (saved.lastRoom) {
        const joinPanel = document.getElementById('panelJoin');
        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:10px; font-size:12px; color:var(--text-secondary); text-align:center; cursor:pointer';
        hint.innerHTML = `Última sala: <span style="color:var(--accent);text-decoration:underline">${saved.lastRoom}</span>`;
        hint.onclick = () => {
            switchTab('join');
            document.getElementById('roomCode').value = saved.lastRoom;
        };
        joinPanel.appendChild(hint);
    }
});

function saveUserData(username, avatar) {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, username, avatar }));
}

function saveLastRoom(code) {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, lastRoom: code }));
}

// Selecionar emoji de avatar
function selectEmoji(el) {
    document.querySelectorAll('.emoji-opt').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    selectedEmoji = el.dataset.emoji;
    document.getElementById('avatarEmoji').textContent = selectedEmoji;
}

// Alternar abas
function switchTab(tab) {
    const isCreate = tab === 'create';
    document.getElementById('tabCreate').classList.toggle('active', isCreate);
    document.getElementById('tabJoin').classList.toggle('active', !isCreate);
    document.getElementById('panelCreate').classList.toggle('hidden', !isCreate);
    document.getElementById('panelJoin').classList.toggle('hidden', isCreate);
    hideError();
}

// Mostrar erro
function showError(msg) {
    const el = document.getElementById('errorMsg');
    el.textContent = msg;
    el.classList.remove('hidden');
}

function hideError() {
    document.getElementById('errorMsg').classList.add('hidden');
}

// Validar nome
function getUsername() {
    const name = document.getElementById('username').value.trim();
    if (!name) {
        showError('Por favor, insira seu nome antes de continuar.');
        document.getElementById('username').focus();
        return null;
    }
    return name;
}

// Criar sala
async function createRoom() {
    const username = getUsername();
    if (!username) return;

    saveUserData(username, selectedEmoji);

    // Salvar dados na sessão (ainda necessário para o map.js ler initially)
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('avatar', selectedEmoji);
    sessionStorage.setItem('action', 'create');

    const base = `${location.protocol}//${location.host}`;
    window.location.replace(`${base}/map?t=${Date.now()}`);
}

// Entrar em sala
async function joinRoom() {
    const username = getUsername();
    if (!username) return;

    const code = document.getElementById('roomCode').value.trim().toUpperCase();
    if (!code || code.length !== 6) {
        showError('O código da sala deve ter 6 caracteres.');
        document.getElementById('roomCode').focus();
        return;
    }

    saveUserData(username, selectedEmoji);

    // Verificar se sala existe (se falhar, deixa o servidor decidir)
    try {
        const res = await fetch(`/api/room/${code}`);
        const data = await res.json();
        if (!data.exists) {
            showError('Sala não encontrada ou expirada (5h).');
            return;
        }
    } catch {
        // Se fetch falhar, prossegue mesmo assim
        console.warn('Verificação de sala falhou, prosseguindo...');
    }

    saveLastRoom(code);
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('avatar', selectedEmoji);
    sessionStorage.setItem('action', 'join');
    sessionStorage.setItem('roomCode', code);

    const base = `${location.protocol}//${location.host}`;
    window.location.replace(`${base}/map?t=${Date.now()}`);
}

// Tecla Enter nos campos
document.addEventListener('DOMContentLoaded', () => {
    sessionStorage.clear(); // Limpar sessionStorage ao carregar a página
    document.getElementById('username').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const activeTab = document.getElementById('tabCreate').classList.contains('active');
            activeTab ? createRoom() : document.getElementById('roomCode').focus();
        }
    });

    document.getElementById('roomCode')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') joinRoom();
    });

    // Selecionar primeiro emoji por padrão
    document.querySelector('.emoji-opt')?.classList.add('selected');
});

// ── PWA: Registrar Service Worker ────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('SW registrado na home:', reg.scope))
            .catch(err => console.log('SW falhou na home:', err));
    });
}
