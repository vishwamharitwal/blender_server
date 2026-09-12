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

/**
 * Broadcast live online users count to all connected sockets (0 DB load)
 */
function broadcastOnlineCount() {
  const count = io.engine.clientsCount || 0;
  io.emit('onlineCount', { count: count });
}

// Periodic heartbeat broadcast every 15 seconds
setInterval(broadcastOnlineCount, 15000);

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ${socket.id} (Total sockets: ${io.engine.clientsCount})`);
  broadcastOnlineCount();

  socket.on('getOnlineCount', () => {
    socket.emit('onlineCount', { count: io.engine.clientsCount || 1 });
  });

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

    // Helper: Check VIP gender preference compatibility
    function isCompatible(u1, u2) {
      const g1 = (u1?.gender || 'Boy').toLowerCase();
      const p1 = (u1?.preferredGender || 'Anyone').toLowerCase();
      const isVip1 = !!u1?.isVip;

      const g2 = (u2?.gender || 'Boy').toLowerCase();
      const p2 = (u2?.preferredGender || 'Anyone').toLowerCase();
      const isVip2 = !!u2?.isVip;

      if (isVip1) {
        if (p1 === 'girls' && !g2.includes('girl')) return false;
        if (p1 === 'boys' && !g2.includes('boy')) return false;
      }
      if (isVip2) {
        if (p2 === 'girls' && !g1.includes('girl')) return false;
        if (p2 === 'boys' && !g1.includes('boy')) return false;
      }
      return true;
    }

    // Find first compatible candidate in waiting queue
    const candidateIndex = waitingUsers.findIndex((u) =>
      u.socket.connected && u.socket.id !== socket.id && isCompatible(userData, u.userData)
    );

    if (candidateIndex !== -1) {
      const [candidate] = waitingUsers.splice(candidateIndex, 1);
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

    // If no candidate available, add to waiting queue
    if (userData?.isVip) {
      // Find the first non-VIP user to insert the VIP user before them
      const firstNonVipIndex = waitingUsers.findIndex(u => !u.userData?.isVip);
      if (firstNonVipIndex === -1) {
        waitingUsers.push({ socket: socket, userData: userData });
      } else {
        waitingUsers.splice(firstNonVipIndex, 0, { socket: socket, userData: userData });
      }
    } else {
      waitingUsers.push({ socket: socket, userData: userData });
    }
    console.log(`⏳ [Queued] User ${socket.id} (VIP: ${!!userData?.isVip}, Filter: ${userData?.preferredGender || 'Anyone'}) waiting. Queue depth: ${waitingUsers.length}`);
  });

  // --- 2. ACCEPT MATCH ---
  socket.on('acceptMatch', (data) => {
    const { roomId } = data || {};
    if (roomId) socket.join(roomId);
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
      io.to(room.user1).emit('startCall', { roomId });
      io.to(room.user2).emit('startCall', { roomId });
    }
  });

  // --- 3. SKIP & CANCEL MATCH ---
  socket.on('cancelMatch', () => {
    console.log(`[Cancel Match] Socket ${socket.id} requested cancel`);
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);
  });

  socket.on('skipMatch', (data) => {
    const { roomId } = data || {};
    console.log(`[Skip] User ${socket.id} skipped match in room ${roomId}`);
    
    // Always remove this user from waiting queue
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);

    if (roomId && activeRooms.has(roomId)) {
      socket.to(roomId).emit('matchCanceled', { message: 'The other soul skipped the match.' });
      cleanupRoom(roomId, 'User skipped');
    }
  });

  // --- 4. WEBRTC SIGNALING RELAYS ---
  socket.on('offer', (data) => {
    const { roomId, offer } = data || {};
    if (!roomId || !offer) return;
    socket.join(roomId);
    const room = activeRooms.get(roomId);
    if (room) {
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      console.log(`[Relay Offer] from ${socket.id} to partner ${partnerId} in room ${roomId}`);
      io.to(partnerId).emit('offer', offer);
    } else {
      socket.to(roomId).emit('offer', offer);
    }
  });

  socket.on('answer', (data) => {
    const { roomId, answer } = data || {};
    if (!roomId || !answer) return;
    socket.join(roomId);
    const room = activeRooms.get(roomId);
    if (room) {
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      console.log(`[Relay Answer] from ${socket.id} to partner ${partnerId} in room ${roomId}`);
      io.to(partnerId).emit('answer', answer);
    } else {
      socket.to(roomId).emit('answer', answer);
    }
  });

  socket.on('candidate', (data) => {
    const { roomId, candidate } = data || {};
    if (!roomId || !candidate) return;
    const room = activeRooms.get(roomId);
    if (room) {
      const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
      io.to(partnerId).emit('candidate', candidate);
    } else {
      socket.to(roomId).emit('candidate', candidate);
    }
  });

  // --- 4.5 EXTEND CALL (+5 MINS) ---
  socket.on('extendCall', (data) => {
    const { roomId, addedSeconds = 300 } = data || {};
    if (roomId) {
      console.log(`[Extend Call] User ${socket.id} extended call in room ${roomId} by ${addedSeconds}s`);
      io.to(roomId).emit('callExtended', { addedSeconds });
    }
  });

  // --- 5. END CALL ---
  socket.on('endCall', (data) => {
    const { roomId } = data || {};
    console.log(`[End Call] User ${socket.id} ended call in room ${roomId}`);
    if (roomId) {
      const room = activeRooms.get(roomId);
      if (room) {
        const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
        console.log(`[End Call Relay] Sending callEnded to partner ${partnerId}`);
        io.to(partnerId).emit('callEnded', { message: 'The other soul ended the call.' });
      }
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

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`⚡ Blender Server running on port ${PORT}`);
  console.log(`⚡ Industrial Matchmaking & WebRTC Ready`);
  console.log(`=========================================`);
});

