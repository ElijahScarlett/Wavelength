// server/index.js
// Wavelength backend server
// Handles room creation, queue management, and real-time sync

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

// Connect to Supabase using keys from .env
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// GET /health - check the server is running
app.get('/health', (req, res) => {
  res.json({ status: 'Wavelength server is running' });
});

// POST /room - create a new room
app.post('/room', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name is required' });

  const { data, error } = await supabase
    .from('rooms')
    .insert({ name })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

// GET /room/:id - get a room and its queue
app.get('/room/:id', async (req, res) => {
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

// POST /room/:id/queue - add a song to the queue
app.post('/room/:id/queue', async (req, res) => {
  const { id } = req.params;
  const { track_name, artist_name, added_by } = req.body;

  if (!track_name || !artist_name) {
    return res.status(400).json({ error: 'track_name and artist_name are required' });
  }

  const { data, error } = await supabase
    .from('queue_items')
    .insert({ room_id: id, track_name, artist_name, added_by })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Broadcast to everyone in this room that the queue changed
  io.to(id).emit('queue:updated', { item: data });

  res.json({ item: data });
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // When a user joins a room, add them to that room's channel
  socket.on('room:join', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  // When a user disconnects
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavelength server running on http://localhost:${PORT}`);
});