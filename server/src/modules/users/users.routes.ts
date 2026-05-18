import { Router, Response } from 'express';
import { authMiddleware, AuthRequest, adminMiddleware } from '../../middleware/auth';
import { query } from '../../database/connection';
import { getOnlineUsers, getUserStatus } from '../../services/redis.service';

const router = Router();

// GET /api/users — List all users (with search)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // Default limit raised to 1000 so org-wide lists (contacts, mentions, group-add picker)
    // don't silently truncate. Callers that want pagination pass their own ?limit=.
    const { search, department, limit = '1000', offset = '0' } = req.query;
    let sql = `
      SELECT id, username, email, display_name, role, department, designation,
             avatar_url, status, status_message, sip_extension, last_seen
      FROM users WHERE is_active = true
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      sql += ` AND (display_name ILIKE $${paramIndex} OR username ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (department) {
      sql += ` AND department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    sql += ` ORDER BY display_name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query(sql, params);

    // Enrich with real-time presence from Redis
    const onlineSet = new Set(await getOnlineUsers());

    const users = result.rows.map((u: any) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      department: u.department,
      designation: u.designation,
      avatar_url: u.avatar_url,
      status: onlineSet.has(u.id) ? 'online' : 'offline',
      status_message: u.status_message,
      sip_extension: u.sip_extension,
      last_seen: u.last_seen,
    }));

    res.json({ users, total: users.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id — Get user profile
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, username, email, display_name, role, department, designation,
              avatar_url, status, status_message, sip_extension, last_seen, created_at
       FROM users WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = result.rows[0];
    const realtimeStatus = await getUserStatus(u.id);

    res.json({
      id: u.id,
      username: u.username,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      department: u.department,
      designation: u.designation,
      avatar_url: u.avatar_url,
      status: realtimeStatus !== 'offline' ? realtimeStatus : u.status,
      status_message: u.status_message,
      sip_extension: u.sip_extension,
      last_seen: u.last_seen,
      created_at: u.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — Update own profile
router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.userId !== req.params.id && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot update other user profiles' });
    }

    const { displayName, department, designation, statusMessage } = req.body;
    const result = await query(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        department = COALESCE($2, department),
        designation = COALESCE($3, designation),
        status_message = $4
       WHERE id = $5
       RETURNING id, username, display_name, department, designation, status_message`,
      [displayName, department, designation, statusMessage || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
