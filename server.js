const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8
});

app.use(express.static('public'));

const rooms = new Map();
const ROOM_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

// Cleanup expired rooms periodically
setInterval(() => {
  const now = Date.now();
  for (const [roomKey, room] of rooms.entries()) {
    if (room.expiresAt && now > room.expiresAt) {
      console.log(`Room ${roomKey} expired and will be deleted`);
      io.to(roomKey).emit('room-expired', { message: 'Room has expired (1 hour limit)' });
      rooms.delete(roomKey);
    }
  }
}, 60000); // Check every minute

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomKey, callback) => {
    const now = Date.now();
    
    if (!rooms.has(roomKey)) {
      // Create new room with expiration
      rooms.set(roomKey, {
        clients: new Set([socket.id]),
        files: new Map(),
        createdAt: now,
        expiresAt: now + ROOM_LIFETIME_MS,
        messages: [] // Store chat messages
      });
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      
      callback({ 
        success: true, 
        isCreator: true, 
        clientsCount: 1, 
        files: [],
        expiresIn: ROOM_LIFETIME_MS
      });
      console.log(`Room ${roomKey} created, expires in 1 hour`);
    } else {
      const room = rooms.get(roomKey);
      
      // Check if room expired
      if (now > room.expiresAt) {
        rooms.delete(roomKey);
        callback({ success: false, error: 'Room expired' });
        return;
      }
      
      room.clients.add(socket.id);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      
      const existingFiles = Array.from(room.files.values()).map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        fileSize: f.fileSize,
        fileType: f.fileType
      }));
      
      // Send chat history to new user
      socket.emit('chat-history', room.messages);
      
      io.to(roomKey).emit('peer-joined', { 
        clientsCount: room.clients.size,
        message: `User joined the room`
      });
      
      callback({ 
        success: true, 
        isCreator: false, 
        clientsCount: room.clients.size, 
        files: existingFiles,
        expiresIn: room.expiresAt - now
      });
      console.log(`${socket.id} joined room ${roomKey}`);
    }
  });

  // Handle chat message
  socket.on('chat-message', (data) => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const message = {
        id: Date.now(),
        userId: socket.id.slice(-6),
        userName: data.userName || `User_${socket.id.slice(-4)}`,
        message: data.message,
        timestamp: new Date().toLocaleTimeString()
      };
      room.messages.push(message);
      // Keep only last 100 messages
      if (room.messages.length > 100) room.messages.shift();
      
      io.to(roomKey).emit('chat-message', message);
    }
  });

  socket.on('file-upload-start', (data) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) return;
    
    const room = rooms.get(roomKey);
    
    room.files.set(data.fileId, {
      fileId: data.fileId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      fileType: data.fileType,
      chunks: [],
      receivedSize: 0,
      senderId: socket.id
    });
    
    console.log(`File upload started: ${data.fileName}`);
  });

  socket.on('file-chunk', (chunk, callback) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) return;
    
    const room = rooms.get(roomKey);
    const fileId = chunk.fileId;
    
    if (room.files.has(fileId)) {
      const fileData = room.files.get(fileId);
      const buffer = Buffer.from(chunk.data);
      fileData.chunks.push(buffer);
      fileData.receivedSize += buffer.length;
      
      const progress = (fileData.receivedSize / fileData.fileSize) * 100;
      
      io.to(roomKey).emit('upload-progress', {
        fileId: fileId,
        progress: progress,
        fileName: fileData.fileName
      });
      
      if (callback) callback({ success: true, progress: progress });
      
      if (fileData.receivedSize >= fileData.fileSize) {
        console.log(`File complete: ${fileData.fileName}`);
        io.to(roomKey).emit('file-available', {
          fileId: fileId,
          fileName: fileData.fileName,
          fileSize: fileData.fileSize,
          fileType: fileData.fileType,
          senderId: socket.id
        });
      }
    }
  });

  socket.on('download-file', (data, callback) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) {
      callback({ success: false, error: 'Room not found' });
      return;
    }
    
    const room = rooms.get(roomKey);
    const fileData = room.files.get(data.fileId);
    
    if (!fileData) {
      callback({ success: false, error: 'File not found' });
      return;
    }
    
    const fullBuffer = Buffer.concat(fileData.chunks);
    
    callback({
      success: true,
      fileName: fileData.fileName,
      fileSize: fileData.fileSize,
      fileData: fullBuffer.toString('base64')
    });
  });

  socket.on('get-room-info', (callback) => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      callback({
        clientsCount: room.clients.size,
        expiresIn: room.expiresAt - Date.now(),
        filesCount: room.files.size
      });
    }
  });

  socket.on('leave-room', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.clients.delete(socket.id);
      
      io.to(roomKey).emit('peer-left', { 
        clientsCount: room.clients.size,
        message: `User left the room`
      });
      socket.leave(roomKey);
      
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
        console.log(`Room ${roomKey} deleted (empty)`);
      }
    }
  });

  socket.on('disconnect', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.clients.delete(socket.id);
      
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
        console.log(`Room ${roomKey} deleted (disconnect)`);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Room lifetime: 1 hour`);
});
