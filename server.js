const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Store rooms and their participants
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create or join room with custom key
  socket.on('join-room', (roomKey, callback) => {
    if (!rooms.has(roomKey)) {
      // Create new room
      rooms.set(roomKey, {
        clients: new Set([socket.id]),
        files: [] // Shared files queue
      });
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.isCreator = true;
      callback({ success: true, isCreator: true, clientsCount: 1 });
      console.log(`Room ${roomKey} created by ${socket.id}`);
    } else {
      // Join existing room
      const room = rooms.get(roomKey);
      room.clients.add(socket.id);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.isCreator = false;
      
      // Notify all clients in room about new peer
      io.to(roomKey).emit('peer-joined', {
        peerId: socket.id,
        clientsCount: room.clients.size
      });
      
      callback({ success: true, isCreator: false, clientsCount: room.clients.size });
      console.log(`${socket.id} joined room ${roomKey}`);
    }
  });

  // Leave room
  socket.on('leave-room', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.clients.delete(socket.id);
      
      // Notify others
      socket.to(roomKey).emit('peer-left', {
        peerId: socket.id,
        clientsCount: room.clients.size
      });
      
      socket.leave(roomKey);
      
      // Delete room if empty
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
        console.log(`Room ${roomKey} deleted`);
      }
    }
  });

  // Broadcast file metadata to all peers in room
  socket.on('file-metadata', (data) => {
    const roomKey = socket.data.roomKey;
    if (roomKey) {
      socket.to(roomKey).emit('file-metadata', {
        fileId: data.fileId,
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileType: data.fileType,
        senderId: socket.id
      });
    }
  });

  // Broadcast file chunk to specific peer or all peers
  socket.on('file-chunk', (data) => {
    const roomKey = socket.data.roomKey;
    if (roomKey) {
      if (data.targetId) {
        // Send to specific peer
        io.to(data.targetId).emit('file-chunk', {
          fileId: data.fileId,
          chunk: data.chunk,
          offset: data.offset,
          isLast: data.isLast
        });
      } else {
        // Broadcast to all other peers
        socket.to(roomKey).emit('file-chunk', {
          fileId: data.fileId,
          chunk: data.chunk,
          offset: data.offset,
          isLast: data.isLast,
          senderId: socket.id
        });
      }
    }
  });

  // Request file from peer
  socket.on('request-file', (data) => {
    const roomKey = socket.data.roomKey;
    if (roomKey) {
      io.to(data.peerId).emit('file-request', {
        fileId: data.fileId,
        requesterId: socket.id
      });
    }
  });

  // Get room info
  socket.on('get-room-info', (roomKey, callback) => {
    if (rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      callback({
        exists: true,
        clientsCount: room.clients.size,
        clients: Array.from(room.clients)
      });
    } else {
      callback({ exists: false });
    }
  });

  socket.on('disconnect', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.clients.delete(socket.id);
      
      socket.to(roomKey).emit('peer-left', {
        peerId: socket.id,
        clientsCount: room.clients.size
      });
      
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
