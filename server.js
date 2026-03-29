const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 // 100MB limit for file chunks
});

app.use(express.static('public'));

// Store rooms with their files
const rooms = new Map();

// Helper to generate unique file ID
function generateFileId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create or join room with custom key
  socket.on('join-room', (roomKey, callback) => {
    if (!rooms.has(roomKey)) {
      // Create new room
      rooms.set(roomKey, {
        clients: new Set([socket.id]),
        files: new Map(), // fileId -> { metadata, chunks }
        creatorId: socket.id
      });
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.isCreator = true;
      callback({ success: true, isCreator: true, clientsCount: 1, files: [] });
      console.log(`Room ${roomKey} created by ${socket.id}`);
    } else {
      // Join existing room
      const room = rooms.get(roomKey);
      room.clients.add(socket.id);
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.isCreator = false;
      
      // Send existing files to new peer
      const existingFiles = Array.from(room.files.values()).map(file => ({
        fileId: file.fileId,
        fileName: file.metadata.fileName,
        fileSize: file.metadata.fileSize,
        fileType: file.metadata.fileType,
        senderId: file.senderId
      }));
      
      // Notify all clients in room about new peer
      io.to(roomKey).emit('peer-joined', {
        peerId: socket.id,
        clientsCount: room.clients.size
      });
      
      callback({ success: true, isCreator: false, clientsCount: room.clients.size, files: existingFiles });
      console.log(`${socket.id} joined room ${roomKey}`);
    }
  });

  // Upload file chunk (store on server)
  socket.on('upload-chunk', (data) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) return;
    
    const room = rooms.get(roomKey);
    
    if (!room.files.has(data.fileId)) {
      // Initialize file storage
      room.files.set(data.fileId, {
        fileId: data.fileId,
        metadata: {
          fileName: data.fileName,
          fileSize: data.fileSize,
          fileType: data.fileType,
          senderId: socket.id
        },
        chunks: [],
        totalSize: data.fileSize,
        receivedSize: 0,
        senderId: socket.id
      });
    }
    
    const fileData = room.files.get(data.fileId);
    
    // Convert chunk back to Buffer if it came as ArrayBuffer
    const chunkBuffer = Buffer.from(data.chunk);
    fileData.chunks.push(chunkBuffer);
    fileData.receivedSize += chunkBuffer.length;
    
    // Notify all peers about progress
    io.to(roomKey).emit('upload-progress', {
      fileId: data.fileId,
      progress: (fileData.receivedSize / fileData.fileSize) * 100,
      isComplete: fileData.receivedSize >= fileData.fileSize
    });
    
    // If file is complete, notify all peers
    if (fileData.receivedSize >= fileData.fileSize) {
      console.log(`File complete: ${data.fileName} in room ${roomKey}`);
      io.to(roomKey).emit('file-available', {
        fileId: data.fileId,
        fileName: fileData.metadata.fileName,
        fileSize: fileData.metadata.fileSize,
        fileType: fileData.metadata.fileType,
        senderId: socket.id
      });
    }
  });

  // Download file request
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
    
    // Reassemble file from chunks
    const fullBuffer = Buffer.concat(fileData.chunks);
    
    callback({
      success: true,
      fileName: fileData.metadata.fileName,
      fileSize: fileData.metadata.fileSize,
      fileData: fullBuffer.toString('base64')
    });
  });

  // Get list of available files
  socket.on('get-files', (callback) => {
    const roomKey = socket.data.roomKey;
    if (!roomKey || !rooms.has(roomKey)) {
      callback([]);
      return;
    }
    
    const room = rooms.get(roomKey);
    const files = Array.from(room.files.values()).map(file => ({
      fileId: file.fileId,
      fileName: file.metadata.fileName,
      fileSize: file.metadata.fileSize,
      fileType: file.metadata.fileType,
      senderId: file.metadata.senderId
    }));
    
    callback(files);
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
      
      // Delete room if empty (files are cleared automatically)
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
      
      socket.to(roomKey).emit('peer-left', {
        peerId: socket.id,
        clientsCount: room.clients.size
      });
      
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
  console.log(`Server running on port ${PORT}`);
});
