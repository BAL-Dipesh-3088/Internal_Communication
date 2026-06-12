import { create } from 'zustand';
import api from '@/services/api';
import { connectSocket, disconnectSocket } from '@/services/socket';
import type { User } from '@/types';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (username: string, password: string) => Promise<void>;
  register: (data: {
    username: string;
    email: string;
    password: string;
    display_name: string;
    department?: string;
    title?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
  /** Forced first-login flow (and voluntary changes): verifies the current
   *  (temporary) password server-side, sets the new one, clears the gate. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (username, password) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.post('/auth/login', { username, password });
      localStorage.setItem('accessToken', data.tokens.accessToken);
      localStorage.setItem('refreshToken', data.tokens.refreshToken);
      if (data.sipPassword) {
        localStorage.setItem('sipPassword', data.sipPassword);
      }
      connectSocket(data.tokens.accessToken);
      set({ user: data.user, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Login failed';
      set({ error: msg, isLoading: false });
      throw new Error(msg);
    }
  },

  register: async (regData) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.post('/auth/register', regData);
      localStorage.setItem('accessToken', data.tokens.accessToken);
      localStorage.setItem('refreshToken', data.tokens.refreshToken);
      if (data.sipPassword) {
        localStorage.setItem('sipPassword', data.sipPassword);
      }
      connectSocket(data.tokens.accessToken);
      set({ user: data.user, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Registration failed';
      set({ error: msg, isLoading: false });
      throw new Error(msg);
    }
  },

  logout: async () => {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken }).catch(() => {});
      }
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('sipPassword');
      disconnectSocket();
      set({ user: null, isAuthenticated: false, isLoading: false, error: null });
    }
  },

  checkAuth: async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) {
      set({ isLoading: false });
      return;
    }
    try {
      const { data } = await api.get('/auth/me');
      // Persist SIP password for auto-registration on page refresh
      if (data.user?.sip_password) {
        localStorage.setItem('sipPassword', data.user.sip_password);
      }
      // NOTE: do NOT pass the token captured above — if it was expired, the
      // /auth/me call just rotated it via the 401 interceptor, and the old
      // snapshot would poison the socket handshake. connectSocket reads the
      // fresh token from localStorage on every attempt.
      connectSocket();
      set({ user: data.user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  updateUser: (updates) => {
    const current = get().user;
    if (current) {
      set({ user: { ...current, ...updates } });
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    await api.post('/auth/change-password', { currentPassword, newPassword });
    const current = get().user;
    if (current) {
      set({ user: { ...current, must_change_password: false } });
    }
  },

  clearError: () => set({ error: null }),
}));
