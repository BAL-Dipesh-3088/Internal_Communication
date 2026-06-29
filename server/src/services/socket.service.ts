import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { query } from '../database/connection';
import { setUserOnline, setUserOffline, setTyping, clearTyping, refreshPresence, setUserStatus, getRedis } from './redis.service';
import { AuthPayload } from '../middleware/auth';
import { checkRateLimit } from '../middleware/socketRateLimit';

let io: Server;

interface AuthenticatedSocket extends Socket {
  user?: AuthPayload;
}

export function initSocketIO(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.isDev ? true : config.clientUrl, // Allow all origins in dev for LAN testing
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Auth middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token as string, config.jwt.secret) as AuthPayload;
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const user = socket.user!;
    console.log(`[WS] User connected: ${user.username} (${user.userId})`);

    // Join user's personal room
    socket.join(`user:${user.userId}`);

    // Set online & join conversation rooms
    handleConnect(socket, user);

    // ---- MESSAGE EVENTS ----
    socket.on('message:send', (data, callback) => handleMessageSend(socket, user, data, callback));
    socket.on('message:edit', (data, callback) => handleMessageEdit(socket, user, data, callback));
    socket.on('message:delete', (data, callback) => handleMessageDelete(socket, user, data, callback));
    socket.on('message:reaction', (data) => handleReaction(socket, user, data));
    socket.on('message:read', (data) => handleMessageRead(socket, user, data));

    // ---- TYPING EVENTS ----
    socket.on('typing:start', (data) => handleTypingStart(socket, user, data));
    socket.on('typing:stop', (data) => handleTypingStop(socket, user, data));

    // ---- SYNC EVENTS ----
    socket.on('sync:request', (data, callback) => handleSyncRequest(socket, user, data, callback));

    // ---- PRESENCE EVENTS ----
    socket.on('presence:update', (data) => handlePresenceUpdate(socket, user, data));
    socket.on('presence:heartbeat', () => refreshPresence(user.userId));

    // ---- CALL EVENTS ----
    socket.on('call:initiate', (data) => handleCallInitiate(socket, user, data));
    socket.on('call:accept', (data) => handleCallAccept(socket, user, data));
    socket.on('call:reject', (data) => handleCallReject(socket, user, data));
    socket.on('call:end', (data) => handleCallEnd(socket, user, data));

    // ---- GROUP CALL EVENTS ----
    socket.on('group-call:start', (data) => handleGroupCallStart(socket, user, data));
    socket.on('group-call:join', (data) => handleGroupCallJoin(socket, user, data));
    socket.on('group-call:leave', (data) => handleGroupCallLeave(socket, user, data));

    // ---- SCREEN SHARE EVENTS ----
    socket.on('screen-share:started', (data: { conversationId: string }) => {
      socket.to(data.conversationId).emit('screen-share:started', { from: user.userId, fromName: user.username });
    });
    socket.on('screen-share:stopped', (data: { conversationId: string }) => {
      socket.to(data.conversationId).emit('screen-share:stopped', { from: user.userId });
    });

    // ---- WEBRTC SIGNALING (peer-to-peer call negotiation) ----
    socket.on('webrtc:offer', (data: { to: string; offer: any; conversationId?: string }) => {
      io.to(`user:${data.to}`).emit('webrtc:offer', { from: user.userId, offer: data.offer, conversationId: data.conversationId });
    });
    socket.on('webrtc:answer', (data: { to: string; answer: any; conversationId?: string }) => {
      io.to(`user:${data.to}`).emit('webrtc:answer', { from: user.userId, answer: data.answer, conversationId: data.conversationId });
    });
    socket.on('webrtc:ice-candidate', (data: { to: string; candidate: any; conversationId?: string }) => {
      io.to(`user:${data.to}`).emit('webrtc:ice-candidate', { from: user.userId, candidate: data.candidate, conversationId: data.conversationId });
    });

    // ---- REMOTE CONTROL EVENTS ----
    socket.on('remote-control:request', (data: { to: string }) => {
      io.to(`user:${data.to}`).emit('remote-control:request', { from: user.userId, fromName: user.username });
    });
    socket.on('remote-control:grant', (data: { to: string }) => {
      io.to(`user:${data.to}`).emit('remote-control:granted', { from: user.userId });
    });
    socket.on('remote-control:deny', (data: { to: string }) => {
      io.to(`user:${data.to}`).emit('remote-control:denied', { from: user.userId });
    });
    socket.on('remote-control:end', (data: { to: string }) => {
      io.to(`user:${data.to}`).emit('remote-control:ended', { from: user.userId });
    });

    // ---- DISCONNECT ----
    socket.on('disconnect', () => handleDisconnect(socket, user));
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

// ============================================
// HANDLERS
// ============================================

async function handleConnect(socket: AuthenticatedSocket, user: AuthPayload) {
  await setUserOnline(user.userId);
  await query('UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2', ['online', user.userId]);

  // Join all conversation rooms
  const convs = await query(
    'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
    [user.userId]
  );
  for (const conv of convs.rows) {
    socket.join(`conv:${conv.conversation_id}`);
  }

  // Broadcast online status to everyone (including self so UI updates on cached login)
  const io = getIO();
  io.emit('presence:changed', {
    userId: user.userId,
    status: 'online',
  });
}

async function handleMessageSend(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { conversationId: string; content: string; type?: string; replyToId?: string; metadata?: any; clientId?: string },
  callback?: (response: any) => void
) {
  try {
    // Rate limiting: 10 messages per 5 seconds per user
    const rateCheck = checkRateLimit(user.userId, 'message:send', 10, 5000);
    if (!rateCheck.allowed) {
      if (callback) callback({ success: false, error: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs });
      return;
    }

    const { conversationId, content, type = 'text', replyToId, metadata, clientId } = data;

    // Idempotency check: if clientId already exists, return existing message
    if (clientId) {
      const existing = await query(
        `SELECT id, conversation_id, sender_id, type, content, reply_to_id, metadata,
                is_edited, created_at, sequence_number, client_id
         FROM messages WHERE conversation_id = $1 AND client_id = $2`,
        [conversationId, clientId]
      );
      if (existing.rows.length > 0) {
        const msg = existing.rows[0];
        const senderResult = await query(
          'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
          [user.userId]
        );
        const fullMsg = {
          ...msg,
          sender: senderResult.rows[0],
          reactions: [],
          reply_to: null,
        };
        if (callback) callback({ success: true, message: fullMsg, duplicate: true });
        return;
      }
    }

    // Save to DB with sequence number
    const result = await query(
      `INSERT INTO messages (conversation_id, sender_id, type, content, reply_to_id, metadata, client_id, sequence_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, allocate_sequence_number($1))
       RETURNING id, conversation_id, sender_id, type, content, reply_to_id, metadata, is_edited, created_at, sequence_number, client_id`,
      [conversationId, user.userId, type, content, replyToId || null, metadata || {}, clientId || null]
    );

    const message = result.rows[0];

    // Get sender info
    const senderResult = await query(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
      [user.userId]
    );

    const fullMessage = {
      ...message,
      sender: {
        id: senderResult.rows[0].id,
        username: senderResult.rows[0].username,
        display_name: senderResult.rows[0].display_name,
        avatar_url: senderResult.rows[0].avatar_url,
      },
      reactions: [],
      reply_to: null,
    };

    // Get reply info if exists
    if (replyToId) {
      const replyResult = await query(
        `SELECT m.id, m.content, u.display_name as sender_name, u.username as sender_username
         FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
        [replyToId]
      );
      if (replyResult.rows.length > 0) {
        fullMessage.reply_to = replyResult.rows[0];
      }
    }

    // Update conversation
    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversationId]);

    // Broadcast to conversation room
    io.to(`conv:${conversationId}`).emit('message:new', fullMessage);

    // Clear typing
    await clearTyping(user.userId, conversationId);

    if (callback) callback({ success: true, message: fullMessage });
  } catch (err: any) {
    console.error('[WS] message:send error:', err.message);
    if (callback) callback({ success: false, error: err.message });
  }
}

async function handleMessageEdit(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { messageId: string; content: string },
  callback?: (response: any) => void
) {
  try {
    const result = await query(
      `UPDATE messages SET content = $1, is_edited = true, edited_at = NOW()
       WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
       RETURNING id, conversation_id, content, is_edited, edited_at`,
      [data.content, data.messageId, user.userId]
    );

    if (result.rows.length === 0) {
      if (callback) callback({ success: false, error: 'Message not found' });
      return;
    }

    const msg = result.rows[0];
    io.to(`conv:${msg.conversation_id}`).emit('message:updated', msg);
    if (callback) callback({ success: true });
  } catch (err: any) {
    if (callback) callback({ success: false, error: err.message });
  }
}

async function handleMessageDelete(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { messageId: string },
  callback?: (response: any) => void
) {
  try {
    const result = await query(
      `UPDATE messages SET deleted_at = NOW(), content = '[deleted]'
       WHERE id = $1 AND (sender_id = $2 OR $3 = 'admin') AND deleted_at IS NULL
       RETURNING id, conversation_id`,
      [data.messageId, user.userId, user.role]
    );

    if (result.rows.length > 0) {
      const msg = result.rows[0];
      io.to(`conv:${msg.conversation_id}`).emit('message:deleted', { messageId: msg.id, conversationId: msg.conversation_id });
    }
    if (callback) callback({ success: true });
  } catch (err: any) {
    if (callback) callback({ success: false, error: err.message });
  }
}

async function handleReaction(socket: AuthenticatedSocket, user: AuthPayload, data: { messageId: string; emoji: string }) {
  try {
    // Toggle reaction
    const existing = await query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING id',
      [data.messageId, user.userId, data.emoji]
    );

    let action = 'removed';
    if (existing.rows.length === 0) {
      await query(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [data.messageId, user.userId, data.emoji]
      );
      action = 'added';
    }

    // Get conversation ID for broadcast
    const msgResult = await query('SELECT conversation_id FROM messages WHERE id = $1', [data.messageId]);
    if (msgResult.rows.length > 0) {
      io.to(`conv:${msgResult.rows[0].conversation_id}`).emit('message:reaction', {
        messageId: data.messageId,
        userId: user.userId,
        username: user.username,
        emoji: data.emoji,
        action,
      });
    }
  } catch (err: any) {
    console.error('[WS] reaction error:', err.message);
  }
}

async function handleMessageRead(socket: AuthenticatedSocket, user: AuthPayload, data: { conversationId: string; messageId: string }) {
  try {
    await query(
      `UPDATE conversation_members SET last_read_message_id = $1, last_read_at = NOW()
       WHERE conversation_id = $2 AND user_id = $3`,
      [data.messageId, data.conversationId, user.userId]
    );

    // Look up the read message's sequence_number so the "Seen" indicator on the
    // sender's side can compare reliably (sequence is monotonic per conversation,
    // unlike timestamps). The sender's client uses this to mark every own message
    // up to this sequence as seen by this reader.
    const seqRes = await query(
      'SELECT sequence_number FROM messages WHERE id = $1',
      [data.messageId]
    );
    const sequence = seqRes.rows[0]?.sequence_number ?? null;

    socket.to(`conv:${data.conversationId}`).emit('message:read', {
      conversationId: data.conversationId,
      userId: user.userId,
      messageId: data.messageId,
      sequence,
      readAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[WS] read error:', err.message);
  }
}

async function handleTypingStart(socket: AuthenticatedSocket, user: AuthPayload, data: { conversationId: string }) {
  if (!checkRateLimit(user.userId, 'typing:start', 5, 3000).allowed) return;
  await setTyping(user.userId, data.conversationId);
  socket.to(`conv:${data.conversationId}`).emit('typing:start', {
    conversationId: data.conversationId,
    userId: user.userId,
    username: user.username,
  });
}

async function handleTypingStop(socket: AuthenticatedSocket, user: AuthPayload, data: { conversationId: string }) {
  await clearTyping(user.userId, data.conversationId);
  socket.to(`conv:${data.conversationId}`).emit('typing:stop', {
    conversationId: data.conversationId,
    userId: user.userId,
  });
}

async function handlePresenceUpdate(socket: AuthenticatedSocket, user: AuthPayload, data: { status: string }) {
  const validStatuses = ['online', 'away', 'busy', 'dnd'];
  if (!validStatuses.includes(data.status)) return;

  await setUserStatus(user.userId, data.status);
  await query('UPDATE users SET status = $1 WHERE id = $2', [data.status, user.userId]);

  io.emit('presence:changed', {
    userId: user.userId,
    status: data.status,
  });
}

async function handleCallInitiate(socket: AuthenticatedSocket, user: AuthPayload, data: any) {
  // Notify call target(s)
  if (data.targetUserId) {
    const targetRoom = `user:${data.targetUserId}`;
    const roomSockets = io.sockets.adapter.rooms.get(targetRoom);
    console.log(`[CALL] ${user.username} calling user ${data.targetUserId} | Room "${targetRoom}" has ${roomSockets?.size || 0} socket(s)`);

    // Use display_name if available
    const callerDisplayName = await query('SELECT display_name FROM users WHERE id = $1', [user.userId]);
    const callerName = callerDisplayName.rows[0]?.display_name || user.username;

    io.to(targetRoom).emit('call:incoming', {
      callerId: user.userId,
      callerName,
      callType: data.callType || 'audio',
      conversationId: data.conversationId,
    });
  }
}

async function handleCallAccept(socket: AuthenticatedSocket, user: AuthPayload, data: any) {
  if (data.callerId) {
    io.to(`user:${data.callerId}`).emit('call:accepted', {
      userId: user.userId,
      username: user.username,
    });
  }
}

async function handleCallReject(socket: AuthenticatedSocket, user: AuthPayload, data: any) {
  if (data.callerId) {
    io.to(`user:${data.callerId}`).emit('call:rejected', {
      userId: user.userId,
      username: user.username,
    });
  }
}

async function handleCallEnd(socket: AuthenticatedSocket, user: AuthPayload, data: any) {
  if (data.conversationId) {
    io.to(`conv:${data.conversationId}`).emit('call:ended', {
      userId: user.userId,
    });
  }
}

// ============================================
// SYNC HANDLER (Reconnection Gap-Fill)
// ============================================

async function handleSyncRequest(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { conversations: Record<string, number> },
  callback?: (response: any) => void
) {
  try {
    // Rate limit: 1 sync per 10 seconds
    if (!checkRateLimit(user.userId, 'sync:request', 1, 10000).allowed) {
      if (callback) callback({ success: false, error: 'Rate limit exceeded' });
      return;
    }

    const convIds = Object.keys(data.conversations || {});
    if (convIds.length === 0) {
      if (callback) callback({ success: true, conversations: {} });
      return;
    }

    // Verify membership for all requested conversations
    const memberCheck = await query(
      `SELECT conversation_id FROM conversation_members
       WHERE user_id = $1 AND conversation_id = ANY($2::uuid[])`,
      [user.userId, convIds]
    );
    const memberConvIds = new Set(memberCheck.rows.map((r: any) => r.conversation_id));

    const result: Record<string, any[]> = {};

    for (const convId of convIds) {
      if (!memberConvIds.has(convId)) continue;
      const lastSeq = data.conversations[convId];
      if (typeof lastSeq !== 'number' || lastSeq < 0) continue;

      // Cap at 200 messages per conversation to prevent abuse
      const messages = await query(
        `SELECT m.id, m.conversation_id, m.sender_id, m.type, m.content, m.metadata,
                m.reply_to_id, m.is_edited, m.created_at, m.sequence_number, m.client_id,
                json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name,
                  'avatar_url', u.avatar_url) as sender
         FROM messages m LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.conversation_id = $1 AND m.sequence_number > $2
         ORDER BY m.sequence_number ASC LIMIT 200`,
        [convId, lastSeq]
      );
      if (messages.rows.length > 0) {
        result[convId] = messages.rows;
      }
    }

    if (callback) callback({ success: true, conversations: result });
  } catch (err: any) {
    console.error('[WS] sync:request error:', err.message);
    if (callback) callback({ success: false, error: err.message });
  }
}

// ============================================
// GROUP CALL HANDLERS
// ============================================

async function handleGroupCallStart(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { conversationId: string; callType: string; groupName?: string }
) {
  try {
    const redis = getRedis();
    const redisKey = `groupcall:${data.conversationId}`;

    // Get user display name
    const userResult = await query(
      'SELECT display_name, username FROM users WHERE id = $1',
      [user.userId]
    );
    const displayName = userResult.rows[0]?.display_name || user.username;

    // Store group call in Redis with 2 hour TTL
    const callData = {
      callType: data.callType,
      startedBy: user.userId,
      startedAt: new Date().toISOString(),
      groupName: data.groupName || '',
      participants: JSON.stringify([{
        userId: user.userId,
        displayName,
        joinedAt: new Date().toISOString(),
      }]),
    };
    await redis.hSet(redisKey, callData);
    await redis.expire(redisKey, 7200); // 2 hours max

    // Broadcast to all conversation members
    io.to(`conv:${data.conversationId}`).emit('group-call:started', {
      conversationId: data.conversationId,
      callType: data.callType,
      startedBy: user.userId,
      startedByName: displayName,
      groupName: data.groupName || '',
    });

    // Also emit participant joined for the starter
    io.to(`conv:${data.conversationId}`).emit('group-call:participant-joined', {
      conversationId: data.conversationId,
      userId: user.userId,
      displayName,
      extension: '',
    });

    console.log(`[WS] Group call started in ${data.conversationId} by ${user.username}`);
  } catch (err: any) {
    console.error('[WS] group-call:start error:', err.message);
  }
}

async function handleGroupCallJoin(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { conversationId: string }
) {
  try {
    const redis = getRedis();
    const redisKey = `groupcall:${data.conversationId}`;

    // Check if call exists
    const exists = await redis.exists(redisKey);
    if (!exists) return;

    // Get user display name
    const userResult = await query(
      'SELECT display_name, username FROM users WHERE id = $1',
      [user.userId]
    );
    const displayName = userResult.rows[0]?.display_name || user.username;

    // Add participant to Redis
    const participantsStr = await redis.hGet(redisKey, 'participants') || '[]';
    const participants = JSON.parse(participantsStr);
    const alreadyIn = participants.some((p: any) => p.userId === user.userId);
    if (!alreadyIn) {
      participants.push({
        userId: user.userId,
        displayName,
        joinedAt: new Date().toISOString(),
      });
      await redis.hSet(redisKey, 'participants', JSON.stringify(participants));
    }

    // Broadcast participant joined
    io.to(`conv:${data.conversationId}`).emit('group-call:participant-joined', {
      conversationId: data.conversationId,
      userId: user.userId,
      displayName,
      extension: '',
    });

    console.log(`[WS] ${user.username} joined group call in ${data.conversationId}`);
  } catch (err: any) {
    console.error('[WS] group-call:join error:', err.message);
  }
}

async function handleGroupCallLeave(
  socket: AuthenticatedSocket,
  user: AuthPayload,
  data: { conversationId: string }
) {
  try {
    const redis = getRedis();
    const redisKey = `groupcall:${data.conversationId}`;

    const exists = await redis.exists(redisKey);
    if (!exists) return;

    // Remove participant from Redis
    const participantsStr = await redis.hGet(redisKey, 'participants') || '[]';
    const participants = JSON.parse(participantsStr).filter(
      (p: any) => p.userId !== user.userId
    );

    // Broadcast participant left
    io.to(`conv:${data.conversationId}`).emit('group-call:participant-left', {
      conversationId: data.conversationId,
      userId: user.userId,
    });

    // If no participants left, end the call
    if (participants.length === 0) {
      await redis.del(redisKey);
      io.to(`conv:${data.conversationId}`).emit('group-call:ended', {
        conversationId: data.conversationId,
      });
      console.log(`[WS] Group call ended in ${data.conversationId} (last participant left)`);
    } else {
      await redis.hSet(redisKey, 'participants', JSON.stringify(participants));
    }

    console.log(`[WS] ${user.username} left group call in ${data.conversationId}`);
  } catch (err: any) {
    console.error('[WS] group-call:leave error:', err.message);
  }
}

async function handleDisconnect(socket: AuthenticatedSocket, user: AuthPayload) {
  console.log(`[WS] User disconnected: ${user.username}`);

  // Check if user has other active connections
  const rooms = io.sockets.adapter.rooms.get(`user:${user.userId}`);
  if (!rooms || rooms.size === 0) {
    await setUserOffline(user.userId);
    await query('UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2', ['offline', user.userId]);

    io.emit('presence:changed', {
      userId: user.userId,
      status: 'offline',
    });
  }
}
