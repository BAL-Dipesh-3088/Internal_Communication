import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { query } from '../../database/connection';
import groupCallRoutes from './group-call.routes';

const router = Router();

// Mount group call sub-router at /api/calls/group/*
router.use('/group', groupCallRoutes);

// GET /api/calls/history — Get user's call history from system messages
router.get('/history', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    const userId = req.user!.userId;
    const lim = parseInt(limit as string);
    const off = parseInt(offset as string);

    // Call history comes from TWO sources, because the two calling systems log
    // differently:
    //   A) GROUP calls (LiveKit)  → rows in the call_history table.
    //   B) 1:1 calls (WebRTC)     → system messages in the messages table
    //      (the 1:1 flow never writes call_history). We must read both and merge.
    const mapStatus = (s: string): string => {
      if (s === 'missed') return 'missed';
      if (s === 'rejected' || s === 'declined') return 'declined';
      if (s === 'failed') return 'failed';
      return 'completed';
    };

    // ── A) Group calls from call_history ──
    const groupRes = await query(
      `SELECT ch.id, ch.conversation_id, ch.call_type, ch.status,
              ch.duration_seconds, ch.caller_id, ch.host_user_id, ch.started_at,
              conv.name AS conv_name
         FROM call_history ch
         LEFT JOIN conversations conv ON conv.id = ch.conversation_id
        WHERE ch.is_group_call = TRUE
          AND (ch.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)
               OR ch.caller_id = $1 OR ch.host_user_id = $1)
        ORDER BY ch.started_at DESC
        LIMIT 200`,
      [userId]
    );
    const groupCalls = groupRes.rows.map((row: any) => ({
      id: `g:${row.id}`,
      sender_id: row.caller_id,
      sender_name: null,
      conversation_id: row.conversation_id,
      call_type: row.call_type || 'video',
      status: mapStatus(row.status),
      duration_seconds: row.duration_seconds || 0,
      direction: (row.caller_id === userId || row.host_user_id === userId) ? 'outgoing' : 'incoming',
      remote_name: row.conv_name || `Group ${row.call_type || 'video'} call`,
      remote_user_id: null, // no single call-back target for a group
      is_group_call: true,
      content: null,
      started_at: row.started_at,
    }));

    // ── B) 1:1 calls from chat system messages ──
    const oneToOneRes = await query(
      `SELECT m.id, m.sender_id, m.conversation_id, m.metadata, m.created_at,
              (SELECT cm.user_id FROM conversation_members cm
                WHERE cm.conversation_id = m.conversation_id AND cm.user_id != $1 LIMIT 1) as remote_user_id,
              (SELECT ru.display_name FROM conversation_members cm2
                JOIN users ru ON ru.id = cm2.user_id
                WHERE cm2.conversation_id = m.conversation_id AND cm2.user_id != $1 LIMIT 1) as remote_display_name
         FROM messages m
        WHERE m.type = 'system' AND m.metadata IS NOT NULL AND m.metadata->>'callType' IS NOT NULL
          AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)
        ORDER BY m.created_at DESC
        LIMIT 200`,
      [userId]
    );
    let oneToOne = oneToOneRes.rows.map((row: any) => {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      return {
        id: `m:${row.id}`,
        sender_id: row.sender_id,
        sender_name: null,
        conversation_id: row.conversation_id,
        call_type: meta.callType || 'audio',
        status: meta.status || 'completed',
        duration_seconds: meta.duration || 0,
        direction: meta.direction || 'outgoing',
        remote_name: meta.remoteName || row.remote_display_name || 'Unknown',
        remote_user_id: row.remote_user_id || null,
        is_group_call: false,
        content: row.content,
        started_at: row.created_at,
      };
    });
    // Dedup the 1:1 logs — both call sides can post; keep one per ~5s window per conversation.
    const seen = new Set<string>();
    oneToOne = oneToOne.filter((c: any) => {
      const key = `${c.conversation_id}-${Math.floor(new Date(c.started_at).getTime() / 5000)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── Merge both sources, newest first, then page ──
    const merged = [...groupCalls, ...oneToOne]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(off, off + lim);

    res.json({ calls: merged });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls — Log a new call
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { calleeId, callType, sipCallId, conversationId } = req.body;
    const callerId = req.user!.userId;

    const result = await query(
      `INSERT INTO call_history (caller_id, callee_id, call_type, sip_call_id, conversation_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, caller_id, callee_id, call_type, status, started_at`,
      [callerId, calleeId, callType || 'audio', sipCallId || null, conversationId || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calls/:id — Update call status (end call, etc.)
router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status, endedAt } = req.body;

    const result = await query(
      `UPDATE call_history
       SET status = $1, ended_at = COALESCE($2, NOW()),
           duration_seconds = EXTRACT(EPOCH FROM (COALESCE($2, NOW()) - started_at))::int
       WHERE id = $3 AND (caller_id = $4 OR callee_id = $4)
       RETURNING id, status, ended_at, duration_seconds`,
      [status || 'completed', endedAt || null, req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
