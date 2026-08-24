const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let waitingUsers = [];
// Store room states for mutual acceptance
const activeRooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // User requests to find a match
  socket.on('findMatch', (userData) => {
    console.log(`User ${socket.id} looking for match. Letter: ${userData?.letter}, UserId: ${userData?.userId}`);

    // If there's someone waiting, match them!
    if (waitingUsers.length > 0) {
      const partner = waitingUsers.pop();
      const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      // Join both sockets to the room
      socket.join(roomId);
      partner.socket.join(roomId);
      
      // Initialize room state
      activeRooms.set(roomId, {
        user1: socket.id,
        user1Accepted: false,
        user2: partner.socket.id,
        user2Accepted: false,
      });

      console.log(`Matched ${socket.id} and ${partner.socket.id} in room ${roomId}`);

      // Send partner's details to this socket
      io.to(socket.id).emit('matchFound', {
        roomId: roomId,
        partnerLetter: partner.userData?.letter || "No letter provided.",
        partnerUserId: partner.userData?.userId || null,
        partnerAvatarUrl: partner.userData?.avatarUrl || null,
        isCaller: true // One user initiates WebRTC offer
      });

      // Send this socket's details to the partner
      io.to(partner.socket.id).emit('matchFound', {
        roomId: roomId,
        partnerLetter: userData?.letter || "No letter provided.",
        partnerUserId: userData?.userId || null,
        partnerAvatarUrl: userData?.avatarUrl || null,
        isCaller: false // The other receives and answers
      });
      
    } else {
      // Nobody is waiting, add this user to the queue
      waitingUsers.push({ socket: socket, userData: userData });
      console.log(`User ${socket.id} added to waiting queue.`);
    }
  });

  // Handle Match Acceptance
  socket.on('acceptMatch', (data) => {
    const { roomId } = data;
    const room = activeRooms.get(roomId);
    
    if (room) {
      if (room.user1 === socket.id) room.user1Accepted = true;
      if (room.user2 === socket.id) room.user2Accepted = true;

      console.log(`User ${socket.id} accepted match in room ${roomId}`);

      // If both accepted, start the call!
      if (room.user1Accepted && room.user2Accepted) {
        console.log(`Both users accepted in room ${roomId}. Starting call.`);
        io.to(roomId).emit('startCall', { roomId });
      }
    }
  });

  // Handle Match Skip/Reject
  socket.on('skipMatch', (data) => {
    const { roomId } = data;
    console.log(`User ${socket.id} skipped match in room ${roomId}`);
    io.to(roomId).emit('matchCanceled', { message: 'The other user skipped the match.' });
    
    // Cleanup room
    activeRooms.delete(roomId);
  });

  // WebRTC Signaling: Offer
  socket.on('offer', (data) => {
    console.log(`[Signaling] Offer from ${socket.id} in room ${data.roomId}`);
    socket.to(data.roomId).emit('offer', data.offer);
  });

  // WebRTC Signaling: Answer
  socket.on('answer', (data) => {
    console.log(`[Signaling] Answer from ${socket.id} in room ${data.roomId}`);
    socket.to(data.roomId).emit('answer', data.answer);
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('candidate', (data) => {
    console.log(`[Signaling] ICE Candidate from ${socket.id} in room ${data.roomId}`);
    socket.to(data.roomId).emit('candidate', data.candidate);
  });

  // Handle Call End (by user or timer)
  socket.on('endCall', (data) => {
    console.log(`User ${socket.id} ended call in room ${data.roomId}`);
    socket.to(data.roomId).emit('callEnded', { message: 'The other user ended the call.' });
    activeRooms.delete(data.roomId);
  });

  // Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blender Signaling Server running on port ${PORT}`);
});
