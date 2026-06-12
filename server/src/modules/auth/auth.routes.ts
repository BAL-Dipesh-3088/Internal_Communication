import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthService } from './auth.service';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { z } from 'zod';

const router = Router();
const authService = new AuthService();

// Brute-force protection on credential endpoints. Each office machine has its
// own LAN IP, so a per-IP limit doesn't punish other users. 20 attempts per
// 15 minutes is far above any honest user's typo rate, while making password
// guessing impractical. successful requests don't count against the limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

// Registration is rarely repeated by an honest user — keep it tight.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' },
});

// Help-desk endpoints are public (shown on the login page) — rate-limit so
// they can't be used to spam every admin's mailbox.
const helpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const registerSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  display_name: z.string().min(1).max(100).optional(),
  displayName: z.string().min(1).max(100).optional(),
  department: z.string().max(100).optional(),
  designation: z.string().max(100).optional(),
  title: z.string().max(100).optional(),
}).transform((data) => ({
  username: data.username,
  email: data.email,
  password: data.password,
  displayName: data.display_name || data.displayName || data.username,
  department: data.department || undefined,
  designation: data.designation || data.title || undefined,
}));

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  try {
    const input = registerSchema.parse(req.body);
    const result = await authService.register(input);
    res.status(201).json(result);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.json(result);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    res.status(401).json({ error: err.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }
    const result = await authService.refreshToken(refreshToken);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await authService.logout(req.user!.userId);
    res.json({ message: 'Logged out successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { query: dbQuery } = await import('../../database/connection');
    const result = await dbQuery(
      `SELECT id, username, email, display_name, role, sip_extension, sip_password,
              department, designation, avatar_url, status, status_message, last_seen, created_at,
              must_change_password
       FROM users WHERE id = $1`,
      [req.user!.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const u = result.rows[0];
    res.json({
      user: {
        id: u.id,
        username: u.username,
        email: u.email,
        display_name: u.display_name,
        role: u.role,
        sip_extension: u.sip_extension,
        sip_password: u.sip_password,
        department: u.department,
        designation: u.designation,
        avatar_url: u.avatar_url,
        status: u.status,
        status_message: u.status_message,
        last_seen: u.last_seen,
        created_at: u.created_at,
        must_change_password: u.must_change_password === true,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/change-password
// Body: { currentPassword, newPassword }
// Used by the forced first-login gate (and works for voluntary changes too).
// Verifying the CURRENT password proves possession even with a valid token —
// a stolen/left-open session can't silently take over the account here.
router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the temporary password' });
    }

    const { query: dbQuery } = await import('../../database/connection');
    const result = await dbQuery(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const bcrypt = (await import('bcryptjs')).default;
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await dbQuery(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
      [hash, req.user!.userId]
    );

    console.log(`[Auth] ${req.user!.username} set a new password (must_change cleared)`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LOGIN-PAGE HELP DESK (public — shown to users who can't sign in)
// ============================================================

/** Active admins who receive help-desk emails (and are listed in Contact Admin). */
async function getAdminContacts(): Promise<Array<{ name: string; email: string }>> {
  const { query: dbQuery } = await import('../../database/connection');
  const result = await dbQuery(
    `SELECT display_name, email FROM users
      WHERE role = 'admin' AND is_active = true AND email IS NOT NULL
      ORDER BY display_name`,
  );
  return result.rows.map((r: any) => ({ name: r.display_name, email: r.email }));
}

/** Shared purple-banner email shell for help-desk mails to admins. */
function helpEmailHtml(title: string, rows: Array<[string, string]>): string {
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e8e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#6264A7;color:#fff;padding:14px 22px;font-size:15px;font-weight:700">${esc(title)}</div>
    <div style="padding:20px 22px">
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#333">
        ${rows.map(([k, v]) => `
          <tr>
            <td style="padding:7px 12px 7px 0;color:#8B8CA7;white-space:nowrap;vertical-align:top">${esc(k)}</td>
            <td style="padding:7px 0;font-weight:600;white-space:pre-wrap">${esc(v)}</td>
          </tr>`).join('')}
      </table>
    </div>
    <div style="padding:12px 22px;border-top:1px solid #f0f0f5;font-size:11px;color:#A0A1BC">
      Sent by BAL Connect (ICP) — login-page help desk
    </div>
  </div>`;
}

// GET /api/auth/help/admins — admin names/emails + support phone (Contact Admin view)
router.get('/help/admins', helpLimiter, async (_req: Request, res: Response) => {
  try {
    const admins = await getAdminContacts();
    res.json({
      admins,
      supportPhone: process.env.SUPPORT_PHONE || '7029398688',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/help/forgot-password — Body: { identifier, phone }
// Emails every admin so they can reset the password and call the user back.
router.post('/help/forgot-password', helpLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = String(req.body?.identifier || '').trim().slice(0, 100);
    const phone = String(req.body?.phone || '').trim().slice(0, 20);
    if (!identifier) return res.status(400).json({ error: 'Username or employee ID is required' });
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'A valid phone number is required' });
    }

    // Enrich with the matched account when it exists (helps the admin act fast).
    // The response NEVER reveals whether the account exists.
    const { query: dbQuery } = await import('../../database/connection');
    const match = await dbQuery(
      `SELECT username, display_name, employee_id, department FROM users
        WHERE username = $1 OR employee_id = $1 LIMIT 1`,
      [identifier],
    );
    const m = match.rows[0];

    const admins = await getAdminContacts();
    if (admins.length > 0) {
      // System sender — there is no authenticated user behind this request,
      // so regular sendEmail (per-user Stalwart auth) cannot be used here.
      const { sendSystemEmail } = await import('../email/email.service');
      sendSystemEmail({
        to: admins.map((a) => a.email),
        subject: `🔑 Password reset request — ${m?.display_name || identifier}`,
        html: helpEmailHtml('Password reset request from the login page', [
          ['Entered ID', identifier],
          ['Phone number', phone],
          ['Matched account', m ? `${m.display_name} (@${m.username})` : 'No matching account found'],
          ...(m?.employee_id ? [['Employee ID', m.employee_id] as [string, string]] : []),
          ...(m?.department ? [['Department', m.department] as [string, string]] : []),
          ['What to do', 'Reset their password in Admin → Users → Reset Password, then call them with the temporary password. They will be forced to set their own at first login.'],
        ]),
      }).catch((err) => console.warn('[Help] forgot-password mail failed:', err?.message));
    }

    console.log(`[Help] Forgot-password request for "${identifier}" (phone ${phone})`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/help/feedback — Body: { mood, category, message, name? }
// Stored in the feedback table and reviewed in Admin Panel → Feedback
// (deliberately NOT emailed — management preference).
router.post('/help/feedback', helpLimiter, async (req: Request, res: Response) => {
  try {
    const mood = String(req.body?.mood || '').slice(0, 10);
    const category = String(req.body?.category || 'Other').slice(0, 40);
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!message) return res.status(400).json({ error: 'Please write something in the feedback' });

    const { query: dbQuery } = await import('../../database/connection');
    await dbQuery(
      `INSERT INTO feedback (mood, category, message, name) VALUES ($1, $2, $3, $4)`,
      [mood || null, category, message, name || null],
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
