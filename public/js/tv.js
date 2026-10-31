// ─── HITSTER TV display ──────────────────────────────────────────────────────
// Runs on the laptop plugged into the TV. Logs into Spotify, attaches to a TV-mode room, picks the
// playlist and plays every song through the Spotify Web Playback SDK. Players only get a thin client.
const socket = io();

const SESSION_KEY = 'hitster:tv';
const DEVICE_NAME = 'Hitster TV';
const state = {
  code: null,
  roomState: null,
  accessToken: null,
  player: null,
  deviceId: null,
  deviceReady: false,
  audioEnabled: false,
  pendingUri: null,
  stealEndsAt: 0,
  stealTimer: null
};

const $ = id => document.getElementById(id);
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showScreen(id) {
  document.querySelectorAll('.tv-screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg) {
  const t = el('div', 'tv-toast', msg);
  $('tv-toasts').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

function banner(msg) {
  const b = $('tv-banner');
  b.textContent = msg || '';
  b.classList.toggle('hidden', !msg);
}

// ─── Socket: connection / login / attach ─────────────────────────────────────
socket.on('connect', () => {
  banner('');
  const session = loadSession();
  if (session?.code) {
    socket.emit('display:attach', { code: session.code, token: session.token });
  } else if (!state.accessToken) {
    showScreen('tv-login');
  }
});

socket.on('disconnect', () => banner('Connection lost — reconnecting…'));

socket.on('auth:success', ({ access_token }) => {
  state.accessToken = access_token;
  if (!state.player) initPlayer();
  if ($('tv-login').classList.contains('active')) {
    const session = loadSession();
    if (session?.code) socket.emit('display:attach', { code: session.code, token: session.token });
    else showScreen('tv-attach');
  }
});

$('btn-tv-login').addEventListener('click', () => {
  window.open(`/auth/login?socketId=${socket.id}`, '_blank', 'width=500,height=700');
});

const codeInput = $('tv-code-input');
codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 5);

function attachFromInput() {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 5) return;
  $('tv-attach-error').classList.add('hidden');
  const session = loadSession();
  socket.emit('display:attach', { code, token: session?.code === code ? session.token : undefined });
}
$('btn-tv-attach').addEventListener('click', attachFromInput);
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') attachFromInput(); });

socket.on('display:attached', ({ code, token }) => {
  state.code = code;
  saveSession({ code, token });
  banner('');
  // A plain socket reconnect: our player and audio unlock are still alive, so we're ready again
  emitReady();
});

socket.on('display:attach_failed', ({ reason, message }) => {
  if (reason === 'login') {
    showScreen('tv-login');
    return;
  }
  if (reason === 'gone') clearSession();
  showScreen('tv-attach');
  const err = $('tv-attach-error');
  err.textContent = message;
  err.classList.remove('hidden');
});

socket.on('display:replaced', () => {
  clearSession();
  banner('Another screen took over as the TV for this room.');
  socket.disconnect();
});

socket.on('room:gone', () => {
  clearSession();
  state.code = null;
  state.roomState = null;
  showScreen('tv-attach');
  const err = $('tv-attach-error');
  err.textContent = 'That room has ended.';
  err.classList.remove('hidden');
});

socket.on('room:error', msg => toast(msg));

// ─── Room state → screens ────────────────────────────────────────────────────
socket.on('room:state', rs => {
  state.roomState = rs;
  if (rs.phase === 'lobby') {
    showScreen('tv-lobby');
    renderLobby(rs);
  } else if (rs.phase === 'ended' && rs.winner) {
    const w = rs.players.find(p => p.name === rs.winner);
    $('tv-winner-name').textContent = rs.winner;
    $('tv-winner-sub').textContent = `with ${w ? w.score : rs.winScore} songs on their timeline`;
    showScreen('tv-winner');
  } else {
    showScreen('tv-game');
    renderGame(rs);
  }
  banner(rs.phase !== 'lobby' && rs.phase !== 'ended' && rs.waitingForTv ? 'Waiting for audio — tap "Enable audio" to continue' : '');
});

function renderLobby(rs) {
  $('tv-room-code').textContent = rs.code;
  $('tv-join-url').textContent = location.host;
  const qr = $('tv-qr');
  const src = `/qr/${rs.code}.svg`;
  if (qr.getAttribute('src') !== src) qr.setAttribute('src', src);

  const list = $('tv-players');
  list.innerHTML = '';
  rs.players.forEach(p => {
    const li = el('li', p.connected === false ? 'offline' : '', p.name);
    if (p.isHost) li.appendChild(el('span', 'player-host-badge', 'HOST'));
    list.appendChild(li);
  });
  if (!rs.players.length) list.appendChild(el('li', '', 'Waiting for players…'));

  const note = $('tv-ready-note');
  if (!rs.tvReady) {
    note.textContent = 'Enable audio above, then load a playlist.';
    note.className = 'tv-status bad';
  } else if (!rs.playlistCount) {
    note.textContent = 'Audio ready ✓ — now load a playlist.';
    note.className = 'tv-status';
  } else {
    note.textContent = `All set ✓ ${rs.playlistCount} tracks — the host can start the game on their phone.`;
    note.className = 'tv-status ok';
  }
}

function renderGame(rs) {
  const current = rs.players.find(p => p.id === rs.currentPlayerId);
  $('tv-turn').textContent = current ? `🎵 ${current.name}'s turn` : '';
  const turn = rs.turnInCycle ? `Turn ${rs.turnInCycle}/${rs.turnsPerCycle}` : '';
  $('tv-roundinfo').textContent = rs.finalRound ? `🏁 Final round${turn ? ' · ' + turn : ''} — outright leader wins` : turn;

  const cols = $('tv-columns');
  cols.innerHTML = '';
  rs.players.forEach(p => {
    const col = el('div', 'tv-col' + (p.id === rs.currentPlayerId ? ' active' : '') + (p.connected === false ? ' offline' : '') + (p.timeline.length > 8 ? ' dense' : ''));
    const head = el('div', 'tv-col-head');
    head.appendChild(el('div', 'tv-col-name', p.name + (p.connected === false ? ' 💤' : '')));
    head.appendChild(el('div', 'tv-col-meta', `🃏${p.score}  🪙${p.tokens}`));
    col.appendChild(head);
    const cards = el('div', 'tv-cards');
    if (!p.timeline.length) cards.appendChild(el('div', 'tv-empty', 'No songs yet'));
    p.timeline.forEach(c => {
      const card = el('div', 'tv-card');
      card.appendChild(el('b', '', String(c.year)));
      card.appendChild(el('span', '', c.name));
      cards.appendChild(card);
    });
    col.appendChild(cards);
    cols.appendChild(col);
  });
}

// ─── Round events ────────────────────────────────────────────────────────────
function resetSongCard() {
  $('tv-song').classList.add('unrevealed');
  $('tv-song-title').textContent = '???';
  $('tv-song-artist').innerHTML = '&nbsp;';
  $('tv-song-year').textContent = '????';
  $('tv-results').classList.add('hidden');
  hideSteal();
}

socket.on('round:start', ({ uri }) => {
  resetSongCard();
  if (uri) playTrack(uri);
});

function hideSteal() {
  clearInterval(state.stealTimer);
  state.stealTimer = null;
  $('tv-steal').classList.add('hidden');
}

socket.on('steal:window', ({ guessedYear, activePlayerName, stealMsLeft }) => {
  $('tv-results').classList.add('hidden');
  $('tv-steal-text').textContent = `${activePlayerName} guessed ${guessedYear} — steal their card?`;
  state.stealEndsAt = Date.now() + (stealMsLeft || 0);
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.stealEndsAt - Date.now()) / 1000));
    $('tv-steal-time').textContent = left;
    if (left <= 0) clearInterval(state.stealTimer);
  };
  clearInterval(state.stealTimer);
  tick();
  state.stealTimer = setInterval(tick, 250);
  $('tv-steal').classList.remove('hidden');
});

socket.on('steal:attempt', ({ stealerName, targetName }) => toast(`🪙 ${stealerName} attempted a steal on ${targetName}`));
socket.on('token:skipped', ({ playerName }) => toast(`⏭ ${playerName} skipped the song`));
socket.on('free_card:awarded', ({ playerName, track }) => toast(`🎁 ${playerName} used 3 tokens for a free card: "${track.name}" (${track.year})`));

socket.on('round:reveal', ({ track, results, yearOverridden }) => {
  hideSteal();
  $('tv-song').classList.remove('unrevealed');
  $('tv-song-title').textContent = track.name;
  $('tv-song-artist').textContent = track.artist;
  $('tv-song-year').textContent = track.year;
  const box = $('tv-results');
  box.innerHTML = '';
  Object.values(results).forEach(r => {
    let text, ok;
    if (r.steal) {
      ok = r.stolenCard;
      text = `${r.name}: ${r.stolenCard ? '✅ stole the card!' : r.stealCorrect ? '✔ right spot, card already won' : '❌ wrong spot'}`;
    } else {
      ok = r.placementCorrect;
      text = `${r.name} guessed ${r.guessedYear} ${r.placementCorrect ? '✅' : '❌'}`;
    }
    box.appendChild(el('div', ok ? 'r-ok' : 'r-bad', text));
  });
  if (yearOverridden) box.appendChild(el('div', 'r-bad', '(year corrected by host)'));
  box.classList.remove('hidden');
});

// ─── Playlist (picked on the TV) ─────────────────────────────────────────────
function extractPlaylistId(input) {
  if (!input) return null;
  const m = input.match(/playlist\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9]{22}$/.test(input) ? input : null;
}

$('btn-tv-playlists').addEventListener('click', () => socket.emit('playlists:fetch'));

socket.on('playlists:list', playlists => {
  const dd = $('tv-playlists');
  dd.innerHTML = '';
  dd.classList.remove('hidden');
  playlists.forEach(p => {
    const item = el('div', 'playlist-item');
    item.appendChild(el('span', '', p.name));
    item.appendChild(el('span', '', `${p.tracks} tracks`));
    item.addEventListener('click', () => {
      $('tv-playlist-input').value = p.id;
      dd.classList.add('hidden');
      loadPlaylist();
    });
    dd.appendChild(item);
  });
});

function loadPlaylist() {
  const id = extractPlaylistId($('tv-playlist-input').value.trim());
  const status = $('tv-playlist-status');
  if (!id) { status.textContent = 'Enter a valid Spotify playlist link or ID'; status.className = 'tv-status bad'; return; }
  status.textContent = 'Loading playlist…';
  status.className = 'tv-status';
  socket.emit('playlist:load', { code: state.code, playlistId: id });
}
$('btn-tv-load').addEventListener('click', loadPlaylist);

socket.on('playlist:loaded', ({ count }) => {
  const status = $('tv-playlist-status');
  status.textContent = `✓ Loaded ${count} tracks`;
  status.className = 'tv-status ok';
  $('tv-progress').classList.add('hidden');
});

socket.on('playlist:progress', ({ loaded, total, background, done }) => {
  $('tv-progress').classList.remove('hidden');
  $('tv-progress-fill').style.width = Math.round((loaded / total) * 100) + '%';
  $('tv-progress-label').textContent = done ? `✓ All ${total} albums cached`
    : background ? `⏳ Caching albums in background… ${loaded}/${total}` : `Loading album years… ${loaded}/${total}`;
  if (done) setTimeout(() => $('tv-progress').classList.add('hidden'), 3000);
});

// ─── Spotify playback ────────────────────────────────────────────────────────
function setAudioStatus(text, cls) {
  const s = $('tv-audio-status');
  s.textContent = text;
  s.className = 'tv-status' + (cls ? ' ' + cls : '');
}

function emitReady() {
  socket.emit('display:ready', { ready: !!(state.audioEnabled && state.deviceReady) });
}

// Fresh access token from the server (they expire hourly)
function getToken() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(state.accessToken), 5000);
    socket.emit('display:token', t => {
      clearTimeout(timer);
      if (t) state.accessToken = t;
      resolve(state.accessToken);
    });
  });
}

async function spotifyApi(path, options = {}) {
  const token = await getToken();
  return fetch('https://api.spotify.com/v1' + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

function initPlayer() {
  if (!window.isSecureContext) {
    const w = $('tv-login-warn');
    w.textContent = '⚠️ Spotify audio needs HTTPS. Open this page over https:// (the deployed site) or via localhost.';
    w.classList.remove('hidden');
    setAudioStatus('⚠️ HTTPS required for audio', 'bad');
    return;
  }
  setAudioStatus('Starting Spotify player…');
  if (!document.getElementById('spotify-sdk')) {
    const script = document.createElement('script');
    script.id = 'spotify-sdk';
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    document.body.appendChild(script);
  }
  const create = () => {
    if (!window.Spotify) { setTimeout(create, 200); return; }
    const player = new Spotify.Player({
      name: DEVICE_NAME,
      getOAuthToken: cb => getToken().then(cb),
      volume: parseFloat($('tv-volume').value)
    });
    state.player = player;

    player.addListener('ready', async ({ device_id }) => {
      state.deviceId = device_id;
      setAudioStatus('Activating player…');
      let activated = false;
      for (let attempt = 1; attempt <= 10 && !activated; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const res = await spotifyApi('/me/player/devices');
          const data = await res.json();
          const found = data.devices?.find(d => d.id === device_id) || data.devices?.find(d => d.name === DEVICE_NAME);
          if (found) {
            state.deviceId = found.id;
            await spotifyApi('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [found.id], play: false }) });
            activated = true;
          }
        } catch (e) { console.warn('Device poll error:', e); }
      }
      if (!activated) { setAudioStatus('⚠️ Player never appeared — is this a Premium account?', 'bad'); return; }
      state.deviceReady = true;
      setAudioStatus(state.audioEnabled ? '🎵 Spotify ready' : 'Player ready — tap "Enable audio"', state.audioEnabled ? 'ok' : '');
      emitReady();
      if (state.pendingUri) { const uri = state.pendingUri; state.pendingUri = null; setTimeout(() => playTrack(uri), 500); }
    });
    player.addListener('not_ready', () => {
      state.deviceReady = false;
      setAudioStatus('⚠️ Player disconnected', 'bad');
      emitReady();
    });
    player.addListener('initialization_error', ({ message }) => setAudioStatus('Init error: ' + message, 'bad'));
    player.addListener('authentication_error', ({ message }) => setAudioStatus('Auth error — reload and reconnect Spotify', 'bad'));
    player.addListener('account_error', () => setAudioStatus('⚠️ Spotify Premium required', 'bad'));
    // Stop when the song ends, so Spotify's Autoplay can't roll on into a "similar" song
    player.addListener('player_state_changed', s => handleSdkState(player, s));
    player.connect();
    $('btn-tv-audio').classList.remove('hidden');
  };
  window.onSpotifyWebPlaybackSDKReady = create;
  if (window.Spotify) create();
}

// Browsers only allow sound after a click — the SDK needs activateElement() inside one
$('btn-tv-audio').addEventListener('click', () => {
  try { state.player?.activateElement?.(); } catch {}
  state.audioEnabled = true;
  $('btn-tv-audio').classList.add('hidden');
  setAudioStatus(state.deviceReady ? '🎵 Spotify ready' : 'Activating player…', state.deviceReady ? 'ok' : '');
  emitReady();
});
$('btn-tv-audio').classList.add('hidden');

// ─── Stop at the end of the song ──────────────────────────────────────────────
// Songs play once from the start. When one finishes, Spotify's Autoplay may start a
// "similar" song; if anything other than the round's song plays after it, we pause.
const isRoundTrack = (t, uri) => !!t && (t.uri === uri || t.linked_from?.uri === uri);
let sdkEndTimer = null;

function handleSdkState(player, s) {
  const uri = state.currentUri;
  if (!s || s.paused || !uri) return;
  const tw = s.track_window || {};
  if (isRoundTrack(tw.current_track, uri)) {
    // Backstop in case Autoplay doesn't show up in previous_tracks: check just after the song should end
    clearTimeout(sdkEndTimer);
    sdkEndTimer = setTimeout(async () => {
      if (state.currentUri !== uri) return;
      const now = await player.getCurrentState().catch(() => null);
      if (now && !now.paused && !isRoundTrack(now.track_window?.current_track, uri)) player.pause().catch(() => {});
    }, Math.max(0, s.duration - s.position) + 1500);
  } else if ((tw.previous_tracks || []).some(t => isRoundTrack(t, uri))) {
    player.pause().catch(() => {});
  }
}

async function playTrack(uri, attempt = 1) {
  state.currentUri = uri;
  if (!state.deviceId || !state.deviceReady) { state.pendingUri = uri; return; }
  if (attempt > 1) await new Promise(r => setTimeout(r, [0, 1000, 2000, 3000, 5000][attempt - 1] || 5000));
  try {
    const res = await spotifyApi(`/me/player/play?device_id=${state.deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [uri], position_ms: 0 })
    });
    if (res.ok) setAudioStatus('▶ Playing', 'ok');
    else if (res.status === 404 && attempt < 5) playTrack(uri, attempt + 1);
    else setAudioStatus(`⚠️ Playback failed (${res.status})`, 'bad');
  } catch (e) {
    setAudioStatus('⚠️ Playback failed', 'bad');
  }
}

$('tv-volume').addEventListener('input', e => state.player?.setVolume(parseFloat(e.target.value)));
