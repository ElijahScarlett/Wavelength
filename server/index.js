// server/index.js
// Wavelength backend — Spotify OAuth + Apple Music token + rooms + real-time sync
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─────────────────────────────────────────────────────────
// IN-MEMORY ROOM STATE
// ─────────────────────────────────────────────────────────
const rooms = {};
// rooms[id] = {
//   queue: [],
//   currentTrack: null,
//   isPlaying: false,
//   positionMs: 0,
//   lastUpdateTs: Date.now(),
//   members: Map { socketId -> { name } }
// }

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = {
      queue: [],
      currentTrack: null,
      isPlaying: false,
      positionMs: 0,
      lastUpdateTs: Date.now(),
      members: new Map()
    };
  }
  return rooms[id];
}

function getLivePosition(room) {
  if (!room.isPlaying) return room.positionMs;
  return room.positionMs + (Date.now() - room.lastUpdateTs);
}

// ─────────────────────────────────────────────────────────
// SPOTIFY OAUTH
// ─────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI || 'https://wavelength-0nh9.onrender.com/callback';

app.get('/spotify/login', (req, res) => {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
    'user-read-playback-state'
  ].join(' ');
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         scopes,
    redirect_uri:  SPOTIFY_REDIRECT_URI
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      })
    });
    const data = await resp.json();
    if (!data.access_token) return res.status(400).send('Token exchange failed');
    // Send token back to opener via postMessage
    res.send(`
      <script>
        window.opener.postMessage({ type:'SPOTIFY_TOKEN', token:'${data.access_token}' }, '*');
        window.close();
      </script>
    `);
  } catch(e) {
    console.error('Spotify callback error:', e);
    res.status(500).send('Auth failed');
  }
});

// ─────────────────────────────────────────────────────────
// APPLE MUSIC DEVELOPER TOKEN
// ─────────────────────────────────────────────────────────
// Required env vars:
//   APPLE_TEAM_ID        — your Apple Developer Team ID (10-char)
//   APPLE_KEY_ID         — your MusicKit key ID (10-char)
//   APPLE_PRIVATE_KEY    — full PEM content of your AuthKey_XXXXXX.p8 file
//                          (or set APPLE_PRIVATE_KEY_PATH to the file path)
//
// How to get these:
//   1. Go to developer.apple.com → Certificates, Identifiers & Profiles → Keys
//   2. Create a new key, enable "MusicKit"
//   3. Download the .p8 file — that's your private key
//   4. Your Team ID is in the top-right of your Apple Developer account
//   5. The Key ID is shown when you create/view the key

let appleDevToken = null;
let appleDevTokenExpiry = 0;

function generateAppleDevToken() {
  const now = Math.floor(Date.now() / 1000);
  // Token cached for 23 hours (max is 6 months but we refresh often to be safe)
  if (appleDevToken && now < appleDevTokenExpiry) return appleDevToken;

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId  = process.env.APPLE_KEY_ID;

  if (!teamId || !keyId) {
    console.warn('Apple Music: APPLE_TEAM_ID or APPLE_KEY_ID not set in .env');
    return null;
  }

  let privateKey;
  if (process.env.APPLE_PRIVATE_KEY) {
    // Key stored directly in env (replace literal \n with newlines)
    privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (process.env.APPLE_PRIVATE_KEY_PATH) {
    privateKey = fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8');
  } else {
    console.warn('Apple Music: No private key found. Set APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_PATH in .env');
    return null;
  }

  const expirySeconds = 60 * 60 * 24; // 24 hours
  appleDevTokenExpiry = now + expirySeconds - 60; // Refresh 1 min before expiry

  appleDevToken = jwt.sign({}, privateKey, {
    algorithm:  'ES256',
    expiresIn:  expirySeconds,
    issuer:     teamId,
    header: {
      alg: 'ES256',
      kid: keyId
    }
  });

  return appleDevToken;
}

app.get('/apple/token', (req, res) => {
  try {
    const token = generateAppleDevToken();
    if (!token) {
      return res.status(503).json({
        error: 'Apple Music not configured',
        hint: 'Set APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY in your .env file'
      });
    }
    res.json({ token });
  } catch(e) {
    console.error('Apple token error:', e);
    res.status(500).json({ error: 'Failed to generate Apple developer token' });
  }
});

// ─────────────────────────────────────────────────────────
// ROOM API
// ─────────────────────────────────────────────────────────
app.post('/room', async (req, res) => {
  const { name, is_private, passcode } = req.body;
  if (!name) return res.status(400).json({ error:'Name required' });
  const { data, error } = await supabase
    .from('rooms')
    .insert({ name, is_private: !!is_private, passcode: passcode || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json({ room: data });
});

app.get('/api/room/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, name, is_private')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error:'Room not found' });
  res.json(data);
});

app.post('/api/room/:id/verify', async (req, res) => {
  const { passcode } = req.body;
  const { data } = await supabase
    .from('rooms')
    .select('passcode')
    .eq('id', req.params.id)
    .single();
  if (!data) return res.status(404).json({ ok:false });
  res.json({ ok: data.passcode === passcode });
});

// ─────────────────────────────────────────────────────────
// SOCKET.IO — REAL-TIME SYNC
// ─────────────────────────────────────────────────────────
io.on('connection', socket => {
  let currentRoomId = null;
  let memberName    = null;

  socket.on('join', ({ roomId, name }) => {
    currentRoomId = roomId;
    memberName    = name;
    socket.join(roomId);

    const room = getRoom(roomId);
    room.members.set(socket.id, { name });

    // Broadcast updated members list
    broadcastMembers(roomId);

    // Send current room state to new joiner
    socket.emit('roomState', {
      queue:        room.queue,
      currentTrack: room.currentTrack,
      isPlaying:    room.isPlaying,
      positionMs:   getLivePosition(room),
      server_ts:    Date.now()
    });
  });

  // ── Playback events ──
  socket.on('play', ({ roomId, track, server_ts }) => {
    const room = getRoom(roomId);
    room.currentTrack   = track;
    room.isPlaying      = true;
    room.positionMs     = 0;
    room.lastUpdateTs   = Date.now();
    // Add to queue if not already there
    if (!room.queue.find(t => t.id === track.id)) {
      room.queue.push(track);
      io.to(roomId).emit('queueUpdate', room.queue);
    }
    io.to(roomId).emit('play', { track, positionMs:0, server_ts:Date.now() });
  });

  socket.on('addSong', ({ roomId, track }) => {
    const room = getRoom(roomId);
    if (!room.queue.find(t => t.id === track.id)) {
      room.queue.push(track);
    }
    io.to(roomId).emit('queueUpdate', room.queue);
  });

  socket.on('playState', ({ roomId, isPlaying, positionMs }) => {
    const room = getRoom(roomId);
    room.isPlaying    = isPlaying;
    room.positionMs   = positionMs || 0;
    room.lastUpdateTs = Date.now();
    socket.to(roomId).emit('playState', { isPlaying, positionMs, server_ts:Date.now() });
  });

  socket.on('seek', ({ roomId, positionMs }) => {
    const room = getRoom(roomId);
    room.positionMs   = positionMs;
    room.lastUpdateTs = Date.now();
    socket.to(roomId).emit('seek', { positionMs, server_ts:Date.now() });
  });

  socket.on('nextSong', ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room.queue.length) return;
    const idx = room.queue.findIndex(t => t.id === room.currentTrack?.id);
    const next = room.queue[idx + 1];
    if (next) {
      room.currentTrack = next;
      room.positionMs   = 0;
      room.lastUpdateTs = Date.now();
      io.to(roomId).emit('play', { track:next, positionMs:0, server_ts:Date.now() });
    }
  });

  socket.on('prevSong', ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room.queue.length) return;
    const idx = room.queue.findIndex(t => t.id === room.currentTrack?.id);
    const prev = room.queue[idx - 1];
    if (prev) {
      room.currentTrack = prev;
      room.positionMs   = 0;
      room.lastUpdateTs = Date.now();
      io.to(roomId).emit('play', { track:prev, positionMs:0, server_ts:Date.now() });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId) {
      const room = rooms[currentRoomId];
      if (room) {
        room.members.delete(socket.id);
        broadcastMembers(currentRoomId);
      }
    }
  });
});

function broadcastMembers(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const members = Array.from(room.members.values());
  io.to(roomId).emit('members', members);
}

// ─────────────────────────────────────────────────────────
// STATIC ROUTES
// ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/home.html'));
});
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/room.html'));
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wavelength running on port ${PORT}`));