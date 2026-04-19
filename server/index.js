// server/index.js
// Wavelength backend — rooms, queue, real-time sync, Spotify OAuth, playback state

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, '../public/home.html'));
});

app.get('/room/:id', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, '../public/room.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'Wavelength server is running' });
});

app.post('/room', async (req, res) => {
  const { name, is_private, passcode } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name is required' });
  const insertData = { name };
  if (is_private) { insertData.is_private = true; insertData.passcode = passcode; }
  const { data, error } = await supabase.from('rooms').insert(insertData).select().single();
  if (error) { console.error('Supabase error:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ room: data });
});

app.get('/api/room/:id', async (req, res) => {
  const { id } = req.params;
  const { data: room, error: roomError } = await supabase.from('rooms').select('*').eq('id', id).single();
  if (roomError) return res.status(404).json({ error: 'Room not found' });
  const { data: queue, error: queueError } = await supabase.from('queue_items').select('*').eq('room_id', id).order('position', { ascending: true });
  if (queueError) return res.status(500).json({ error: queueError.message });
  res.json({
    room: { id: room.id, name: room.name, is_private: room.is_private || false, created_at: room.created_at },
    queue
  });
});

app.post('/api/room/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { passcode } = req.body;
  const { data: room, error } = await supabase.from('rooms').select('passcode, is_private').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'Room not found' });
  if (!room.is_private) return res.json({ valid: true });
  res.json({ valid: room.passcode === passcode });
});

app.post('/room/:id/queue', async (req, res) => {
  const { id } = req.params;
  const { track_name, artist_name, added_by, image_url, spotify_uri } = req.body;
  if (!track_name || !artist_name) return res.status(400).json({ error: 'track_name and artist_name are required' });
  const { data, error } = await supabase.from('queue_items').insert({ room_id: id, track_name, artist_name, added_by, image_url, spotify_uri }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  io.to(id).emit('queue:updated', { item: data });
  res.json({ item: data });
});

app.get('/auth/spotify', (req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const params = new URLSearchParams({ response_type: 'code', client_id: SPOTIFY_CLIENT_ID, scope, redirect_uri: SPOTIFY_REDIRECT_URI });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64') },
    body,
  });
  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error });
  res.send(`<script>window.opener.postMessage({ type: 'spotify-auth', access_token: '${data.access_token}' }, '*'); window.close();</script>`);
});

// POST /spotify/play — supports position_ms for sync seeking
app.post('/spotify/play', async (req, res) => {
  const { access_token, track_uri, device_id, position_ms } = req.body;
  const bodyData = { uris: [track_uri] };
  if (device_id) bodyData.device_id = device_id;
  if (position_ms !== undefined) bodyData.position_ms = position_ms;
  const url = device_id
    ? `https://api.spotify.com/v1/me/player/play?device_id=${device_id}`
    : 'https://api.spotify.com/v1/me/player/play';
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyData),
  });
  if (response.status === 204) { res.json({ success: true }); }
  else { const error = await response.json(); res.status(400).json({ error }); }
});

app.get('/spotify/search', async (req, res) => {
  const { query, access_token } = req.query;
  if (!query || !access_token) return res.status(400).json({ error: 'Missing query or token' });
  const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, {
    headers: { 'Authorization': `Bearer ${access_token}` }
  });
  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error });
  const tracks = data.tracks.items.map(t => ({
    uri: t.uri, name: t.name, artist: t.artists[0].name,
    album: t.album.name, image: t.album.images[1]?.url,
    duration: Math.round(t.duration_ms / 1000)
  }));
  res.json({ tracks });
});

// ── IN-MEMORY ROOM STATE ──
// Tracks live playback state AND the host's current live queue
// roomState[roomId] = { track_name, artist_name, image_url, spotify_uri, duration, started_at, elapsed_at_start, is_paused, live_queue: [] }
const roomState = {};
const roomMembers = {};

// GET /api/room/:id/state — late joiners call this to get current playback position + live queue
app.get('/api/room/:id/state', (req, res) => {
  const { id } = req.params;
  const state = roomState[id];
  if (!state || !state.track_name) return res.json({ playing: false });

  // Calculate current elapsed, accounting for time since last update
  let elapsed = state.elapsed_at_start;
  if (!state.is_paused) {
    elapsed += Math.floor((Date.now() - state.started_at) / 1000);
  }
  if (elapsed >= state.duration) elapsed = state.duration;

  res.json({
    playing: true,
    track_name: state.track_name,
    artist_name: state.artist_name,
    image_url: state.image_url,
    spotify_uri: state.spotify_uri,
    duration: state.duration,
    elapsed,
    is_paused: state.is_paused || false,
    // The host's live queue (songs still to play) — NOT stale Supabase data
    live_queue: state.live_queue || []
  });
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('room:join', (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('member:join', ({ roomId, name }) => {
    if (!roomMembers[roomId]) roomMembers[roomId] = {};
    roomMembers[roomId][socket.id] = { name };
    socket.roomId = roomId;
    io.to(roomId).emit('member:update', roomMembers[roomId]);
  });

  // Host tells server: new song started + current live queue
  socket.on('playback:started', ({ roomId, track_name, artist_name, image_url, spotify_uri, duration, elapsed, live_queue }) => {
    if (!roomState[roomId]) roomState[roomId] = {};
    Object.assign(roomState[roomId], {
      track_name, artist_name, image_url, spotify_uri, duration,
      elapsed_at_start: elapsed || 0,
      started_at: Date.now(),
      is_paused: false,
      live_queue: live_queue || []
    });
    // Tell all OTHER users to sync — include server timestamp so they can calculate network delay
    socket.to(roomId).emit('playback:sync', {
      track_name, artist_name, image_url, spotify_uri, duration,
      elapsed: elapsed || 0,
      server_ts: Date.now(), // client uses this to correct for latency
      live_queue: live_queue || []
    });
  });

  // Host updates live queue (song added/removed/reordered)
  socket.on('queue:sync', ({ roomId, live_queue }) => {
    if (roomState[roomId]) roomState[roomId].live_queue = live_queue;
    socket.to(roomId).emit('queue:host_sync', { live_queue });
  });

  // Host pauses
  socket.on('playback:pause', ({ roomId, elapsed }) => {
    if (roomState[roomId]) { roomState[roomId].is_paused = true; roomState[roomId].elapsed_at_start = elapsed; }
    socket.to(roomId).emit('playback:paused', { elapsed });
  });

  // Host resumes
  socket.on('playback:resume', ({ roomId, elapsed }) => {
    if (roomState[roomId]) { roomState[roomId].is_paused = false; roomState[roomId].elapsed_at_start = elapsed; roomState[roomId].started_at = Date.now(); }
    socket.to(roomId).emit('playback:resumed', { elapsed });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && roomMembers[roomId]) {
      delete roomMembers[roomId][socket.id];
      io.to(roomId).emit('member:update', roomMembers[roomId]);
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavelength server running on http://localhost:${PORT}`);
});