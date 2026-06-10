import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'http';
import { createServer as createHttpsServer } from 'https';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config';
import { testConnection, query } from './database/connection';
import { runMigrations } from './database/migrate';
import { initRedis, clearAllPresence } from './services/redis.service';
import { initSocketIO } from './services/socket.service';

// Routes
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/users.routes';
import chatRoutes from './modules/chat/chat.routes';
import fileRoutes from './modules/files/files.routes';
import callRoutes from './modules/calls/calls.routes';
import adminRoutes from './modules/admin/admin.routes';
import emailRoutes from './modules/email/email.routes';
import calendarRoutes from './modules/calendar/calendar.routes';

async function bootstrap() {
  console.log('\n=== ConnectHub Server ===\n');

  // 1. Test database connection
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('Cannot start without database. Run: docker compose up -d');
    process.exit(1);
  }

  // 2. Run migrations
  try {
    await runMigrations();
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }

  // 2b. Reset all users to offline on server start (clean state)
  await query('UPDATE users SET status = $1', ['offline']);
  console.log('[DB] All users reset to offline');

  // 2c. Clear stale group calls — any call still marked 'ringing'/'answered' from
  // a previous run is a ghost (LiveKit rooms don't survive restarts, and no client
  // is connected to drive the lifecycle). Mark them all ended.
  //
  // We INTENTIONALLY exclude 'scheduled' calls (calendar-event-backed meetings
  // that haven't started yet). Those have no live LiveKit room by design —
  // the room is auto-created when the first participant joins. Marking them
  // ended would silently delete future meetings.
  const ghostCleanup = await query(
    `UPDATE call_history
        SET status = 'ended',
            ended_at = NOW(),
            duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int
      WHERE is_group_call = TRUE
        AND status IN ('ringing', 'answered')
      RETURNING id`,
  );
  if (ghostCleanup.rows.length > 0) {
    console.log(`[DB] Cleaned up ${ghostCleanup.rows.length} stale group call(s) from previous run`);
  }

  // 3. Init Redis + clear stale presence
  await initRedis();
  await clearAllPresence();
  console.log('[REDIS] All presence data cleared');

  // 4. Create Express app
  const app = express();

  // Use HTTPS if certificates exist (required for WebRTC mic/camera)
  const certPath = path.resolve(__dirname, '../../certs/server.crt');
  const keyPath = path.resolve(__dirname, '../../certs/server.key');
  const hasSSL = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const httpServer = hasSSL
    ? createHttpsServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
    : createHttpServer(app);
  if (hasSSL) console.log('[SERVER] HTTPS enabled with SSL certificate');

  // Middleware
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  }));
  app.use(compression());
  app.use(cors({
    origin: config.isDev ? true : config.clientUrl, // Allow all origins in dev for LAN testing
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('dev'));

  // Static files (uploads)
  app.use('/uploads', express.static(path.resolve(config.upload.dir)));
  app.use('/avatars', express.static(path.resolve(config.upload.avatarDir)));

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/conversations', chatRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/calls', callRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/email', emailRoutes);
  app.use('/api/calendar', calendarRoutes);

  // Serve React client build in production
  if (process.env.NODE_ENV === 'production') {
    const clientDist = path.resolve(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    // All non-API routes serve index.html (React SPA routing)
    app.get(/^\/(?!api|uploads|avatars|socket\.io).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
    console.log('[SERVER] Serving client from', clientDist);
  }

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 5. Init Socket.IO
  initSocketIO(httpServer);

  // 6. WSS Proxy — Proxies browser SIP.js WebSocket to UCM6304
  // Solves self-signed certificate issue permanently
  const wssProxy = new WebSocketServer({ noServer: true });
  let activeProxyConnections = 0;

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const pathname = req.url || '';

    // Only handle /wss-proxy — let Socket.IO handle /socket.io/
    if (pathname === '/wss-proxy') {
      wssProxy.handleUpgrade(req, socket, head, (browserWs) => {
        activeProxyConnections++;
        console.log(`[WSS-PROXY] Browser connected (active: ${activeProxyConnections})`);

        // Connect to the real UCM6304 WebSocket
        const ucmWs = new WebSocket(config.ucm.wssUrl, {
          rejectUnauthorized: false, // Accept UCM's self-signed cert (internal hardware)
        });

        let ucmReady = false;
        const pendingMessages: (string | Buffer)[] = [];

        ucmWs.on('open', () => {
          ucmReady = true;
          console.log('[WSS-PROXY] Connected to UCM6304');
          // Flush any messages that arrived before UCM connection was ready
          for (const msg of pendingMessages) {
            ucmWs.send(msg);
          }
          pendingMessages.length = 0;
        });

        // Browser → UCM
        browserWs.on('message', (data: Buffer | string) => {
          if (ucmReady && ucmWs.readyState === WebSocket.OPEN) {
            ucmWs.send(data);
          } else {
            pendingMessages.push(data);
          }
        });

        // UCM → Browser
        ucmWs.on('message', (data: Buffer | string) => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(data);
          }
        });

        // Close handling
        browserWs.on('close', (code, reason) => {
          activeProxyConnections--;
          console.log(`[WSS-PROXY] Browser disconnected (code: ${code}, active: ${activeProxyConnections})`);
          if (ucmWs.readyState === WebSocket.OPEN || ucmWs.readyState === WebSocket.CONNECTING) {
            ucmWs.close();
          }
        });

        ucmWs.on('close', (code, reason) => {
          console.log(`[WSS-PROXY] UCM disconnected (code: ${code})`);
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.close();
          }
        });

        // Error handling
        browserWs.on('error', (err) => {
          console.error('[WSS-PROXY] Browser WS error:', err.message);
          if (ucmWs.readyState === WebSocket.OPEN) ucmWs.close();
        });

        ucmWs.on('error', (err) => {
          console.error('[WSS-PROXY] UCM WS error:', err.message);
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.close(1011, 'UCM connection failed');
          }
        });
      });
    }
    // If not /wss-proxy, do nothing — Socket.IO handles /socket.io/ upgrades internally
  });

  // 7. Start server
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`\n[SERVER] Running on http://0.0.0.0:${config.port}`);
    console.log(`[SERVER] Socket.IO ready`);
    console.log(`[SERVER] UCM6304 API: ${config.ucm.apiUrl}`);
    console.log(`[SERVER] UCM6304 WSS: ${config.ucm.wssUrl}`);
    console.log(`[SERVER] Environment: ${config.nodeEnv}\n`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
