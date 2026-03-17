require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
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
async function getPlaylistTracks(socketId, playlistId) {
  const token = await refreshToken(socketId);
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

  async function fetchAlbumWithRetry(albumId, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const year = res.data.release_date ? parseInt(res.data.release_date.substring(0, 4)) : null;
        albumCache[albumId] = year;
        return;
      } catch (err) {
        if (err.response?.status === 429) {
          const wait = Math.min(parseInt(err.response.headers['retry-after'] || '2') * 1000, 45000);
          console.log(`Rate limited — waiting ${wait / 1000}s… (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.error(`Album fetch error (${albumId}):`, err.response?.status);
          albumCache[albumId] = null;
          return;
        }
      }
    }
  }

  // Initial load — fetch up to INITIAL_CAP uncached albums before returning
  const initialBatch = uncachedIds.slice(0, INITIAL_CAP);
  const remainingBatch = uncachedIds.slice(INITIAL_CAP);

  for (let i = 0; i < initialBatch.length; i++) {
    await fetchAlbumWithRetry(initialBatch[i]);
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
      for (let i = 0; i < remainingBatch.length; i++) {
        await fetchAlbumWithRetry(remainingBatch[i]);
        await new Promise(r => setTimeout(r, DELAY_MS));
        if (i % 50 === 0) {
          saveCache(albumCache);
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
    winner: room.winner || null
  };
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
    rooms[code].players.push({ id: socket.id, name: playerName, timeline: [], ready: false, tokens: 2 });
    socket.emit('room:joined', { code, playerId: socket.id });
    io.to(code).emit('room:state', getRoomState(rooms[code]));
  });

  socket.on('room:join', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('room:error', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('room:error', 'Game already in progress');
    if (room.players.find(p => p.id === socket.id)) return;
    socket.join(code);
    room.players.push({ id: socket.id, name: playerName, timeline: [], ready: false, tokens: 2 });
    socket.emit('room:joined', { code, playerId: socket.id });
    io.to(code).emit('room:state', getRoomState(room));
  });

  socket.on('room:get_state', ({ code }) => {
    const room = rooms[code];
    if (room) socket.emit('room:state', getRoomState(room));
  });

  socket.on('playlist:load', async ({ code, playlistId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    try {
      const tracks = await getPlaylistTracks(socket.id, playlistId);
      if (tracks.length < WIN_SCORE + 5) {
        return socket.emit('room:error', `Playlist needs at least ${WIN_SCORE + 5} tracks with release years.`);
      }
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
    room.phase = 'playing';
    startRound(code);
  });

  function startRound(code) {
    const room = rooms[code];
    if (!room) return;

    const winner = room.players.find(p => p.timeline.length >= WIN_SCORE);
    if (winner) {
      room.phase = 'ended';
      room.winner = winner.name;
      io.to(code).emit('room:state', getRoomState(room));
      return;
    }

    const available = room.playlist.filter(t => !room.usedTracks.includes(t.id));
    if (!available.length) {
      room.playlist = shuffle(room.playlist);
      room.usedTracks = [];
    }
    const track = available[0] || room.playlist[0];
    room.usedTracks.push(track.id);
    room.currentTrack = track;
    room.roundAnswers = {};
    room.cardClaimed = null;
    room.phase = 'round';
    room.players.forEach(p => p.ready = false);
    // Track whose turn it is (rotate through players)
    const currentIdx = room.players.findIndex(p => p.id === room.currentPlayerId);
    const nextIdx = (currentIdx + 1) % room.players.length;
    room.currentPlayerId = room.players[nextIdx].id;

    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('round:start', {
      trackId: track.id,
      uri: track.uri,
      preview_url: track.preview_url
    });
  }

  socket.on('round:answer', ({ code, year }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return; // only active player can answer
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.ready) return;

    room.roundAnswers[socket.id] = parseInt(year);
    room.currentPlayerGuess = parseInt(year);
    player.ready = true;

    // Open steal window — others can now spend tokens to steal
    room.phase = 'steal';
    room.stealAttempts = {}; // track claimed gaps (gapIndex -> socketId)

    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('steal:window', {
      guessedYear: room.currentPlayerGuess,
      activePlayerName: player.name,
      activePlayerTimeline: [...player.timeline].sort((a, b) => a.year - b.year)
    });

    // Auto-advance to reveal after 15 seconds
    room.stealTimeout = setTimeout(() => revealRound(code), 15000);
  });

  // Any non-active player can spend 1 token to steal during steal phase
  socket.on('round:steal', ({ code, gapIndex }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'steal') return;
    if (socket.id === room.currentPlayerId) return;
    const stealer = room.players.find(p => p.id === socket.id);
    if (!stealer) return;
    if (stealer.tokens < 1) return socket.emit('room:error', 'Need 1 token to steal');
    if (room.stealAttempts[gapIndex] !== undefined) return socket.emit('room:error', 'Someone already picked that gap');

    const track = room.currentTrack;
    const activePlayer = room.players.find(p => p.id === room.currentPlayerId);
    const timeline = [...activePlayer.timeline].sort((a, b) => a.year - b.year);
    const strictlyBefore = timeline.filter(t => t.year < track.year).length;
    const strictlyAfter = timeline.filter(t => t.year > track.year).length;
    const stealCorrect = gapIndex >= strictlyBefore && gapIndex <= (timeline.length - strictlyAfter);

    stealer.tokens -= 1;
    // Record attempt — correctness resolved at reveal, not here
    // (we don't know if Player A was right until reveal)
    room.stealAttempts[gapIndex] = { socketId: socket.id, correct: stealCorrect };

    io.to(code).emit('steal:attempt', {
      stealerName: stealer.name,
      targetName: activePlayer.name,
      gapIndex
    });
    io.to(code).emit('room:state', getRoomState(room));
  });

  // Host or active player closes steal window and triggers reveal
  socket.on('steal:end', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'steal') return;
    if (socket.id !== room.hostId && socket.id !== room.currentPlayerId) return;
    if (room.stealTimeout) { clearTimeout(room.stealTimeout); room.stealTimeout = null; }
    revealRound(code);
  });

  function revealRound(code) {
    const room = rooms[code];
    if (!room || room.phase === 'reveal') return;
    if (room.stealTimeout) { clearTimeout(room.stealTimeout); room.stealTimeout = null; }
    room.phase = 'reveal';
    const track = room.currentTrack;
    const results = {};

    // Step 1: check active player's guess — they win ties
    const activePlayer = room.players.find(p => p.id === room.currentPlayerId);
    let cardWinnerId = null;
    if (activePlayer) {
      const guessedYear = room.roundAnswers[activePlayer.id];
      const timeline = [...activePlayer.timeline].sort((a, b) => a.year - b.year);
      const strictlyBefore = timeline.filter(t => t.year < track.year).length;
      const strictlyAfter = timeline.filter(t => t.year > track.year).length;
      const beforeGuess = timeline.filter(t => t.year <= guessedYear).length;
      const placementCorrect = beforeGuess >= strictlyBefore && beforeGuess <= (timeline.length - strictlyAfter);
      if (placementCorrect) {
        cardWinnerId = activePlayer.id;
        activePlayer.timeline.push({ ...track });
      }
      results[activePlayer.id] = { name: activePlayer.name, guessedYear, placementCorrect, score: activePlayer.timeline.length };
    }

    // Step 2: if active player was wrong, find first correct steal (by gap insertion order)
    if (!cardWinnerId && room.stealAttempts) {
      for (const [gapIndex, attempt] of Object.entries(room.stealAttempts)) {
        if (attempt.correct) {
          const stealer = room.players.find(p => p.id === attempt.socketId);
          if (stealer) {
            cardWinnerId = stealer.id;
            stealer.timeline.push({ ...track });
            results[stealer.id] = { name: stealer.name, stolenCard: true, score: stealer.timeline.length };
          }
          break; // only first correct steal wins
        }
      }
    }

    io.to(code).emit('round:reveal', {
      track: { id: track.id, name: track.name, artist: track.artist, year: track.year, uri: track.uri, preview_url: track.preview_url },
      results
    });
    io.to(code).emit('room:state', getRoomState(room));
  }

  // ─── Token management ────────────────────────────────────────────────────────
  socket.on('token:adjust', ({ code, playerId, delta }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.tokens = Math.min(5, Math.max(0, player.tokens + delta));
    io.to(code).emit('room:state', getRoomState(room));
  });

  // Active player spends 1 token to skip current song and move to next
  socket.on('round:skip', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.tokens < 1) return socket.emit('room:error', 'Need 1 token to skip');
    player.tokens -= 1;
    room.phase = 'playing';
    io.to(code).emit('token:skipped', { playerName: player.name });
    startRound(code);
  });

  // Active player spends 3 tokens for a free card — draws next track onto their timeline
  // without changing the current song being played
  socket.on('round:free_card', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'round') return;
    if (socket.id !== room.currentPlayerId) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.tokens < 3) return socket.emit('room:error', 'Need 3 tokens for a free card');

    // Pick a track not yet used and not the current one
    const available = room.playlist.filter(t => !room.usedTracks.includes(t.id) && t.id !== room.currentTrack?.id);
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
    room.phase = 'playing';
    startRound(code);
  });

  socket.on('game:restart', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    room.players.forEach(p => { p.timeline = []; p.ready = false; p.tokens = 2; });
    room.usedTracks = [];
    room.currentTrack = null;
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
    if (!player) return;
    // card = { name, artist, year }
    const newCard = {
      id: 'manual-' + Date.now(),
      name: card.name || 'Unknown',
      artist: card.artist || '',
      year: parseInt(card.year),
      uri: null,
      preview_url: null,
      manual: true
    };
    player.timeline.push(newCard);
    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('cards:updated', { playerId, timeline: player.timeline });
  });

  // Remove a card from a player's timeline by card id or index
  socket.on('card:remove', ({ code, playerId, cardId }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.timeline = player.timeline.filter(c => c.id !== cardId);
    io.to(code).emit('room:state', getRoomState(room));
    io.to(code).emit('cards:updated', { playerId, timeline: player.timeline });
  });

  // Override the year of the current round's track and re-evaluate who got the card
  socket.on('round:override_year', ({ code, correctYear }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'reveal') return;
    const track = room.currentTrack;
    if (!track) return;
    const oldYear = track.year;
    track.year = parseInt(correctYear);

    // Also update albumCache so future loads use the correct year
    if (track.albumId) albumCache[track.albumId] = track.year;
    saveCache(albumCache);

    // Re-evaluate all players: remove this round's card entirely, then re-award if correct
    const results = {};
    room.players.forEach(p => {
      // Always strip any version of this card first (old year, new year, any year)
      p.timeline = p.timeline.filter(c => c.id !== track.id);

      // Re-check placement with corrected year
      const timeline = [...p.timeline].sort((a, b) => a.year - b.year);
      const guessedYear = room.roundAnswers[p.id];
      if (guessedYear === undefined) return;
      const strictlyBefore = timeline.filter(t => t.year < track.year).length;
      const strictlyAfter = timeline.filter(t => t.year > track.year).length;
      const beforeGuess = timeline.filter(t => t.year <= guessedYear).length;
      const placementCorrect = beforeGuess >= strictlyBefore && beforeGuess <= (timeline.length - strictlyAfter);
      if (placementCorrect) p.timeline.push({ ...track });
      results[p.id] = { name: p.name, guessedYear, placementCorrect, score: p.timeline.length };
    });

    io.to(code).emit('round:reveal', {
      track: { ...track },
      results,
      yearOverridden: true
    });
    io.to(code).emit('room:state', getRoomState(room));
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          io.to(code).emit('room:state', getRoomState(room));
        }
      }
    }
    delete userTokens[socket.id];
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  // Load Redis cache and merge with file cache if available
  await initRedis();
  const redisCache = await loadCacheFromRedis();
  if (redisCache) {
    Object.assign(albumCache, redisCache);
    console.log(`Merged Redis cache: ${Object.keys(albumCache).length} total albums`);
  }

  httpServer.listen(PORT, () => {
    console.log(`🎵 Hitster running on port ${PORT}`);
    if (process.env.RAILWAY_STATIC_URL) {
      console.log(`   Public URL: https://${process.env.RAILWAY_STATIC_URL}`);
    }
  });
}

start();
