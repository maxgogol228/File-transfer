const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Хранилище комнат и их участников
const rooms = new Map(); // roomId -> { clients: Set(socketIds), offer: null, answer: null }

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Создание новой комнаты
  socket.on('create-room', (roomId, callback) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        clients: new Set([socket.id]),
        initiator: socket.id
      });
      socket.join(roomId);
      socket.data.roomId = roomId;
      callback({ success: true, isInitiator: true });
      console.log(`Room ${roomId} created by ${socket.id}`);
    } else {
      callback({ success: false, error: 'Room already exists' });
    }
  });

  // Подключение к существующей комнате
  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (room && room.clients.size === 1) {
      room.clients.add(socket.id);
      socket.join(roomId);
      socket.data.roomId = roomId;
      
      // Уведомляем создателя комнаты, что кто-то подключился
      io.to(room.initiator).emit('peer-joined', socket.id);
      callback({ success: true, isInitiator: false });
      console.log(`${socket.id} joined room ${roomId}`);
    } else {
      callback({ success: false, error: 'Room not available' });
    }
  });

  // Передача WebRTC signaling сообщений
  socket.on('signal', (data) => {
    const { to, signal } = data;
    io.to(to).emit('signal', {
      from: socket.id,
      signal: signal
    });
  });

  // Отключение клиента
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.clients.delete(socket.id);
      
      // Уведомляем другого участника об отключении
      const remainingClients = Array.from(room.clients);
      remainingClients.forEach(clientId => {
        io.to(clientId).emit('peer-disconnected');
      });
      
      if (room.clients.size === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});