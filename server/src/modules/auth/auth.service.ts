import bcrypt from 'bcryptjs';
import { query } from '../../database/connection';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken, AuthPayload } from '../../middleware/auth';
import { v4 as uuidv4 } from 'uuid';

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  displayName: string;
  department?: string;
  designation?: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export class AuthService {

  async register(input: RegisterInput) {
    // Check existing user
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [input.username, input.email]
    );
    if (existing.rows.length > 0) {
      throw new Error('Username or email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(input.password, 12);

    // Get next available SIP extension
    const sipExtension = await this.getNextSipExtension();
    const sipPassword = uuidv4().replace(/-/g, '').substring(0, 16);

    // Create user
    const result = await query(
      `INSERT INTO users (username, email, password_hash, display_name, department, designation, sip_extension, sip_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, username, email, display_name, role, sip_extension, department, designation, avatar_url, status, created_at`,
      [input.username, input.email, passwordHash, input.displayName, input.department || null, input.designation || null, sipExtension, sipPassword]
    );

    const user = result.rows[0];

    // Generate tokens
    const payload: AuthPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        sip_extension: user.sip_extension,
        sip_password: sipPassword,
        department: user.department,
        designation: user.designation,
        avatar_url: user.avatar_url,
        status: user.status,
        created_at: user.created_at,
      },
      tokens: {
        accessToken: generateAccessToken(payload),
        refreshToken: generateRefreshToken(payload),
      },
      sipPassword,
    };
  }

  async login(input: LoginInput) {
    // The identifier field accepts the USERNAME or the corporate EMPLOYEE ID
    // (users.employee_id, mapped from the SAP master). Employee IDs are short
    // numeric-ish codes that can never collide with usernames in practice, and
    // employee_id is UNIQUE, so at most one account matches either way.
    const result = await query(
      `SELECT id, username, email, password_hash, display_name, role, sip_extension, sip_password,
              department, designation, avatar_url, status, is_active, must_change_password
       FROM users WHERE username = $1 OR employee_id = $2 LIMIT 1`,
      [input.username, input.username.trim()]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid username or password');
    }

    const user = result.rows[0];

    if (!user.is_active) {
      throw new Error('Account is disabled. Contact administrator.');
    }

    const validPassword = await bcrypt.compare(input.password, user.password_hash);
    if (!validPassword) {
      throw new Error('Invalid username or password');
    }

    // Update last_seen and status
    await query(
      'UPDATE users SET last_seen = NOW(), status = $1 WHERE id = $2',
      ['online', user.id]
    );

    const payload: AuthPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        sip_extension: user.sip_extension,
        sip_password: user.sip_password,
        department: user.department,
        designation: user.designation,
        avatar_url: user.avatar_url,
        status: 'online',
        last_seen: new Date().toISOString(),
        created_at: user.created_at || new Date().toISOString(),
        // TRUE when the password is a temporary one (onboarding / admin reset)
        // — the client blocks the app behind the set-new-password gate.
        must_change_password: user.must_change_password === true,
      },
      tokens: {
        accessToken: generateAccessToken(payload),
        refreshToken: generateRefreshToken(payload),
      },
      sipPassword: user.sip_password,
    };
  }

  async refreshToken(token: string) {
    const decoded = verifyRefreshToken(token);

    // Verify user still exists and is active
    const result = await query(
      'SELECT id, username, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw new Error('User not found or disabled');
    }

    const user = result.rows[0];
    const payload: AuthPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };

    return {
      accessToken: generateAccessToken(payload),
      refreshToken: generateRefreshToken(payload),
    };
  }

  async logout(userId: string) {
    await query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
      ['offline', userId]
    );
  }

  private async getNextSipExtension(): Promise<string> {
    const result = await query(
      `SELECT sip_extension FROM users
       WHERE sip_extension IS NOT NULL
       ORDER BY sip_extension::int DESC LIMIT 1`
    );

    if (result.rows.length === 0) {
      return '1001';
    }

    const lastExt = parseInt(result.rows[0].sip_extension, 10);
    return (lastExt + 1).toString();
  }
}
