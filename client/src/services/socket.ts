import { io, Socket } from 'socket.io-client';
import axios from 'axios';

let socket: Socket | null = null;

// Always use Vite proxy — required because browser is on HTTPS (self-signed SSL)
// and cannot connect to plain HTTP backend directly (mixed content blocked)
function getBackendUrl(): string {
  return '/';
}

// ─── Self-healing auth ────────────────────────────────────────────────────────
// The access token expires every 15 minutes. A user who reopens the app days
// later (or whose laptop slept overnight) still has a valid REFRESH token, but
// the socket handshake would fail with the stale access token. Two guarantees
// make the socket layer self-healing:
//   1. `auth` is a FUNCTION — Socket.IO calls it on EVERY (re)connection
//      attempt, so each attempt reads the freshest token from localStorage
//      (which the axios 401-interceptor keeps up to date).
//   2. On an auth handshake failure we proactively call /auth/refresh
//      ourselves, store the new tokens, and reconnect. Only if the refresh
//      itself fails (refresh token revoked/expired) do we send the user to
//      the login page — at that point the session is genuinely dead.
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  // Single-flight: connect_error can fire in bursts; refresh only once.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) return false;
        // Plain axios (not the api instance) — must not recurse into the 401 interceptor.
        const { data } = await axios.post('/api/auth/refresh', { refreshToken });
        localStorage.setItem('accessToken', data.accessToken);
        if (data.refreshToken) {
          localStorage.setItem('refreshToken', data.refreshToken);
        }
        return true;
      } catch {
        return false;
      } finally {
        // Allow a future refresh after this burst settles.
        setTimeout(() => { refreshInFlight = null; }, 1000);
      }
    })();
  }
  return refreshInFlight;
}

function isAuthError(message: string): boolean {
  const m = (message || '').toLowerCase();
  return m.includes('invalid token') || m.includes('authentication required') || m.includes('jwt');
}

export function connectSocket(_token?: string): Socket {
  // If already connected, reuse
  if (socket?.connected) return socket;

  // If socket exists but disconnected, reconnect (auth fn reads fresh token)
  if (socket) {
    socket.connect();
    return socket;
  }

  const url = getBackendUrl();
  socket = io(url, {
    // Function form: evaluated on EVERY connection attempt → always the
    // freshest token, never a stale snapshot from page-load time.
    auth: (cb) => cb({ token: localStorage.getItem('accessToken') || '' }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    // Never stop trying — a laptop waking from overnight sleep must reconnect
    // on its own, like Teams. (A finite cap left the app permanently dead
    // after ~4 minutes of failed attempts.)
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket?.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
    // The server force-disconnects sockets it considers dead; manual reconnect
    // is required for 'io server disconnect' (socket.io does not auto-retry it).
    if (reason === 'io server disconnect') {
      socket?.connect();
    }
  });

  socket.on('connect_error', async (err) => {
    console.error('[Socket] Connection error:', err.message);
    if (isAuthError(err.message)) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        console.log('[Socket] Token refreshed — reconnecting');
        socket?.connect();
      } else {
        // Refresh token is dead too — the session is over. Clean up and
        // send the user to login instead of leaving a zombie UI.
        console.warn('[Socket] Session expired — redirecting to login');
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      }
    }
  });

  return socket;
}

/** Kept for callers (e.g. the axios 401 interceptor). With the auth function
 *  above, the next connection attempt always reads the fresh token from
 *  localStorage — so this only needs to kick a reconnect if we're down. */
export function updateSocketToken(_newToken: string) {
  if (socket && !socket.connected) {
    socket.connect();
  }
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
