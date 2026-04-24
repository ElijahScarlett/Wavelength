// server/index.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY
);

// ── Spotify config ────────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI || 'https://wavelength-0nh9.onrender.com/callback';

// ── Static routes ─────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, '../public/home.html')));
app.get('/room/:id', (req, res) => res.sendFile(path.resolve(__dirname, '../public/room.html')));
app.get('/invite/:id', (req, res) => res.sendFile(path.resolve(__dirname, '../public/invite.html')));
app.get('/health', (req, res) => res.json({ status: 'Wavelength running' }));

// ── Spotify OAuth ─────────────────────────────────────────
app.get('/auth/spotify', (req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri:  SPOTIFY_REDIRECT_URI
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
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
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI })
    });
    const data = await resp.json();
    if (!data.access_token) return res.status(400).send('Token exchange failed');
    res.send(`<script>window.opener.postMessage({ type:'spotify-auth', access_token:'${data.access_token}' }, '*'); window.close();</script>`);
  } catch(e) {
    console.error('Spotify callback error:', e);
    res.status(500).send('Auth failed');
  }
});

// ── Spotify search proxy ──────────────────────────────────
app.get('/spotify/search', async (req, res) => {
  const { query, access_token } = req.query;
  if (!query || !access_token) return res.status(400).json({ error: 'Missing query or token' });
  try {
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error });
    const tracks = data.tracks.items.map(t => ({
      uri:      t.uri,
      name:     t.name,
      artist:   t.artists[0].name,
      album:    t.album.name,
      image:    t.album.images[1]?.url || t.album.images[0]?.url || '',
      duration: Math.round(t.duration_ms / 1000)
    }));
    res.json({ tracks });
  } catch(e) {
    console.error('Search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Spotify play proxy ────────────────────────────────────
app.post('/spotify/play', async (req, res) => {
  const { access_token, track_uri, position_ms } = req.body;
  if (!access_token || !track_uri) return res.status(400).json({ error: 'Missing params' });
  const body = { uris: [track_uri] };
  if (position_ms !== undefined) body.position_ms = position_ms;
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.status === 204) return res.json({ success: true });
    const err = await r.json();
    console.error('Spotify play error:', err);
    res.status(400).json({ error: err });
  } catch(e) {
    console.error('Play proxy error:', e);
    res.status(500).json({ error: 'Play failed' });
  }
});

// ── Room API ──────────────────────────────────────────────
app.post('/room', async (req, res) => {
  const { name, is_private, passcode } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { data, error } = await supabase
    .from('rooms')
    .insert({ name, is_private: !!is_private, passcode: passcode || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.get('/api/room/:id', async (req, res) => {
  const { data: room, error } = await supabase
    .from('rooms').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Room not found' });
  res.json({ room, members: roomMembers[req.params.id] || {} });
});

app.post('/api/room/:id/verify', async (req, res) => {
  const { passcode } = req.body;
  const { data: room, error } = await supabase
    .from('rooms').select('passcode, is_private').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Room not found' });
  if (!room.is_private) return res.json({ valid: true });
  res.json({ valid: room.passcode === passcode });
});

app.post('/room/:id/queue', async (req, res) => {
  const { track_name, artist_name, added_by, image_url, spotify_uri } = req.body;
  const { data, error } = await supabase
    .from('queue_items')
    .insert({ room_id: req.params.id, track_name, artist_name, added_by, image_url, spotify_uri })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  io.to(req.params.id).emit('queue:updated', { item: data });
  res.json({ item: data });
});

// ── In-memory room state (live playback) ─────────────────
const roomState   = {};
const roomMembers = {};

// Persist state to Supabase
async function saveRoomState(roomId, state) {
  try {
    await supabase.from('room_state').upsert({
      room_id:       roomId,
      track_name:    state.track_name,
      artist_name:   state.artist_name,
      image_url:     state.image_url,
      spotify_uri:   state.spotify_uri,
      duration:      state.duration,
      elapsed:       state.elapsed_at_start,
      is_paused:     state.is_paused || false,
      live_queue:    JSON.stringify(state.live_queue || []),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'room_id' });
  } catch(e) { console.error('saveRoomState error:', e.message); }
}

app.get('/api/room/:id/state', async (req, res) => {
  const id = req.params.id;
  let state = roomState[id];

  // If not in memory (server restarted), try Supabase
  if (!state || !state.track_name) {
    try {
      const { data } = await supabase.from('room_state').select('*').eq('room_id', id).single();
      if (data && data.track_name) {
        // Restore to memory
        roomState[id] = {
          track_name:       data.track_name,
          artist_name:      data.artist_name,
          image_url:        data.image_url,
          spotify_uri:      data.spotify_uri,
          duration:         data.duration,
          elapsed_at_start: data.elapsed,
          started_at:       Date.now(),
          is_paused:        true, // safe default — don't auto-resume
          live_queue:       JSON.parse(data.live_queue || '[]')
        };
        state = roomState[id];
      }
    } catch(e) { /* no saved state */ }
  }

  if (!state || !state.track_name) return res.json({ playing: false });
  let elapsed = state.elapsed_at_start;
  if (!state.is_paused) elapsed += Math.floor((Date.now() - state.started_at) / 1000);
  if (elapsed >= state.duration) elapsed = state.duration;
  res.json({
    playing:     true,
    track_name:  state.track_name,
    artist_name: state.artist_name,
    image_url:   state.image_url,
    spotify_uri: state.spotify_uri,
    duration:    state.duration,
    elapsed,
    is_paused:   state.is_paused || false,
    live_queue:  state.live_queue || []
  });
});

// ── Socket.IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('room:join', roomId => {
    socket.join(roomId);
    socket.roomId = roomId;
  });

  socket.on('member:join', ({ roomId, name }) => {
    if (!roomMembers[roomId]) roomMembers[roomId] = {};
    // Reject duplicate names
    const taken = Object.values(roomMembers[roomId]).some(m => m.name.toLowerCase() === name.toLowerCase());
    if (taken) {
      socket.emit('join:rejected', { reason: `The name "${name}" is already taken in this room.` });
      return;
    }
    const isFirstMember = Object.keys(roomMembers[roomId]).length === 0;
    roomMembers[roomId][socket.id] = { name, isHost: isFirstMember };
    socket.roomId = roomId;
    io.to(roomId).emit('member:update', roomMembers[roomId]);
  });

  socket.on('playback:started', ({ roomId, track_name, artist_name, image_url, spotify_uri, duration, elapsed, live_queue }) => {
    if (!roomState[roomId]) roomState[roomId] = {};
    Object.assign(roomState[roomId], {
      track_name, artist_name, image_url, spotify_uri, duration,
      elapsed_at_start: elapsed || 0,
      started_at: Date.now(),
      is_paused: false,
      live_queue: live_queue || []
    });
    saveRoomState(roomId, roomState[roomId]);
    socket.to(roomId).emit('playback:sync', {
      track_name, artist_name, image_url, spotify_uri, duration,
      elapsed: elapsed || 0, server_ts: Date.now(),
      live_queue: live_queue || []
    });
  });

  socket.on('queue:sync', ({ roomId, live_queue }) => {
    if (roomState[roomId]) {
      roomState[roomId].live_queue = live_queue;
      saveRoomState(roomId, roomState[roomId]);
    }
    socket.to(roomId).emit('queue:host_sync', { live_queue });
  });

  socket.on('playback:pause', ({ roomId, elapsed }) => {
    if (roomState[roomId]) {
      roomState[roomId].is_paused = true;
      roomState[roomId].elapsed_at_start = elapsed;
      saveRoomState(roomId, roomState[roomId]);
    }
    socket.to(roomId).emit('playback:paused', { elapsed });
  });

  socket.on('playback:resume', ({ roomId, elapsed }) => {
    if (roomState[roomId]) {
      roomState[roomId].is_paused = false;
      roomState[roomId].elapsed_at_start = elapsed;
      roomState[roomId].started_at = Date.now();
      saveRoomState(roomId, roomState[roomId]);
    }
    socket.to(roomId).emit('playback:resumed', { elapsed });
  });

  // Host passes their role to another member
  socket.on('host:pass', ({ roomId, toSocketId }) => {
    if (!roomMembers[roomId]) return;
    const me = roomMembers[roomId][socket.id];
    if (!me?.isHost) return; // only host can pass
    const target = roomMembers[roomId][toSocketId];
    if (!target) return;
    me.isHost = false;
    target.isHost = true;
    target.isCoHost = false; // promoted to full host
    io.to(roomId).emit('member:update', roomMembers[roomId]);
    io.to(roomId).emit('room:notify', { msg: `${target.name} is now the host` });
  });

  // Host grants/revokes co-host
  socket.on('host:cohost', ({ roomId, toSocketId, grant }) => {
    if (!roomMembers[roomId]) return;
    const me = roomMembers[roomId][socket.id];
    if (!me?.isHost) return;
    const target = roomMembers[roomId][toSocketId];
    if (!target) return;
    target.isCoHost = grant;
    io.to(roomId).emit('member:update', roomMembers[roomId]);
    io.to(roomId).emit('room:notify', { msg: grant ? `${target.name} is now a co-host` : `${target.name} is no longer a co-host` });
  });

  // Host toggles open controls for all listeners
  socket.on('host:permissions', ({ roomId, openControls }) => {
    if (!roomMembers[roomId]) return;
    const me = roomMembers[roomId][socket.id];
    if (!me?.isHost) return;
    if (!roomState[roomId]) roomState[roomId] = {};
    roomState[roomId].openControls = openControls;
    io.to(roomId).emit('permissions:update', { openControls });
    io.to(roomId).emit('room:notify', { msg: openControls ? 'Everyone can now control playback' : 'Only the host can control playback' });
  });

  // Host grants specific member playback permission
  socket.on('host:grant', ({ roomId, toSocketId, grant }) => {
    if (!roomMembers[roomId]) return;
    const me = roomMembers[roomId][socket.id];
    if (!me?.isHost && !me?.isCoHost) return;
    const target = roomMembers[roomId][toSocketId];
    if (!target) return;
    target.canControl = grant;
    io.to(roomId).emit('member:update', roomMembers[roomId]);
    io.to(roomId).emit('room:notify', { msg: grant ? `${target.name} can now control playback` : `${target.name}'s controls removed` });
  });

  socket.on('chat:message', ({ roomId, name, text }) => {
    if(!text||!name||!roomId) return;
    const safe = text.slice(0,300);
    io.to(roomId).emit('chat:message', { name, text:safe, time:Date.now() });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && roomMembers[roomId]) {
      const leaving = roomMembers[roomId][socket.id];
      const wasHost = leaving?.isHost;
      const leavingName = leaving?.name || 'Someone';
      delete roomMembers[roomId][socket.id];

      // If host left, promote next member
      if (wasHost) {
        const remaining = Object.entries(roomMembers[roomId]);
        if (remaining.length > 0) {
          const [newHostId, newHostMember] = remaining[0];
          newHostMember.isHost = true;
          io.to(roomId).emit('member:update', roomMembers[roomId]);
          io.to(roomId).emit('room:notify', { msg: `${leavingName} left · ${newHostMember.name} is now the host` });
        }
      } else {
        io.to(roomId).emit('member:update', roomMembers[roomId]);
        if (leavingName !== 'Someone') {
          io.to(roomId).emit('room:notify', { msg: `${leavingName} left the room` });
        }
      }
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wavelength running on port ${PORT}`));