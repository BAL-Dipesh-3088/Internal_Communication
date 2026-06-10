import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'connecthub',
    user: process.env.DB_USER || 'connecthub',
    password: process.env.DB_PASSWORD || 'connecthub_dev_2026',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  ucm: {
    host: process.env.UCM_HOST || '192.168.7.2',
    apiPort: parseInt(process.env.UCM_API_PORT || '8089', 10),
    apiUrl: process.env.UCM_API_URL || 'https://192.168.7.2:8089/api',
    wssUrl: process.env.UCM_WSS_URL || 'wss://192.168.7.2:8445/ws',
    adminUser: process.env.UCM_ADMIN_USER || 'admin',
    adminPassword: process.env.UCM_ADMIN_PASSWORD || 'admin',
  },

  sip: {
    extensionStart: parseInt(process.env.SIP_EXTENSION_START || '1001', 10),
    extensionEnd: parseInt(process.env.SIP_EXTENSION_END || '1500', 10),
  },

  upload: {
    dir: process.env.UPLOAD_DIR || '../data/files',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '104857600', 10),
    avatarDir: process.env.AVATAR_DIR || '../data/avatars',
  },

  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // Canonical, public-facing URL of the app (the address real users type in the
  // browser, e.g. https://icp.balasorealloys.in). This is the SINGLE source of
  // truth for every absolute link we put into outbound email — meeting invites,
  // password resets, etc. It is intentionally SEPARATE from `clientUrl` (which
  // is the CORS origin) because email recipients are on other machines and must
  // never receive a dev/localhost link. Falls back to CLIENT_URL only when it is
  // not a local address; otherwise emails would carry an unreachable link.
  publicAppUrl: process.env.PUBLIC_APP_URL || '',
};
