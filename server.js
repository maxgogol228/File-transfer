const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 // 100MB
});

app.use(express.static('public'));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomKey, callback) => {
    if (!rooms.has(roomKey)) {
      rooms.set(roomKey, {
        clients: new Set([socket.id]),
        files: new Map()
      });
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      callback({ success: true, isCreator: true, clientsCount: 1, files: [] });
      console.log(`Room ${roomKey} created`);
    } else {
      const room = rooms.get(roomKey);
      room.clients.add(socket.id);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      
      const existingFiles = Array.from(room.files.values()).map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        fileSize: f.fileSize,
        fileType: f.fileType
      }));
      
      io.to(roomKey).emit('peer-joined', { clientsCount: room.clients.size });
      callback({ success: true, isCreator: false, clientsCount: room.clients.size, files: existingFiles });
      console.log(`${socket.id} joined room ${roomKey}`);
    }
  });

  // Handle file upload with binary data
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
    
    console.log(`File upload started: ${data.fileName} (${data.fileSize} bytes)`);
  });

  // Receive binary chunks
  socket.on('file-chunk', (chunk, callback) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) return;
    
    const room = rooms.get(roomKey);
    const fileId = chunk.fileId;
    
    if (room.files.has(fileId)) {
      const fileData = room.files.get(fileId);
      
      // Convert ArrayBuffer to Buffer
      const buffer = Buffer.from(chunk.data);
      fileData.chunks.push(buffer);
      fileData.receivedSize += buffer.length;
      
      const progress = (fileData.receivedSize / fileData.fileSize) * 100;
      
      // Broadcast progress to all clients in room
      io.to(roomKey).emit('upload-progress', {
        fileId: fileId,
        progress: progress,
        fileName: fileData.fileName
      });
      
      if (callback) callback({ success: true, progress: progress });
      
      // If file is complete, notify all clients
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

  // Download file
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
    
    // Concatenate all chunks
    const fullBuffer = Buffer.concat(fileData.chunks);
    
    callback({
      success: true,
      fileName: fileData.fileName,
      fileSize: fileData.fileSize,
      fileData: fullBuffer.toString('base64')
    });
  });

  socket.on('leave-room', () => {
    const roomKey = socket.data.roomKey;
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      room.clients.delete(socket.id);
      
      socket.to(roomKey).emit('peer-left', { clientsCount: room.clients.size });
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
});
