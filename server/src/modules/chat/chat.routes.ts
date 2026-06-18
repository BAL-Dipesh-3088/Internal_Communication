import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { query, getClient } from '../../database/connection';
import { getIO } from '../../services/socket.service';
import { z } from 'zod';

const router = Router();

// ============================================
// CONVERSATIONS
// ============================================

// GET /api/conversations — List user's conversations
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.id, c.type, c.name, c.description, c.avatar_url, c.last_message_at, c.created_at,
              cm.role as member_role, cm.is_muted, cm.last_read_message_id,
              (SELECT COUNT(*) FROM messages m
               WHERE m.conversation_id = c.id
               AND m.created_at > COALESCE(cm.last_read_at, cm.joined_at)
               AND m.sender_id != $1
               AND m.deleted_at IS NULL) as unread_count,
              (SELECT json_build_object('id', m.id, 'content', m.content, 'type', m.type,
                'sender_id', m.sender_id, 'created_at', m.created_at,
                'sender_name', u2.display_name)
               FROM messages m
               LEFT JOIN users u2 ON m.sender_id = u2.id
               WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
               ORDER BY m.created_at DESC LIMIT 1) as last_message,
              CASE WHEN c.type = 'direct' THEN
                (SELECT json_build_object('id', u3.id, 'display_name', u3.display_name,
                  'avatar_url', u3.avatar_url, 'status', u3.status, 'username', u3.username)
                 FROM conversation_members cm2
                 JOIN users u3 ON cm2.user_id = u3.id
                 WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
                 LIMIT 1)
              ELSE NULL END as other_user,
              (SELECT COUNT(*) FROM conversation_members cm3 WHERE cm3.conversation_id = c.id) as member_count
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND c.is_archived = false
       ORDER BY c.last_message_at DESC NULLS LAST`,
      [req.user!.userId]
    );

    res.json({ conversations: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conversations — Create conversation
const createConvSchema = z.object({
  type: z.enum(['direct', 'group']),
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  memberIds: z.array(z.string().uuid()).min(1),
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const input = createConvSchema.parse(req.body);
    const userId = req.user!.userId;

    await client.query('BEGIN');

    // For direct messages, check if conversation already exists
    if (input.type === 'direct' && input.memberIds.length === 1) {
      const otherId = input.memberIds[0];
      const existing = await client.query(
        `SELECT c.id FROM conversations c
         JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = $1
         JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = $2
         WHERE c.type = 'direct'`,
        [userId, otherId]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return res.json({ id: existing.rows[0].id, existing: true });
      }
    }

    // Create conversation
    const convResult = await client.query(
      `INSERT INTO conversations (type, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, name, description, created_at`,
      [input.type, input.name || null, input.description || null, userId]
    );

    const convId = convResult.rows[0].id;

    // Add creator as owner
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [convId, userId]
    );

    // Add other members
    for (const memberId of input.memberIds) {
      if (memberId !== userId) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
          [convId, memberId]
        );
      }
    }

    // Add system message
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, type, content, sequence_number)
       VALUES ($1, $2, 'system', $3, allocate_sequence_number($1))`,
      [convId, userId, input.type === 'group' ? `created the group "${input.name}"` : 'Conversation started']
    );

    await client.query('COMMIT');

    // Real-time: put every member's live sockets into the new conversation room
    // and notify them, so messages flow INSTANTLY without waiting for a reconnect
    // (rooms otherwise only join on connect). Best-effort — never block the response.
    try {
      const io = getIO();
      const members = [userId, ...input.memberIds.filter((m: string) => m !== userId)];
      for (const memberId of members) {
        io.in(`user:${memberId}`).socketsJoin(`conv:${convId}`);
        io.to(`user:${memberId}`).emit('conversation:created', { conversationId: convId });
      }
    } catch (e) { /* socket layer optional; REST result already prepared */ }

    res.status(201).json(convResult.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/conversations/:id — Get conversation details
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // Verify membership
    const memberCheck = await query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );
    if (memberCheck.rows.length === 0 && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const result = await query(
      `SELECT c.*, json_agg(json_build_object(
         'id', u.id, 'username', u.username, 'display_name', u.display_name,
         'avatar_url', u.avatar_url, 'status', u.status, 'role', cm.role
       )) as members
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       JOIN users u ON cm.user_id = u.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conversations/:id/members — Add member(s) to a group conversation
const addMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(20),
});

router.post('/:id/members', authMiddleware, async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const convId = String(req.params.id);
    const userId = req.user!.userId;
    const input = addMembersSchema.parse(req.body);

    // Verify conversation exists and is a group
    const convCheck = await client.query(
      'SELECT id, type, name FROM conversations WHERE id = $1',
      [convId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (convCheck.rows[0].type !== 'group') {
      return res.status(400).json({ error: 'Can only add members to group conversations' });
    }

    // Verify requester is a member
    const memberCheck = await client.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [convId, userId]
    );
    if (memberCheck.rows.length === 0 && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    await client.query('BEGIN');

    const addedUsers: { id: string; display_name: string }[] = [];

    for (const memberId of input.memberIds) {
      // Skip if already a member
      const exists = await client.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [convId, memberId]
      );
      if (exists.rows.length > 0) continue;

      // Add the member
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [convId, memberId]
      );

      // Get user info for the system message
      const userInfo = await client.query(
        'SELECT id, display_name FROM users WHERE id = $1',
        [memberId]
      );
      if (userInfo.rows.length > 0) {
        addedUsers.push(userInfo.rows[0]);
      }
    }

    if (addedUsers.length === 0) {
      await client.query('COMMIT');
      return res.json({ added: 0, message: 'All users are already members' });
    }

    // Get adder's name
    const adderInfo = await client.query(
      'SELECT display_name FROM users WHERE id = $1',
      [userId]
    );
    const adderName = adderInfo.rows[0]?.display_name || 'Someone';

    // Add system message
    const names = addedUsers.map((u) => u.display_name).join(', ');
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, type, content, sequence_number)
       VALUES ($1, $2, 'system', $3, allocate_sequence_number($1))`,
      [convId, userId, `${adderName} added ${names} to the group`]
    );

    // Update conversation timestamp
    await client.query(
      'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
      [convId]
    );

    await client.query('COMMIT');

    // Fetch updated members list
    const membersResult = await client.query(
      `SELECT u.id as user_id, u.username, u.display_name, u.avatar_url, u.status, cm.role
       FROM conversation_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.conversation_id = $1`,
      [convId]
    );

    // Notify via Socket.IO so all clients update in real time. Use the shared
    // getIO() + the canonical `conv:` room prefix (the rest of the app — message
    // broadcasts, handleConnect — uses `conv:`, NOT `conversation:`).
    try {
      const io = getIO();
      // Tell existing members the roster changed.
      io.to(`conv:${convId}`).emit('conversation:members-updated', {
        conversationId: convId,
        members: membersResult.rows,
        memberCount: membersResult.rows.length,
      });
      // Put each newly-added user's live sockets into the room AND notify them,
      // so they receive messages instantly without waiting for a reconnect.
      for (const added of addedUsers) {
        io.in(`user:${added.id}`).socketsJoin(`conv:${convId}`);
        io.to(`user:${added.id}`).emit('conversation:added', { conversationId: convId });
        io.to(`user:${added.id}`).emit('conversation:created', { conversationId: convId });
      }
    } catch (e) { /* socket layer optional */ }

    res.json({
      added: addedUsers.length,
      members: membersResult.rows,
      memberCount: membersResult.rows.length,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================
// MESSAGES
// ============================================

// GET /api/conversations/:id/messages — Get messages
router.get('/:id/messages', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', before, after, before_seq, after_seq } = req.query;

    // Verify membership (admin can view all)
    if (req.user!.role !== 'admin') {
      const memberCheck = await query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [req.params.id, req.user!.userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member' });
      }
    }

    let sql = `
      SELECT m.id, m.conversation_id, m.sender_id, m.type, m.content, m.metadata,
             m.reply_to_id, m.is_pinned, m.is_edited, m.edited_at, m.deleted_at, m.created_at,
             m.sequence_number, m.client_id,
             json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name,
               'avatar_url', u.avatar_url) as sender,
             COALESCE(
               (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id, 'username', u2.username))
                FROM message_reactions r JOIN users u2 ON r.user_id = u2.id
                WHERE r.message_id = m.id), '[]'
             ) as reactions,
             CASE WHEN m.reply_to_id IS NOT NULL THEN
               (SELECT json_build_object('id', rm.id, 'content', rm.content, 'sender_name', ru.display_name, 'sender_username', ru.username)
                FROM messages rm LEFT JOIN users ru ON rm.sender_id = ru.id
                WHERE rm.id = m.reply_to_id)
             ELSE NULL END as reply_to
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
    `;
    const params: any[] = [req.params.id];
    let paramIndex = 2;

    // Prefer sequence-based pagination, fall back to timestamp
    if (before_seq) {
      sql += ` AND m.sequence_number < $${paramIndex}`;
      params.push(parseInt(before_seq as string));
      paramIndex++;
    } else if (before) {
      sql += ` AND m.created_at < $${paramIndex}`;
      params.push(before);
      paramIndex++;
    }
    if (after_seq) {
      sql += ` AND m.sequence_number > $${paramIndex}`;
      params.push(parseInt(after_seq as string));
      paramIndex++;
    } else if (after) {
      sql += ` AND m.created_at > $${paramIndex}`;
      params.push(after);
      paramIndex++;
    }

    sql += ` ORDER BY m.sequence_number DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit as string));

    const result = await query(sql, params);

    res.json({ messages: result.rows.reverse() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conversations/:id/messages — Send message (HTTP fallback, primary is Socket.IO)
router.post('/:id/messages', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { content, type = 'text', replyToId, metadata, clientId } = req.body;

    if (!content && type === 'text') {
      return res.status(400).json({ error: 'Message content required' });
    }

    // Idempotency check
    if (clientId) {
      const existing = await query(
        'SELECT id, conversation_id, sender_id, type, content, metadata, created_at, sequence_number, client_id FROM messages WHERE conversation_id = $1 AND client_id = $2',
        [req.params.id, clientId]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json(existing.rows[0]);
      }
    }

    const result = await query(
      `INSERT INTO messages (conversation_id, sender_id, type, content, reply_to_id, metadata, client_id, sequence_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, allocate_sequence_number($1))
       RETURNING id, conversation_id, sender_id, type, content, reply_to_id, metadata, created_at, sequence_number, client_id`,
      [req.params.id, req.user!.userId, type, content, replyToId || null, metadata || {}, clientId || null]
    );

    // Update conversation last_message_at
    await query(
      'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/messages/:id — Edit message
router.put('/messages/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { content } = req.body;
    const result = await query(
      `UPDATE messages SET content = $1, is_edited = true, edited_at = NOW()
       WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
       RETURNING id, content, is_edited, edited_at`,
      [content, req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found or not yours' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/messages/:id — Soft delete message
router.delete('/messages/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE messages SET deleted_at = NOW(), content = '[deleted]'
       WHERE id = $1 AND (sender_id = $2 OR $3 = 'admin') AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.user!.userId, req.user!.role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:id/reactions — Toggle reaction
router.post('/messages/:id/reactions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji required' });

    // Toggle: remove if exists, add if not
    const existing = await query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING id',
      [req.params.id, req.user!.userId, emoji]
    );

    if (existing.rows.length > 0) {
      return res.json({ action: 'removed', emoji });
    }

    await query(
      'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
      [req.params.id, req.user!.userId, emoji]
    );

    res.json({ action: 'added', emoji });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conversations/:id/messages/search — Search messages
router.get('/:id/messages/search', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { q, limit = '20' } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const result = await query(
      `SELECT m.id, m.content, m.type, m.created_at,
              json_build_object('id', u.id, 'display_name', u.display_name) as sender
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
         AND m.search_vector @@ plainto_tsquery('english', $2)
         AND m.deleted_at IS NULL
       ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', $2)) DESC
       LIMIT $3`,
      [req.params.id, q, parseInt(limit as string)]
    );

    res.json({ messages: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
