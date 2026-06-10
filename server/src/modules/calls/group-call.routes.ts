/**
 * Group call (Teams-style multi-party) routes — all routed through LiveKit SFU.
 *
 * Flow:
 *   POST /api/calls/group/start         → host creates room, gets token, members get notified
 *   POST /api/calls/group/:id/join      → late joiner gets a fresh token for the room
 *   POST /api/calls/group/:id/end       → host force-ends the room for everyone
 *   POST /api/calls/group/:id/kick      → host removes a single participant
 *   POST /api/calls/group/:id/mute-user → host server-mutes a participant's audio
 *
 * These are SEPARATE from the existing 1:1 webrtc flow (socket.service.ts). The
 * existing Socket.IO 'group-call:*' events stay in place but become advisory —
 * actual media routing is handled by LiveKit.
 */

import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { query } from '../../database/connection';
import { randomUUID } from 'crypto';
import * as livekit from '../../services/livekit.service';
import { getIO } from '../../services/socket.service';

const router = Router();
router.use(authMiddleware);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  const r = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
    [conversationId, userId],
  );
  return r.rows.length > 0;
}

async function isCallHost(callId: string, userId: string): Promise<boolean> {
  const r = await query(
    'SELECT 1 FROM call_history WHERE id = $1 AND host_user_id = $2 LIMIT 1',
    [callId, userId],
  );
  return r.rows.length > 0;
}

/**
 * A user counts as a "call participant" if they're listed in `participants` JSONB,
 * regardless of status ('invited' / 'joined'). Used for:
 *   - Authorizing who can invite OTHERS into the call (must already be in the call)
 *   - Authorizing /join for users who were invited but aren't conversation members
 */
async function isCallParticipant(callId: string, userId: string): Promise<boolean> {
  const r = await query(
    `SELECT participants FROM call_history WHERE id = $1`,
    [callId],
  );
  if (r.rows.length === 0) return false;
  const participants = parseParticipants(r.rows[0].participants);
  return participants.some((p) => p.userId === userId);
}

type CallParticipant = {
  userId: string;
  displayName?: string;
  joinedAt?: string;
  status?: 'invited' | 'joined' | 'declined';
  invitedBy?: string;
  invitedAt?: string;
};

function parseParticipants(raw: any): CallParticipant[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as CallParticipant[];
  try { return JSON.parse(raw) as CallParticipant[]; } catch { return []; }
}

async function getDisplayName(userId: string): Promise<string> {
  const r = await query('SELECT display_name, username FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.display_name || r.rows[0]?.username || 'User';
}

// ------------------------------------------------------------------
// GET /api/calls/group/active?conversationId=...
// ------------------------------------------------------------------
// Returns the ONE active (ringing or answered) group call for a conversation,
// or { call: null } if none.
//
// Reconciles with LiveKit before returning: if the DB says a call is active
// but LiveKit's room has 0 participants (or doesn't exist), the call is
// auto-marked as 'ended'. This handles the common "ghost call" problem where
// the host's browser crashed / closed without calling /end, leaving a stale
// row that would otherwise show the banner forever.
//
// Used to render the "Meeting in progress — Join" banner.
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || '');
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    const userId = req.user!.userId;
    if (!(await isConversationMember(conversationId, userId))) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const r = await query(
      `SELECT ch.id              AS call_id,
              ch.call_type,
              ch.host_user_id,
              ch.livekit_room_name,
              ch.started_at,
              ch.participants,
              u.display_name      AS host_name,
              u.username          AS host_username
         FROM call_history ch
         LEFT JOIN users u ON u.id = ch.host_user_id
        WHERE ch.conversation_id = $1
          AND ch.is_group_call = TRUE
          AND ch.status IN ('ringing', 'answered')
        ORDER BY ch.started_at DESC
        LIMIT 1`,
      [conversationId],
    );

    if (r.rows.length === 0) return res.json({ call: null });

    const row = r.rows[0];

    // ── Reconcile with LiveKit — verify the room actually has participants ──
    // Grace period: a brand-new call (< 60s old) might not have anyone yet because
    // the host is still connecting. Don't auto-end during the grace window.
    const ageMs = Date.now() - new Date(row.started_at).getTime();
    const isInGracePeriod = ageMs < 60_000;

    if (row.livekit_room_name && !isInGracePeriod) {
      try {
        const liveParticipants = await livekit.listParticipants(row.livekit_room_name);
        if (!liveParticipants || liveParticipants.length === 0) {
          // Ghost call — room is empty (host closed browser etc.). Auto-end it.
          console.log(`[GroupCall] Ghost call detected (id=${row.call_id}, room=${row.livekit_room_name}) — auto-ending`);
          await query(
            `UPDATE call_history
                SET status = 'ended',
                    ended_at = NOW(),
                    duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int
              WHERE id = $1`,
            [row.call_id],
          );
          // Broadcast so any banners clear immediately on every client
          const io = getIO();
          io.to(`conv:${conversationId}`).emit('group-call:active-ended', {
            callId: row.call_id,
            conversationId,
          });
          return res.json({ call: null });
        }
      } catch (err: any) {
        // LiveKit is unreachable (e.g. Docker container is down). Be conservative:
        // don't auto-end (we'd lose legitimate calls during transient outages).
        // But signal the dead state to the client so it doesn't pretend it's joinable.
        console.warn(`[GroupCall] LiveKit unreachable while reconciling call ${row.call_id}: ${err.message}`);
        return res.json({
          call: null,
          warning: 'LiveKit server unreachable — group calls temporarily unavailable',
        });
      }
    }

    return res.json({
      call: {
        callId: row.call_id,
        callType: row.call_type,
        hostId: row.host_user_id,
        hostName: row.host_name || row.host_username || 'Host',
        roomName: row.livekit_room_name,
        startedAt: row.started_at,
        participants: row.participants || [],
      },
    });
  } catch (err: any) {
    console.error('[GroupCall] active error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/calls/group/:callId/info
// ------------------------------------------------------------------
// Lightweight meeting info — used by the /meeting/:callId join page so it
// can render a preview ("Akash Yadav's meeting", N participants) BEFORE the
// user commits to joining. Available to any authenticated BAL Connect user
// (the callId UUID is the shared-secret that makes the link work).
//
// Reconciles with LiveKit just like /active — if the LiveKit room is empty
// and the call is older than the grace period, returns { status: 'ended' }.
router.get('/:callId/info', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);

    const r = await query(
      `SELECT ch.id, ch.call_type, ch.host_user_id, ch.livekit_room_name,
              ch.started_at, ch.status, ch.participants, ch.conversation_id,
              u.display_name AS host_name, u.username AS host_username,
              c.name AS conversation_name
         FROM call_history ch
         LEFT JOIN users u ON u.id = ch.host_user_id
         LEFT JOIN conversations c ON c.id = ch.conversation_id
        WHERE ch.id = $1`,
      [callId],
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Meeting not found' });
    const row = r.rows[0];

    // Read live participant count + room metadata (for custom title) from LiveKit
    let livePresent = 0;
    let liveMetadata: string | null = null;
    let resolvedStatus: string = row.status;

    // Only reconcile with LiveKit for ACTIVE calls. 'scheduled' calls have no
    // live room yet — the LiveKit room is auto-created when the first
    // participant joins. Running the reconciler on them would falsely mark
    // every future calendar meeting as ended.
    if (row.livekit_room_name && row.status !== 'ended' && row.status !== 'scheduled') {
      try {
        const list = await livekit.listParticipants(row.livekit_room_name);
        livePresent = list.length;
        // Grab metadata from the first room-level lookup
        const rooms = await livekit.listRooms();
        const room = rooms.find((rm) => rm.name === row.livekit_room_name);
        liveMetadata = room?.metadata || null;

        // Reconcile: empty room + old enough → mark ended
        const ageMs = Date.now() - new Date(row.started_at).getTime();
        if (livePresent === 0 && ageMs > 60_000) {
          await query(
            `UPDATE call_history SET status = 'ended', ended_at = NOW() WHERE id = $1`,
            [callId],
          );
          resolvedStatus = 'ended';
        }
      } catch {
        // LiveKit unreachable — fall through with DB-only data
      }
    }

    // Parse custom title from LiveKit room metadata if present
    let customTitle: string | null = null;
    try {
      if (liveMetadata) {
        const parsed = JSON.parse(liveMetadata);
        if (typeof parsed?.title === 'string') customTitle = parsed.title;
      }
    } catch { /* metadata not JSON or no title */ }

    res.json({
      callId,
      callType: row.call_type,
      hostId: row.host_user_id,
      hostName: row.host_name || row.host_username || 'Host',
      conversationId: row.conversation_id || null,
      conversationName: row.conversation_name || null,
      title: customTitle,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      status: resolvedStatus,
      participantCount: livePresent,
    });
  } catch (err: any) {
    console.error('[GroupCall] info error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/title  (host only)
// ------------------------------------------------------------------
// Body: { title: string }
//
// Updates the meeting title. Stored as the LiveKit room metadata — this is
// auto-synced to every connected client (they get it via useRoomInfo()'s
// `metadata` field), so no extra socket plumbing required.
//
// Empty string clears the custom title (reverts to default "Group Video Call").
router.post('/:callId/title', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;
    const title = String(req.body?.title ?? '').slice(0, 200); // hard cap

    if (!(await isCallHost(callId, userId))) {
      return res.status(403).json({ error: 'Only the host can rename the meeting' });
    }

    const r = await query('SELECT livekit_room_name FROM call_history WHERE id = $1', [callId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const { livekit_room_name } = r.rows[0];
    if (!livekit_room_name) return res.status(400).json({ error: 'Not a LiveKit room' });

    // Stored as JSON so we can add more fields later (e.g. agenda, recording flag)
    const metadata = JSON.stringify({ title });

    try {
      await livekit.updateRoomMetadata(livekit_room_name, metadata);
    } catch (err: any) {
      return res.status(502).json({ error: 'LiveKit metadata update failed: ' + err.message });
    }

    res.json({ ok: true, title });
  } catch (err: any) {
    console.error('[GroupCall] title update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/start
// ------------------------------------------------------------------
// Body: { conversationId: string, callType: 'audio' | 'video' }
// Returns: { callId, livekit: { wsUrl, token, roomName } }
router.post('/start', async (req: AuthRequest, res: Response) => {
  try {
    const { conversationId, callType } = req.body || {};
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
    if (callType !== 'audio' && callType !== 'video') {
      return res.status(400).json({ error: 'callType must be "audio" or "video"' });
    }

    const hostId = req.user!.userId;

    // Verify caller is a member of the conversation
    if (!(await isConversationMember(conversationId, hostId))) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Use a deterministic-ish room name so late joiners can find it
    const roomName = `gc-${conversationId.replace(/-/g, '').slice(0, 12)}-${Date.now().toString(36)}`;

    // Pre-create the LiveKit room (so max_participants = 30 takes effect immediately)
    try {
      await livekit.createRoom(roomName, 30);
    } catch (err: any) {
      // Room might already exist — that's OK. Other errors abort.
      if (!String(err.message || '').toLowerCase().includes('already exists')) {
        console.error('[GroupCall] createRoom error:', err.message);
        return res.status(502).json({ error: 'Failed to create LiveKit room: ' + err.message });
      }
    }

    // Get host display name
    const hostName = await getDisplayName(hostId);

    // Mint host's access token (with admin/host privileges)
    const token = await livekit.generateAccessToken({
      roomName,
      identity: hostId,
      name: hostName,
      isHost: true,
      ttlSeconds: 3600 * 4, // 4 hours
    });

    // Write call_history row
    const callId = randomUUID();
    await query(
      `INSERT INTO call_history (
         id, caller_id, conversation_id, call_type, is_group_call, status,
         participants, livekit_room_name, host_user_id, started_at
       ) VALUES ($1, $2, $3, $4, TRUE, 'ringing', $5, $6, $2, NOW())`,
      [
        callId,
        hostId,
        conversationId,
        callType,
        JSON.stringify([{ userId: hostId, displayName: hostName, joinedAt: new Date().toISOString() }]),
        roomName,
      ],
    );

    // Ring all other conversation members via Socket.IO
    const io = getIO();
    const startedAt = new Date().toISOString();
    io.to(`conv:${conversationId}`).emit('group-call:incoming', {
      callId,
      conversationId,
      callType,
      hostId,
      hostName,
      roomName,
      startedAt,
    });

    // Persistent active-meeting marker so late joiners can discover and join.
    // Sent to the same room — clients merge this into a per-conversation map.
    io.to(`conv:${conversationId}`).emit('group-call:active', {
      callId,
      conversationId,
      callType,
      hostId,
      hostName,
      roomName,
      startedAt,
      participants: [{ userId: hostId, displayName: hostName, joinedAt: startedAt }],
    });

    console.log(`[GroupCall] ${hostName} started ${callType} call in ${conversationId} (room=${roomName})`);

    return res.json({
      callId,
      livekit: {
        wsUrl: livekit.getClientWsUrl(),
        token,
        roomName,
      },
    });
  } catch (err: any) {
    console.error('[GroupCall] start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/join
// ------------------------------------------------------------------
// Returns: { livekit: { wsUrl, token, roomName } }
router.post('/:callId/join', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;

    const callR = await query(
      `SELECT id, conversation_id, livekit_room_name, status, is_group_call, host_user_id, participants
         FROM call_history WHERE id = $1`,
      [callId],
    );
    if (callR.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const call = callR.rows[0];

    if (!call.is_group_call || !call.livekit_room_name) {
      return res.status(400).json({ error: 'Not a group call' });
    }
    if (call.status === 'ended') {
      return res.status(410).json({ error: 'Call has ended' });
    }

    // ── Authorization ──
    // Allow joining if ANY of:
    //   (a) the user is a member of the conversation (normal group call), OR
    //   (b) the user was explicitly invited into this call by an existing
    //       participant (in-call invite — Teams-style "add people" flow), OR
    //   (c) the user has the meeting link (callId is a UUID — unguessable).
    //       This is the Teams-style "anyone in the org with the link can join"
    //       model and is safe for an internal-only authenticated platform.
    // Invitations are tracked in participants JSONB with status='invited'.
    const participantsBefore = parseParticipants(call.participants);
    const isInvited = participantsBefore.some((p) => p.userId === userId && p.status === 'invited');
    const isMember = await isConversationMember(call.conversation_id, userId);

    // All authenticated BAL Connect users with the link can join. We still
    // log who joins via which path for audit purposes (the participants JSONB
    // captures everyone who actually joined).
    if (!isMember && !isInvited) {
      console.log(`[GroupCall] link-join: user ${userId} joining call ${callId} via meeting link (not a conv member, not pre-invited)`);
    }

    const displayName = await getDisplayName(userId);

    // Mint token for joiner (non-host unless they ARE the host)
    const token = await livekit.generateAccessToken({
      roomName: call.livekit_room_name,
      identity: userId,
      name: displayName,
      isHost: call.host_user_id === userId,
      ttlSeconds: 3600 * 4,
    });

    // Update participants JSONB:
    //   - If already 'joined' (or host already there), nothing to do.
    //   - If 'invited', flip to 'joined' and stamp joinedAt.
    //   - If not present, append as a new joined participant.
    try {
      const participants = parseParticipants(call.participants);
      const existing = participants.find((p) => p.userId === userId);
      if (!existing) {
        participants.push({ userId, displayName, status: 'joined', joinedAt: new Date().toISOString() });
      } else {
        existing.status = 'joined';
        existing.joinedAt = existing.joinedAt || new Date().toISOString();
        existing.displayName = existing.displayName || displayName;
      }
      await query(
        `UPDATE call_history SET participants = $1, status = CASE WHEN status IN ('ringing', 'scheduled') THEN 'answered' ELSE status END
           WHERE id = $2`,
        [JSON.stringify(participants), callId],
      );
    } catch (err) {
      // Non-fatal — participant tracking is best-effort
      console.warn('[GroupCall] participant update failed:', err);
    }

    // Broadcast participant joined
    const io = getIO();
    io.to(`conv:${call.conversation_id}`).emit('group-call:participant-joined', {
      callId,
      conversationId: call.conversation_id,
      userId,
      displayName,
    });

    return res.json({
      livekit: {
        wsUrl: livekit.getClientWsUrl(),
        token,
        roomName: call.livekit_room_name,
      },
    });
  } catch (err: any) {
    console.error('[GroupCall] join error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/invite
// ------------------------------------------------------------------
// Body: { userId: string }
// Caller must be a participant (already joined) in the call.
// The invited user gets an incoming-call ring on their personal socket room
// AND is recorded in call_history.participants with status='invited' so the
// existing /join endpoint will authorize them even if they're not a member
// of the underlying conversation.
//
// Matches Microsoft Teams' "Add people to this meeting" flow — anyone in
// the meeting can invite, not just the host. Invitations are one-shot and
// per-call (don't grant permanent conversation membership).
router.post('/:callId/invite', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const inviterId = req.user!.userId;
    const inviteeId = String(req.body?.userId || '').trim();

    if (!inviteeId) return res.status(400).json({ error: 'userId required' });
    if (inviteeId === inviterId) return res.status(400).json({ error: 'Cannot invite yourself' });

    // 1. Inviter must be a current participant of the call (not host-only — anyone in the meeting can invite)
    if (!(await isCallParticipant(callId, inviterId))) {
      return res.status(403).json({ error: 'You must be in the call to invite others' });
    }

    // 2. Load the call & verify it's active
    const callR = await query(
      `SELECT id, conversation_id, call_type, status, is_group_call, livekit_room_name, host_user_id, participants, started_at
         FROM call_history WHERE id = $1`,
      [callId],
    );
    if (callR.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const call = callR.rows[0];

    if (!call.is_group_call) return res.status(400).json({ error: 'Not a group call' });
    if (call.status === 'ended') return res.status(410).json({ error: 'Call has ended' });

    // 3. Verify the invitee is a real, active user (not deleted/disabled)
    const userR = await query(
      `SELECT id, display_name, username FROM users WHERE id = $1 AND is_active = true LIMIT 1`,
      [inviteeId],
    );
    if (userR.rows.length === 0) return res.status(404).json({ error: 'User not found or inactive' });
    const inviteeName = userR.rows[0].display_name || userR.rows[0].username || 'User';

    // 4. Update participants JSONB
    //    - If already joined: no-op (don't re-ring someone already in the call)
    //    - If already invited but hasn't joined: re-ring them (they may have missed it)
    //    - Otherwise: append as new invited participant
    const participants = parseParticipants(call.participants);
    const existing = participants.find((p) => p.userId === inviteeId);

    if (existing?.status === 'joined') {
      return res.status(409).json({ error: 'User is already in the call' });
    }

    if (!existing) {
      participants.push({
        userId: inviteeId,
        displayName: inviteeName,
        status: 'invited',
        invitedBy: inviterId,
        invitedAt: new Date().toISOString(),
      });
    } else {
      // Re-invite — refresh the invitedAt so we can show "Just now" in the UI
      existing.status = 'invited';
      existing.invitedBy = inviterId;
      existing.invitedAt = new Date().toISOString();
      existing.displayName = existing.displayName || inviteeName;
    }

    await query(
      `UPDATE call_history SET participants = $1 WHERE id = $2`,
      [JSON.stringify(participants), callId],
    );

    // 5. Get inviter's display name for the ring payload
    const inviterName = await getDisplayName(inviterId);

    // 6. Emit incoming-call ring to the invitee's personal socket room.
    //    The same `group-call:incoming` event the conversation broadcast uses —
    //    the invitee's frontend already listens for this and renders the modal.
    const io = getIO();
    const ringPayload = {
      callId,
      conversationId: call.conversation_id,
      callType: call.call_type,
      hostId: call.host_user_id,
      hostName: inviterName, // For the invitee, the "inviter" IS effectively the caller
      roomName: call.livekit_room_name,
      startedAt: call.started_at instanceof Date ? call.started_at.toISOString() : String(call.started_at),
      invitedBy: { userId: inviterId, displayName: inviterName },
    };
    io.to(`user:${inviteeId}`).emit('group-call:incoming', ringPayload);

    // 7. Tell everyone in the conversation that a new person was invited (for UI updates)
    io.to(`conv:${call.conversation_id}`).emit('group-call:participant-invited', {
      callId,
      conversationId: call.conversation_id,
      userId: inviteeId,
      displayName: inviteeName,
      invitedBy: { userId: inviterId, displayName: inviterName },
    });

    console.log(`[GroupCall] ${inviterName} invited ${inviteeName} into call ${callId}`);

    res.json({ ok: true, invited: { userId: inviteeId, displayName: inviteeName } });
  } catch (err: any) {
    console.error('[GroupCall] invite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/calls/group/:callId/chat  — fetch chat history
// ------------------------------------------------------------------
// Optional query: ?since=<ISO-8601 timestamp> to fetch only newer messages
// (delta sync). Defaults to full history.
//
// Authorization: caller must be a current OR invited call participant. Anyone
// else is rejected (chat history is private to call attendees).
router.get('/:callId/chat', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;

    if (!(await isCallParticipant(callId, userId))) {
      return res.status(403).json({ error: 'You must be in the call to read chat' });
    }

    const since = String(req.query.since || '');
    const params: any[] = [callId];
    let sql = `SELECT id, sender_id, sender_display_name, client_msg_id, content, created_at
                 FROM call_chat_messages
                WHERE call_id = $1`;
    if (since) {
      sql += ` AND created_at > $2`;
      params.push(since);
    }
    sql += ` ORDER BY created_at ASC LIMIT 1000`;

    const r = await query(sql, params);

    res.json({
      messages: r.rows.map((m: any) => ({
        id: m.id,
        senderId: m.sender_id,
        senderDisplayName: m.sender_display_name,
        clientMsgId: m.client_msg_id,
        content: m.content,
        createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
      })),
    });
  } catch (err: any) {
    console.error('[GroupCall] chat history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/chat  — persist a chat message
// ------------------------------------------------------------------
// Body: { clientMsgId: string (UUID), content: string }
// The client also broadcasts via LiveKit's data channel for real-time delivery —
// this endpoint exists purely for persistence so late joiners can hydrate.
//
// The (call_id, client_msg_id) unique index makes this idempotent: if the
// client retries the POST after a network blip, the second insert is a no-op
// (caught by ON CONFLICT) and we return the existing row.
router.post('/:callId/chat', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;
    const clientMsgId = String(req.body?.clientMsgId || '').trim();
    const content = String(req.body?.content || '').trim();

    if (!clientMsgId || !/^[0-9a-f-]{36}$/i.test(clientMsgId)) {
      return res.status(400).json({ error: 'clientMsgId must be a UUID' });
    }
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 chars)' });

    if (!(await isCallParticipant(callId, userId))) {
      return res.status(403).json({ error: 'You must be in the call to send chat' });
    }

    const senderName = await getDisplayName(userId);

    // ON CONFLICT (call_id, client_msg_id) DO UPDATE ... RETURNING — idempotent insert.
    // The DO UPDATE is a no-op trick that lets us RETURNING the existing row on duplicate.
    const r = await query(
      `INSERT INTO call_chat_messages (call_id, sender_id, sender_display_name, client_msg_id, content)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (call_id, client_msg_id)
         DO UPDATE SET content = call_chat_messages.content
       RETURNING id, sender_id, sender_display_name, client_msg_id, content, created_at`,
      [callId, userId, senderName, clientMsgId, content],
    );

    const row = r.rows[0];
    res.json({
      message: {
        id: row.id,
        senderId: row.sender_id,
        senderDisplayName: row.sender_display_name,
        clientMsgId: row.client_msg_id,
        content: row.content,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      },
    });
  } catch (err: any) {
    console.error('[GroupCall] chat send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/lower-hand  (host only)
// ------------------------------------------------------------------
// Body: { targetUserId: string | 'all' }
//
// Clears the `handRaised` participant attribute for either a single user or
// every user currently in the call. We hit LiveKit's server API rather than
// trying to do this client-side, because the client SDK only allows
// participants to update their OWN attributes.
//
// Use cases (matches Microsoft Teams):
//   - Host calls on a specific raised hand to speak → after that person is
//     done, host lowers their hand
//   - Host wants a clean slate at the start of a new agenda topic →
//     "Lower all hands"
router.post('/:callId/lower-hand', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;
    const targetUserId = String(req.body?.targetUserId || '').trim();

    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required ("all" or a user id)' });
    if (!(await isCallHost(callId, userId))) {
      return res.status(403).json({ error: 'Only the host can lower other participants\' hands' });
    }

    const r = await query('SELECT livekit_room_name FROM call_history WHERE id = $1', [callId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const { livekit_room_name } = r.rows[0];
    if (!livekit_room_name) return res.status(400).json({ error: 'Not a LiveKit room' });

    // Empty-string value clears the attribute on LiveKit's side
    const clearAttrs = { handRaised: '', handRaisedAt: '' };

    if (targetUserId === 'all') {
      // Iterate everyone currently in the LiveKit room with a raised hand
      const participants = await livekit.listParticipants(livekit_room_name);
      const withHands = participants.filter((p) => p.attributes?.handRaised === '1');
      await Promise.all(
        withHands.map((p) =>
          livekit.updateParticipantAttributes(livekit_room_name, p.identity, clearAttrs)
            .catch((err: any) => console.warn(`[GroupCall] lower-hand failed for ${p.identity}:`, err.message)),
        ),
      );
      return res.json({ ok: true, lowered: withHands.length });
    }

    // Single user
    try {
      await livekit.updateParticipantAttributes(livekit_room_name, targetUserId, clearAttrs);
    } catch (err: any) {
      return res.status(502).json({ error: 'LiveKit update failed: ' + err.message });
    }
    res.json({ ok: true, lowered: 1 });
  } catch (err: any) {
    console.error('[GroupCall] lower-hand error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/end  (host only)
// ------------------------------------------------------------------
router.post('/:callId/end', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;

    if (!(await isCallHost(callId, userId))) {
      return res.status(403).json({ error: 'Only the host can end the call' });
    }

    const callR = await query(
      'SELECT livekit_room_name, conversation_id, started_at FROM call_history WHERE id = $1',
      [callId],
    );
    if (callR.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const call = callR.rows[0];

    // Tell LiveKit to disconnect everyone
    if (call.livekit_room_name) {
      try { await livekit.endRoom(call.livekit_room_name); } catch (err: any) {
        console.warn('[GroupCall] livekit endRoom warning:', err.message);
      }
    }

    // Update DB
    await query(
      `UPDATE call_history
          SET status = 'ended',
              ended_at = NOW(),
              duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int
        WHERE id = $1`,
      [callId],
    );

    // Notify conversation
    const io = getIO();
    io.to(`conv:${call.conversation_id}`).emit('group-call:ended', {
      callId,
      conversationId: call.conversation_id,
      endedBy: userId,
    });
    // Clear the persistent banner on all clients
    io.to(`conv:${call.conversation_id}`).emit('group-call:active-ended', {
      callId,
      conversationId: call.conversation_id,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[GroupCall] end error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/kick  (host only)
// ------------------------------------------------------------------
// Body: { targetUserId: string }
router.post('/:callId/kick', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;
    const targetUserId = String(req.body?.targetUserId || '');

    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    if (!(await isCallHost(callId, userId))) {
      return res.status(403).json({ error: 'Only the host can remove participants' });
    }

    const r = await query('SELECT livekit_room_name, conversation_id FROM call_history WHERE id = $1', [callId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const { livekit_room_name, conversation_id } = r.rows[0];

    if (livekit_room_name) {
      try { await livekit.kickParticipant(livekit_room_name, targetUserId); } catch (err: any) {
        console.warn('[GroupCall] kick warning:', err.message);
      }
    }

    const io = getIO();
    io.to(`conv:${conversation_id}`).emit('group-call:participant-kicked', {
      callId,
      userId: targetUserId,
      kickedBy: userId,
    });

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/mute-user  (host only)
// ------------------------------------------------------------------
// Body: { targetUserId: string, mute: boolean }
router.post('/:callId/mute-user', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;
    const targetUserId = String(req.body?.targetUserId || '');
    const mute = req.body?.mute === true;

    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    if (!(await isCallHost(callId, userId))) {
      return res.status(403).json({ error: 'Only the host can mute participants' });
    }

    const r = await query('SELECT livekit_room_name FROM call_history WHERE id = $1', [callId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    const { livekit_room_name } = r.rows[0];

    if (!livekit_room_name) return res.status(400).json({ error: 'Not a LiveKit room' });

    try {
      await livekit.muteParticipantAudio(livekit_room_name, targetUserId, mute);
    } catch (err: any) {
      return res.status(502).json({ error: 'Mute failed: ' + err.message });
    }

    res.json({ ok: true, muted: mute });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// POST /api/calls/group/:callId/decline  (callee declines incoming ring)
// ------------------------------------------------------------------
router.post('/:callId/decline', async (req: AuthRequest, res: Response) => {
  try {
    const callId = String(req.params.callId);
    const userId = req.user!.userId;

    const r = await query('SELECT conversation_id FROM call_history WHERE id = $1', [callId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Call not found' });

    const io = getIO();
    io.to(`conv:${r.rows[0].conversation_id}`).emit('group-call:participant-declined', {
      callId,
      userId,
    });

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
