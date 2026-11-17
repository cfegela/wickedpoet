import './style.css';
import QRCode from 'qrcode';
import {
  ensureAnonymousSession,
  createRoom,
  joinRoom,
  fetchRoom,
  fetchRoomTurnState,
  startGame,
  submitPoemTurn,
  fetchGameRoundState,
  leaveRoom,
  subscribeToRoom,
} from './supabase.js';

// State Management
let currentUser = null;
let currentRoom = null;
let currentPlayers = [];
let submittedUserIds = [];
let mySubmitted = false;
let truncatedPrompt = null;
let previousAuthorName = null;
let completedPoems = null;

let unsubscribeRealtime = null;
let currentSubscribedRoomId = null;
let pollInterval = null;
let lastSeenRound = 0;
let isSubmittingTurn = false;

// DOM Elements
const alertBox = document.getElementById('alert-box');
const alertMsg = document.getElementById('alert-msg');
const alertClose = document.getElementById('alert-close');

const landingView = document.getElementById('landing-view');
const lobbyView = document.getElementById('lobby-view');
const gameView = document.getElementById('game-view');

const hostCard = document.getElementById('host-card');
const joinCard = document.getElementById('join-card');

const btnOpenHostPrompt = document.getElementById('btn-open-host-prompt');
const hostModal = document.getElementById('host-modal');
const hostPlayerName = document.getElementById('host-player-name');
const btnCancelHost = document.getElementById('btn-cancel-host');
const btnConfirmCreateRoom = document.getElementById('btn-confirm-create-room');

const joinPlayerName = document.getElementById('join-player-name');
const btnJoinGame = document.getElementById('btn-join-game');

const qrModal = document.getElementById('qr-modal');
const qrCanvas = document.getElementById('qr-canvas');
const btnCloseQr = document.getElementById('btn-close-qr');

const endGameModal = document.getElementById('end-game-modal');
const btnCancelEndGame = document.getElementById('btn-cancel-end-game');
const btnConfirmEndGame = document.getElementById('btn-confirm-end-game');

const roundStartModal = document.getElementById('round-start-modal');
const modalRoundTitle = document.getElementById('modal-round-title');
const modalRoundList = document.getElementById('modal-round-list');
const btnStartRound = document.getElementById('btn-start-round');

const playerCount = document.getElementById('player-count');
const seatsGrid = document.getElementById('seats-grid');
const hostInviteControls = document.getElementById('host-invite-controls');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnShowQr = document.getElementById('btn-show-qr');
const btnStartGame = document.getElementById('btn-start-game');
const lobbyWaitMsg = document.getElementById('lobby-wait-msg');

// Game View DOM Elements
const gameHudBar = document.querySelector('.game-hud-bar');
const hudRoundNumber = document.getElementById('hud-round-number');
const hudPoetsDone = document.getElementById('hud-poets-done');
const btnEndTurn = document.getElementById('btn-end-turn');

const waitingRoundOverlay = document.getElementById('waiting-round-overlay');
const waitingRoundSubtitle = document.getElementById('waiting-round-subtitle');
const waitingPlayersList = document.getElementById('waiting-players-list');

const writingSection = document.getElementById('writing-section');
const promptBox = document.getElementById('prompt-box');
const promptAuthorName = document.getElementById('prompt-author-name');
const promptText = document.getElementById('prompt-text');
const round1Header = document.getElementById('round1-header');
const poemInput = document.getElementById('poem-input');
const poemCharCount = document.getElementById('poem-char-count');
const btnEndActiveGame = document.getElementById('btn-end-active-game');

const gameCompletedSection = document.getElementById('game-completed-section');
const completedPoemsList = document.getElementById('completed-poems-list');
const btnCompletedHome = document.getElementById('btn-completed-home');

// Helper Utilities
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSavedName() {
  return sessionStorage.getItem('wickedpoet_display_name') || '';
}

function saveName(name) {
  if (name) {
    sessionStorage.setItem('wickedpoet_display_name', name.trim());
  }
}

function getQueryParam(key) {
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
}

function setRoomUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }
  window.history.replaceState({}, '', url.toString());
}

function showAlert(message, type = 'error') {
  alertMsg.textContent = message;
  alertBox.className = `alert alert-${type}`;
  alertBox.classList.remove('hidden');
}

function hideAlert() {
  alertBox.classList.add('hidden');
}

function updateHostFormValidity() {
  btnConfirmCreateRoom.disabled = hostPlayerName.value.trim().length === 0;
}

function updateJoinFormValidity() {
  btnJoinGame.disabled = joinPlayerName.value.trim().length === 0;
}

// Modals
function openHostModal() {
  hostPlayerName.value = getSavedName();
  updateHostFormValidity();
  hostModal.classList.remove('hidden');
  hostPlayerName.focus();
}

function closeHostModal() {
  hostModal.classList.add('hidden');
}

function openQrModal() {
  if (!currentRoom) return;
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoom.id}`;
  QRCode.toCanvas(
    qrCanvas,
    joinUrl,
    { width: 200, margin: 1, color: { dark: '#1f1e30', light: '#ffffff' } },
    (err) => {
      if (err) {
        showAlert('Failed to generate QR code: ' + err.message);
        return;
      }
      qrModal.classList.remove('hidden');
    }
  );
}

function closeQrModal() {
  qrModal.classList.add('hidden');
}

function openEndGameModal() {
  endGameModal.classList.remove('hidden');
}

function closeEndGameModal() {
  endGameModal.classList.add('hidden');
}

function openRoundStartModal(roundNumber, totalRounds) {
  modalRoundTitle.textContent = `Round ${roundNumber} of ${totalRounds}`;
  if (roundNumber === 1) {
    modalRoundList.innerHTML = `
      <li>Write 1 or 2 opening lines of poetry.</li>
      <li>Hit <strong>End Turn</strong> in the HUD when you're done.</li>
      <li>Next round, your lines pass to the next poet.</li>
    `;
  } else {
    modalRoundList.innerHTML = `
      <li>You'll see only the last few words from the previous poet.</li>
      <li>Write 1 or 2 lines to continue the verse.</li>
      <li>Hit <strong>End Turn</strong> in the HUD when you're done.</li>
    `;
  }
  roundStartModal.classList.remove('hidden');
}

function closeRoundStartModal() {
  roundStartModal.classList.add('hidden');
  if (poemInput && !mySubmitted) {
    poemInput.focus();
  }
}

// Polling & Realtime
function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function startLobbyPolling(roomId) {
  stopPolling();
  pollInterval = setInterval(async () => {
    if (!currentRoom || currentRoom.id !== roomId || currentRoom.status !== 'waiting') {
      return;
    }
    try {
      const { room, players } = await fetchRoom(roomId);
      currentRoom = room;
      currentPlayers = players;

      if (room.status === 'in_progress') {
        enterGameView();
      } else if (room.status === 'abandoned') {
        showAlert('The host has closed the room.', 'error');
        showLandingView();
      } else {
        renderSeats();
      }
    } catch {
      // Transient polling errors ignored
    }
  }, 2500);
}

function startGamePolling(roomId) {
  stopPolling();
  pollInterval = setInterval(async () => {
    if (!currentRoom || currentRoom.id !== roomId) return;
    if (currentRoom.status === 'completed' || currentRoom.status === 'abandoned') return;

    try {
      const state = await fetchRoomTurnState(roomId);
      if (!state) return;

      if (state.status === 'abandoned') {
        showAlert('The host has ended the game.', 'error');
        showLandingView();
        return;
      }

      await syncGameState();
    } catch {
      // Transient polling errors ignored
    }
  }, 2500);
}

function setupRealtimeSubscription(roomId) {
  if (currentSubscribedRoomId === roomId && unsubscribeRealtime) {
    return;
  }
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
  currentSubscribedRoomId = roomId;

  unsubscribeRealtime = subscribeToRoom(
    roomId,
    async () => {
      // room_players changed
      if (!currentRoom || currentRoom.id !== roomId) return;
      try {
        const { room, players } = await fetchRoom(roomId);
        currentRoom = room;
        currentPlayers = players;
        if (room.status === 'waiting') {
          renderSeats();
        } else {
          await syncGameState();
        }
      } catch {
        // Ignore transient errors
      }
    },
    async (payload) => {
      // rooms changed
      const updated = payload.new;
      if (!updated || updated.id !== roomId) return;
      currentRoom = updated;

      if (updated.status === 'abandoned') {
        showAlert('The host has ended the game.', 'error');
        showLandingView();
        return;
      }

      if (updated.status === 'in_progress' && lobbyView && !lobbyView.classList.contains('hidden')) {
        enterGameView();
      } else if (updated.status === 'in_progress' || updated.status === 'completed') {
        await syncGameState();
      }
    },
    async () => {
      // poem_lines changed
      if (currentRoom && currentRoom.id === roomId && currentRoom.status === 'in_progress') {
        await syncGameState();
      }
    }
  );
}

// View Renderers
function renderSeats() {
  if (!currentRoom) return;

  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);
  playerCount.textContent = currentPlayers.length;

  seatsGrid.innerHTML = '';

  for (let seatNum = 1; seatNum <= (currentRoom.max_players || 6); seatNum++) {
    const player = currentPlayers.find((p) => p.seat_number === seatNum);
    const seatEl = document.createElement('div');
    const isMe = myPlayer && player && player.user_id === myPlayer.user_id;

    if (player) {
      seatEl.className = `seat-card seat-occupied ${isMe ? 'seat-me' : ''}`;
      const initial = (player.display_name || '?').charAt(0).toUpperCase();

      seatEl.innerHTML = `
        ${player.is_host ? '<div class="status-host-badge">Host</div>' : ''}
        <div class="seat-header">
          <span>Player ${seatNum}</span>
        </div>
        <div class="seat-avatar">${escapeHtml(initial)}</div>
        <div class="seat-name">${escapeHtml(player.display_name)}</div>
        <div class="status-badge status-connected">
          ● Connected
        </div>
      `;
    } else {
      seatEl.className = 'seat-card seat-empty';
      seatEl.innerHTML = `
        <div class="seat-header">
          <span>Player ${seatNum}</span>
        </div>
        <div class="seat-avatar-empty">+</div>
        <div class="seat-name" style="font-size: 0.95rem; color: var(--text-muted);">Empty Slot</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">Waiting for player...</div>
      `;
    }

    seatsGrid.appendChild(seatEl);
  }

  if (myPlayer) {
    if (myPlayer.is_host) {
      if (hostInviteControls) hostInviteControls.classList.remove('hidden');
      btnStartGame.classList.remove('hidden');
      if (lobbyWaitMsg) lobbyWaitMsg.classList.add('hidden');
      const canStart = currentPlayers.length >= 1;
      btnStartGame.disabled = !canStart;
      btnStartGame.title = canStart ? 'Start Game' : 'Need at least 1 player';
    } else {
      if (hostInviteControls) hostInviteControls.classList.add('hidden');
      btnStartGame.classList.add('hidden');
      if (lobbyWaitMsg) lobbyWaitMsg.classList.remove('hidden');
    }
  }
}

function showLobbyView(room, players) {
  currentRoom = room;
  currentPlayers = players;

  document.getElementById('app').classList.remove('in-game');
  document.getElementById('app').classList.add('in-lobby');
  landingView.classList.add('hidden');
  gameView.classList.add('hidden');
  lobbyView.classList.remove('hidden');

  setRoomUrl(room.id);
  renderSeats();
  setupRealtimeSubscription(room.id);
  startLobbyPolling(room.id);
}

function showLandingView() {
  stopPolling();
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
  currentSubscribedRoomId = null;
  currentRoom = null;
  currentPlayers = [];
  submittedUserIds = [];
  mySubmitted = false;
  truncatedPrompt = null;
  previousAuthorName = null;
  completedPoems = null;
  lastSeenRound = 0;

  setRoomUrl(null);
  closeHostModal();
  closeQrModal();
  closeEndGameModal();
  closeRoundStartModal();

  if (btnEndActiveGame) btnEndActiveGame.style.display = 'none';
  if (poemInput) poemInput.value = '';
  if (poemCharCount) poemCharCount.textContent = '0 / 400';

  document.getElementById('app').classList.remove('in-lobby', 'in-game');
  lobbyView.classList.add('hidden');
  gameView.classList.add('hidden');
  if (gameCompletedSection) gameCompletedSection.classList.add('hidden');
  landingView.classList.remove('hidden');

  hostCard.classList.remove('hidden');
  joinCard.classList.add('hidden');
}

async function enterGameView() {
  document.getElementById('app').classList.remove('in-lobby');
  document.getElementById('app').classList.add('in-game');
  landingView.classList.add('hidden');
  lobbyView.classList.add('hidden');
  gameView.classList.remove('hidden');

  setupRealtimeSubscription(currentRoom.id);
  startGamePolling(currentRoom.id);
  await syncGameState();
}

function updateHUD() {
  if (!currentRoom) return;
  const myPlayer = currentPlayers.find((p) => p.user_id === currentUser?.id);

  if (hudRoundNumber) {
    hudRoundNumber.textContent = `${currentRoom.current_round} / ${currentRoom.total_rounds}`;
  }
  if (hudPoetsDone) {
    hudPoetsDone.textContent = `${submittedUserIds.length} / ${currentPlayers.length}`;
  }
  if (btnEndTurn) {
    const hasText = poemInput && poemInput.value.trim().length > 0;
    btnEndTurn.disabled = mySubmitted || !hasText || isSubmittingTurn || currentRoom.status !== 'in_progress';
  }
  if (btnEndActiveGame) {
    btnEndActiveGame.style.display = myPlayer?.is_host ? 'inline-flex' : 'none';
  }
}

function renderWaitingPlayersList() {
  if (!waitingPlayersList) return;
  waitingPlayersList.innerHTML = '';

  const submittedSet = new Set(submittedUserIds);
  for (const player of currentPlayers) {
    const isDone = submittedSet.has(player.user_id);
    const row = document.createElement('div');
    row.className = 'waiting-player-row';
    row.innerHTML = `
      <span>${escapeHtml(player.display_name)}${player.user_id === currentUser?.id ? ' (You)' : ''}</span>
      <span class="${isDone ? 'waiting-status-done' : 'waiting-status-writing'}">
        ${isDone ? '✓ Done' : 'Writing...'}
      </span>
    `;
    waitingPlayersList.appendChild(row);
  }
}

function renderCompletedPoems() {
  if (!completedPoemsList) return;
  completedPoemsList.innerHTML = '';

  const poems = completedPoems || [];
  if (poems.length === 0) {
    completedPoemsList.innerHTML = '<p style="color: var(--text-muted);">No poem lines recorded.</p>';
    return;
  }

  poems.forEach((poem, idx) => {
    const card = document.createElement('div');
    card.className = 'completed-poem-card';

    const titleText = `Poem ${poem.poem_index + 1}`;
    const linesHtml = (poem.lines || [])
      .map(
        (line) => `
        <div class="poem-stanza">
          <div class="poem-stanza-text">${escapeHtml(line.content)}</div>
        </div>
      `
      )
      .join('');

    card.innerHTML = `
      <div class="completed-poem-title">${titleText}</div>
      <div class="completed-poem-stanzas">${linesHtml}</div>
    `;
    completedPoemsList.appendChild(card);
  });
}

async function syncGameState() {
  if (!currentRoom) return;
  try {
    const state = await fetchGameRoundState(currentRoom.id);
    currentRoom = state.room;
    currentPlayers = state.players || [];
    mySubmitted = !!state.my_submitted;
    submittedUserIds = state.submitted_user_ids || [];
    truncatedPrompt = state.truncated_prompt || null;
    previousAuthorName = state.previous_author_name || null;
    completedPoems = state.completed_poems || null;

    if (currentRoom.status === 'abandoned') {
      showAlert('The host has ended the game.', 'error');
      showLandingView();
      return;
    }

    if (currentRoom.status === 'completed') {
      closeRoundStartModal();
      if (gameHudBar) gameHudBar.classList.add('hidden');
      if (waitingRoundOverlay) waitingRoundOverlay.classList.add('hidden');
      if (writingSection) writingSection.classList.add('hidden');
      if (gameCompletedSection) gameCompletedSection.classList.remove('hidden');
      renderCompletedPoems();
      return;
    }

    // Active round (in_progress)
    if (gameHudBar) gameHudBar.classList.remove('hidden');
    if (gameCompletedSection) gameCompletedSection.classList.add('hidden');

    if (currentRoom.current_round > lastSeenRound) {
      lastSeenRound = currentRoom.current_round;
      if (poemInput) poemInput.value = '';
      if (poemCharCount) poemCharCount.textContent = '0 / 400';
      openRoundStartModal(currentRoom.current_round, currentRoom.total_rounds);
    }

    updateHUD();

    if (mySubmitted) {
      if (writingSection) writingSection.classList.add('hidden');
      if (waitingRoundOverlay) waitingRoundOverlay.classList.remove('hidden');
      if (waitingRoundSubtitle) {
        waitingRoundSubtitle.textContent = `You've submitted your lines for Round ${currentRoom.current_round}. Waiting for other poets...`;
      }
      renderWaitingPlayersList();
    } else {
      if (waitingRoundOverlay) waitingRoundOverlay.classList.add('hidden');
      if (writingSection) writingSection.classList.remove('hidden');

      if (currentRoom.current_round > 1 && truncatedPrompt) {
        if (round1Header) round1Header.classList.add('hidden');
        if (promptBox) promptBox.classList.remove('hidden');
        if (promptAuthorName) promptAuthorName.textContent = previousAuthorName || 'previous poet';
        if (promptText) promptText.textContent = `"${truncatedPrompt}"`;
      } else {
        if (promptBox) promptBox.classList.add('hidden');
        if (round1Header) round1Header.classList.remove('hidden');
      }
    }
  } catch (err) {
    showAlert(err.message || 'Failed to sync game state.');
  }
}

// Event Handlers
async function handleCreateRoom() {
  const name = hostPlayerName.value.trim();
  if (!name) return;

  btnConfirmCreateRoom.disabled = true;
  btnConfirmCreateRoom.textContent = 'Creating...';
  hideAlert();

  try {
    saveName(name);
    const { room } = await createRoom(name);
    const { room: freshRoom, players } = await fetchRoom(room.id);
    closeHostModal();
    showLobbyView(freshRoom, players);
  } catch (err) {
    showAlert(err.message || 'Failed to create room.');
  } finally {
    btnConfirmCreateRoom.disabled = false;
    btnConfirmCreateRoom.textContent = 'Start Game';
    updateHostFormValidity();
  }
}

async function handleJoinRoom() {
  const roomId = getQueryParam('room');
  const name = joinPlayerName.value.trim();
  if (!roomId || !name) return;

  btnJoinGame.disabled = true;
  btnJoinGame.textContent = 'Joining...';
  hideAlert();

  try {
    saveName(name);
    await joinRoom(roomId, name);
    const { room, players } = await fetchRoom(roomId);
    if (room.status === 'in_progress' || room.status === 'completed') {
      currentRoom = room;
      currentPlayers = players;
      await enterGameView();
    } else {
      showLobbyView(room, players);
    }
  } catch (err) {
    showAlert(err.message || 'Failed to join room.');
  } finally {
    btnJoinGame.disabled = false;
    btnJoinGame.textContent = 'Join Game';
    updateJoinFormValidity();
  }
}

async function handleStartGame() {
  if (!currentRoom) return;
  btnStartGame.disabled = true;
  btnStartGame.textContent = 'Starting...';
  hideAlert();

  try {
    const res = await startGame(currentRoom.id);
    currentRoom = res.room;
    const { players } = await fetchRoom(currentRoom.id);
    currentPlayers = players;
    await enterGameView();
  } catch (err) {
    showAlert(err.message || 'Failed to start game.');
    btnStartGame.disabled = false;
  } finally {
    btnStartGame.textContent = 'Start Game';
  }
}

async function handleEndTurn() {
  if (!currentRoom || !poemInput || isSubmittingTurn) return;
  const content = poemInput.value.trim();
  if (!content) return;

  isSubmittingTurn = true;
  updateHUD();
  btnEndTurn.textContent = 'Saving...';
  hideAlert();

  try {
    await submitPoemTurn(currentRoom.id, content);
    poemInput.value = '';
    if (poemCharCount) poemCharCount.textContent = '0 / 400';
    await syncGameState();
  } catch (err) {
    showAlert(err.message || 'Failed to submit your lines.');
  } finally {
    isSubmittingTurn = false;
    btnEndTurn.textContent = 'End Turn';
    updateHUD();
  }
}

async function handleConfirmEndGame() {
  if (!currentRoom) {
    showLandingView();
    return;
  }
  btnConfirmEndGame.disabled = true;
  try {
    await leaveRoom(currentRoom.id);
  } catch {
    // Ignore errors when leaving
  } finally {
    btnConfirmEndGame.disabled = false;
    showLandingView();
  }
}

// Wire Event Listeners
alertClose?.addEventListener('click', hideAlert);

btnOpenHostPrompt?.addEventListener('click', openHostModal);
btnCancelHost?.addEventListener('click', closeHostModal);
hostPlayerName?.addEventListener('input', updateHostFormValidity);
hostPlayerName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnConfirmCreateRoom.disabled) {
    handleCreateRoom();
  }
});
btnConfirmCreateRoom?.addEventListener('click', handleCreateRoom);

joinPlayerName?.addEventListener('input', updateJoinFormValidity);
joinPlayerName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnJoinGame.disabled) {
    handleJoinRoom();
  }
});
btnJoinGame?.addEventListener('click', handleJoinRoom);

btnCopyLink?.addEventListener('click', async () => {
  if (!currentRoom) return;
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoom.id}`;
  try {
    await navigator.clipboard.writeText(joinUrl);
    const orig = btnCopyLink.textContent;
    btnCopyLink.textContent = 'Copied!';
    setTimeout(() => {
      btnCopyLink.textContent = orig;
    }, 1800);
  } catch {
    showAlert(`Share this link: ${joinUrl}`, 'success');
  }
});

btnShowQr?.addEventListener('click', openQrModal);
btnCloseQr?.addEventListener('click', closeQrModal);

btnStartGame?.addEventListener('click', handleStartGame);
btnStartRound?.addEventListener('click', closeRoundStartModal);

poemInput?.addEventListener('input', () => {
  if (poemCharCount) {
    poemCharCount.textContent = `${poemInput.value.length} / 400`;
  }
  updateHUD();
});

btnEndTurn?.addEventListener('click', handleEndTurn);

btnEndActiveGame?.addEventListener('click', openEndGameModal);
btnCancelEndGame?.addEventListener('click', closeEndGameModal);
btnConfirmEndGame?.addEventListener('click', handleConfirmEndGame);

btnCompletedHome?.addEventListener('click', showLandingView);

// Initialization
async function init() {
  try {
    currentUser = await ensureAnonymousSession();
  } catch (err) {
    showAlert('Unable to connect to game server: ' + (err.message || 'Unknown error'));
    return;
  }

  const roomId = getQueryParam('room');
  if (roomId) {
    try {
      const { room, players } = await fetchRoom(roomId);
      const existingPlayer = players.find((p) => p.user_id === currentUser.id);

      if (room.status === 'abandoned') {
        showAlert('This game room has already closed.');
        setRoomUrl(null);
        return;
      }

      if (existingPlayer) {
        currentRoom = room;
        currentPlayers = players;
        if (room.status === 'waiting') {
          showLobbyView(room, players);
        } else {
          await enterGameView();
        }
        return;
      }

      if (room.status !== 'waiting') {
        showAlert('This game has already started.');
        setRoomUrl(null);
        return;
      }

      // Show Join Card
      hostCard.classList.add('hidden');
      joinCard.classList.remove('hidden');
      joinPlayerName.value = getSavedName();
      updateJoinFormValidity();
      joinPlayerName.focus();
    } catch {
      showAlert('Room not found or no longer available.');
      setRoomUrl(null);
    }
  }
}

init();
