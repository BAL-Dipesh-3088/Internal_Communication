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
              department, designation, avatar_url, status, status_message, last_seen, created_at
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
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
