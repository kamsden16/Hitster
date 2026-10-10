require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();

// ─── Server ──────────────────────────────────────────────────────────────────
// HTTPS is terminated by Railway/cloud proxy — always run plain HTTP here
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  transports: ['websocket', 'polling'],
  cors: { origin: '*' }
});

const PORT = parseInt(process.env.PORT || '3000');
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const WIN_SCORE = parseInt(process.env.WIN_SCORE || '10');
// How long a disconnected player is held before the game moves on / their seat is released
const TURN_GRACE_MS = parseInt(process.env.TURN_GRACE_MS || '30000');   // active player gone mid-turn
const HOST_GRACE_MS = parseInt(process.env.HOST_GRACE_MS || '30000');   // host gone → promote someone
const REMOVE_AFTER_MS = parseInt(process.env.REMOVE_AFTER_MS || String(5 * 60 * 1000)); // seat released
const CACHE_FILE = path.join(__dirname, 'album-cache.json');

// ─── Album year cache ─────────────────────────────────────────────────────────
// Uses Redis if REDIS_URL is set (Railway), otherwise falls back to local JSON file
let redisClient = null;
const REDIS_CACHE_KEY = 'hitster:album-cache';

async function initRedis() {
  if (!process.env.REDIS_URL) return;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
    console.log('Redis connected');
  } catch (err) {
    console.error('Redis init failed, falling back to file cache:', err.message);
    redisClient = null;
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`Loaded file cache: ${Object.keys(data).length} albums`);
      return data;
    }
  } catch (err) {
    console.error('Failed to load file cache:', err.message);
  }
  return {};
}

async function loadCacheFromRedis() {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(REDIS_CACHE_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      console.log(`Loaded Redis cache: ${Object.keys(parsed).length} albums`);
      return parsed;
    }
  } catch (err) {
    console.error('Redis load error:', err.message);
  }
  return null;
}

function saveCache(cache) {
  // Save to file always (local fallback)
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (err) {
    console.error('Failed to save file cache:', err.message);
  }
  // Also save to Redis if available
  if (redisClient) {
    redisClient.set(REDIS_CACHE_KEY, JSON.stringify(cache)).catch(err =>
      console.error('Redis save error:', err.message)
    );
  }
}

// Initialised in startup below
const albumCache = loadCache();
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── In-memory state ─────────────────────────────────────────────────────────
const rooms = {};
const userTokens = {};

// ─── Spotify OAuth ────────────────────────────────────────────────────────────
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

app.get('/auth/login', (req, res) => {
  const socketId = req.query.socketId;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${BASE_URL}/auth/callback`,
    scope: SPOTIFY_SCOPES,
    state: socketId
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: socketId } = req.query;
  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE_URL}/auth/callback`,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    userTokens[socketId] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000
    };

    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (userTokens[socketId]) userTokens[socketId].display_name = profileRes.data.display_name;

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('auth:success', {
        access_token,
        display_name: profileRes.data.display_name
      });
    }
    res.send('<script>window.close();</script><p>Logged in! You can close this window.</p>');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.send('<p>Authentication failed. Please close this window and try again.</p>');
  }
});

app.get('/auth/logout', (req, res) => {
  const { socketId } = req.query;
  if (socketId && userTokens[socketId]) delete userTokens[socketId];
  res.json({ ok: true });
});

// ─── Token refresh ────────────────────────────────────────────────────────────
async function refreshToken(socketId) {
  const tokens = userTokens[socketId];
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  try {
    const res = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access_token = res.data.access_token;
    tokens.expires_at = Date.now() + res.data.expires_in * 1000;
    return tokens.access_token;
  } catch {
    return null;
  }
}

// ─── Spotify API helpers ──────────────────────────────────────────────────────
// onBackgroundTracks(tracks) is called with newly-yeared tracks as the background load progresses
async function getPlaylistTracks(socketId, playlistId, onBackgroundTracks) {
  let token = await refreshToken(socketId);
  if (!token) throw new Error('Not authenticated');

  // Step 1: fetch all playlist items
  // Note: Feb 2026 API change — items are under i.item (not i.track)
  let rawTracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;
  while (url) {
    try {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      const items = res.data.items.filter(i => i.item?.id && i.item?.album?.id && i.item?.type === 'track');
      rawTracks.push(...items.map(i => ({
        id: i.item.id,
        name: i.item.name,
        artist: i.item.artists.map(a => a.name).join(', '),
        albumId: i.item.album.id,
        uri: i.item.uri,
        preview_url: i.item.preview_url
      })));
      url = res.data.next;
    } catch (err) {
      console.error('Playlist fetch error:', err.response?.status, err.response?.data?.error?.message);
      throw err;
    }
  }

  // Step 2: fetch album release dates
  // Note: Feb 2026 API change — GET /albums bulk endpoint removed, must fetch one at a time
  // Uses a persistent on-disk cache so each album is only ever fetched once
  const allAlbumIds = [...new Set(rawTracks.map(t => t.albumId))];
  const uncachedIds = allAlbumIds.filter(id => !(id in albumCache));
  const INITIAL_CAP = 200; // fetch this many on first load so game can start quickly
  const DELAY_MS = 400;    // conservative delay to avoid rate limits

  console.log(`Albums: ${allAlbumIds.length} total, ${uncachedIds.length} not cached, ${allAlbumIds.length - uncachedIds.length} from cache`);

  // Returns 'ok', 'skip' (transient failure, not cached so it's retried next load) or 'auth' (token dead)
  async function fetchAlbumWithRetry(albumId, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Refresh per request — background loads can outlive the 1h access token.
      // If the host has disconnected their tokens are gone, so keep the last good one.
      token = (await refreshToken(socketId)) || token;
      try {
        const res = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const year = res.data.release_date ? parseInt(res.data.release_date.substring(0, 4)) : null;
        albumCache[albumId] = year;
        return 'ok';
      } catch (err) {
        const status = err.response?.status;
        if (status === 429) {
          const wait = Math.min(parseInt(err.response.headers['retry-after'] || '2') * 1000, 45000);
          console.log(`Rate limited — waiting ${wait / 1000}s… (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, wait));
        } else if (status === 401) {
          console.error('Album fetch: token expired/invalid — stopping album load');
          return 'auth';
        } else if (status === 404 || status === 400) {
          // Album genuinely doesn't exist — safe to remember that
          albumCache[albumId] = null;
          return 'ok';
        } else {
          // Network error / 5xx — don't cache, so it's retried on a future load
          console.error(`Album fetch error (${albumId}):`, status || err.message);
          return 'skip';
        }
      }
    }
    return 'skip';
  }

  const tracksForAlbums = ids => {
    const set = new Set(ids);
    return rawTracks
      .filter(t => set.has(t.albumId) && albumCache[t.albumId] > 0)
      .map(t => ({ ...t, year: albumCache[t.albumId] }));
  };

  // Initial load — fetch up to INITIAL_CAP uncached albums before returning
  const initialBatch = uncachedIds.slice(0, INITIAL_CAP);
  const remainingBatch = uncachedIds.slice(INITIAL_CAP);

  for (let i = 0; i < initialBatch.length; i++) {
    if (await fetchAlbumWithRetry(initialBatch[i]) === 'auth') break;
    if (i % 50 === 0 && i > 0) console.log(`Initial load progress: ${i}/${initialBatch.length}`);
    // Emit progress to socket so UI can show a progress bar
    if (i % 10 === 0) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('playlist:progress', {
        loaded: i + 1,
        total: uncachedIds.length,
        hasMore: remainingBatch.length > 0
      });
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (initialBatch.length > 0) saveCache(albumCache);

  const tracks = rawTracks
    .map(t => ({ ...t, year: albumCache[t.albumId] || 0 }))
    .filter(t => t.year > 0);

  console.log(`Playlist loaded: ${rawTracks.length} tracks, ${tracks.length} with release years (${remainingBatch.length} albums still queued for background load)`);

  // Background load remaining albums after returning — updates room playlist as years come in
  if (remainingBatch.length > 0) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.emit('playlist:progress', { loaded: initialBatch.length, total: uncachedIds.length, hasMore: true, background: true });

    setImmediate(async () => {
      console.log(`Background loading ${remainingBatch.length} remaining albums...`);
      let pendingIds = [];
      const flushTracks = () => {
        if (pendingIds.length && onBackgroundTracks) {
          const newTracks = tracksForAlbums(pendingIds);
          if (newTracks.length) onBackgroundTracks(newTracks);
        }
        pendingIds = [];
      };
      for (let i = 0; i < remainingBatch.length; i++) {
        const result = await fetchAlbumWithRetry(remainingBatch[i]);
        if (result === 'auth') break;
        pendingIds.push(remainingBatch[i]);
        await new Promise(r => setTimeout(r, DELAY_MS));
        if (i % 50 === 0) {
          saveCache(albumCache);
          flushTracks();
          // Notify host of background progress every 50 albums
          const s = io.sockets.sockets.get(socketId);
          if (s) s.emit('playlist:progress', {
            loaded: initialBatch.length + i + 1,
            total: uncachedIds.length,
            hasMore: i < remainingBatch.length - 1,
            background: true
          });
        }
      }
      saveCache(albumCache);
      flushTracks();
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('playlist:progress', { loaded: uncachedIds.length, total: uncachedIds.length, hasMore: false, background: true, done: true });
      console.log('Background album load complete');
    });
  }

  return tracks;
}

async function getUserPlaylists(socketId) {
  const token = await refreshToken(socketId);
  if (!token) throw new Error('Not authenticated');
  const res = await axios.get('https://api.spotify.com/v1/me/playlists?limit=50', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.items
    .filter(p => p)
    .map(p => ({ id: p.id, name: p.name, tracks: p.tracks?.total ?? '?' }));
}

// ─── Room helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.timeline.length,
      isHost: p.id === room.hostId,
      ready: p.ready,
      connected: p.connected !== false,
      tokens: p.tokens,
      timeline: [...p.timeline].sort((a, b) => a.year - b.year)
    })),
    currentPlayerId: room.currentPlayerId || null,
    currentTrack: room.currentTrack ? {
      id: room.currentTrack.id,
      uri: room.currentTrack.uri,
      preview_url: room.currentTrack.preview_url
    } : null,
    winScore: WIN_SCORE,
    winner: room.winner || null,
    // Someone has reached WIN_SCORE — game ends at the end of this rotation if they lead outright
    finalRound: room.players.some(p => p.timeline.length >= WIN_SCORE),
    turnInCycle: (room.cycleTurns || []).filter(id => room.players.some(p => p.id === id)).length,
    turnsPerCycle: room.players.length
  };
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────
const sortByYear = timeline => [...timeline].sort((a, b) => a.year - b.year);

// Is gapIndex (0 = before first card) a valid spot for trackYear on this sorted timeline?
function isGapCorrect(sortedTimeline, trackYear, gapIndex) {
  const strictlyBefore = sortedTimeline.filter(t => t.year < trackYear).length;
  const strictlyAfter = sortedTimeline.filter(t => t.year > trackYear).length;
  return gapIndex >= strictlyBefore && gapIndex <= sortedTimeline.length - strictlyAfter;
}

// The gap a year guess lands in
function gapForGuess(sortedTimeline, guessedYear) {
  return sortedTimeline.filter(t => t.year <= guessedYear).length;
}

// Unique leader with at least WIN_SCORE cards, or null if nobody qualifies / tied at the top
function findWinner(room) {
  if (!room.players.length) return null;
  const max = Math.max(...room.players.map(p => p.timeline.length));
  if (max < WIN_SCORE) return null;
  const leaders = room.players.filter(p => p.timeline.length === max);
  return leaders.length === 1 ? leaders[0] : null;
}

// Awards this round's card. Safe to call again (year override): it first strips the card
// from everyone, then re-scores against the timeline snapshot taken when the guess locked in.
function scoreRound(room) {
  const track = room.currentTrack;
  const results = {};
  room.players.forEach(p => { p.timeline = p.timeline.filter(c => c.id !== track.id); });

  const activePlayer = room.players.find(p => p.id === room.currentPlayerId);
  const snapshot = room.roundTimelineSnapshot || (activePlayer ? sortByYear(activePlayer.timeline) : []);
  let cardWinnerId = null;

  // Step 1: active player — they win ties
  if (activePlayer && room.roundAnswers[activePlayer.id] !== undefined) {
    const guessedYear = room.roundAnswers[activePlayer.id];
    const placementCorrect = isGapCorrect(snapshot, track.year, gapForGuess(snapshot, guessedYear));
    if (placementCorrect) {
      cardWinnerId = activePlayer.id;
      activePlayer.timeline.push({ ...track });
    }
    results[activePlayer.id] = { name: activePlayer.name, guessedYear, placementCorrect, score: activePlayer.timeline.length };
  }

  // Step 2: steals, in the order they were made — first correct one wins if the active player missed
  for (const attempt of room.stealAttempts || []) {
    const stealer = room.players.find(p => p.id === attempt.socketId);
    if (!stealer) continue;
    const correct = isGapCorrect(snapshot, track.year, attempt.gapIndex);
    let won = false;
    if (correct && !cardWinnerId) {
      cardWinnerId = stealer.id;
      stealer.timeline.push({ ...track });
      won = true;
    }
    results[stealer.id] = { name: stealer.name, steal: true, stealCorrect: correct, stolenCard: won, score: stealer.timeline.length };
  }

  return results;
}

function revealPayload(track, results, extra = {}) {
  return {
    track: { id: track.id, name: track.name, artist: track.artist, year: track.year, uri: track.uri, preview_url: track.preview_url },
    results,
    ...extra
  };
}

function clearStealTimer(room) {
  if (room.stealTimeout) { clearTimeout(room.stealTimeout); room.stealTimeout = null; }
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function roundStartPayload(track) {
  return { trackId: track.id, uri: track.uri, preview_url: track.preview_url };
}

// ─── Player presence / rejoin ─────────────────────────────────────────────────
// A disconnected player keeps their seat, timeline and tokens. They come back by joining the
// same room with the same name; their id is re-pointed at the new socket (see rebindPlayer),
// so the rest of the game keeps working off player.id === socket.id.
const normName = n => String(n || '').trim().toLowerCase();

function clearPlayerTimers(player) {
  if (player.removeTimer) { clearTimeout(player.removeTimer); player.removeTimer = null; }
  if (player.hostTimer) { clearTimeout(player.hostTimer); player.hostTimer = null; }
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearStealTimer(room);
  clearTurnTimer(room);
  room.players.forEach(clearPlayerTimers);
  delete rooms[code];
}

// If the active player is offline during the guess phase, let the song play out (TURN_GRACE_MS),
// then ask the host whether to skip their turn or keep waiting. Never skips on its own.
// Safe to call any time: it re-evaluates from scratch.
function watchActivePlayer(code) {
  const room = rooms[code];
  if (!room) return;
  clearTurnTimer(room);
  const active = room.players.find(p => p.id === room.currentPlayerId);
  const absent = room.phase === 'round' && active && active.connected === false;
  if (!absent) {
    // Player is back (or the round moved on) — withdraw any pending question
    if (room.absentPrompt) io.to(code).emit('turn:absent_cleared');
    room.absentPrompt = null;
    room.hostWaiting = null;
    return;
  }
  if (room.absentPrompt || room.hostWaiting === active.id) return; // already asked / host chose to wait
  if (!room.players.some(p => p.connected !== false)) return; // nobody here to ask
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (rooms[code] !== room || room.phase !== 'round') return;
    const still = room.players.find(p => p.id === room.currentPlayerId);
    if (!still || still.connected !== false) return;
    room.absentPrompt = still.id;
    promptHostAbsent(room);
  }, TURN_GRACE_MS);
}

function promptHostAbsent(room) {
  if (!room.absentPrompt) return;
  const absent = room.players.find(p => p.id === room.absentPrompt);
  const host = io.sockets.sockets.get(room.hostId);
  if (absent && host) host.emit('turn:absent', { playerName: absent.name });
}

// Release a seat for good (offline too long)
function removePlayer(code, player) {
  const room = rooms[code];
  if (!room) return;
  const idx = room.players.indexOf(player);
  if (idx === -1) return;
  clearPlayerTimers(player);
  const wasActive = room.currentPlayerId === player.id;
  const wasHost = room.hostId === player.id;
  room.players.splice(idx, 1);
  delete userTokens[player.id];
  if (room.players.length === 0) return destroyRoom(code);
  if (wasHost) room.hostId = (room.players.find(p => p.connected !== false) || room.players[0]).id;
  if (wasActive && ['round', 'steal'].includes(room.phase)) {
    // Point "current" at the previous seat so the rotation continues from the leaver's spot.
    room.currentPlayerId = room.players[(idx - 1 + room.players.length) % room.players.length].id;
    startRound(code);
  } else {
    io.to(code).emit('room:state', getRoomState(room));
  }
}

function markDisconnected(code, player) {
  const room = rooms[code];
  player.connected = false;
  clearPlayerTimers(player);
  player.removeTimer = setTimeout(() => removePlayer(code, player), REMOVE_AFTER_MS);
  if (room.hostId === player.id) {
    // Don't leave the room without a working host for long
    player.hostTimer = setTimeout(() => {
      player.hostTimer = null;
      if (rooms[code] !== room || room.hostId !== player.id || player.connected !== false) return;
      const next = room.players.find(p => p.connected !== false);
      if (next) {
        room.hostId = next.id;
        io.to(code).emit('room:state', getRoomState(room));
        promptHostAbsent(room);
      }
    }, HOST_GRACE_MS);
  }
  watchActivePlayer(code);
  io.to(code).emit('room:state', getRoomState(room));
}

// Re-point every reference to the player's old socket id at their new one.
// Returns true if Spotify tokens were carried over to the new socket.
function rebindPlayer(room, player, newId) {
  const oldId = player.id;
  if (oldId === newId) return false;
  player.id = newId;
  if (room.hostId === oldId) room.hostId = newId;
  if (room.currentPlayerId === oldId) room.currentPlayerId = newId;
  room.cycleTurns = (room.cycleTurns || []).map(id => (id === oldId ? newId : id));
  if (room.roundAnswers && oldId in room.roundAnswers) {
    room.roundAnswers[newId] = room.roundAnswers[oldId];
    delete room.roundAnswers[oldId];
  }
  (room.stealAttempts || []).forEach(a => { if (a.socketId === oldId) a.socketId = newId; });
  // Spotify tokens follow the player — unless they've already logged in on the new socket
  let carried = false;
  if (!userTokens[newId] && userTokens[oldId]) { userTokens[newId] = userTokens[oldId]; carried = true; }
  delete userTokens[oldId];
  return carried;
}

// Bring a returning player's screen up to date with the phase the room is in
function resyncPlayer(socket, room) {
  const track = room.currentTrack;
  if (['round', 'steal'].includes(room.phase) && track) {
    socket.emit('round:start', roundStartPayload(track));
  }
  if (room.phase === 'steal') {
    const active = room.players.find(p => p.id === room.currentPlayerId);
    socket.emit('steal:window', {
      guessedYear: room.currentPlayerGuess,
      activePlayerName: active?.name || 'Player',
      activePlayerTimeline: room.roundTimelineSnapshot || [],
      alreadyStole: (room.stealAttempts || []).some(a => a.socketId === socket.id)
    });
  } else if (room.phase === 'reveal' && room.lastReveal) {
    socket.emit('round:reveal', room.lastReveal);
  }
}

function rejoinPlayer(socket, room, player) {
  const code = room.code;
  clearPlayerTimers(player);
  const oldId = player.id;
  let carriedTokens = false;
  if (oldId !== socket.id) {
    // Re-point first so the stale socket's eventual disconnect finds nobody to mark offline
    carriedTokens = rebindPlayer(room, player, socket.id);
    const stale = io.sockets.sockets.get(oldId);
    if (stale) {
      stale.leave(code);
      stale.emit('room:error', 'You joined this game from another device or tab');
    }
  }
  player.connected = true;
  socket.join(code);
  socket.emit('room:joined', { code, playerId: socket.id, rejoinToken: player.rejoinToken, rejoined: true });
  io.to(code).emit('room:state', getRoomState(room));
  resyncPlayer(socket, room);
  watchActivePlayer(code);
  if (room.hostId === socket.id) promptHostAbsent(room);
  console.log(`Rejoined: ${player.name} → ${code}`);

  if (carriedTokens) {
    refreshToken(socket.id).then(access_token => {
      if (access_token) socket.emit('auth:success', { access_token, display_name: userTokens[socket.id]?.display_name || player.name });
    });
  }
}

function revealRound(code) {
  const room = rooms[code];
  // Only a live steal window can be revealed — guards against a stale timer firing in a later round
  if (!room || room.phase !== 'steal') return;
  clearStealTimer(room);
  room.phase = 'reveal';
  const results = scoreRound(room);
  room.lastReveal = revealPayload(room.currentTrack, results);
  io.to(code).emit('round:reveal', room.lastReveal);
  io.to(code).emit('room:state', getRoomState(room));
}

// keepPlayer: same player goes again with a new song (token skip)
function startRound(code, { keepPlayer = false } = {}) {
  const room = rooms[code];
  if (!room || !room.players.length) return;
  clearStealTimer(room);
  clearTurnTimer(room);
  room.absentPrompt = null;
  room.hostWaiting = null;
  room.lastReveal = null;
  room.cycleTurns = room.cycleTurns || [];

  if (!keepPlayer || !room.players.some(p => p.id === room.currentPlayerId)) {
    // End of a full rotation? Check for a winner before anyone starts a new one.
    const everyoneHasGone = room.currentPlayerId && room.players.every(p => room.cycleTurns.includes(p.id));
    if (everyoneHasGone) {
      const winner = findWinner(room);
      if (winner) {
        room.phase = 'ended';
        room.winner = winner.name;
        io.to(code).emit('room:state', getRoomState(room));
        return;
      }
      room.cycleTurns = [];
    }
    // Next player in seat order after the current one who hasn't gone this rotation
    const currentIdx = room.players.findIndex(p => p.id === room.currentPlayerId);
    let next = null;
    for (let step = 1; step <= room.players.length; step++) {
      const candidate = room.players[(currentIdx + step + room.players.length) % room.players.length];
      if (!room.cycleTurns.includes(candidate.id)) { next = candidate; break; }
    }
    if (!next) { room.cycleTurns = []; next = room.players[(currentIdx + 1 + room.players.length) % room.players.length]; }
    room.currentPlayerId = next.id;
    room.cycleTurns.push(next.id);
  }

  // Pick a song nobody has used — and that isn't already sitting on someone's timeline
  const onTimelines = new Set(room.players.flatMap(p => p.timeline.map(c => c.id)));
  let available = room.playlist.filter(t => !room.usedTracks.includes(t.id) && !onTimelines.has(t.id));
  if (!available.length) {
    room.usedTracks = [];
    room.playlist = shuffle(room.playlist);
    available = room.playlist.filter(t => !onTimelines.has(t.id));
  }
  const track = available[0] || room.playlist[0];
  room.usedTracks.push(track.id);
  room.currentTrack = track;
  room.roundAnswers = {};
  room.stealAttempts = [];
  room.roundTimelineSnapshot = null;
  room.phase = 'round';
  room.players.forEach(p => p.ready = false);

  io.to(code).emit('room:state', getRoomState(room));
  io.to(code).emit('round:start', roundStartPayload(track));
  watchActivePlayer(code);
}

function validYear(y) {
  const n = parseInt(y);
  return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear() + 1 ? n : null;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('room:create', ({ playerName }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      phase: 'lobby',
      players: [],
      playlist: [],
      usedTracks: [],
      currentTrack: null,
      winner: null,
      roundAnswers: {}
    };
    socket.join(code);
    const rejoinToken = crypto.randomBytes(12).toString('hex');
    rooms[code].players.push({ id: socket.id, name: playerName, timeline: [], ready: false, tokens: 2, connected: true, rejoinToken });
    socket.emit('room:joined', { code, playerId: socket.id, rejoinToken });
    io.to(code).emit('room:state', getRoomState(rooms[code]));
  });

  // Joins a room — or, if a player with this name is offline in it (or this is their own session
  // token), takes that seat back with timeline and tokens intact. `auto` = silent reconnect by the client.
  socket.on('room:join', ({ code, playerName, rejoinToken, auto }) => {
    code = String(code || '').trim().toUpperCase();
    const fail = msg => socket.emit(auto ? 'room:rejoin_failed' : 'room:error', msg);
    const room = rooms[code];
    if (!room) return fail('Room not found');
    if (room.players.find(p => p.id === socket.id)) return;

    const sameName = room.players.filter(p => normName(p.name) === normName(playerName));
    const seat = sameName.find(p => rejoinToken && p.rejoinToken === rejoinToken)
      || sameName.find(p => p.connected === false);
    if (seat) return rejoinPlayer(socket, room, seat);

    if (auto) return fail('Your seat is gone');
    if (room.phase !== 'lobby') {
      return fail(sameName.length ? 'That name is already connected' : 'Game already in progress');
    }
    socket.join(code);
    const token = crypto.randomBytes(12).toString('hex');
    room.players.push({ id: socket.id, name: playerName, timeline: [], ready: false, tokens: 2, connected: true, rejoinToken: token });
    socket.emit('room:joined', { code, playerId: socket.id, rejoinToken: token });
    io.to(code).emit('room:state', getRoomState(room));
  });

  socket.on('room:get_state', ({ code }) => {
    const room = rooms[code];
    if (room) socket.emit('room:state', getRoomState(room));
  });

  socket.on('playlist:load', async ({ code, playlistId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const loadId = (room.playlistLoadId || 0) + 1;
    room.playlistLoadId = loadId;
    try {
      // Tracks whose album years arrive in the background get shuffled into this room's playlist
      const addBackgroundTracks = newTracks => {
        const r = rooms[code];
        if (!r || r.playlistLoadId !== loadId) return; // room gone or host loaded a different playlist
        const known = new Set(r.playlist.map(t => t.id));
        for (const t of newTracks) {
          if (known.has(t.id)) continue;
          r.playlist.splice(Math.floor(Math.random() * (r.playlist.length + 1)), 0, t);
        }
        const host = io.sockets.sockets.get(r.hostId);
        if (host) host.emit('playlist:loaded', { count: r.playlist.length });
      };
      const tracks = await getPlaylistTracks(socket.id, playlistId, addBackgroundTracks);
      if (tracks.length < WIN_SCORE + 5) {
        return socket.emit('room:error', `Playlist needs at least ${WIN_SCORE + 5} tracks with release years.`);
      }
      if (room.playlistLoadId !== loadId) return;
      room.playlist = shuffle(tracks);
      socket.emit('playlist:loaded', { count: tracks.length });
      io.to(code).emit('room:state', getRoomState(room));
    } catch (err) {
      socket.emit('room:error', 'Failed to load playlist: ' + err.message);
    }
  });

  socket.on('playlists:fetch', async () => {
    try {
      const playlists = await getUserPlaylists(socket.id);
      socket.emit('playlists:list', playlists);
    } catch (err) {
      socket.emit('room:error', 'Failed to fetch playlists');
    }
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (!room.playlist.length) return socket.emit('room:error', 'Load a playlist first');
    clearStealTimer(room);
    room.currentPlayerId = null;
    room.cycleTurns = [];
    room.winner = null;
    room.phase = 'playing';
    startRound(code);
  });

  socket.on('round:answer', ({ code, year }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return; // only active player can answer
    const player = room.players.find(p => p.id === socket.id);
    const guess = parseInt(year);
    if (!player || player.ready || !Number.isInteger(guess)) return;

    room.roundAnswers[socket.id] = guess;
    room.currentPlayerGuess = guess;
    player.ready = true;
    // Freeze the timeline everyone is judged against this round
    room.roundTimelineSnapshot = sortByYear(player.timeline);

    // Open steal window — others can now spend tokens to steal
    room.phase = 'steal';
    room.stealAttempts = [];

    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('steal:window', {
      guessedYear: guess,
      activePlayerName: player.name,
      activePlayerTimeline: room.roundTimelineSnapshot
    });

    // Auto-advance to reveal after 15 seconds
    clearStealTimer(room);
    room.stealTimeout = setTimeout(() => revealRound(code), 15000);
  });

  // Any non-active player can spend 1 token to steal during steal phase (one attempt each)
  socket.on('round:steal', ({ code, gapIndex }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'steal') return;
    if (socket.id === room.currentPlayerId) return;
    const stealer = room.players.find(p => p.id === socket.id);
    if (!stealer) return;
    const gap = parseInt(gapIndex);
    const maxGap = (room.roundTimelineSnapshot || []).length;
    if (!Number.isInteger(gap) || gap < 0 || gap > maxGap) return;
    if (stealer.tokens < 1) return socket.emit('room:error', 'Need 1 token to steal');
    if (room.stealAttempts.some(a => a.socketId === socket.id)) return socket.emit('room:error', 'You already made a steal this round');
    if (room.stealAttempts.some(a => a.gapIndex === gap)) return socket.emit('room:error', 'Someone already picked that gap');

    stealer.tokens -= 1;
    // Correctness is resolved at reveal (and re-resolved if the host overrides the year)
    room.stealAttempts.push({ socketId: socket.id, gapIndex: gap });

    const activePlayer = room.players.find(p => p.id === room.currentPlayerId);
    io.to(code).emit('steal:attempt', {
      stealerName: stealer.name,
      targetName: activePlayer?.name || 'Player',
      gapIndex: gap
    });
    io.to(code).emit('room:state', getRoomState(room));
  });

  // Host or active player closes steal window and triggers reveal
  socket.on('steal:end', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'steal') return;
    if (socket.id !== room.hostId && socket.id !== room.currentPlayerId) return;
    revealRound(code);
  });

  // Host's answer to "active player is offline — skip them or keep waiting?"
  socket.on('turn:absent_decision', ({ code, action }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.phase !== 'round' || !room.absentPrompt) return;
    const absentId = room.absentPrompt;
    const still = room.players.find(p => p.id === absentId);
    room.absentPrompt = null;
    if (!still || still.connected !== false || room.currentPlayerId !== absentId) return; // they came back meanwhile
    if (action === 'skip') startRound(code);
    else room.hostWaiting = absentId; // keep waiting; no more prompts until they return or the host moves on
  });

  // ─── Token management ────────────────────────────────────────────────────────
  socket.on('token:adjust', ({ code, playerId, delta }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.tokens = Math.min(5, Math.max(0, player.tokens + (delta > 0 ? 1 : -1)));
    io.to(code).emit('room:state', getRoomState(room));
  });

  // Active player spends 1 token to skip the current song — they keep their turn with a new song
  socket.on('round:skip', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.tokens < 1) return socket.emit('room:error', 'Need 1 token to skip');
    player.tokens -= 1;
    io.to(code).emit('token:skipped', { playerName: player.name });
    startRound(code, { keepPlayer: true });
  });

  // Active player spends 3 tokens for a free card — draws next track onto their timeline
  // without changing the current song being played
  socket.on('round:free_card', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.tokens < 3) return socket.emit('room:error', 'Need 3 tokens for a free card');

    const onTimelines = new Set(room.players.flatMap(p => p.timeline.map(c => c.id)));
    const available = room.playlist.filter(t =>
      !room.usedTracks.includes(t.id) && !onTimelines.has(t.id) && t.id !== room.currentTrack?.id);
    if (!available.length) return socket.emit('room:error', 'No more tracks available');

    player.tokens -= 3;
    const freeTrack = available[0];
    room.usedTracks.push(freeTrack.id);
    player.timeline.push({ ...freeTrack });

    io.to(code).emit('free_card:awarded', {
      playerName: player.name,
      track: { name: freeTrack.name, artist: freeTrack.artist, year: freeTrack.year }
    });
    io.to(code).emit('room:state', getRoomState(room));
  });

  socket.on('round:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (!['reveal', 'round', 'steal'].includes(room.phase)) return;
    clearStealTimer(room); // otherwise a pending steal timer could reveal the NEXT round
    startRound(code);
  });

  socket.on('game:restart', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    clearStealTimer(room);
    room.players.forEach(p => { p.timeline = []; p.ready = false; p.tokens = 2; });
    room.usedTracks = [];
    room.currentTrack = null;
    room.currentPlayerId = null;
    room.cycleTurns = [];
    room.stealAttempts = [];
    room.roundTimelineSnapshot = null;
    room.winner = null;
    room.roundAnswers = {};
    room.playlist = shuffle(room.playlist);
    room.phase = 'lobby';
    io.to(code).emit('room:state', getRoomState(room));
  });

  // ─── Host card management ────────────────────────────────────────────────────

  // Add a card manually to a player's timeline
  socket.on('card:add', ({ code, playerId, card }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player || !card) return;
    const year = validYear(card.year);
    if (!year) return socket.emit('room:error', 'Invalid year');
    const newCard = {
      id: 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: String(card.name || 'Unknown').slice(0, 200),
      artist: String(card.artist || '').slice(0, 200),
      year,
      uri: null,
      preview_url: null,
      manual: true
    };
    player.timeline.push(newCard);
    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('cards:updated', { playerId, timeline: player.timeline });
  });

  // Remove a card from a player's timeline by card id
  socket.on('card:remove', ({ code, playerId, cardId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.timeline = player.timeline.filter(c => c.id !== cardId);
    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('cards:updated', { playerId, timeline: player.timeline });
  });

  // Override the year of the current round's track and re-score the whole round (guess + steals)
  socket.on('round:override_year', ({ code, correctYear }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'reveal') return;
    const track = room.currentTrack;
    if (!track) return;
    const year = validYear(correctYear);
    if (!year) return socket.emit('room:error', 'Invalid year');
    track.year = year;

    // Also update albumCache so future loads use the correct year
    if (track.albumId) {
      albumCache[track.albumId] = track.year;
      // Other songs from the same album share the bad date — fix them in this room too
      room.playlist.forEach(t => { if (t.albumId === track.albumId) t.year = track.year; });
    }
    saveCache(albumCache);

    const results = scoreRound(room);
    room.lastReveal = revealPayload(track, results, { yearOverridden: true });
    io.to(code).emit('round:reveal', room.lastReveal);
    io.to(code).emit('room:state', getRoomState(room));
  });

  socket.on('disconnect', () => {
    let inRoom = false;
    for (const code in rooms) {
      const player = rooms[code].players.find(p => p.id === socket.id);
      if (!player) continue;
      inRoom = true;
      // Keep the seat (and Spotify tokens) so they can rejoin; the game moves on if it has to
      markDisconnected(code, player);
    }
    if (!inRoom) delete userTokens[socket.id];
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  // Load Redis cache and merge with file cache if available
  await initRedis();
  const redisCache = await loadCacheFromRedis();
  if (redisCache) {
    Object.assign(albumCache, redisCache); // Redis wins conflicts (it holds year overrides)
    console.log(`Merged Redis cache: ${Object.keys(albumCache).length} total albums`);
  }
  // Seed Redis with anything the file cache knows that Redis doesn't (e.g. the committed album-cache.json)
  if (redisClient) {
    const redisCount = redisCache ? Object.keys(redisCache).length : 0;
    const mergedCount = Object.keys(albumCache).length;
    if (mergedCount > redisCount) {
      try {
        await redisClient.set(REDIS_CACHE_KEY, JSON.stringify(albumCache));
        console.log(`Seeded Redis cache: ${redisCount} → ${mergedCount} albums`);
      } catch (err) {
        console.error('Redis seed error:', err.message);
      }
    }
  }

  httpServer.listen(PORT, () => {
    console.log(`🎵 Hitster running on port ${PORT}`);
    if (process.env.RAILWAY_STATIC_URL) {
      console.log(`   Public URL: https://${process.env.RAILWAY_STATIC_URL}`);
    }
  });
}

start();
