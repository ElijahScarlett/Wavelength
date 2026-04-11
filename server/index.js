// server/index.js
// Wavelength backend server
// Handles rooms, queue, real-time sync, and Spotify OAuth

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
// Home page route
app.get('/', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, '../public/home.html'));
});
// Room page route — serves index.html for any /room/:id URL
app.get('/room/:id', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, '../public/room.html'));
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'Wavelength server is running' });
});

// POST /room - create a room
app.post('/room', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name is required' });

  const { data, error } = await supabase
    .from('rooms')
    .insert({ name })
    .select()
    .single();

  if (error) {
    console.error('Supabase error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ room: data });
});

// GET /api/room/:id - get room + queue
app.get('/api/room/:id', async (req, res) => {
  const { id } = req.params;

  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', id)
    .single();

  if (roomError) return res.status(404).json({ error: 'Room not found' });

  const { data: queue, error: queueError } = await supabase
    .from('queue_items')
    .select('*')
    .eq('room_id', id)
    .order('position', { ascending: true });

  if (queueError) return res.status(500).json({ error: queueError.message });

  res.json({ room, queue });
});

// POST /room/:id/queue - add a song
app.post('/room/:id/queue', async (req, res) => {
  const { id } = req.params;
const { track_name, artist_name, added_by, image_url } = req.body;

  if (!track_name || !artist_name) {
    return res.status(400).json({ error: 'track_name and artist_name are required' });
  }

  const { data, error } = await supabase
    .from('queue_items')
   .insert({ room_id: id, track_name, artist_name, added_by, image_url })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  io.to(id).emit('queue:updated', { item: data });
  res.json({ item: data });
});

// GET /auth/spotify - redirect to Spotify login
app.get('/auth/spotify', (req, res) => {
  const scope = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// GET /callback - Spotify sends user back here
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body,
  });

  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error });

  res.send(`
    <script>
      window.opener.postMessage({ 
        type: 'spotify-auth', 
        access_token: '${data.access_token}' 
      }, '*');
      window.close();
    </script>
  `);
});

// POST /spotify/play - play a track on user's Spotify
app.post('/spotify/play', async (req, res) => {
  const { access_token, track_uri } = req.body;

  const response = await fetch('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: [track_uri], device_id: req.body.device_id }),
  });

  if (response.status === 204) {
    res.json({ success: true });
  } else {
    const error = await response.json();
    res.status(400).json({ error });
  }
});
// GET /spotify/search - search for tracks
app.get('/spotify/search', async (req, res) => {
  const { query, access_token } = req.query;
  if (!query || !access_token) return res.status(400).json({ error: 'Missing query or token' });

  const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, {
    headers: { 'Authorization': `Bearer ${access_token}` }
  });

  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error });

  const tracks = data.tracks.items.map(t => ({
    uri: t.uri,
    name: t.name,
    artist: t.artists[0].name,
    album: t.album.name,
    image: t.album.images[1]?.url,
    duration: Math.round(t.duration_ms / 1000)
  }));

  res.json({ tracks });
});
// WebSocket connection
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('room:join', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavelength server running on http://localhost:${PORT}`);
});