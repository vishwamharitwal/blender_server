const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check and root route for keep-alive & monitoring
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Blender Signaling Server is live and rock solid! ⚡',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    waitingUsers: waitingUsers.length,
    activeRooms: activeRooms.size,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

const server = http.createServer(app);

// Configure Socket.io with aggressive heartbeat ping-pong for fast stale connection cleanup
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000, // Send ping every 10 seconds
  pingTimeout: 5000,    // Consider socket disconnected if no pong within 5 seconds
  transports: ['websocket', 'polling'],
});

// State storage
let waitingUsers = [];
const activeRooms = new Map(); // roomId -> { user1, user1Accepted, user2, user2Accepted, timeoutTimer, callStarted }

/**
 * Helper: Safely cleanup a room and notify users if needed
 */
function cleanupRoom(roomId, reason = 'Match ended') {
  const room = activeRooms.get(roomId);
  if (!room) return;

  if (room.timeoutTimer) {
    clearTimeout(room.timeoutTimer);
  }

  activeRooms.delete(roomId);
  console.log(`[Room Cleaned] ${roomId} (Reason: ${reason}). Remaining active rooms: ${activeRooms.size}`);
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ${socket.id} (Total sockets: ${io.engine.clientsCount})`);

  // --- 1. FIND MATCH ---
  socket.on('findMatch', (userData) => {
    console.log(`[Find Match Request] Socket: ${socket.id} | User: ${userData?.userId || 'anon'}`);

    // Remove any existing waiting entry with the same socket OR same userId
    waitingUsers = waitingUsers.filter((u) => {
      const isSameSocket = u.socket.id === socket.id;
      const isSameUser = userData?.userId && u.userData?.userId === userData.userId;
      const isAlive = u.socket.connected;
      return !isSameSocket && !isSameUser && isAlive;
    });

    // Also leave any previous active room to prevent ghost states
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.user1 === socket.id || room.user2 === socket.id) {
        const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
        io.to(partnerId).emit('matchCanceled', { message: 'Partner started a new search.' });
        cleanupRoom(roomId, 'User re-queued');
      }
    }

    // Match with the first valid waiting user in queue
    while (waitingUsers.length > 0) {
      const candidate = waitingUsers.shift();

      // Ensure candidate socket is still alive and not the same user
      if (candidate.socket.connected && candidate.socket.id !== socket.id) {
        const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        socket.join(roomId);
        candidate.socket.join(roomId);

        // 30-Second Acceptance Timeout (prevents one user hanging if other ignores)
        const timeoutTimer = setTimeout(() => {
          const r = activeRooms.get(roomId);
          if (r && !r.callStarted) {
            console.log(`[Match Timeout] Room ${roomId} expired without mutual acceptance.`);
            io.to(roomId).emit('matchCanceled', { message: 'Match timed out. Finding a new soul...' });
            cleanupRoom(roomId, 'Acceptance timeout');
          }
        }, 35000);

        activeRooms.set(roomId, {
          user1: socket.id,
          user1Accepted: false,
          user2: candidate.socket.id,
          user2Accepted: false,
          timeoutTimer: timeoutTimer,
          callStarted: false,
        });

        console.log(`⚡ [MATCH SUCCESS] ${socket.id} (Caller) <===> ${candidate.socket.id} (Receiver) in [${roomId}]`);

        // Emit matchFound to Caller
        io.to(socket.id).emit('matchFound', {
          roomId: roomId,
          partnerLetter: candidate.userData?.letter || 'A soul with unspoken thoughts.',
          partnerUserId: candidate.userData?.userId || null,
          partnerAvatarUrl: candidate.userData?.avatarUrl || null,
          isCaller: true,
        });

        // Emit matchFound to Receiver
        io.to(candidate.socket.id).emit('matchFound', {
          roomId: roomId,
          partnerLetter: userData?.letter || 'A soul with unspoken thoughts.',
          partnerUserId: userData?.userId || null,
          partnerAvatarUrl: userData?.avatarUrl || null,
          isCaller: false,
        });

        return; // Matched successfully!
      }
    }

    // If no candidate available, add to waiting queue
    waitingUsers.push({ socket: socket, userData: userData });
    console.log(`⏳ [Queued] User ${socket.id} waiting. Current queue depth: ${waitingUsers.length}`);
  });

  // --- 2. ACCEPT MATCH ---
  socket.on('acceptMatch', (data) => {
    const { roomId } = data || {};
    const room = activeRooms.get(roomId);

    if (!room) {
      console.log(`[Accept Ignored] Room ${roomId} does not exist or expired.`);
      return;
    }

    if (room.user1 === socket.id) room.user1Accepted = true;
    if (room.user2 === socket.id) room.user2Accepted = true;

    console.log(`[Accept] ${socket.id} accepted room ${roomId} (u1: ${room.user1Accepted}, u2: ${room.user2Accepted})`);

    // When both accept, trigger the WebRTC Call
    if (room.user1Accepted && room.user2Accepted && !room.callStarted) {
      room.callStarted = true;
      if (room.timeoutTimer) clearTimeout(room.timeoutTimer);

      console.log(`📞 [START CALL] Both accepted in room ${roomId}. Emitting startCall.`);
      io.to(roomId).emit('startCall', { roomId });
    }
  });

  // --- 3. SKIP MATCH ---
  socket.on('skipMatch', (data) => {
    const { roomId } = data || {};
    console.log(`[Skip] User ${socket.id} skipped match in room ${roomId}`);
    
    if (roomId && activeRooms.has(roomId)) {
      socket.to(roomId).emit('matchCanceled', { message: 'The other soul skipped the match.' });
      cleanupRoom(roomId, 'User skipped');
    }
  });

  // --- 4. WEBRTC SIGNALING RELAYS ---
  socket.on('offer', (data) => {
    if (data?.roomId) {
      socket.to(data.roomId).emit('offer', data.offer);
    }
  });

  socket.on('answer', (data) => {
    if (data?.roomId) {
      socket.to(data.roomId).emit('answer', data.answer);
    }
  });

  socket.on('candidate', (data) => {
    if (data?.roomId) {
      socket.to(data.roomId).emit('candidate', data.candidate);
    }
  });

  // --- 5. END CALL ---
  socket.on('endCall', (data) => {
    const { roomId } = data || {};
    console.log(`[End Call] User ${socket.id} ended call in room ${roomId}`);
    if (roomId) {
      socket.to(roomId).emit('callEnded', { message: 'The call was ended.' });
      cleanupRoom(roomId, 'User ended call');
    }
  });

  // --- 6. DISCONNECT & FAILSAFE CLEANUP ---
  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ${socket.id} (Reason: ${reason})`);

    // Clean up queue
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);

    // Clean up any active rooms this socket was part of
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.user1 === socket.id || room.user2 === socket.id) {
        const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
        io.to(partnerId).emit('matchCanceled', { message: 'Partner disconnected.' });
        io.to(partnerId).emit('callEnded', { message: 'Partner disconnected.' });
        cleanupRoom(roomId, `Socket disconnect: ${reason}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`⚡ Blender Server running on port ${PORT}`);
  console.log(`⚡ Industrial Matchmaking & WebRTC Ready`);
  console.log(`=========================================`);
});

