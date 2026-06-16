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

    // Source of truth = the call_history table (every 1:1 AND group call, with
    // real duration/status). The old approach scraped chat system messages,
    // which missed group calls and any call that didn't post a message.
    const result = await query(
      `SELECT ch.id, ch.conversation_id, ch.call_type, ch.is_group_call, ch.status,
              ch.duration_seconds, ch.caller_id, ch.host_user_id, ch.started_at,
              conv.name AS conv_name, conv.type AS conv_type,
              (SELECT ru.display_name FROM conversation_members cm
                 JOIN users ru ON ru.id = cm.user_id
                WHERE cm.conversation_id = ch.conversation_id AND cm.user_id != $1
                LIMIT 1) AS other_name,
              (SELECT cm.user_id FROM conversation_members cm
                WHERE cm.conversation_id = ch.conversation_id AND cm.user_id != $1
                LIMIT 1) AS other_user_id
         FROM call_history ch
         LEFT JOIN conversations conv ON conv.id = ch.conversation_id
        WHERE ch.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)
           OR ch.caller_id = $1
           OR ch.host_user_id = $1
        ORDER BY ch.started_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit as string), parseInt(offset as string)]
    );

    // Map call_history.status → the 4 statuses the UI understands.
    const mapStatus = (s: string): string => {
      if (s === 'missed') return 'missed';
      if (s === 'rejected' || s === 'declined') return 'declined';
      if (s === 'failed') return 'failed';
      return 'completed'; // ended / answered / ringing / initiated / scheduled
    };

    const calls = result.rows.map((row: any) => {
      const isGroup = row.is_group_call === true;
      const remoteName = isGroup
        ? (row.conv_name || `Group ${row.call_type} call`)
        : (row.other_name || 'Unknown');
      return {
        id: row.id,
        sender_id: row.caller_id,
        sender_name: null,
        conversation_id: row.conversation_id,
        call_type: row.call_type || 'audio',
        status: mapStatus(row.status),
        duration_seconds: row.duration_seconds || 0,
        // outgoing if I started it (caller or host); else incoming
        direction: (row.caller_id === userId || row.host_user_id === userId) ? 'outgoing' : 'incoming',
        remote_name: remoteName,
        // Group calls have no single "call back" target → disable the callback buttons
        remote_user_id: isGroup ? null : (row.other_user_id || null),
        is_group_call: isGroup,
        content: null,
        started_at: row.started_at,
      };
    });

    res.json({ calls });
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
