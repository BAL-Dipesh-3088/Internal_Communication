import { create } from 'zustand';
import api from '@/services/api';
import { getSocket } from '@/services/socket';
import type { Conversation, Message } from '@/types';

/** Normalize a message from the server so sender fields are always flat */
function normalizeMessage(raw: any): Message {
  const sender = raw.sender || {};
  // Flatten reply_to → reply_message
  let replyMessage = raw.reply_message || null;
  if (!replyMessage && raw.reply_to) {
    replyMessage = {
      id: raw.reply_to.id,
      content: raw.reply_to.content,
      sender_display_name: raw.reply_to.sender_name || raw.reply_to.display_name,
      sender_username: raw.reply_to.sender_username,
    };
  }
  // Extract file info from metadata if not already flat
  const meta = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : (raw.metadata || {});
  return {
    ...raw,
    sender_id: raw.sender_id || sender.id,
    sender_username: raw.sender_username || sender.username,
    sender_display_name: raw.sender_display_name || sender.display_name,
    sender_avatar: raw.sender_avatar || sender.avatar_url || null,
    reply_message: replyMessage,
    metadata: meta,
    file_url: raw.file_url || meta.fileUrl || null,
    file_name: raw.file_name || meta.fileName || null,
    file_size: raw.file_size || meta.fileSize || null,
  };
}

/** How far one member has read in a conversation (for the "Seen" indicator). */
export interface ReadEntry {
  /** The last message id this member has read. */
  messageId: string | null;
  /** sequence_number of that message — monotonic per conversation, used for
   *  reliable "is this message seen?" comparison (timestamps can tie/skew). */
  sequence: number | null;
  /** When they last read (ISO). */
  at: string | null;
  /** Display name (for the "Seen by X" tooltip in group chats). */
  name?: string;
}

interface ChatState {
  conversations: Conversation[];
  activeConversation: Conversation | null;
  messages: Record<string, Message[]>;
  typingUsers: Record<string, Set<string>>;
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  hasMoreMessages: Record<string, boolean>;
  /** Per-conversation read receipts keyed by readerId → how far they've read. */
  readState: Record<string, Record<string, ReadEntry>>;

  fetchConversations: () => Promise<void>;
  setActiveConversation: (conv: Conversation | null) => void;
  fetchMessages: (conversationId: string, before?: string) => Promise<void>;
  addMessage: (conversationId: string, message: any) => void;
  updateMessage: (conversationId: string, message: Message) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  updateMessageStatus: (conversationId: string, clientId: string, updates: Partial<Message>) => void;
  addConversation: (conv: Conversation) => void;
  updateConversation: (convId: string, updates: Partial<Conversation>) => void;
  setTyping: (conversationId: string, username: string) => void;
  clearTyping: (conversationId: string, username: string) => void;
  updateUnreadCount: (conversationId: string, count: number) => void;
  addReaction: (conversationId: string, messageId: string, userId: string, username: string, emoji: string) => void;
  removeReaction: (conversationId: string, messageId: string, userId: string, emoji: string) => void;
  /** Load existing read receipts for a conversation (so "Seen" shows for messages
   *  read before this chat was opened, not just live ones). */
  fetchReadState: (conversationId: string) => Promise<void>;
  /** Apply a single live read receipt (from the `message:read` socket broadcast). */
  applyRead: (conversationId: string, userId: string, messageId: string, sequence: number | null, at?: string, name?: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversation: null,
  messages: {},
  typingUsers: {},
  isLoadingConversations: false,
  isLoadingMessages: false,
  hasMoreMessages: {},
  readState: {},

  fetchConversations: async () => {
    set({ isLoadingConversations: true });
    try {
      const { data } = await api.get('/conversations');
      set({ conversations: data.conversations || data || [], isLoadingConversations: false });
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      set({ isLoadingConversations: false });
    }
  },

  setActiveConversation: (conv) => {
    set({ activeConversation: conv });
    if (conv) {
      // Reset unread count locally
      const conversations = get().conversations.map((c) =>
        c.id === conv.id ? { ...c, unread_count: 0 } : c
      );
      set({ conversations });

      // Tell the server we've read this conversation
      const msgs = get().messages[conv.id];
      const lastMsg = msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (lastMsg) {
        getSocket()?.emit('message:read', {
          conversationId: conv.id,
          messageId: lastMsg.id,
        });
      }

      // Load existing read receipts so the "Seen" indicator is correct for
      // messages read before we opened this chat (live updates arrive via socket).
      get().fetchReadState(conv.id);
    }
  },

  fetchMessages: async (conversationId, before) => {
    set({ isLoadingMessages: true });
    try {
      const params: any = { limit: 50 };
      if (before) {
        // Use sequence-based pagination if available, fall back to timestamp
        const existing = get().messages[conversationId] || [];
        const minSeq = existing.reduce((min, m) => {
          const seq = m.sequence_number;
          return seq != null && (min === 0 || seq < min) ? seq : min;
        }, 0);
        if (minSeq > 0) {
          params.before_seq = minSeq;
        } else {
          params.before = before;
        }
      }
      const { data } = await api.get(`/conversations/${conversationId}/messages`, { params });

      const msgArray = (data.messages || data || []).map(normalizeMessage);
      const existing = get().messages[conversationId] || [];
      const newMessages = before ? [...msgArray, ...existing] : msgArray;

      set({
        messages: { ...get().messages, [conversationId]: newMessages },
        hasMoreMessages: {
          ...get().hasMoreMessages,
          [conversationId]: msgArray.length === 50,
        },
        isLoadingMessages: false,
      });

      // Mark last message as read on the server if this is the active conversation
      const activeConv = get().activeConversation;
      if (activeConv && activeConv.id === conversationId && newMessages.length > 0) {
        const lastMsg = newMessages[newMessages.length - 1];
        getSocket()?.emit('message:read', {
          conversationId,
          messageId: lastMsg.id,
        });
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      set({ isLoadingMessages: false });
    }
  },

  addMessage: (conversationId, message) => {
    const normalized = normalizeMessage(message);
    const existing = get().messages[conversationId] || [];

    // Replace optimistic message if server-confirmed message arrives with same client_id
    if (normalized.client_id) {
      const optimisticIdx = existing.findIndex(
        (m) => m.client_id === normalized.client_id && m.id?.startsWith('optimistic-')
      );
      if (optimisticIdx !== -1) {
        const updated = [...existing];
        updated[optimisticIdx] = { ...normalized, status: 'sent' as const };
        set({ messages: { ...get().messages, [conversationId]: updated } });
        // Still update conversation metadata below
        const conversations = get().conversations.map((c) => {
          if (c.id === conversationId) {
            return {
              ...c,
              last_message: normalized.content,
              last_message_at: normalized.created_at,
              last_message_sender: normalized.sender_display_name || normalized.sender_username || null,
            };
          }
          return c;
        });
        set({ conversations: conversations.sort((a, b) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()) });
        return;
      }
    }

    // Avoid duplicates by server ID
    if (existing.some((m) => m.id === normalized.id)) return;

    set({
      messages: {
        ...get().messages,
        [conversationId]: [...existing, normalized],
      },
    });

    // Update conversation's last message
    const conversations = get().conversations.map((c) => {
      if (c.id === conversationId) {
        return {
          ...c,
          last_message: normalized.content,
          last_message_at: normalized.created_at,
          last_message_sender: normalized.sender_display_name || normalized.sender_username || null,
          unread_count:
            get().activeConversation?.id === conversationId
              ? 0
              : (Number(c.unread_count) || 0) + 1,
        };
      }
      return c;
    });

    // Sort conversations by last message time
    conversations.sort((a, b) => {
      const aTime = a.last_message_at || a.created_at;
      const bTime = b.last_message_at || b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    set({ conversations });
  },

  updateMessage: (conversationId, message) => {
    const existing = get().messages[conversationId] || [];
    set({
      messages: {
        ...get().messages,
        [conversationId]: existing.map((m) => (m.id === message.id ? { ...m, ...message } : m)),
      },
    });
  },

  removeMessage: (conversationId, messageId) => {
    const existing = get().messages[conversationId] || [];
    set({
      messages: {
        ...get().messages,
        [conversationId]: existing.map((m) =>
          m.id === messageId ? { ...m, is_deleted: true, content: 'This message was deleted' } : m
        ),
      },
    });
  },

  addConversation: (conv) => {
    const existing = get().conversations;
    if (existing.some((c) => c.id === conv.id)) return;
    set({ conversations: [conv, ...existing] });
  },

  updateConversation: (convId, updates) => {
    set({
      conversations: get().conversations.map((c) =>
        c.id === convId ? { ...c, ...updates } : c
      ),
    });
  },

  setTyping: (conversationId, username) => {
    const current = get().typingUsers;
    const set_ = new Set(current[conversationId] || []);
    set_.add(username);
    set({ typingUsers: { ...current, [conversationId]: set_ } });

    // Auto-clear after 3 seconds
    setTimeout(() => {
      get().clearTyping(conversationId, username);
    }, 3000);
  },

  clearTyping: (conversationId, username) => {
    const current = get().typingUsers;
    const set_ = new Set(current[conversationId] || []);
    set_.delete(username);
    set({ typingUsers: { ...current, [conversationId]: set_ } });
  },

  updateUnreadCount: (conversationId, count) => {
    set({
      conversations: get().conversations.map((c) =>
        c.id === conversationId ? { ...c, unread_count: count } : c
      ),
    });
  },

  addReaction: (conversationId, messageId, userId, username, emoji) => {
    const existing = get().messages[conversationId] || [];
    set({
      messages: {
        ...get().messages,
        [conversationId]: existing.map((m) => {
          if (m.id !== messageId) return m;
          const reactions = [...(m.reactions || [])];
          // Don't duplicate
          if (!reactions.some((r) => r.user_id === userId && r.emoji === emoji)) {
            reactions.push({ id: `${messageId}-${userId}-${emoji}`, message_id: messageId, user_id: userId, emoji, username });
          }
          return { ...m, reactions };
        }),
      },
    });
  },

  removeReaction: (conversationId, messageId, userId, emoji) => {
    const existing = get().messages[conversationId] || [];
    set({
      messages: {
        ...get().messages,
        [conversationId]: existing.map((m) => {
          if (m.id !== messageId) return m;
          const reactions = (m.reactions || []).filter(
            (r) => !(r.user_id === userId && r.emoji === emoji)
          );
          return { ...m, reactions };
        }),
      },
    });
  },

  updateMessageStatus: (conversationId, clientId, updates) => {
    const existing = get().messages[conversationId] || [];
    set({
      messages: {
        ...get().messages,
        [conversationId]: existing.map((m) =>
          m.client_id === clientId ? { ...m, ...updates } : m
        ),
      },
    });
  },

  fetchReadState: async (conversationId) => {
    try {
      const { data } = await api.get(`/conversations/${conversationId}/read-state`);
      const rows: any[] = data.readState || data || [];
      const map: Record<string, ReadEntry> = {};
      for (const r of rows) {
        map[r.user_id] = {
          messageId: r.last_read_message_id ?? null,
          sequence: r.last_read_sequence != null ? Number(r.last_read_sequence) : null,
          at: r.last_read_at ?? null,
          name: r.display_name || r.username || undefined,
        };
      }
      set({ readState: { ...get().readState, [conversationId]: map } });
    } catch (err) {
      // Non-fatal — the indicator just won't show historical reads.
      console.error('Failed to fetch read state:', err);
    }
  },

  applyRead: (conversationId, userId, messageId, sequence, at, name) => {
    const convReads = get().readState[conversationId] || {};
    const prev = convReads[userId];
    // Read state only ever moves forward — ignore an out-of-order/stale event
    // (e.g. a late socket message for an earlier sequence).
    if (prev && prev.sequence != null && sequence != null && sequence < prev.sequence) {
      return;
    }
    set({
      readState: {
        ...get().readState,
        [conversationId]: {
          ...convReads,
          [userId]: {
            messageId,
            sequence: sequence != null ? Number(sequence) : (prev?.sequence ?? null),
            at: at ?? new Date().toISOString(),
            name: name ?? prev?.name,
          },
        },
      },
    });
  },
}));
