// ===== User Types =====
export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: 'admin' | 'manager' | 'employee';
  department: string | null;
  designation: string | null;
  sip_extension: string | null;
  sip_password: string | null;
  status: 'online' | 'offline' | 'away' | 'busy' | 'dnd';
  status_message?: string | null;
  last_seen: string;
  created_at: string;
  /** TRUE while the password is a temporary one (onboarding / admin reset) —
   *  the app is blocked behind the set-new-password gate until cleared. */
  must_change_password?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse {
  user: User;
  tokens: AuthTokens;
  sipPassword?: string;
}

// ===== Conversation Types =====
export type ConversationType = 'direct' | 'group';

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  description: string | null;
  avatar_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Enriched fields from API
  last_message?: string | { id: string; content: string; type: string; sender_id: string; created_at: string; sender_name: string } | null;
  last_message_at?: string | null;
  last_message_sender?: string | null;
  unread_count?: number;
  member_count?: number;
  other_user?: User;
  members?: ConversationMember[];
}

export interface ConversationMember {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
  status?: string;
}

// ===== Message Types =====
export interface MentionData {
  userId: string;
  username: string;
  displayName: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  content: string;
  type: 'text' | 'file' | 'image' | 'system';
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  reply_to: string | null;
  is_edited: boolean;
  is_deleted: boolean;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  // Sequence-based ordering & idempotency
  sequence_number?: number;
  client_id?: string;
  // Optimistic send status
  status?: 'sending' | 'sent' | 'failed';
  // Enriched
  sender_username?: string;
  sender_display_name?: string;
  sender_avatar?: string | null;
  reactions?: MessageReaction[];
  reply_message?: Message | null;
  metadata?: { mentions?: MentionData[]; [key: string]: any };
}

export interface MessageReaction {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  username?: string;
}

// ===== Socket Event Types =====
export interface TypingEvent {
  conversationId: string;
  userId: string;
  username: string;
}

export interface PresenceEvent {
  userId: string;
  status: 'online' | 'offline' | 'away' | 'busy';
}

export interface MessageEvent {
  message: Message;
  conversationId: string;
}

// ===== Call Types =====
export interface CallEvent {
  callId: string;
  callerId: string;
  callerName: string;
  calleeId: string;
  type: 'audio' | 'video';
  conversationId?: string;
}

// ===== API Response Types =====
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
