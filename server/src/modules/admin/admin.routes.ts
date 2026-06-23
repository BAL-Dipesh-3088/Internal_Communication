import { Router, Response } from 'express';
import { authMiddleware, adminMiddleware, AuthRequest } from '../../middleware/auth';
import { query, pool } from '../../database/connection';
import { getOnlineUsers } from '../../services/redis.service';
import { config } from '../../config';
import https from 'https';
import net from 'net';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { ucmService } from '../../services/ucm.service';
import { lookupEmployee, searchEmployees, directoryHealth } from '../../services/employee-directory.service';
import * as stalwart from '../../services/stalwart.service';
import { encryptSecret, generateMailPassword } from '../../utils/crypto';

const router = Router();

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// ============================================
// DASHBOARD
// ============================================

// GET /api/admin/dashboard — Overview stats
router.get('/dashboard', async (_req: AuthRequest, res: Response) => {
  try {
    const [usersResult, convsResult, msgsResult, filesResult, callsResult, onlineUsers] =
      await Promise.all([
        query('SELECT COUNT(*) as total FROM users'),
        query('SELECT COUNT(*) as total FROM conversations'),
        query('SELECT COUNT(*) as total FROM messages WHERE deleted_at IS NULL'),
        query('SELECT COUNT(*) as total, COALESCE(SUM(size_bytes), 0) as total_size FROM files'),
        // Calls today = group/LiveKit calls (call_history) + 1:1 WebRTC calls
        // (logged as chat system-messages). The two calling systems log to
        // different places, so we count both.
        query(`SELECT
                 (SELECT COUNT(*) FROM call_history
                    WHERE started_at > NOW() - INTERVAL '24 hours')
                 +
                 (SELECT COUNT(*) FROM messages
                    WHERE type = 'system' AND metadata->>'callType' IS NOT NULL
                      AND created_at > NOW() - INTERVAL '24 hours')
               AS total`),
        getOnlineUsers(),
      ]);

    // Resolve online user IDs to names and clean stale entries
    let onlineUserDetails: { id: string; username: string; display_name: string }[] = [];
    if (onlineUsers.length > 0) {
      // Filter to valid UUIDs only (Redis may contain stale/corrupt entries)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validIds = onlineUsers.filter(id => uuidRegex.test(id));
      if (validIds.length > 0) {
        const onlineResult = await query(
          `SELECT id, username, display_name FROM users WHERE id = ANY($1::uuid[])`,
          [validIds]
        );
        onlineUserDetails = onlineResult.rows;
      }
    }

    // Recent activity (last 24h messages)
    const recentActivity = await query(
      `SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as count
       FROM messages WHERE created_at > NOW() - INTERVAL '24 hours' AND deleted_at IS NULL
       GROUP BY hour ORDER BY hour`
    );

    res.json({
      users: {
        total: parseInt(usersResult.rows[0].total),
        online: onlineUserDetails.length,
      },
      conversations: parseInt(convsResult.rows[0].total),
      messages: parseInt(msgsResult.rows[0].total),
      files: {
        count: parseInt(filesResult.rows[0].total),
        totalSizeBytes: parseInt(filesResult.rows[0].total_size),
      },
      callsToday: parseInt(callsResult.rows[0].total),
      recentActivity: recentActivity.rows,
      onlineUsers: onlineUserDetails,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// USER MANAGEMENT
// ============================================

// GET /api/admin/users — List all users with details
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    // Default limit raised to 1000 so admin views never silently truncate the user list.
    // Pagination still works for callers that explicitly pass ?limit= and ?offset=.
    const { search, department, limit = '1000', offset = '0' } = req.query;

    let sql = `
      SELECT id, username, email, display_name, avatar_url, role, department, designation,
             employee_id, sip_extension, sip_password, status, status_message, is_active, last_seen, created_at,
             mail_status, mail_assigned_at, mail_assigned_by, mail_last_test_at, mail_last_test_ok,
             (SELECT COUNT(*) FROM messages WHERE sender_id = users.id AND deleted_at IS NULL) as message_count,
             (SELECT COUNT(*) FROM files WHERE uploaded_by = users.id) as file_count
      FROM users WHERE 1=1
    `;
    const params: any[] = [];
    let idx = 1;

    if (search) {
      sql += ` AND (username ILIKE $${idx} OR display_name ILIKE $${idx} OR email ILIKE $${idx} OR employee_id ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (department) {
      sql += ` AND department = $${idx}`;
      params.push(department);
      idx++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) as total FROM users');

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].total),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id — Update user (admin can change role, disable, etc.)
router.put('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { role, department, designation, display_name, status, is_active } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (role) { updates.push(`role = $${idx}`); params.push(role); idx++; }
    if (department !== undefined) { updates.push(`department = $${idx}`); params.push(department); idx++; }
    if (designation !== undefined) { updates.push(`designation = $${idx}`); params.push(designation); idx++; }
    if (display_name !== undefined) { updates.push(`display_name = $${idx}`); params.push(display_name); idx++; }
    if (status) { updates.push(`status = $${idx}`); params.push(status); idx++; }
    if (is_active !== undefined) { updates.push(`is_active = $${idx}`); params.push(is_active); idx++; }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const result = await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}
       RETURNING id, username, display_name, role, department, designation, status, is_active, sip_extension`,
      [...params, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/toggle-active — Enable/disable user
router.put('/users/:id/toggle-active', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE users SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, display_name, is_active`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    console.log(`[Admin] User ${user.username} ${user.is_active ? 'enabled' : 'disabled'}`);
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/reset-password — Set a TEMPORARY password
// Body: { newPassword?: string } — the admin types the temp password themselves
// (easy to read out to the employee). Falls back to a random one when omitted.
// Either way the account is flagged must_change_password, so the user is
// forced to pick their own password at the next login.
router.put('/users/:id/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    const supplied = String(req.body?.newPassword || '').trim();
    if (supplied && supplied.length < 6) {
      return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
    }
    const tempPassword = supplied || crypto.randomBytes(4).toString('hex'); // 8-char hex fallback
    const hash = await bcrypt.hash(tempPassword, 12);
    const result = await query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW()
       WHERE id = $2 RETURNING id, username, display_name`,
      [hash, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    console.log(`[Admin] Password reset for user ${result.rows[0].username} (must change at next login)`);
    res.json({ user: result.rows[0], tempPassword, mustChangePassword: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/dashboard/analytics — Extended stats with trends
router.get('/dashboard/analytics', async (_req: AuthRequest, res: Response) => {
  try {
    const [
      msgTodayRes, msgYesterdayRes, msg7dRes,
      topUsersRes, deptRes, recentUsersRes,
      recentCallsRes, storageRes,
    ] = await Promise.all([
      // Messages today
      query(`SELECT COUNT(*) as count FROM messages WHERE created_at >= CURRENT_DATE AND deleted_at IS NULL`),
      // Messages yesterday
      query(`SELECT COUNT(*) as count FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND deleted_at IS NULL`),
      // Messages by day (last 7 days)
      query(`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '7 days' AND deleted_at IS NULL
        GROUP BY DATE(created_at) ORDER BY day
      `),
      // Top 5 active users this week
      query(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.department, COUNT(m.id) as message_count
        FROM users u LEFT JOIN messages m ON m.sender_id = u.id AND m.created_at >= CURRENT_DATE - INTERVAL '7 days' AND m.deleted_at IS NULL
        GROUP BY u.id ORDER BY message_count DESC LIMIT 5
      `),
      // Department distribution
      query(`
        SELECT COALESCE(department, 'Unassigned') as department, COUNT(*) as count
        FROM users GROUP BY department ORDER BY count DESC
      `),
      // Recent users (last 30 days)
      query(`SELECT id, username, display_name, created_at FROM users WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' ORDER BY created_at DESC LIMIT 10`),
      // Recent calls
      query(`SELECT id, call_type, is_group_call, status, started_at, duration_seconds FROM call_history ORDER BY started_at DESC LIMIT 10`),
      // Storage
      query(`SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files`),
    ]);

    res.json({
      messagesToday: parseInt(msgTodayRes.rows[0].count),
      messagesYesterday: parseInt(msgYesterdayRes.rows[0].count),
      messagesLast7Days: msg7dRes.rows.map((r: any) => ({ day: r.day, count: parseInt(r.count) })),
      topUsers: topUsersRes.rows.map((r: any) => ({ ...r, message_count: parseInt(r.message_count) })),
      departments: deptRes.rows.map((r: any) => ({ department: r.department, count: parseInt(r.count) })),
      recentUsers: recentUsersRes.rows,
      recentCalls: recentCallsRes.rows,
      storage: { count: parseInt(storageRes.rows[0].count), totalBytes: parseInt(storageRes.rows[0].total_size) },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// EMPLOYEE ONBOARDING (atomic)
// ============================================

const VALID_ROLES = new Set(['admin', 'manager', 'employee']);
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// GET /api/admin/users/check-availability?username=...&email=...
// Real-time uniqueness check used by the Onboard wizard.
router.get('/users/check-availability', async (req: AuthRequest, res: Response) => {
  try {
    const username = String(req.query.username || '').trim().toLowerCase();
    const email = String(req.query.email || '').trim().toLowerCase();

    const out: any = {
      username: { available: true, reason: null as string | null },
      email: { available: true, reason: null as string | null },
    };

    if (username) {
      if (!USERNAME_PATTERN.test(username)) {
        out.username = { available: false, reason: 'invalid' };
      } else {
        const r = await query('SELECT 1 FROM users WHERE username = $1 LIMIT 1', [username]);
        if (r.rows.length > 0) out.username = { available: false, reason: 'taken' };
      }
    } else {
      out.username = { available: false, reason: 'empty' };
    }

    if (email) {
      if (!EMAIL_PATTERN.test(email)) {
        out.email = { available: false, reason: 'invalid' };
      } else {
        const r = await query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
        if (r.rows.length > 0) out.email = { available: false, reason: 'taken' };
      }
    } else {
      out.email = { available: false, reason: 'empty' };
    }

    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/onboard — Atomic employee creation (user + optional mail)
// Body shape:
// {
//   display_name, username, email, department, designation?, role,
//   loginPassword: string,                              (admin-set)
//   mail: { mode: 'create' | 'assign' | 'skip', existingPassword?, customEmail? }
// }
router.post('/users/onboard', async (req: AuthRequest, res: Response) => {
  // ---- Validate input ----
  const body = req.body || {};
  const display_name = String(body.display_name || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const department = body.department ? String(body.department).trim() : null;
  const designation = body.designation ? String(body.designation).trim() : null;
  const role = String(body.role || 'employee').trim();
  const loginPassword = String(body.loginPassword || '');
  // Optional corporate employee ID (validated against the SAP master below)
  const employeeId = body.employee_id ? String(body.employee_id).trim() : null;
  const mail = body.mail || { mode: 'skip' };
  const mailMode = mail.mode === 'create' || mail.mode === 'assign' ? mail.mode : 'skip';
  const mailExistingPassword = mail.existingPassword ? String(mail.existingPassword) : '';
  const mailCustomEmail = mail.customEmail ? String(mail.customEmail).trim().toLowerCase() : '';

  if (!display_name) return res.status(400).json({ error: 'display_name is required' });
  if (!username || !USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'username is required (3-50 chars, lowercase letters/digits/.-_)' });
  }
  if (!email || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'role must be admin / manager / employee' });
  }
  if (loginPassword.length < 8) {
    return res.status(400).json({ error: 'Login password must be at least 8 characters' });
  }
  if (mailMode === 'assign' && !mailExistingPassword) {
    return res.status(400).json({ error: 'Existing mail password required for assign mode' });
  }

  // ---- Pre-flight uniqueness check ----
  try {
    const dup = await query('SELECT 1 FROM users WHERE username = $1 OR email = $2 LIMIT 1', [username, email]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already in use' });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'DB error: ' + err.message });
  }

  // ---- Employee ID validation (optional field) ----
  if (employeeId) {
    try {
      const emp = await lookupEmployee(employeeId);
      if (!emp) {
        return res.status(404).json({ error: 'No active employee with that ID in the corporate directory' });
      }
      const dup = await query('SELECT username FROM users WHERE employee_id = $1 LIMIT 1', [employeeId]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: `Employee ID already mapped to user "${dup.rows[0].username}"` });
      }
    } catch (err: any) {
      return res.status(502).json({ error: 'Employee directory unavailable: ' + err.message });
    }
  }

  // ---- Begin transaction ----
  const client = await pool.connect();
  let createdUserId: string | null = null;
  let createdStalwartLogin: string | null = null;

  try {
    await client.query('BEGIN');

    // Hash login password
    const loginHash = await bcrypt.hash(loginPassword, 12);

    // Insert user. mail_status defaults to 'none' from schema.
    // must_change_password = TRUE: the admin chose this initial password, so the
    // employee is forced to set their own at first login (enterprise policy).
    const insertUser = await client.query(
      `INSERT INTO users (
         username, email, password_hash, display_name, department, designation, role, employee_id,
         must_change_password
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       RETURNING id, username, email, display_name, department, designation, role, employee_id, created_at`,
      [username, email, loginHash, display_name, department, designation, role, employeeId],
    );
    const newUser = insertUser.rows[0];
    createdUserId = newUser.id;

    // ---- Mail account provisioning (optional) ----
    let mailEmailFinal: string | null = null;
    let mailGeneratedPassword: string | null = null;

    if (mailMode !== 'skip') {
      const mailLogin = (mailCustomEmail || email).split('@')[0]; // login = local part
      const mailEmail = mailCustomEmail || email;
      mailEmailFinal = mailEmail;

      let mailPassword = '';
      if (mailMode === 'create') {
        // Refuse if Stalwart principal already exists
        const existing = await stalwart.getPrincipal(mailLogin);
        if (existing) {
          throw new HttpError(409, `Stalwart principal "${mailLogin}" already exists. Use "Assign existing" instead.`);
        }
        mailPassword = generateMailPassword(12);
        await stalwart.createPrincipal({
          name: mailLogin,
          password: mailPassword,
          email: mailEmail,
          description: display_name,
        });
        createdStalwartLogin = mailLogin;
        mailGeneratedPassword = mailPassword;
      } else {
        // mode === 'assign'
        mailPassword = mailExistingPassword;
        const test = await stalwart.testCredentials(mailLogin, mailPassword);
        if (!test.ok) {
          throw new HttpError(400, 'Provided mail credentials failed IMAP login: ' + (test.error || 'unknown'));
        }
      }

      const encrypted = encryptSecret(mailPassword);
      await client.query(
        `UPDATE users
            SET mail_password_encrypted = $1,
                mail_password = NULL,
                mail_status = 'active',
                mail_assigned_at = NOW(),
                mail_assigned_by = $2,
                mail_last_test_at = NOW(),
                mail_last_test_ok = TRUE,
                updated_at = NOW()
          WHERE id = $3`,
        [encrypted, req.user!.userId, newUser.id],
      );
    }

    // ---- Audit log ----
    await client.query(
      `INSERT INTO admin_audit_logs (admin_user_id, target_user_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user!.userId,
        newUser.id,
        'user.onboarded',
        {
          username,
          email,
          role,
          department,
          mailMode,
          mailEmail: mailEmailFinal,
        },
        Array.isArray(req.ip) ? req.ip[0] : req.ip || null,
      ],
    );

    await client.query('COMMIT');

    console.log(`[Admin] Onboarded ${username} (mailMode=${mailMode})`);

    return res.json({
      ok: true,
      user: newUser,
      credentials: {
        loginPassword,                         // echo back so admin can show in UI
        mailEmail: mailEmailFinal,
        mailPassword: mailGeneratedPassword,   // null if assign or skip
      },
    });
  } catch (err: any) {
    // Rollback DB
    try { await client.query('ROLLBACK'); } catch { /* noop */ }

    // Best-effort cleanup: if we created a Stalwart principal and DB rolled back,
    // delete the orphan Stalwart principal so retries don't hit a 409.
    if (createdStalwartLogin) {
      try {
        await stalwart.deletePrincipal(createdStalwartLogin);
        console.warn(`[Admin] Cleaned up orphan Stalwart principal: ${createdStalwartLogin}`);
      } catch (cleanupErr: any) {
        console.error(`[Admin] Failed to clean up orphan Stalwart principal "${createdStalwartLogin}":`, cleanupErr.message);
      }
    }

    const status = err instanceof HttpError ? err.status : 500;
    const message = err.message || 'Onboarding failed';
    console.error('[Admin] Onboard error:', message);
    return res.status(status).json({ error: message });
  } finally {
    client.release();
  }
});

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ============================================
// MAIL ACCOUNT MANAGEMENT (Stalwart)
// ============================================

const MAIL_DOMAIN = process.env.STALWART_DOMAIN || 'balasorealloys.in';

async function writeAuditLog(
  adminUserId: string,
  targetUserId: string | string[] | null | undefined,
  action: string,
  details: Record<string, any> = {},
  ip?: string | string[] | undefined,
) {
  try {
    const ipString = Array.isArray(ip) ? ip[0] : ip;
    const targetIdString = Array.isArray(targetUserId) ? targetUserId[0] : targetUserId;
    await query(
      `INSERT INTO admin_audit_logs (admin_user_id, target_user_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminUserId, targetIdString || null, action, details, ipString || null],
    );
  } catch (err: any) {
    console.error('[Admin] Failed to write audit log:', err.message);
  }
}

/**
 * Stalwart principal/login name = local part of the user's email address.
 * This MUST match what email.routes.ts (/inbox) uses to log into IMAP, which is
 * `(user.email).split('@')[0]`. Using `user.username` here was a bug — username
 * is for BAL Connect login, not mail.
 */
function defaultMailLogin(user: { email?: string | null; username?: string }): string {
  const email = user.email || '';
  if (email.includes('@')) return email.split('@')[0];
  // Fallback if email missing (older accounts) — use username + domain.
  return user.username || '';
}

/**
 * Mail address = the user's email field directly. If somehow blank, construct
 * from username and STALWART_DOMAIN.
 */
function defaultMailEmail(user: { email?: string | null; username?: string }, customDomain?: string): string {
  if (user.email && user.email.includes('@')) return user.email;
  return `${user.username}@${customDomain || MAIL_DOMAIN}`;
}

// GET /api/admin/users/:id/mail-account — Show current mail account state
router.get('/users/:id/mail-account', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, username, email, display_name, mail_status,
              mail_assigned_at, mail_assigned_by, mail_last_test_at, mail_last_test_ok,
              (mail_password_encrypted IS NOT NULL OR mail_password IS NOT NULL) as has_credential
         FROM users WHERE id = $1`,
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    let assignedByName: string | null = null;
    if (user.mail_assigned_by) {
      const r = await query('SELECT display_name FROM users WHERE id = $1', [user.mail_assigned_by]);
      assignedByName = r.rows[0]?.display_name || null;
    }

    res.json({
      userId: user.id,
      username: user.username,
      mailEmail: defaultMailEmail(user),
      status: user.mail_status,
      hasCredential: user.has_credential,
      assignedAt: user.mail_assigned_at,
      assignedBy: user.mail_assigned_by,
      assignedByName,
      lastTestAt: user.mail_last_test_at,
      lastTestOk: user.mail_last_test_ok,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/mail-account — Create or assign mail account
// Body: { mode: 'auto' | 'manual', password?: string, customEmail?: string }
//   - 'auto':   generate password, create principal in Stalwart, save encrypted creds
//   - 'manual': admin provides existing Stalwart password; we test it before saving
router.post('/users/:id/mail-account', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.id;
    const { mode, password: providedPassword, customEmail } = req.body || {};

    if (mode !== 'auto' && mode !== 'manual') {
      return res.status(400).json({ error: 'mode must be "auto" or "manual"' });
    }
    if (mode === 'manual' && !providedPassword) {
      return res.status(400).json({ error: 'password is required for manual mode' });
    }

    const userResult = await query(
      'SELECT id, username, display_name, email FROM users WHERE id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    const loginName = defaultMailLogin(user);
    const mailEmail = customEmail || defaultMailEmail(user);
    const password = mode === 'auto' ? generateMailPassword(12) : String(providedPassword);

    // For auto mode: ensure the principal does not already exist (avoid silent overwrites)
    if (mode === 'auto') {
      const existing = await stalwart.getPrincipal(loginName);
      if (existing) {
        return res.status(409).json({
          error: `Stalwart principal "${loginName}" already exists. Use manual mode to assign existing or delete it first.`,
        });
      }
      try {
        await stalwart.createPrincipal({
          name: loginName,
          password,
          email: mailEmail,
          description: user.display_name || user.username,
        });
      } catch (err: any) {
        return res.status(502).json({ error: 'Stalwart create failed: ' + err.message });
      }
    } else {
      // manual: test credentials before saving
      const test = await stalwart.testCredentials(loginName, password);
      if (!test.ok) {
        return res.status(400).json({ error: 'Provided credentials failed IMAP login: ' + test.error });
      }
    }

    // Encrypt and persist
    const encrypted = encryptSecret(password);
    await query(
      `UPDATE users
         SET mail_password_encrypted = $1,
             mail_password = NULL,
             mail_status = 'active',
             mail_assigned_at = NOW(),
             mail_assigned_by = $2,
             mail_last_test_at = NOW(),
             mail_last_test_ok = TRUE,
             updated_at = NOW()
       WHERE id = $3`,
      [encrypted, req.user!.userId, userId],
    );

    await writeAuditLog(
      req.user!.userId,
      userId,
      mode === 'auto' ? 'mail_account.created' : 'mail_account.assigned',
      { mailEmail, loginName, mode },
      req.ip,
    );

    console.log(`[Admin] Mail account ${mode === 'auto' ? 'created' : 'assigned'} for ${user.username} (${mailEmail})`);

    // Return generated password ONCE so admin can hand it to the user.
    res.json({
      ok: true,
      mode,
      mailEmail,
      loginName,
      password: mode === 'auto' ? password : undefined,
    });
  } catch (err: any) {
    console.error('[Admin] mail-account create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/mail-account/reset-password — Generate new password and push to Stalwart
router.put('/users/:id/mail-account/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.id;
    const userResult = await query(
      `SELECT id, username, email, display_name, mail_status FROM users WHERE id = $1`,
      [userId],
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    if (user.mail_status === 'none') {
      return res.status(400).json({ error: 'User has no mail account. Create one first.' });
    }

    const loginName = defaultMailLogin(user);
    const newPassword = generateMailPassword(12);

    try {
      await stalwart.setPrincipalPassword(loginName, newPassword);
    } catch (err: any) {
      return res.status(502).json({ error: 'Stalwart password update failed: ' + err.message });
    }

    const encrypted = encryptSecret(newPassword);
    await query(
      `UPDATE users
         SET mail_password_encrypted = $1,
             mail_password = NULL,
             mail_status = 'active',
             mail_last_test_at = NOW(),
             mail_last_test_ok = TRUE,
             updated_at = NOW()
       WHERE id = $2`,
      [encrypted, userId],
    );

    await writeAuditLog(
      req.user!.userId,
      userId,
      'mail_account.password_reset',
      { loginName },
      req.ip,
    );

    console.log(`[Admin] Mail password reset for ${user.username}`);
    res.json({ ok: true, loginName, password: newPassword });
  } catch (err: any) {
    console.error('[Admin] mail-account reset error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/mail-account/toggle — Enable/Disable mail access
// Body: { enable: boolean }
router.put('/users/:id/mail-account/toggle', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.id;
    const enable = req.body?.enable === true;

    const userResult = await query(
      'SELECT id, username, email, mail_status FROM users WHERE id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    if (user.mail_status === 'none') {
      return res.status(400).json({ error: 'User has no mail account. Create one first.' });
    }

    const loginName = defaultMailLogin(user);

    try {
      await stalwart.setPrincipalEnabled(loginName, enable);
    } catch (err: any) {
      return res.status(502).json({ error: 'Stalwart toggle failed: ' + err.message });
    }

    await query(
      `UPDATE users SET mail_status = $1, updated_at = NOW() WHERE id = $2`,
      [enable ? 'active' : 'disabled', userId],
    );

    await writeAuditLog(
      req.user!.userId,
      userId,
      enable ? 'mail_account.enabled' : 'mail_account.disabled',
      { loginName },
      req.ip,
    );

    console.log(`[Admin] Mail ${enable ? 'enabled' : 'disabled'} for ${user.username}`);
    res.json({ ok: true, status: enable ? 'active' : 'disabled' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/mail-account/test — Live test credentials
router.post('/users/:id/mail-account/test', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.id;

    const userResult = await query(
      `SELECT id, username, email, mail_status, mail_password_encrypted, mail_password
         FROM users WHERE id = $1`,
      [userId],
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    if (user.mail_status === 'none') {
      return res.status(400).json({ error: 'User has no mail account.' });
    }

    // Decrypt or fall back to plaintext for backward compat
    let password = '';
    try {
      if (user.mail_password_encrypted) {
        const { decryptSecret } = await import('../../utils/crypto');
        password = decryptSecret(user.mail_password_encrypted);
      } else if (user.mail_password) {
        password = user.mail_password;
      }
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to decrypt stored password: ' + err.message });
    }

    if (!password) return res.status(400).json({ error: 'No credential stored' });

    // Test using the SAME loginName that IMAP /inbox uses (email local part)
    const loginName = defaultMailLogin(user);
    const test = await stalwart.testCredentials(loginName, password);

    await query(
      `UPDATE users
         SET mail_last_test_at = NOW(),
             mail_last_test_ok = $1,
             mail_status = CASE
               WHEN $1::boolean THEN (CASE WHEN mail_status = 'error' THEN 'active' ELSE mail_status END)
               ELSE 'error'
             END,
             updated_at = NOW()
       WHERE id = $2`,
      [test.ok, userId],
    );

    await writeAuditLog(
      req.user!.userId,
      userId,
      'mail_account.tested',
      { ok: test.ok, error: test.error },
      req.ip,
    );

    res.json({ ok: test.ok, error: test.error });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// COMPLIANCE MONITORING
// ============================================

// GET /api/admin/conversations — View all conversations
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    // Compliance view — default raised to 500 so auditors don't silently miss older
    // conversations. Pagination via ?limit= / ?offset= still works for callers.
    const { search, type, limit = '500', offset = '0' } = req.query;

    let sql = `
      SELECT c.id, c.type, c.name, c.created_at, c.last_message_at,
             (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as member_count,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL) as message_count,
             json_build_object('id', u.id, 'displayName', u.display_name) as created_by_user,
             (SELECT string_agg(COALESCE(u2.display_name, u2.username), ' \u2194 ' ORDER BY COALESCE(u2.display_name, u2.username))
              FROM conversation_members cm2
              JOIN users u2 ON cm2.user_id = u2.id
              WHERE cm2.conversation_id = c.id
             ) as member_names
      FROM conversations c
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.is_archived = false
    `;
    const params: any[] = [];
    let idx = 1;

    if (type) {
      sql += ` AND c.type = $${idx}`;
      params.push(type);
      idx++;
    }
    if (search) {
      sql += ` AND (c.name ILIKE $${idx} OR EXISTS (
        SELECT 1 FROM conversation_members cm3
        JOIN users u3 ON cm3.user_id = u3.id
        WHERE cm3.conversation_id = c.id
        AND (u3.display_name ILIKE $${idx} OR u3.username ILIKE $${idx})
      ))`;
      params.push(`%${search}%`);
      idx++;
    }

    sql += ` ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query(sql, params);
    res.json({ conversations: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/conversations/:id/messages — View all messages (compliance)
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '100', before } = req.query;

    let sql = `
      SELECT m.id, m.sender_id, m.type, m.content, m.metadata, m.is_edited,
             m.deleted_at, m.created_at,
             json_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name) as sender
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
    `;
    const params: any[] = [req.params.id];
    let idx = 2;

    if (before) {
      sql += ` AND m.created_at < $${idx}`;
      params.push(before);
      idx++;
    }

    // Admin sees ALL messages including deleted
    sql += ` ORDER BY m.created_at DESC LIMIT $${idx}`;
    params.push(parseInt(limit as string));

    const result = await query(sql, params);
    res.json({ messages: result.rows.reverse() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/conversations/:id/export — Export ALL messages for compliance download
router.get('/conversations/:id/export', async (req: AuthRequest, res: Response) => {
  try {
    const sql = `
      SELECT m.id, m.sender_id, m.type, m.content, m.metadata, m.is_edited,
             m.deleted_at, m.created_at,
             json_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name) as sender
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
    `;
    const result = await query(sql, [req.params.id]);

    // Also get conversation details + members
    const convSql = `
      SELECT c.id, c.type, c.name, c.created_at,
             (SELECT string_agg(COALESCE(u2.display_name, u2.username), ', ' ORDER BY COALESCE(u2.display_name, u2.username))
              FROM conversation_members cm2
              JOIN users u2 ON cm2.user_id = u2.id
              WHERE cm2.conversation_id = c.id
             ) as member_names,
             (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as member_count
      FROM conversations c
      WHERE c.id = $1
    `;
    const convResult = await query(convSql, [req.params.id]);
    const conv = convResult.rows[0] || {};

    res.json({
      conversation: conv,
      messages: result.rows,
      exportedAt: new Date().toISOString(),
      exportedBy: req.user?.username || 'admin',
      totalMessages: result.rows.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/messages/search — Global message search (compliance)
router.get('/messages/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q, userId, limit = '50' } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    let sql = `
      SELECT m.id, m.conversation_id, m.content, m.type, m.created_at,
             json_build_object('id', u.id, 'displayName', u.display_name) as sender,
             c.name as conversation_name, c.type as conversation_type
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      LEFT JOIN conversations c ON m.conversation_id = c.id
      WHERE m.search_vector @@ plainto_tsquery('english', $1)
    `;
    const params: any[] = [q];
    let idx = 2;

    if (userId) {
      sql += ` AND m.sender_id = $${idx}`;
      params.push(userId);
      idx++;
    }

    sql += ` ORDER BY m.created_at DESC LIMIT $${idx}`;
    params.push(parseInt(limit as string));

    const result = await query(sql, params);
    res.json({ messages: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// FEEDBACK (submitted from the login page)
// ============================================

// GET /api/admin/feedback — newest first
router.get('/feedback', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, mood, category, message, name, created_at
         FROM feedback ORDER BY created_at DESC LIMIT 500`,
    );
    res.json({ feedback: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/feedback/:id — remove a handled feedback card
router.delete('/feedback/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('DELETE FROM feedback WHERE id = $1 RETURNING id', [String(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// USERS LOGIN — sign-in audit (Admin Panel → Users Login)
// ============================================

// Allowed date-range presets → SQL lower-bound expression (server timezone).
// "today"/"yesterday" are calendar-day windows; the rest are rolling windows.
const LOGIN_RANGES: Record<string, { lower: string; upper?: string; label: string }> = {
  today:     { lower: "date_trunc('day', NOW())",                              label: 'Today' },
  yesterday: { lower: "date_trunc('day', NOW()) - INTERVAL '1 day'",
               upper: "date_trunc('day', NOW())",                             label: 'Yesterday' },
  last7:     { lower: "NOW() - INTERVAL '7 days'",                            label: 'Last 7 days' },
  last14:    { lower: "NOW() - INTERVAL '14 days'",                           label: 'Last 2 weeks' },
  last30:    { lower: "NOW() - INTERVAL '30 days'",                           label: 'Last month' },
};

// GET /api/admin/login-activity?range=&q=&page=&limit=
// Returns paginated sign-in events for the chosen window + a summary
// (unique users / total logins). Modeled on Azure AD sign-in logs.
router.get('/login-activity', async (req: AuthRequest, res: Response) => {
  try {
    const rangeKey = String(req.query.range || 'today');
    const range = LOGIN_RANGES[rangeKey] || LOGIN_RANGES.today;
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = (page - 1) * limit;

    // Build the WHERE clause: time window + optional name/employee-id search.
    const where: string[] = [`le.logged_in_at >= ${range.lower}`];
    if (range.upper) where.push(`le.logged_in_at < ${range.upper}`);
    const params: any[] = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(u.display_name ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.employee_id ILIKE $${params.length})`);
    }
    const whereSql = 'WHERE ' + where.join(' AND ');

    // Summary over the whole window (not just the current page).
    const summary = await query(
      `SELECT COUNT(*)::int AS total_logins,
              COUNT(DISTINCT le.user_id)::int AS unique_users
         FROM login_events le
         JOIN users u ON u.id = le.user_id
         ${whereSql}`,
      params,
    );

    // Page of events, newest first.
    const pageParams = [...params, limit, offset];
    const events = await query(
      `SELECT le.id, le.logged_in_at, le.ip_address, le.user_agent,
              u.id AS user_id, u.display_name, u.username, u.employee_id,
              u.department, u.avatar_url
         FROM login_events le
         JOIN users u ON u.id = le.user_id
         ${whereSql}
         ORDER BY le.logged_in_at DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );

    res.json({
      range: rangeKey,
      rangeLabel: range.label,
      summary: summary.rows[0],
      page,
      limit,
      events: events.rows.map((r: any) => ({
        ...r,
        device: parseUserAgent(r.user_agent),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Minimal, dependency-free UA → "Browser on OS" summary for the login table. */
function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /Windows NT 10/.test(ua) ? 'Windows' :
    /Windows/.test(ua) ? 'Windows' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

// ============================================
// EMPLOYEE DIRECTORY (corporate SAP master — read-only)
// ============================================

// GET /api/admin/employees/lookup/:empId — exact lookup for onboarding auto-fill
router.get('/employees/lookup/:empId', async (req: AuthRequest, res: Response) => {
  try {
    const emp = await lookupEmployee(String(req.params.empId));
    if (!emp) return res.status(404).json({ error: 'No active employee with that ID' });

    // Also report whether this employee ID is already mapped to an ICP account
    const mapped = await query(
      'SELECT id, username, display_name FROM users WHERE employee_id = $1 LIMIT 1',
      [emp.empId],
    );
    res.json({ employee: emp, mappedTo: mapped.rows[0] || null });
  } catch (err: any) {
    res.status(502).json({ error: 'Employee directory unavailable: ' + err.message });
  }
});

// GET /api/admin/employees/search?q= — search the directory (mapping UI)
router.get('/employees/search', async (req: AuthRequest, res: Response) => {
  try {
    const employees = await searchEmployees(String(req.query.q || ''));
    // Annotate each result with its existing ICP mapping (if any)
    const ids = employees.map((e) => e.empId);
    let mappings: Record<string, { userId: string; username: string; displayName: string }> = {};
    if (ids.length > 0) {
      const mapped = await query(
        'SELECT id, username, display_name, employee_id FROM users WHERE employee_id = ANY($1)',
        [ids],
      );
      for (const row of mapped.rows) {
        mappings[row.employee_id] = { userId: row.id, username: row.username, displayName: row.display_name };
      }
    }
    res.json({ employees: employees.map((e) => ({ ...e, mappedTo: mappings[e.empId] || null })) });
  } catch (err: any) {
    res.status(502).json({ error: 'Employee directory unavailable: ' + err.message });
  }
});

// GET /api/admin/employees/health — directory connectivity probe
router.get('/employees/health', async (_req: AuthRequest, res: Response) => {
  res.json(await directoryHealth());
});

// PUT /api/admin/users/:id/employee-id — map (or clear) an employee ID on an account
// Body: { employeeId: string | null }
router.put('/users/:id/employee-id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.id);
    const raw = req.body?.employeeId;
    const employeeId = raw === null || raw === undefined || String(raw).trim() === ''
      ? null
      : String(raw).trim();

    if (employeeId) {
      // 1. Must exist and be Active in the corporate master
      const emp = await lookupEmployee(employeeId);
      if (!emp) return res.status(404).json({ error: 'No active employee with that ID in the corporate directory' });

      // 2. Must not already be mapped to a different account
      const dup = await query(
        'SELECT id, username FROM users WHERE employee_id = $1 AND id != $2 LIMIT 1',
        [employeeId, userId],
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: `Employee ID already mapped to user "${dup.rows[0].username}"` });
      }
    }

    const result = await query(
      'UPDATE users SET employee_id = $1 WHERE id = $2 RETURNING id, username, display_name, employee_id',
      [employeeId, userId],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await query(
      `INSERT INTO admin_audit_logs (admin_user_id, target_user_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user!.userId,
        userId,
        employeeId ? 'employee_id.assigned' : 'employee_id.cleared',
        { employeeId },
        req.ip || null,
      ],
    );
    res.json({ user: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// UCM EXTENSION MANAGEMENT
// ============================================

// GET /api/admin/ucm/extensions — List all UCM extensions with live status
router.get('/ucm/extensions', async (_req: AuthRequest, res: Response) => {
  try {
    const extensions = await ucmService.listExtensions();

    // Also get current assignments from DB
    const assigned = await query(
      'SELECT sip_extension, id, username, display_name FROM users WHERE sip_extension IS NOT NULL'
    );
    const assignmentMap: Record<string, { userId: string; username: string; displayName: string }> = {};
    for (const row of assigned.rows) {
      assignmentMap[row.sip_extension] = {
        userId: row.id,
        username: row.username,
        displayName: row.display_name,
      };
    }

    const result = extensions.map((ext) => ({
      ...ext,
      assignedTo: assignmentMap[ext.extension] || null,
    }));

    res.json({ extensions: result, total: result.length });
  } catch (err: any) {
    console.error('[Admin] UCM list extensions error:', err);
    res.status(500).json({ error: 'Failed to fetch UCM extensions: ' + err.message });
  }
});

// GET /api/admin/ucm/extensions/available — Extensions not assigned to any user
router.get('/ucm/extensions/available', async (_req: AuthRequest, res: Response) => {
  try {
    const extensions = await ucmService.listExtensions();
    const assigned = await query(
      'SELECT sip_extension FROM users WHERE sip_extension IS NOT NULL'
    );
    const assignedSet = new Set(assigned.rows.map((r: any) => r.sip_extension));

    const available = extensions.filter((ext) => !assignedSet.has(ext.extension));
    res.json({ extensions: available, total: available.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch available extensions: ' + err.message });
  }
});

// GET /api/admin/ucm/health — UCM API health with full auth test
router.get('/ucm/health', async (_req: AuthRequest, res: Response) => {
  try {
    const health = await ucmService.healthCheck();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/extension — Assign UCM extension to a BAL Connect user
router.put('/users/:id/extension', async (req: AuthRequest, res: Response) => {
  try {
    const { extension } = req.body;
    const userId = req.params.id;

    if (!extension) {
      return res.status(400).json({ error: 'Extension number required' });
    }

    // 1. Verify extension exists on UCM and get its SIP password
    const detail = await ucmService.getExtensionDetail(extension);
    if (!detail) {
      return res.status(404).json({ error: `Extension ${extension} not found on UCM6304` });
    }

    if (!detail.enableWebrtc) {
      return res.status(400).json({ error: `Extension ${extension} does not have WebRTC enabled on UCM` });
    }

    // 2. Check if extension is already assigned to another user
    const existingAssignment = await query(
      'SELECT id, username FROM users WHERE sip_extension = $1 AND id != $2',
      [extension, userId]
    );
    if (existingAssignment.rows.length > 0) {
      return res.status(409).json({
        error: `Extension ${extension} is already assigned to user "${existingAssignment.rows[0].username}"`,
      });
    }

    // 3. Update user with real UCM extension and SIP password
    const result = await query(
      `UPDATE users SET sip_extension = $1, sip_password = $2
       WHERE id = $3
       RETURNING id, username, display_name, sip_extension, department, role`,
      [extension, detail.secret, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[Admin] Assigned extension ${extension} (${detail.fullname}) to user ${result.rows[0].username}`);

    res.json({
      user: result.rows[0],
      ucmDetail: {
        fullname: detail.fullname,
        webrtc: detail.enableWebrtc,
        mediaEncryption: detail.mediaEncryption,
      },
    });
  } catch (err: any) {
    console.error('[Admin] Extension assignment error:', err);
    res.status(500).json({ error: 'Failed to assign extension: ' + err.message });
  }
});

// DELETE /api/admin/users/:id/extension — Unassign extension from user
router.delete('/users/:id/extension', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE users SET sip_extension = NULL, sip_password = NULL
       WHERE id = $1
       RETURNING id, username, display_name`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[Admin] Unassigned extension from user ${result.rows[0].username}`);
    res.json({ user: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SYSTEM HEALTH
// ============================================

// GET /api/admin/health — Full system health check
router.get('/health', async (_req: AuthRequest, res: Response) => {
  const checks: Record<string, any> = {};

  // Database
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.database = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err: any) {
    checks.database = { status: 'error', error: err.message };
  }

  // Redis
  try {
    const onlineUsers = await getOnlineUsers();
    checks.redis = { status: 'ok', onlineUsers: onlineUsers.length };
  } catch (err: any) {
    checks.redis = { status: 'error', error: err.message };
  }

  // Stalwart mail server — TCP reachability to its SMTP listener
  try {
    checks.stalwart = await checkTcp(
      process.env.STALWART_SMTP_HOST || 'stalwart',
      parseInt(process.env.STALWART_SMTP_PORT || '587', 10),
    );
  } catch (err: any) {
    checks.stalwart = { status: 'error', error: err.message };
  }

  // LiveKit SFU — TCP reachability to its HTTP/WS port
  try {
    const lk = parseHostPort(process.env.LIVEKIT_HTTP_URL || 'http://livekit:7880', 7880);
    checks.livekit = await checkTcp(lk.host, lk.port);
  } catch (err: any) {
    checks.livekit = { status: 'error', error: err.message };
  }

  // Disk usage
  checks.uptime = process.uptime();
  checks.memory = process.memoryUsage();

  // Only check services that have a status property (skip uptime/memory which are raw values)
  const serviceChecks = ['database', 'redis', 'stalwart', 'livekit'];
  const allOk = serviceChecks.every(
    (key) => checks[key] && checks[key].status === 'ok'
  );

  res.json({
    status: allOk ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Lightweight TCP reachability probe — proves a service is up and accepting
// connections, without auth or load. Used for Stalwart + LiveKit health.
function checkTcp(host: string, port: number, timeoutMs = 4000): Promise<{ status: string; latencyMs?: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { resolve({ status: 'ok', latencyMs: Date.now() - start }); socket.destroy(); });
    socket.once('error', () => { resolve({ status: 'unreachable' }); socket.destroy(); });
    socket.once('timeout', () => { resolve({ status: 'timeout' }); socket.destroy(); });
  });
}

// Parse "http://host:port" → { host, port }, with a fallback port.
function parseHostPort(url: string, defaultPort: number): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : defaultPort };
  } catch {
    return { host: url, port: defaultPort };
  }
}

// Helper: check UCM6304 API reachability (retired — kept until full UCM removal)
function checkUCMHealth(): Promise<{ status: string; latencyMs?: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request(
      {
        hostname: config.ucm.host,
        port: config.ucm.apiPort,
        path: '/api',
        method: 'GET',
        timeout: 5000,
        rejectUnauthorized: false, // UCM uses self-signed cert
      },
      (res) => {
        resolve({ status: 'ok', latencyMs: Date.now() - start });
        res.resume(); // consume response
      }
    );
    req.on('error', () => {
      resolve({ status: 'unreachable' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });
    req.end();
  });
}

export default router;
