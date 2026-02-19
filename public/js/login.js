/**
 * login.js – Lógica da página de login
 */

let selectedEmoji = '😊';

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

    // Salvar dados na sessão
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('avatar', selectedEmoji);
    sessionStorage.setItem('action', 'create');

    // Usar URL absoluta + timestamp para ignorar cache de redirect do Chrome
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

    // Verificar se sala existe (se falhar, deixa o servidor decidir)
    try {
        const res = await fetch(`/api/room/${code}`);
        const data = await res.json();
        if (!data.exists) {
            showError('Sala não encontrada. Verifique o código e tente novamente.');
            return;
        }
    } catch {
        // Se fetch falhar, prossegue mesmo assim — o servidor vai rejeitar se não existir
        console.warn('Verificação de sala falhou, prosseguindo...');
    }

    sessionStorage.setItem('username', username);
    sessionStorage.setItem('avatar', selectedEmoji);
    sessionStorage.setItem('action', 'join');
    sessionStorage.setItem('roomCode', code);

    // Usar URL absoluta + timestamp para ignorar cache de redirect do Chrome
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
