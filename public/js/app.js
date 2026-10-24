// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  socketId: null,
  roomCode: null,
  playerId: null,
  playerName: null,
  isHost: false,
  accessToken: null,
  spotifyPlayer: null,
  spotifyDeviceId: null,
  currentTrack: null,
  guessedYear: 1990,
  hasSubmitted: false,
  roomState: null,
  playlistLoaded: false
};

const socket = io();

// Latest year a song can have — keeps the slider/inputs current instead of hardcoding
const MAX_YEAR = new Date().getFullYear();

// Escape text before putting it in innerHTML (song titles and names can contain < & " etc.)
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Saved session (lets a refresh / phone lock / dropped connection rejoin the same seat) ──
const SESSION_KEY = 'hitster:session';
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ─── Screen management ───────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  state.socketId = socket.id;
  // Every (re)connection is a brand-new socket — ask for our old seat back if we had one
  const session = loadSession();
  if (session?.code && session?.name) {
    state.playerName = session.name;
    socket.emit('room:join', { code: session.code, playerName: session.name, rejoinToken: session.token, auto: true });
  }
});

// The room is gone (server restarted, or our seat was released) — forget it and start over
socket.on('room:rejoin_failed', () => {
  clearSession();
  state.roomCode = null;
  state.playerId = null;
  state.roomState = null;
  showScreen(state.accessToken ? 'screen-lobby' : 'screen-auth');
});

socket.on('auth:success', ({ access_token, display_name }) => {
  state.accessToken = access_token;
  document.getElementById('notice-spotify').classList.add('hidden');
  document.getElementById('player-name-badge').textContent = display_name;
  // When this fires on a rejoin we're already in a room — don't yank the player back to the lobby
  if (!state.roomCode) {
    state.playerName = display_name;
    showScreen('screen-lobby');
  }
  initSpotifyPlayer(access_token);
});

socket.on('room:joined', ({ code, playerId, rejoinToken, rejoined }) => {
  state.roomCode = code;
  state.playerId = playerId;
  if (state.playerName) saveSession({ code, name: state.playerName, token: rejoinToken });
  document.getElementById('room-code-display').textContent = code;
  // A reconnect mid-game keeps whatever screen we're already on; the server resyncs the phase right after
  const inGame = ['screen-game', 'screen-reveal', 'screen-winner'].some(id =>
    document.getElementById(id).classList.contains('active'));
  if (!(rejoined && inGame)) showScreen('screen-room');
});

socket.on('room:state', (roomState) => {
  state.roomState = roomState;
  document.body.classList.toggle('tv-mode', !!roomState.tvMode);
  updateTvBanner(roomState);
  state.isHost = roomState.players.find(p => p.id === state.playerId)?.isHost || false;
  updateRoomUI(roomState);

  // Always rebuild my timeline from the server's copy — covers steals, free cards,
  // year overrides and host edits without drifting out of sync
  const me = roomState.players.find(p => p.id === state.playerId);
  if (me) rebuildTimeline(me.timeline || []);

  if (roomState.phase === 'ended' && roomState.winner) {
    showWinner(roomState.winner, roomState.players);
  }
});

socket.on('round:start', ({ trackId, uri, preview_url }) => {
  state.currentTrack = { trackId, uri, preview_url };
  state.hasSubmitted = false;
  state.guessedYear = 1990;
  state.isMyTurn = state.roomState?.currentPlayerId === state.playerId;
  hideAbsentPrompt();
  startRound(uri, preview_url);
});

// round:reveal handled above with clearStealCountdown

socket.on('room:error', (msg) => {
  alert('Error: ' + msg);
});

socket.on('playlists:list', (playlists) => {
  renderPlaylistDropdown(playlists);
});

socket.on('playlist:loaded', ({ count }) => {
  const status = document.getElementById('playlist-status');
  status.textContent = `✓ Loaded ${count} tracks`;
  status.className = 'playlist-status success';
  status.classList.remove('hidden');
  state.playlistLoaded = true;
  document.getElementById('btn-start-game').disabled = false;
  document.getElementById('playlist-progress-bar').classList.add('hidden');
});

socket.on('playlist:progress', ({ loaded, total, hasMore, background, done }) => {
  const bar = document.getElementById('playlist-progress-bar');
  const fill = document.getElementById('playlist-progress-fill');
  const label = document.getElementById('playlist-progress-label');
  bar.classList.remove('hidden');

  const pct = Math.round((loaded / total) * 100);
  fill.style.width = pct + '%';

  if (done) {
    label.textContent = `✓ All ${total} albums cached`;
    setTimeout(() => bar.classList.add('hidden'), 3000);
  } else if (background) {
    label.textContent = `⏳ Caching albums in background… ${loaded}/${total}`;
  } else {
    label.textContent = `Loading album years… ${loaded}/${total}`;
  }
});

// ─── Active player offline: host decides ─────────────────────────────────────────
function hideAbsentPrompt() {
  document.getElementById('absent-prompt')?.remove();
}

socket.on('turn:absent', ({ playerName }) => {
  hideAbsentPrompt();
  const box = document.createElement('div');
  box.id = 'absent-prompt';
  box.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;max-width:92vw;' +
    'background:var(--surface,#222);color:var(--text,#fff);border:1px solid var(--border,#555);border-radius:12px;' +
    'padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,.5);text-align:center;';
  box.innerHTML = `<div style="margin-bottom:8px;">💤 <b>${esc(playerName)}</b> is offline. Skip their turn?</div>`;
  const answer = action => {
    socket.emit('turn:absent_decision', { code: state.roomCode, action });
    hideAbsentPrompt();
  };
  [['Skip their turn', 'skip'], ['Keep waiting', 'wait']].forEach(([label, action]) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm ' + (action === 'skip' ? 'btn-primary' : 'btn-secondary');
    btn.style.margin = '0 4px';
    btn.textContent = label;
    btn.addEventListener('click', () => answer(action));
    box.appendChild(btn);
  });
  document.body.appendChild(box);
});
socket.on('turn:absent_cleared', hideAbsentPrompt);

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function spotifyLogout() {
  await fetch(`/auth/logout?socketId=${socket.id}`);
  state.accessToken = null;
}

document.getElementById('btn-spotify-login').addEventListener('click', () => {
  const loginUrl = `/auth/login?socketId=${socket.id}`;
  window.open(loginUrl, '_blank', 'width=500,height=700');
});

document.getElementById('btn-reconnect-spotify') && document.getElementById('btn-reconnect-spotify').addEventListener('click', async () => {
  await spotifyLogout();
  const loginUrl = `/auth/login?socketId=${socket.id}`;
  window.open(loginUrl, '_blank', 'width=500,height=700');
});

// ─── Landing: join without Spotify, TV-mode toggle ───────────────────────────────
const landingCodeParam = new URLSearchParams(location.search).get('code');
if (landingCodeParam) {
  const c = landingCodeParam.toUpperCase().slice(0, 5);
  document.getElementById('landing-code').value = c;
  document.getElementById('input-room-code').value = c;
}

document.getElementById('toggle-tv-mode').addEventListener('change', e => {
  document.getElementById('host-tv').classList.toggle('hidden', !e.target.checked);
  document.getElementById('host-classic').classList.toggle('hidden', e.target.checked);
});

document.getElementById('landing-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById('btn-landing-join').addEventListener('click', () => {
  const name = document.getElementById('landing-name').value.trim();
  const code = document.getElementById('landing-code').value.trim().toUpperCase();
  if (!name || !code) return alert('Enter your name and room code');
  state.playerName = name;
  socket.emit('room:join', { code, playerName: name });
});

document.getElementById('btn-create-tv-room').addEventListener('click', () => {
  const name = document.getElementById('landing-host-name').value.trim();
  if (!name) return alert('Enter your name');
  state.playerName = name;
  socket.emit('room:create', { playerName: name, tvMode: true });
});

// A banner while the TV is away mid-game (the next song waits for it)
function updateTvBanner(rs) {
  const need = rs.tvMode && !['lobby', 'ended'].includes(rs.phase) && !rs.tvReady;
  let b = document.getElementById('tv-away-banner');
  if (need && !b) {
    b = document.createElement('div');
    b.id = 'tv-away-banner';
    b.className = 'phone-banner';
    b.textContent = '📺 TV disconnected — the next song starts when it is back';
    document.body.appendChild(b);
  } else if (!need && b) {
    b.remove();
  }
}

document.getElementById('btn-notice-spotify').addEventListener('click', () => {
  window.open(`/auth/login?socketId=${socket.id}`, '_blank', 'width=500,height=700');
});

// ─── Token controls ──────────────────────────────────────────────────────────
function adjustToken(playerId, delta) {
  socket.emit('token:adjust', { code: state.roomCode, playerId, delta });
}

socket.on('steal:attempt', ({ stealerName, targetName, gapIndex }) => {
  // Don't reveal correctness — just show that someone attempted a steal
  const el = document.createElement('div');
  el.className = 'steal-result';
  el.style.background = 'rgba(255,255,255,0.05)';
  el.style.border = '1px solid var(--border)';
  el.textContent = `🪙 ${stealerName} attempted a steal on ${targetName}'s timeline`;
  const panel = document.getElementById('guess-panel');
  panel.insertBefore(el, panel.firstChild);
  setTimeout(() => el.remove(), 8000);
});

socket.on('token:skipped', ({ playerName }) => {
  document.getElementById('player-status').textContent = `${playerName} skipped — new song coming…`;
});

socket.on('steal:window', ({ guessedYear, activePlayerName, activePlayerTimeline, alreadyStole }) => {
  state.isMyTurn = state.roomState?.currentPlayerId === state.playerId;
  const me = state.roomState?.players?.find(p => p.id === state.playerId);
  const myTokens = me?.tokens || 0;

  if (state.isMyTurn) {
    // Active player: keep guess-panel visible so btn-end-steal (inside it) can show
    document.getElementById('guess-panel').classList.remove('hidden');
    document.getElementById('steal-panel').classList.add('hidden');
    document.getElementById('btn-attempt-steal').classList.add('hidden');
    document.getElementById('btn-skip-song').classList.add('hidden');
    document.getElementById('btn-free-card').classList.add('hidden');
    document.getElementById('btn-submit-guess').classList.add('hidden');
    document.getElementById('year-slider').disabled = true;
    const waitMsg = document.getElementById('guess-submitted-msg');
    waitMsg.classList.remove('hidden');
    waitMsg.textContent = '✓ Locked in! Others may attempt steals…';
    // Show end-steal button for active player
    document.getElementById('btn-end-steal').classList.remove('hidden');
    // Start countdown display for host
    startStealCountdown();
  } else {
    // Non-active players see the steal interface
    document.getElementById('guess-panel').classList.remove('hidden');
    document.getElementById('guess-submitted-msg').classList.add('hidden');
    document.getElementById('btn-submit-guess').classList.add('hidden');
    document.getElementById('btn-skip-song').classList.add('hidden');
    document.getElementById('year-slider').disabled = true;

    // Show what the active player guessed
    document.getElementById('year-display').textContent = guessedYear;
    document.getElementById('year-slider').value = guessedYear;

    const stealInfo = document.getElementById('steal-info');
    if (stealInfo) stealInfo.remove();
    const infoEl = document.createElement('p');
    infoEl.id = 'steal-info';
    infoEl.style.cssText = 'font-size:13px;color:var(--text-muted);text-align:center;margin:4px 0;';
    infoEl.textContent = `${activePlayerName} guessed ${guessedYear} — steal their card?`;
    document.getElementById('guess-panel').insertBefore(infoEl, document.getElementById('guess-panel').firstChild);

    // Show steal button if they have tokens
    if (myTokens >= 1 && !alreadyStole) {
      state.stealTimeline = activePlayerTimeline; // store for gap builder
      document.getElementById('btn-attempt-steal').classList.remove('hidden');
    }
    document.getElementById('btn-end-steal').classList.add('hidden');
  }
});

// ─── Lobby ────────────────────────────────────────────────────────────────────
document.getElementById('btn-create-room').addEventListener('click', () => {
  const name = document.getElementById('input-host-name').value.trim();
  if (!name) return alert('Enter your name');
  state.playerName = name;
  socket.emit('room:create', { playerName: name });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const name = document.getElementById('input-join-name').value.trim();
  const code = document.getElementById('input-room-code').value.trim().toUpperCase();
  if (!name || !code) return alert('Enter your name and room code');
  state.playerName = name;
  socket.emit('room:join', { code, playerName: name });
});

document.getElementById('input-room-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

// ─── Room / Host Controls ─────────────────────────────────────────────────────
document.getElementById('btn-load-playlists').addEventListener('click', () => {
  if (!state.accessToken) return alert('Connect Spotify first');
  socket.emit('playlists:fetch');
});

document.getElementById('btn-load-playlist').addEventListener('click', () => {
  const val = document.getElementById('input-playlist').value.trim();
  const playlistId = extractPlaylistId(val);
  if (!playlistId) return alert('Enter a valid Spotify playlist ID or URL');
  const status = document.getElementById('playlist-status');
  status.textContent = 'Loading playlist…';
  status.className = 'playlist-status';
  status.classList.remove('hidden');
  socket.emit('playlist:load', { code: state.roomCode, playlistId });
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('game:start', { code: state.roomCode });
});

function extractPlaylistId(input) {
  if (!input) return null;
  const match = input.match(/playlist\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9]{22}$/.test(input)) return input;
  return null;
}

function renderPlaylistDropdown(playlists) {
  const dd = document.getElementById('playlists-dropdown');
  dd.innerHTML = '';
  dd.classList.remove('hidden');
  playlists.forEach(p => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.innerHTML = `${esc(p.name)} <span>${esc(p.tracks)} tracks</span>`;
    item.addEventListener('click', () => {
      document.getElementById('input-playlist').value = p.id;
      dd.classList.add('hidden');
    });
    dd.appendChild(item);
  });
}

// ─── UI Updates ───────────────────────────────────────────────────────────────
function updateRoomUI(roomState) {
  // Players list
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  roomState.players.forEach(p => {
    const li = document.createElement('li');
    const isMe = p.id === state.playerId;
    const tokenPips = Array(p.tokens || 0).fill('🪙').join('');
    li.innerHTML = `
      <span>${esc(p.name)}${isMe ? ' (you)' : ''}${p.connected === false ? ' 💤 offline' : ''}${p.isHost ? ' <span class="player-host-badge">HOST</span>' : ''}</span>
      <span class="player-score-badge">${p.score} 🎵 ${tokenPips}</span>
    `;
    list.appendChild(li);
  });

  document.getElementById('win-score-display').textContent = roomState.winScore;

  // Token controls (host only) — shown in lobby and during game
  function buildTokenControls(el, players) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">🪙 Tokens</div>';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'token-row';
      const pips = Array(p.tokens).fill('<span class="token-pip"></span>').join('');
      row.innerHTML = `
        <span class="token-row-name">${esc(p.name)}</span>
        <div class="token-row-pips">${pips || '<span style="color:var(--text-muted);font-size:11px">0</span>'}</div>
        <button class="token-adj-btn" onclick="adjustToken('${p.id}', -1)" title="Remove token">−</button>
        <button class="token-adj-btn" onclick="adjustToken('${p.id}', 1)" title="Award token">+</button>
      `;
      el.appendChild(row);
    });
  }

  const lobbyTokenControls = document.getElementById('token-controls');
  const gameTokenControls = document.getElementById('game-token-controls');

  if (state.isHost) {
    if (document.getElementById('screen-room').classList.contains('active')) {
      lobbyTokenControls.classList.remove('hidden');
      buildTokenControls(lobbyTokenControls, roomState.players);
    } else {
      lobbyTokenControls.classList.add('hidden');
    }
    if (document.getElementById('screen-game').classList.contains('active') ||
        document.getElementById('screen-reveal').classList.contains('active')) {
      gameTokenControls.classList.remove('hidden');
      buildTokenControls(gameTokenControls, roomState.players);
      document.getElementById('host-editor-bar').classList.remove('hidden');
    } else {
      gameTokenControls.classList.add('hidden');
      document.getElementById('host-editor-bar').classList.add('hidden');
    }
  } else {
    lobbyTokenControls.classList.add('hidden');
    gameTokenControls.classList.add('hidden');
  }

  // TV mode: music and playlists live on the TV; the host's phone only runs the game
  const tvStatus = document.getElementById('tv-host-status');
  const tvMode = !!roomState.tvMode;
  document.getElementById('playlist-section').classList.toggle('hidden', tvMode);
  document.getElementById('btn-reconnect-spotify').classList.toggle('hidden', tvMode);
  tvStatus.classList.toggle('hidden', !tvMode);
  document.getElementById('notice-spotify').classList.toggle('hidden', tvMode || !!state.accessToken);
  if (tvMode) {
    const tvLine = document.getElementById('tv-host-line-tv');
    tvLine.textContent = roomState.tvReady ? '📺 TV connected, audio ready ✓'
      : roomState.tvConnected ? '📺 TV connected — tap "Enable audio" on it'
      : '📺 Waiting for the TV — open /tv.html on the laptop and enter code ' + roomState.code;
    tvLine.className = 'tv-host-line ' + (roomState.tvReady ? 'ok' : 'bad');
    const plLine = document.getElementById('tv-host-line-playlist');
    plLine.textContent = roomState.playlistCount ? `🎵 Playlist loaded: ${roomState.playlistCount} tracks ✓` : '🎵 Pick a playlist on the TV';
    plLine.className = 'tv-host-line ' + (roomState.playlistCount ? 'ok' : 'bad');
    document.getElementById('btn-start-game').disabled = !(roomState.tvReady && roomState.playlistCount > 0);
  }

  // Show/hide host controls
  const hostCtrl = document.getElementById('host-controls');
  const waitingPanel = document.getElementById('waiting-panel');
  if (state.isHost) {
    hostCtrl.classList.remove('hidden');
    waitingPanel.classList.add('hidden');
  } else {
    hostCtrl.classList.add('hidden');
    waitingPanel.classList.remove('hidden');
  }

  // If game is playing, switch to game screen
  if (['round', 'steal', 'reveal', 'playing'].includes(roomState.phase)) {
    if (document.getElementById('screen-room').classList.contains('active')) {
      showScreen('screen-game');
    }
    updateGameHeader(roomState);
    updateTimeline(roomState);
  }
}

function updateGameHeader(roomState) {
  const status = document.getElementById('round-status');
  const turnText = roomState.turnInCycle ? `Turn ${roomState.turnInCycle}/${roomState.turnsPerCycle}` : '';
  status.textContent = roomState.finalRound
    ? `🏁 Final round${turnText ? ' · ' + turnText : ''} — outright leader wins`
    : turnText;

  // Update turn indicator
  const currentPlayer = roomState.players.find(p => p.id === roomState.currentPlayerId);
  if (currentPlayer) {
    const turnEl = document.getElementById('current-turn-label');
    if (turnEl) {
      const isMe = currentPlayer.id === state.playerId;
      turnEl.textContent = isMe ? '🎵 Your turn!' : `🎵 ${currentPlayer.name}'s turn`;
    }
  }
}

function updateTimeline(roomState) {
  const me = roomState.players.find(p => p.id === state.playerId);
  if (!me) return;
  document.getElementById('my-score-badge').textContent = me.score;

  // Update my token count display
  document.getElementById('my-token-count').textContent = me.tokens || 0;

  // Update player scoreboard
  const list = document.getElementById('game-players-list');
  if (!list) return;
  list.innerHTML = '';
  roomState.players.forEach(p => {
    const li = document.createElement('li');
    const isCurrentTurn = p.id === roomState.currentPlayerId;
    if (isCurrentTurn) li.classList.add('is-current-turn');
    const tokenStr = `🪙${p.tokens || 0}`;
    const turnMark = isCurrentTurn ? ' 🎵' : '';
    li.innerHTML = `
      <span class="gpl-name">${esc(p.name)}${p.connected === false ? ' 💤' : ''}${turnMark}</span>
      <span class="gpl-score">${p.score}🃏</span>
      <span class="gpl-tokens">${tokenStr}</span>
    `;
    list.appendChild(li);
  });
}

// ─── Round ────────────────────────────────────────────────────────────────────
function startRound(uri, preview_url) {
  showScreen('screen-game');

  // Reset UI
  ['np-title', 'np-artist', 'np-year'].forEach(id => {
    document.getElementById(id).classList.add('np-hidden');
    document.getElementById(id).classList.remove('revealed');
  });
  document.getElementById('np-title').textContent = '???';
  document.getElementById('np-artist').textContent = '???';
  document.getElementById('np-year').textContent = '????';

  const me = state.roomState?.players?.find(p => p.id === state.playerId);
  const myTokens = me?.tokens || 0;

  // Reset all panels
  document.getElementById('steal-panel').classList.add('hidden');
  document.getElementById('btn-attempt-steal').classList.add('hidden');
  document.getElementById('btn-end-steal').classList.add('hidden');
  document.getElementById('btn-free-card').classList.add('hidden');
  document.getElementById('year-slider').disabled = false;
  const stealInfo = document.getElementById('steal-info');
  if (stealInfo) stealInfo.remove();

  if (state.isMyTurn) {
    // Active player: show guess controls
    document.getElementById('guess-panel').classList.remove('hidden');
    document.getElementById('guess-submitted-msg').classList.add('hidden');
    document.getElementById('btn-submit-guess').disabled = false;
    document.getElementById('btn-submit-guess').classList.remove('hidden');
    document.getElementById('btn-skip-song').classList.toggle('hidden', myTokens < 1);
    document.getElementById('btn-free-card').classList.toggle('hidden', myTokens < 3);
  } else {
    // Non-active player: show waiting message
    document.getElementById('guess-panel').classList.remove('hidden');
    document.getElementById('btn-submit-guess').classList.add('hidden');
    document.getElementById('btn-skip-song').classList.add('hidden');
    document.getElementById('btn-free-card').classList.add('hidden');
    const waitMsg = document.getElementById('guess-submitted-msg');
    waitMsg.classList.remove('hidden');
    const currentPlayerName = state.roomState?.players?.find(p => p.id === state.roomState?.currentPlayerId)?.name || 'Player';
    waitMsg.textContent = `⏳ ${currentPlayerName}'s turn — wait for their guess…`;
  }

  state.guessedYear = 1990;
  document.getElementById('year-slider').value = 1990;
  document.getElementById('year-display').textContent = 1990;

  // Play music
  // On HTTPS: use Web Playback SDK (in-browser)
  // On HTTP: fall back to active Spotify device (phone/desktop app must be open)
  if (state.roomState?.tvMode) {
    document.getElementById('player-status').textContent = '🎵 Music plays on the TV';
  } else if (uri) {
    playSpotifyTrack(uri);
  } else {
    document.getElementById('player-status').textContent = 'No track URI available';
  }
}

// ─── Year Picker ──────────────────────────────────────────────────────────────
const yearSlider = document.getElementById('year-slider');
const yearDisplay = document.getElementById('year-display');
yearSlider.max = MAX_YEAR;
const yearLabels = document.querySelectorAll('.year-labels span');
if (yearLabels.length) yearLabels[yearLabels.length - 1].textContent = MAX_YEAR;
['input-override-year', 'editor-card-year'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.max = MAX_YEAR;
});

yearSlider.addEventListener('input', () => {
  state.guessedYear = parseInt(yearSlider.value);
  yearDisplay.textContent = yearSlider.value;
});

document.getElementById('btn-year-down').addEventListener('click', () => {
  const val = Math.max(1950, parseInt(yearSlider.value) - 1);
  yearSlider.value = val;
  state.guessedYear = val;
  yearDisplay.textContent = val;
});

document.getElementById('btn-year-up').addEventListener('click', () => {
  const val = Math.min(MAX_YEAR, parseInt(yearSlider.value) + 1);
  yearSlider.value = val;
  state.guessedYear = val;
  yearDisplay.textContent = val;
});

document.getElementById('btn-submit-guess').addEventListener('click', () => {
  if (state.hasSubmitted) return;
  state.hasSubmitted = true;
  document.getElementById('btn-submit-guess').disabled = true;
  document.getElementById('guess-submitted-msg').classList.remove('hidden');
  socket.emit('round:answer', { code: state.roomCode, year: state.guessedYear });
});

// ─── Reveal ───────────────────────────────────────────────────────────────────
function showReveal(track, results) {
  // Reveal song info
  document.getElementById('np-title').textContent = track.name;
  document.getElementById('np-artist').textContent = track.artist;
  document.getElementById('np-year').textContent = track.year;
  ['np-title', 'np-artist', 'np-year'].forEach(id =>
    document.getElementById(id).classList.add('revealed')
  );

  // Build reveal screen
  document.getElementById('reveal-title').textContent = track.name;
  document.getElementById('reveal-artist').textContent = track.artist;
  document.getElementById('reveal-year').textContent = track.year;

  const resultsEl = document.getElementById('reveal-results');
  resultsEl.innerHTML = '';
  Object.values(results).forEach(r => {
    const row = document.createElement('div');
    if (r.steal) {
      const outcome = r.stolenCard ? '✅ Stole the card!'
        : r.stealCorrect ? '✔ Right spot, but the card was already won'
        : '❌ Wrong spot';
      row.className = `reveal-result-row ${r.stolenCard ? 'correct' : 'wrong'}`;
      row.innerHTML = `
        <span class="rr-name">${esc(r.name)}</span>
        <span class="rr-guess">Steal</span>
        <span class="rr-outcome">${outcome}</span>
      `;
    } else {
      row.className = `reveal-result-row ${r.placementCorrect ? 'correct' : 'wrong'}`;
      row.innerHTML = `
        <span class="rr-name">${esc(r.name)}</span>
        <span class="rr-guess">Guessed: ${esc(r.guessedYear)}</span>
        <span class="rr-outcome">${r.placementCorrect ? '✅' : '❌'}</span>
      `;
    }
    resultsEl.appendChild(row);
  });

  // My timeline is rebuilt from the room:state that follows every reveal

  // Show next button and host controls for host
  document.getElementById('btn-next-round').classList.toggle('hidden', !state.isHost);
  document.getElementById('reveal-waiting').classList.toggle('hidden', state.isHost);
  const overridePanel = document.getElementById('host-year-override');
  if (state.isHost) {
    overridePanel.classList.remove('hidden');
    document.getElementById('input-override-year').value = track.year;
  } else {
    overridePanel.classList.add('hidden');
  }

  showScreen('screen-reveal');
}

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('round:next', { code: state.roomCode });
  showScreen('screen-game');
});

// ─── Winner ───────────────────────────────────────────────────────────────────
function showWinner(winnerName, players) {
  const winner = players.find(p => p.name === winnerName);
  document.getElementById('winner-name').textContent = winnerName;
  document.getElementById('winner-score').textContent = winner?.score || '10';
  showScreen('screen-winner');
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  socket.emit('game:restart', { code: state.roomCode });
  document.getElementById('my-timeline').innerHTML = '<div class="timeline-empty">No songs yet — get the first one right!</div>';
  document.getElementById('my-score-badge').textContent = '0';
  showScreen('screen-room');
});

// ─── Spotify Web Playback SDK ─────────────────────────────────────────────────
// Requires HTTPS. Falls back to active Spotify device if SDK unavailable.

window.onSpotifyWebPlaybackSDKReady = () => {
  if (state.accessToken) initSpotifyPlayer(state.accessToken);
};

function loadSpotifySDK() {
  if (document.getElementById('spotify-sdk')) return;
  const script = document.createElement('script');
  script.id = 'spotify-sdk';
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  document.body.appendChild(script);
}

function initSpotifyPlayer(token) {
  if (location.protocol !== 'https:') {
    document.getElementById('player-status').textContent = '⚠️ HTTPS required for in-browser audio';
    return;
  }
  loadSpotifySDK();

  const tryInit = () => {
    if (!window.Spotify) { setTimeout(tryInit, 200); return; }

    // Disconnect any existing player before creating a new one
    if (state.spotifyPlayer) {
      state.spotifyPlayer.disconnect();
      state.spotifyPlayer = null;
      state.spotifyDeviceId = null;
    }

    const player = new Spotify.Player({
      name: 'Hitster Game',
      // Always use latest token from state so it never goes stale
      getOAuthToken: cb => cb(state.accessToken),
      volume: 0.8
    });

    player.addListener('ready', async ({ device_id }) => {
      console.log('SDK ready, device_id:', device_id);
      state.spotifyDeviceId = device_id;
      state.spotifyPlayer = player;
      document.getElementById('player-status').textContent = '⏳ Activating player…';

      // Poll devices list until Spotify's backend registers this device, then transfer
      const statusEl = document.getElementById('player-status');
      statusEl.textContent = '⏳ Activating player…';
      let activated = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
            headers: { Authorization: `Bearer ${state.accessToken}` }
          });
          const devData = await devRes.json();
          // Match by name — Spotify sometimes assigns a different ID than what ready() reported
          const found = devData.devices?.find(d => d.id === device_id) ||
                        devData.devices?.find(d => d.name === 'Hitster Game');
          console.log(`Poll ${attempt}: devices =`, devData.devices?.map(d => d.name + '/' + d.id));
          if (found) {
            // Use the actual device ID from the list, not the one from ready()
            state.spotifyDeviceId = found.id;
            await fetch('https://api.spotify.com/v1/me/player', {
              method: 'PUT',
              headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ device_ids: [found.id], play: false })
            });
            console.log('Device activated:', found.name, found.id, 'after', attempt, 'poll(s)');
            statusEl.textContent = '🎵 Spotify ready';
            activated = true;
            break;
          }
        } catch (e) {
          console.warn('Poll error:', e);
        }
      }
      if (!activated) {
        console.warn('SDK device never appeared in devices list after 10 polls');
        statusEl.textContent = '⚠️ Browser player unavailable — using Spotify app';
        state.spotifyDeviceId = null;
      }

      // Play any track that was queued while SDK was initialising
      if (state.pendingUri) {
        const uri = state.pendingUri;
        state.pendingUri = null;
        setTimeout(() => playWithSDK(uri), 500);
      }
    });

    player.addListener('not_ready', ({ device_id }) => {
      console.warn('SDK device went offline:', device_id);
      if (state.spotifyDeviceId === device_id) state.spotifyDeviceId = null;
      document.getElementById('player-status').textContent = '⚠️ Player disconnected';
    });

    player.addListener('initialization_error', ({ message }) => {
      console.error('SDK init error:', message);
      document.getElementById('player-status').textContent = 'Init error: ' + message;
    });

    player.addListener('authentication_error', ({ message }) => {
      console.error('SDK auth error:', message);
      document.getElementById('player-status').textContent = 'Auth error — reconnect Spotify';
    });

    player.addListener('account_error', ({ message }) => {
      console.error('SDK account error:', message);
      document.getElementById('player-status').textContent = '⚠️ Spotify Premium required';
    });

    player.connect().then(success => {
      if (!success) console.error('SDK player failed to connect');
    });
  };

  tryInit();
}

// Play via SDK in-browser device — retries with backoff since Spotify can be slow to register
async function playWithSDK(uri, attempt = 1) {
  const statusEl = document.getElementById('player-status');
  const maxAttempts = 5;
  const delays = [0, 1000, 2000, 3000, 5000];

  if (attempt > 1) {
    await new Promise(r => setTimeout(r, delays[attempt - 1]));
    statusEl.textContent = `⏳ Connecting… (attempt ${attempt}/${maxAttempts})`;
  }

  try {
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${state.spotifyDeviceId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri], position_ms: 30000 })
      }
    );
    if (res.status === 204 || res.ok) {
      statusEl.textContent = '▶ Playing in browser';
    } else if (res.status === 404 && attempt < maxAttempts) {
      // Device not yet registered — retry
      console.warn(`SDK device not ready (attempt ${attempt}), retrying...`);
      playWithSDK(uri, attempt + 1);
    } else {
      const err = await res.json().catch(() => ({}));
      console.error('SDK play error:', res.status, err);
      statusEl.textContent = '⚠️ Browser playback failed — falling back to Spotify app';
      playOnActiveDevice(uri);
    }
  } catch (e) {
    console.error('SDK play exception:', e);
    playOnActiveDevice(uri);
  }
}

// Fallback: play on user's external Spotify app (phone/desktop)
async function playOnActiveDevice(uri) {
  const statusEl = document.getElementById('player-status');
  try {
    const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${state.accessToken}` }
    });
    const devData = await devRes.json();
    const device = devData.devices?.find(d => d.is_active) || devData.devices?.[0];
    if (!device) {
      statusEl.textContent = '⚠️ Open Spotify on any device to hear music';
      return;
    }
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri], position_ms: 30000 })
    });
    if (res.status === 204 || res.ok) {
      statusEl.textContent = `▶ Playing on: ${device.name}`;
    } else {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `Playback error (${res.status}): ${err?.error?.message || ''}`;
    }
  } catch (e) {
    statusEl.textContent = 'Playback failed — open Spotify on any device';
  }
}

async function playSpotifyTrack(uri) {
  if (!state.accessToken) return;

  if (state.spotifyDeviceId) {
    // SDK device is ready — play directly in browser
    playWithSDK(uri);
  } else if (location.protocol === 'https:') {
    // On HTTPS but SDK not ready yet — queue it
    state.pendingUri = uri;
    document.getElementById('player-status').textContent = '⏳ Connecting to Spotify…';
  } else {
    // HTTP — fall back to active external device
    playOnActiveDevice(uri);
  }
}

// ─── Preview fallback ─────────────────────────────────────────────────────────
let previewAudio = null;

function playPreview(url) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (!url) {
    document.getElementById('player-status').textContent = 'No preview available';
    return;
  }
  previewAudio = new Audio(url);
  previewAudio.volume = 0.8;
  previewAudio.play().then(() => {
    document.getElementById('player-status').textContent = '▶ Playing preview…';
  }).catch(() => {
    const btn = document.getElementById('btn-preview-play');
    btn.classList.remove('hidden');
    btn.onclick = () => { previewAudio.play(); btn.classList.add('hidden'); };
    document.getElementById('player-status').textContent = 'Click to play preview';
  });
}

// ─── Volume control ──────────────────────────────────────────────────────────
document.getElementById('volume-slider').addEventListener('input', (e) => {
  const vol = parseFloat(e.target.value);
  document.getElementById('volume-display').textContent = Math.round(vol * 100) + '%';
  if (state.spotifyPlayer) {
    state.spotifyPlayer.setVolume(vol);
  }
});

// ─── Steal countdown (host only) ─────────────────────────────────────────────
let stealCountdownInterval = null;

function startStealCountdown() {
  clearStealCountdown();
  const btn = document.getElementById('btn-end-steal');
  let seconds = 15;
  btn.textContent = `✓ Reveal Now (${seconds}s)`;
  stealCountdownInterval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearStealCountdown();
      btn.textContent = '✓ Reveal Now';
    } else {
      btn.textContent = `✓ Reveal Now (${seconds}s)`;
    }
  }, 1000);
}

function clearStealCountdown() {
  if (stealCountdownInterval) {
    clearInterval(stealCountdownInterval);
    stealCountdownInterval = null;
  }
}

// Clear countdown when reveal happens
socket.on('round:reveal', ({ track, results }) => {
  clearStealCountdown();
  showReveal(track, results);
});

// ─── Skip & Steal ─────────────────────────────────────────────────────────────
document.getElementById('btn-skip-song').addEventListener('click', () => {
  if (confirm('Spend 1 token to skip to the next song?')) {
    socket.emit('round:skip', { code: state.roomCode });
    document.getElementById('btn-skip-song').classList.add('hidden');
    document.getElementById('btn-free-card').classList.add('hidden');
  }
});

document.getElementById('btn-free-card').addEventListener('click', () => {
  if (confirm('Spend 3 tokens for a free card from the playlist?')) {
    socket.emit('round:free_card', { code: state.roomCode });
    document.getElementById('btn-free-card').classList.add('hidden');
  }
});

socket.on('free_card:awarded', ({ playerName, track }) => {
  const isMe = playerName === state.playerName;
  const msg = isMe
    ? `🎁 Free card! "${track.name}" (${track.year}) added to your timeline`
    : `🎁 ${playerName} used 3 tokens for a free card: "${track.name}" (${track.year})`;
  const el = document.createElement('div');
  el.className = 'steal-result correct';
  el.textContent = msg;
  document.getElementById('guess-panel').insertBefore(el, document.getElementById('guess-panel').firstChild);
  setTimeout(() => el.remove(), 5000);
});

document.getElementById('btn-attempt-steal').addEventListener('click', () => {
  const me = state.roomState?.players?.find(p => p.id === state.playerId);
  const myTokens = me?.tokens || 0;
  if (myTokens < 1) return alert('Need 1 token to steal');

  // Use the timeline sent by the server during steal:window
  const activeTimeline = state.stealTimeline || [];
  const activePlayerName = state.roomState?.players?.find(p => p.id === state.roomState?.currentPlayerId)?.name || 'Player';

  const gapsEl = document.getElementById('steal-gaps');
  gapsEl.innerHTML = '';

  // Label showing whose timeline we're targeting
  const targetLabel = document.createElement('div');
  targetLabel.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:4px;';
  targetLabel.textContent = `Targeting: ${activePlayerName}'s timeline`;
  gapsEl.appendChild(targetLabel);

  const buildGap = (index, label) => {
    const btn = document.createElement('button');
    btn.className = 'steal-gap-btn';
    btn.textContent = label || '← Place here';
    btn.addEventListener('click', () => {
      socket.emit('round:steal', { code: state.roomCode, gapIndex: index });
      document.getElementById('steal-panel').classList.add('hidden');
      document.getElementById('btn-attempt-steal').classList.add('hidden');
    });
    return btn;
  };

  const buildCard = (text) => {
    const div = document.createElement('div');
    div.className = 'steal-gap-card';
    div.textContent = text;
    return div;
  };

  if (activeTimeline.length === 0) {
    gapsEl.appendChild(buildGap(0, 'Place here (empty timeline)'));
  } else {
    gapsEl.appendChild(buildGap(0, '← Before everything'));
    activeTimeline.forEach((track, i) => {
      gapsEl.appendChild(buildCard(`${track.year} — ${track.name}`));
      gapsEl.appendChild(buildGap(i + 1, '← Place here'));
    });
  }

  document.getElementById('steal-panel').classList.remove('hidden');
  document.getElementById('btn-attempt-steal').classList.add('hidden');
});

document.getElementById('btn-end-steal').addEventListener('click', () => {
  socket.emit('steal:end', { code: state.roomCode });
  document.getElementById('btn-end-steal').classList.add('hidden');
});

document.getElementById('btn-cancel-steal').addEventListener('click', () => {
  document.getElementById('steal-panel').classList.add('hidden');
  const me = state.roomState?.players?.find(p => p.id === state.playerId);
  if ((me?.tokens || 0) >= 1) {
    document.getElementById('btn-attempt-steal').classList.remove('hidden');
  }
});

// ─── Host Card Editor ─────────────────────────────────────────────────────────
let editorSelectedPlayerId = null;

function openEditor() {
  const modal = document.getElementById('modal-editor');
  modal.classList.remove('hidden');
  renderEditorTabs();
}

function closeEditor() {
  document.getElementById('modal-editor').classList.add('hidden');
}

function renderEditorTabs() {
  const tabs = document.getElementById('editor-player-tabs');
  tabs.innerHTML = '';
  const players = state.roomState?.players || [];
  if (!editorSelectedPlayerId || !players.find(p => p.id === editorSelectedPlayerId)) {
    editorSelectedPlayerId = players[0]?.id;
  }
  players.forEach(p => {
    const tab = document.createElement('button');
    tab.className = 'editor-tab' + (p.id === editorSelectedPlayerId ? ' active' : '');
    tab.textContent = p.name;
    tab.addEventListener('click', () => {
      editorSelectedPlayerId = p.id;
      renderEditorTabs();
      renderEditorTimeline();
    });
    tabs.appendChild(tab);
  });
  renderEditorTimeline();
}

function renderEditorTimeline() {
  const container = document.getElementById('editor-timeline');
  container.innerHTML = '';
  const player = state.roomState?.players?.find(p => p.id === editorSelectedPlayerId);
  if (!player) return;
  const timeline = (player.timeline || []).slice().sort((a, b) => a.year - b.year);
  if (timeline.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No cards yet</p>';
    return;
  }
  timeline.forEach(card => {
    const row = document.createElement('div');
    row.className = 'editor-card-row';
    row.innerHTML = `
      <span class="editor-card-year">${card.year}</span>
      <span class="editor-card-name">${esc(card.name)}</span>
      <span class="editor-card-artist">${esc(card.artist)}</span>
      <button class="editor-remove-btn">✕</button>
    `;
    row.querySelector('.editor-remove-btn').addEventListener('click', () => {
      socket.emit('card:remove', { code: state.roomCode, playerId: editorSelectedPlayerId, cardId: card.id });
    });
    container.appendChild(row);
  });
}

document.getElementById('btn-open-editor').addEventListener('click', openEditor);
document.getElementById('btn-close-editor').addEventListener('click', closeEditor);
document.getElementById('modal-editor').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-editor')) closeEditor();
});

document.getElementById('btn-editor-add').addEventListener('click', () => {
  const name = document.getElementById('editor-card-name').value.trim();
  const artist = document.getElementById('editor-card-artist').value.trim();
  const year = parseInt(document.getElementById('editor-card-year').value);
  if (!name || !year || year < 1900 || year > MAX_YEAR) return alert('Enter a valid song name and year');
  socket.emit('card:add', { code: state.roomCode, playerId: editorSelectedPlayerId, card: { name, artist, year } });
  document.getElementById('editor-card-name').value = '';
  document.getElementById('editor-card-artist').value = '';
  document.getElementById('editor-card-year').value = '';
});

// Refresh editor when cards are updated
socket.on('cards:updated', ({ playerId, timeline }) => {
  if (state.roomState?.players) {
    const player = state.roomState.players.find(p => p.id === playerId);
    if (player) player.timeline = timeline;
  }
  if (!document.getElementById('modal-editor').classList.contains('hidden')) {
    renderEditorTimeline();
  }
  // Also refresh local timeline display if it's our cards
  if (playerId === state.playerId) {
    rebuildTimeline(timeline);
  }
});

function rebuildTimeline(timeline) {
  const container = document.getElementById('my-timeline');
  container.innerHTML = '';
  const sorted = [...timeline].sort((a, b) => a.year - b.year);
  if (sorted.length === 0) {
    container.innerHTML = '<div class="timeline-empty">No songs yet — get the first one right!</div>';
    return;
  }
  sorted.forEach(card => {
    const el = document.createElement('div');
    el.className = 'timeline-card';
    el.dataset.year = card.year;
    el.innerHTML = `
      <div class="tc-year">${esc(card.year)}</div>
      <div class="tc-title">${esc(card.name)}</div>
      <div class="tc-artist">${esc(card.artist)}</div>
    `;
    container.appendChild(el);
  });
  document.getElementById('my-score-badge').textContent = sorted.length;
}

// ─── Year Override (reveal screen) ───────────────────────────────────────────
document.getElementById('btn-override-year').addEventListener('click', () => {
  const year = parseInt(document.getElementById('input-override-year').value);
  if (!year || year < 1900 || year > MAX_YEAR) return alert('Enter a valid year');
  socket.emit('round:override_year', { code: state.roomCode, correctYear: year });
});
