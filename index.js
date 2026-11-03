const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

try {
  require('dotenv').config();
} catch (_) {
  // dotenv optional if env injected by host
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '39a89e2f9b2fc90068fc0754';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '7yIO3XV5gD25+gkv';
// Metered dashboard "API Key" (not the static TURN password)
const TURN_API_KEY = process.env.TURN_API_KEY || '';
const METEREED_DOMAIN =
  process.env.METERED_DOMAIN ||
  process.env.METEREED_DOMAIN ||
  'blender.metered.live';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

if (!supabaseAdmin) {
  console.warn(
    '[WARN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Auth-hardened routes will reject until env is set.',
  );
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Blender Signaling Server is live',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    waitingUsers: waitingUsers.length,
    activeRooms: activeRooms.size,
    uptimeSeconds: Math.floor(process.uptime()),
    authEnabled: !!supabaseAdmin,
  });
});

function staticIceServers() {
  const stun = {
    urls: [
      'stun:stun.relay.metered.ca:80',
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
    ],
  };

  const servers = [stun];
  if (TURN_USERNAME && TURN_CREDENTIAL) {
    servers.push({
      urls: [
        'turn:standard.relay.metered.ca:80',
        'turn:standard.relay.metered.ca:80?transport=tcp',
        'turn:standard.relay.metered.ca:443',
        'turns:standard.relay.metered.ca:443?transport=tcp',
      ],
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }
  return servers;
}

async function getIceServers() {
  // Preferred: Metered temporary credentials via API key
  if (TURN_API_KEY) {
    try {
      const url = `https://${METEREED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(TURN_API_KEY)}`;
      const response = await fetch(url);
      if (response.ok) {
        const iceServers = await response.json();
        if (Array.isArray(iceServers) && iceServers.length > 0) {
          console.log(`[ICE] Successfully fetched ${iceServers.length} servers from Metered`);
          return iceServers;
        }
      } else {
        console.error('[ICE] Metered API status', response.status);
      }
    } catch (e) {
      console.error('[ICE] Metered API error', e.message);
    }
  }
  return staticIceServers();
}

app.get('/ice-servers', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req.headers.authorization);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const iceServers = await getIceServers();
    return res.json({ iceServers });
  } catch (e) {
    console.error('[ice-servers]', e.message);
    return res.status(500).json({ error: 'Failed to fetch ICE servers' });
  }
});

const ALLOWED_VIP_PRODUCTS = {
  blender_vip_monthly: 30,
  weekend_vip_base: 3,
  blender_vip_weekend: 3,
};

app.post('/api/grant-vip', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Server auth not configured' });
    }
    const user = await getUserFromAuthHeader(req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const productId = String(req.body?.productId || '');
    const purchaseToken = String(req.body?.purchaseToken || '').trim();
    const days = ALLOWED_VIP_PRODUCTS[productId];
    if (!days) {
      return res.status(400).json({ error: 'Invalid product' });
    }
    if (!purchaseToken || purchaseToken.length < 8) {
      return res.status(400).json({ error: 'Missing purchase token' });
    }

    const { error: receiptError } = await supabaseAdmin
      .from('vip_purchase_receipts')
      .insert({
        user_id: user.id,
        product_id: productId,
        purchase_token: purchaseToken,
        days_granted: days,
      });

    if (receiptError) {
      if (receiptError.code === '23505') {
        return res.status(409).json({ error: 'Purchase already redeemed' });
      }
      console.error('[grant-vip] receipt insert', receiptError);
      return res.status(500).json({ error: 'Could not store receipt' });
    }

    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ is_vip: true, vip_expires_at: expiry })
      .eq('id', user.id);

    if (updateError) {
      console.error('[grant-vip] user update', updateError);
      return res.status(500).json({ error: 'Could not grant VIP' });
    }

    return res.json({ ok: true, days, vip_expires_at: expiry });
  } catch (e) {
    console.error('[grant-vip]', e);
    return res.status(500).json({ error: 'Grant failed' });
  }
});

async function getUserFromAuthHeader(authorization) {
  if (!supabaseAdmin || !authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function loadTrustedProfile(userId) {
  if (!supabaseAdmin || !userId) return null;
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(
      'id, display_name, avatar_url, gender, is_vip, vip_expires_at, banned_until, last_letter',
    )
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('[profile]', error.message);
    return null;
  }
  return data;
}

function isVipActive(profile) {
  if (!profile?.is_vip) return false;
  if (!profile.vip_expires_at) return true;
  const expires = Date.parse(profile.vip_expires_at);
  return Number.isFinite(expires) ? expires > Date.now() : false;
}

function isBanned(profile) {
  if (!profile?.banned_until) return false;
  const until = Date.parse(profile.banned_until);
  return Number.isFinite(until) ? until > Date.now() : false;
}

function normalizeGender(value) {
  const g = String(value || '').toLowerCase();
  if (g.includes('girl') || g.includes('female') || g === 'f') return 'Girl';
  return 'Boy';
}

function createRoomId() {
  return `room_${crypto.randomBytes(16).toString('hex')}`;
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Mobile radios often pause briefly; 5s was killing live calls.
  pingInterval: 20000,
  pingTimeout: 30000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e5,
});

let waitingUsers = [];
const activeRooms = new Map();
const findMatchRate = new Map(); // userId -> lastTs

function cleanupRoom(roomId, reason = 'Match ended') {
  const room = activeRooms.get(roomId);
  if (!room) return;
  if (room.timeoutTimer) clearTimeout(room.timeoutTimer);
  if (room.disconnectTimer) clearTimeout(room.disconnectTimer);
  activeRooms.delete(roomId);
  console.log(
    `[Room Cleaned] ${roomId} (Reason: ${reason}). Remaining active rooms: ${activeRooms.size}`,
  );
}

function broadcastOnlineCount() {
  const count = io.engine.clientsCount || 0;
  io.emit('onlineCount', { count });
}

setInterval(broadcastOnlineCount, 30000);

function isRoomMember(room, socket) {
  if (!room || !socket) return false;
  if (room.user1 === socket.id || room.user2 === socket.id) return true;
  if (socket.userId && (room.user1Id === socket.userId || room.user2Id === socket.userId)) {
    return true;
  }
  return false;
}

function partnerSocketId(room, socket) {
  if (!room) return null;
  if (room.user1 === socket.id) return room.user2;
  if (room.user2 === socket.id) return room.user1;
  if (socket.userId && room.user1Id === socket.userId) return room.user2;
  if (socket.userId && room.user2Id === socket.userId) return room.user1;
  return null;
}

function isUserInRoom(room, userId) {
  if (!room || !userId) return false;
  return room.user1Id === userId || room.user2Id === userId;
}

io.use(async (socket, next) => {
  try {
    if (!supabaseAdmin) {
      return next(new Error('Server auth not configured'));
    }
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return next(new Error('Invalid token'));
    }
    socket.userId = data.user.id;
    socket.accessToken = token;
    return next();
  } catch (e) {
    return next(new Error('Auth failed'));
  }
});

io.on('connection', (socket) => {
  console.log(
    `[Socket Connected] ${socket.id} user=${socket.userId} (Total: ${io.engine.clientsCount})`,
  );
  broadcastOnlineCount();

  socket.on('getOnlineCount', () => {
    socket.emit('onlineCount', { count: io.engine.clientsCount || 1 });
  });

  socket.on('rejoinCall', (data) => {
    const roomId = data?.roomId;
    if (!roomId || !activeRooms.has(roomId)) {
      socket.emit('callEnded', { message: 'The call has ended.' });
      return;
    }
    const room = activeRooms.get(roomId);
    if (!isUserInRoom(room, socket.userId)) {
      socket.emit('callEnded', { message: 'The call has ended.' });
      return;
    }
    if (room.user1Id === socket.userId) room.user1 = socket.id;
    if (room.user2Id === socket.userId) room.user2 = socket.id;
    if (room.disconnectTimer) {
      clearTimeout(room.disconnectTimer);
      room.disconnectTimer = null;
    }
    socket.join(roomId);
    console.log(`[Rejoin] user ${socket.userId} rebound to ${roomId} as ${socket.id}`);
  });

  socket.on('findMatch', async (userData) => {
    try {
      const profile = await loadTrustedProfile(socket.userId);
      if (!profile) {
        socket.emit('matchCanceled', { message: 'Could not verify your account.' });
        return;
      }
      if (isBanned(profile)) {
        socket.emit('matchCanceled', { message: 'Your account is temporarily restricted.' });
        return;
      }

      const now = Date.now();
      const last = findMatchRate.get(socket.userId) || 0;
      if (now - last < 1500) {
        return;
      }
      findMatchRate.set(socket.userId, now);

      const trustedVip = isVipActive(profile);
      const trustedGender = normalizeGender(profile.gender || userData?.gender);
      const preferredGenderRaw = String(userData?.preferredGender || 'Anyone');
      const preferredGender = preferredGenderRaw.toLowerCase().includes('girl')
        ? 'Girls'
        : preferredGenderRaw.toLowerCase().includes('boy')
          ? 'Boys'
          : 'Anyone';
      const letter = String(userData?.letter || profile.last_letter || '')
        .slice(0, 500);
      const avatarUrl = String(
        profile.avatar_url || userData?.avatarUrl || '👤',
      ).slice(0, 500);

      const trustedUserData = {
        userId: socket.userId,
        letter,
        avatarUrl,
        gender: trustedGender,
        preferredGender,
        isVip: trustedVip,
      };

      waitingUsers = waitingUsers.filter((u) => {
        const isSameSocket = u.socket.id === socket.id;
        const isSameUser = u.userData?.userId === socket.userId;
        const isAlive = u.socket.connected;
        return !isSameSocket && !isSameUser && isAlive;
      });

      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1 === socket.id || room.user2 === socket.id ||
            room.user1Id === socket.userId || room.user2Id === socket.userId) {
          if (room.callStarted) continue;
          const partnerId =
            room.user1Id === socket.userId ? room.user2 : room.user1;
          io.to(partnerId).emit('matchCanceled', {
            message: 'Partner started a new search.',
          });
          cleanupRoom(roomId, 'User re-queued');
        }
      }

      function isCompatible(u1, u2) {
        const g1 = (u1?.gender || 'Boy').toLowerCase();
        const p1 = (u1?.preferredGender || 'Anyone').toLowerCase();
        const isVip1 = !!u1?.isVip;
        const g2 = (u2?.gender || 'Boy').toLowerCase();
        const p2 = (u2?.preferredGender || 'Anyone').toLowerCase();
        const isVip2 = !!u2?.isVip;

        if (isVip1) {
          if (p1.includes('girl') && !g2.includes('girl')) return false;
          if (p1.includes('boy') && !g2.includes('boy')) return false;
        }
        if (isVip2) {
          if (p2.includes('girl') && !g1.includes('girl')) return false;
          if (p2.includes('boy') && !g1.includes('boy')) return false;
        }
        return true;
      }

      const candidateIndex = waitingUsers.findIndex(
        (u) =>
          u.socket.connected &&
          u.socket.id !== socket.id &&
          u.userData?.userId !== socket.userId &&
          isCompatible(trustedUserData, u.userData),
      );

      if (candidateIndex !== -1) {
        const [candidate] = waitingUsers.splice(candidateIndex, 1);
        const roomId = createRoomId();

        socket.join(roomId);
        candidate.socket.join(roomId);

        const timeoutTimer = setTimeout(() => {
          const r = activeRooms.get(roomId);
          if (r && !r.callStarted) {
            io.to(roomId).emit('matchCanceled', {
              message: 'Match timed out. Finding a new soul...',
            });
            cleanupRoom(roomId, 'Acceptance timeout');
          }
        }, 35000);

        activeRooms.set(roomId, {
          user1: socket.id,
          user1Id: socket.userId,
          user1Accepted: false,
          user2: candidate.socket.id,
          user2Id: candidate.userData.userId,
          user2Accepted: false,
          timeoutTimer,
          disconnectTimer: null,
          callStarted: false,
        });

        console.log(
          `⚡ [MATCH SUCCESS] ${socket.userId} <===> ${candidate.userData.userId} in [${roomId}]`,
        );

        io.to(socket.id).emit('matchFound', {
          roomId,
          partnerLetter:
            candidate.userData?.letter || 'A soul with unspoken thoughts.',
          partnerUserId: candidate.userData?.userId || null,
          partnerAvatarUrl: candidate.userData?.avatarUrl || null,
          isCaller: true,
        });

        io.to(candidate.socket.id).emit('matchFound', {
          roomId,
          partnerLetter: trustedUserData.letter || 'A soul with unspoken thoughts.',
          partnerUserId: trustedUserData.userId,
          partnerAvatarUrl: trustedUserData.avatarUrl,
          isCaller: false,
        });
        return;
      }

      if (trustedVip) {
        const firstNonVipIndex = waitingUsers.findIndex((u) => !u.userData?.isVip);
        if (firstNonVipIndex === -1) {
          waitingUsers.push({ socket, userData: trustedUserData });
        } else {
          waitingUsers.splice(firstNonVipIndex, 0, {
            socket,
            userData: trustedUserData,
          });
        }
      } else {
        waitingUsers.push({ socket, userData: trustedUserData });
      }
      console.log(
        `⏳ [Queued] ${socket.userId} VIP=${trustedVip} queue=${waitingUsers.length}`,
      );
    } catch (e) {
      console.error('[findMatch]', e);
      socket.emit('matchCanceled', { message: 'Matchmaking error. Try again.' });
    }
  });

  socket.on('acceptMatch', (data) => {
    const { roomId } = data || {};
    if (!roomId || !activeRooms.has(roomId)) {
      return;
    }
    const room = activeRooms.get(roomId);
    if (!isRoomMember(room, socket)) {
      console.log(`[Accept Denied] ${socket.id} not member of ${roomId}`);
      return;
    }

    if (room.user1Id === socket.userId) room.user1 = socket.id;
    if (room.user2Id === socket.userId) room.user2 = socket.id;
    socket.join(roomId);

    if (room.user1 === socket.id || room.user1Id === socket.userId) {
      room.user1Accepted = true;
    }
    if (room.user2 === socket.id || room.user2Id === socket.userId) {
      room.user2Accepted = true;
    }

    if (room.user1Accepted && room.user2Accepted && !room.callStarted) {
      room.callStarted = true;
      if (room.timeoutTimer) clearTimeout(room.timeoutTimer);
      console.log(`📞 [START CALL] room ${roomId}`);
      io.to(roomId).emit('startCall', { roomId });
    }
  });

  socket.on('cancelMatch', () => {
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);
  });

  socket.on('skipMatch', (data) => {
    const { roomId } = data || {};
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);
    if (!roomId || !activeRooms.has(roomId)) return;
    const room = activeRooms.get(roomId);
    if (!isRoomMember(room, socket)) return;
    socket.to(roomId).emit('matchCanceled', {
      message: 'The other soul skipped the match.',
    });
    cleanupRoom(roomId, 'User skipped');
  });

  function relaySignal(eventName, data) {
    const roomId = data?.roomId;
    const payload = data?.[eventName] ?? data?.offer ?? data?.answer ?? data?.candidate;
    if (!roomId || !payload) return;
    const room = activeRooms.get(roomId);
    if (!room || !isRoomMember(room, socket)) {
      console.log(`[Relay Denied] ${eventName} by ${socket.id} room=${roomId}`);
      socket.emit('callEnded', { message: 'The call has ended.' });
      return;
    }
    if (room.user1Id === socket.userId) room.user1 = socket.id;
    if (room.user2Id === socket.userId) room.user2 = socket.id;
    const partnerId = partnerSocketId(room, socket);
    if (!partnerId) return;
    io.to(partnerId).emit(eventName, payload);
  }

  socket.on('offer', (data) => relaySignal('offer', { ...data, offer: data?.offer }));
  socket.on('answer', (data) => relaySignal('answer', { ...data, answer: data?.answer }));
  socket.on('candidate', (data) =>
    relaySignal('candidate', { ...data, candidate: data?.candidate }),
  );

  socket.on('extendCall', async (data) => {
    const roomId = data?.roomId;
    const addedSeconds = Math.min(
      600,
      Math.max(60, Number(data?.addedSeconds) || 300),
    );
    if (!roomId || !activeRooms.has(roomId)) return;
    const room = activeRooms.get(roomId);
    if (!isRoomMember(room, socket) || !room.callStarted) return;

    const profile = await loadTrustedProfile(socket.userId);
    if (!isVipActive(profile)) {
      socket.emit('matchCanceled', { message: 'VIP required to extend call.' });
      return;
    }
    io.to(roomId).emit('callExtended', { addedSeconds });
  });

  socket.on('endCall', (data) => {
    const roomId = typeof data === 'string' ? data : data?.roomId;
    if (!roomId || !activeRooms.has(roomId)) return;
    const room = activeRooms.get(roomId);
    if (!isRoomMember(room, socket)) {
      console.log(`[EndCall Denied] ${socket.id} not in ${roomId}`);
      return;
    }
    const partnerId = partnerSocketId(room, socket);
    if (partnerId) {
      io.to(partnerId).emit('callEnded', {
        message: 'The other soul ended the call.',
      });
    }
    socket.leave(roomId);
    cleanupRoom(roomId, 'User ended call');
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ${socket.id} (${reason})`);
    waitingUsers = waitingUsers.filter((u) => u.socket.id !== socket.id);

    for (const [roomId, room] of activeRooms.entries()) {
      const member =
        room.user1 === socket.id ||
        room.user2 === socket.id ||
        room.user1Id === socket.userId ||
        room.user2Id === socket.userId;
      if (!member) continue;

      if (room.callStarted) {
        // Grace window for mobile reconnect before killing the call
        if (room.disconnectTimer) clearTimeout(room.disconnectTimer);
        room.disconnectTimer = setTimeout(() => {
          const current = activeRooms.get(roomId);
          if (!current) return;
          const partnerId =
            current.user1Id === socket.userId ? current.user2 : current.user1;
          io.to(partnerId).emit('callEnded', {
            message: 'Partner disconnected.',
          });
          io.to(partnerId).emit('matchCanceled', {
            message: 'Partner disconnected.',
          });
          cleanupRoom(roomId, `Socket disconnect grace: ${reason}`);
        }, 25000);
      } else {
        const partnerId =
          room.user1Id === socket.userId ? room.user2 : room.user1;
        io.to(partnerId).emit('matchCanceled', {
          message: 'Partner disconnected.',
        });
        cleanupRoom(roomId, `Socket disconnect: ${reason}`);
      }
    }

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('=========================================');
  console.log(`⚡ Blender Server running on port ${PORT}`);
  console.log(`⚡ Auth hardening: ${supabaseAdmin ? 'ON' : 'OFF (set env!)'}`);
  console.log('=========================================');
});
