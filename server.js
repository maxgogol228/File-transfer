const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8
});

app.use(express.static('public'));

const rooms = new Map();
const ROOM_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const [roomKey, room] of rooms.entries()) {
    if (room.expiresAt && now > room.expiresAt) {
      console.log(`Room ${roomKey} expired`);
      io.to(roomKey).emit('room-expired', { message: 'Room has expired (1 hour limit)' });
      rooms.delete(roomKey);
    }
  }
}, 60000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (data, callback) => {
    const { roomKey, userName } = data;
    const now = Date.now();
    
    if (!rooms.has(roomKey)) {
      rooms.set(roomKey, {
        clients: new Map(),
        files: new Map(),
        createdAt: now,
        expiresAt: now + ROOM_LIFETIME_MS,
        messages: []
      });
      const room = rooms.get(roomKey);
      room.clients.set(socket.id, userName);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.userName = userName;
      
      callback({ 
        success: true, 
        isCreator: true, 
        clientsCount: 1, 
        files: [],
        expiresIn: ROOM_LIFETIME_MS,
        users: [{ id: socket.id, name: userName }]
      });
      console.log(`Room ${roomKey} created by ${userName}`);
    } else {
      const room = rooms.get(roomKey);
      
      if (now > room.expiresAt) {
        rooms.delete(roomKey);
        callback({ success: false, error: 'Room expired' });
        return;
      }
      
      room.clients.set(socket.id, userName);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.userName = userName;
      
      const existingFiles = Array.from(room.files.values()).map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        fileSize: f.fileSize,
        fileType: f.fileType,
        senderName: f.senderName
      }));
      
      socket.emit('chat-history', room.messages);
      
      const usersList = Array.from(room.clients.entries()).map(([id, name]) => ({ id, name }));
      
      io.to(roomKey).emit('peer-joined', { 
        clientsCount: room.clients.size,
        users: usersList,
        message: `${userName} joined the room`
      });
      
      callback({ 
        success: true, 
        isCreator: false, 
        clientsCount: room.clients.size, 
        files: existingFiles,
        expiresIn: room.expiresAt - now,
        users: usersList
      });
      console.log(`${userName} joined room ${roomKey}`);
    }
  });

  socket.on('chat-message', (data) => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const message = {
        id: Date.now(),
        userName: socket.data.userName,
        userId: socket.id,
        message: data.message,
        timestamp: new Date().toISOString()
      };
      room.messages.push(message);
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
      senderId: socket.id,
      senderName: socket.data.userName
    });
    
    console.log(`File upload started: ${data.fileName} by ${socket.data.userName}`);
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
          senderId: socket.id,
          senderName: socket.data.userName
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
      const userName = socket.data.userName;
      room.clients.delete(socket.id);
      
      const usersList = Array.from(room.clients.entries()).map(([id, name]) => ({ id, name }));
      
      io.to(roomKey).emit('peer-left', { 
        clientsCount: room.clients.size,
        users: usersList,
        message: `${userName} left the room`
      });
      socket.leave(roomKey);
      
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
        console.log(`Room ${roomKey} deleted`);
      }
    }
  });

  socket.on('disconnect', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      const userName = socket.data.userName;
      room.clients.delete(socket.id);
      
      if (room.clients.size === 0) {
        rooms.delete(roomKey);
        console.log(`Room ${roomKey} deleted`);
      } else {
        const usersList = Array.from(room.clients.entries()).map(([id, name]) => ({ id, name }));
        io.to(roomKey).emit('peer-left', { 
          clientsCount: room.clients.size,
          users: usersList,
          message: `${userName} disconnected`
        });
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
