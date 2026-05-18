/**
 * CallChatPanel — Teams-style in-call chat.
 *
 * Architecture (two-layer delivery + persistence):
 *   • Real-time:  LiveKit useChat() — sub-100ms latency, data channel push
 *   • Persistent: backend `call_chat_messages` table (PostgreSQL)
 *
 * Why both:
 *   - LiveKit's useChat is ephemeral. Late joiners see nothing prior to their join.
 *   - Pure backend chat adds latency to every keystroke-to-pixel cycle.
 *   - Combined: live message flows via LiveKit, history loaded from DB on mount.
 *
 * Deduplication:
 *   - Every message carries a clientMsgId (UUID generated at send time).
 *   - Same id is broadcast in LiveKit `attributes` AND stored in DB.
 *   - On receive, we map by clientMsgId — duplicates are merged, not appended.
 *   - The sender's own optimistic message has the same id, so when their own
 *     useChat echo arrives, it just updates the existing local entry.
 *
 * Lifecycle:
 *   - Component is always mounted in the GroupCallOverlay (so unread tracking
 *     keeps working when the user has the panel hidden). When `visible=false`
 *     we render the same DOM but set `display:none`.
 *   - `onUnreadChange` lifts the count back to the parent which renders the
 *     red badge on the Chat tab button.
 *
 * Authorization is enforced server-side — we trust the user is a call
 * participant if the call overlay is even rendered.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, MessageSquare, X, Loader2 } from 'lucide-react';
import { useChat, useLocalParticipant } from '@livekit/components-react';
import * as livekitApi from '@/services/livekit';
import { useAuthStore } from '@/stores/authStore';

interface Props {
  callId: string;
  /** Whether the panel is shown to the user. We stay mounted either way so we keep
   *  receiving useChat events for unread tracking. */
  visible: boolean;
  onClose: () => void;
  /** Lifted unread count — incremented when the panel is hidden and a new message
   *  from someone else arrives. Parent uses this to render the badge. */
  onUnreadChange?: (count: number) => void;
}

/**
 * Local message shape — superset of CallChatMessage with optimistic-UI state.
 * `status` is only used for the local user's own messages:
 *   - 'sending'  : POST in flight (greyed out)
 *   - 'sent'     : persisted successfully OR echoed back via useChat
 *   - 'failed'   : POST failed (network error etc.) — UI shows retry
 */
interface ChatMsg {
  clientMsgId: string;
  senderId: string | null;
  senderDisplayName: string;
  content: string;
  createdAt: string;       // ISO timestamp
  status?: 'sending' | 'sent' | 'failed';
  isLocal?: boolean;       // true if the local user sent this
}

// Lightweight UUID v4 — avoids pulling a dep just for one id.
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function CallChatPanel({ callId, visible, onClose, onUnreadChange }: Props) {
  const { localParticipant } = useLocalParticipant();
  const localUserId = useAuthStore((s) => s.user?.id);
  const localUserName = useAuthStore((s) => s.user?.display_name) || localParticipant?.name || 'You';

  const { chatMessages: liveChatMessages, send: livekitSend, isSending: livekitIsSending } = useChat();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [hydrating, setHydrating] = useState(true);
  const [unread, setUnread] = useState(0);
  const messagesById = useRef<Map<string, ChatMsg>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // ─── Hydrate history from DB on mount ─────────────────────────────────────
  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    setHydrating(true);
    livekitApi.getCallChatHistory(callId)
      .then((history) => {
        if (cancelled) return;
        // Seed the local index from history
        for (const m of history) {
          if (!messagesById.current.has(m.clientMsgId)) {
            messagesById.current.set(m.clientMsgId, {
              clientMsgId: m.clientMsgId,
              senderId: m.senderId,
              senderDisplayName: m.senderDisplayName,
              content: m.content,
              createdAt: m.createdAt,
              status: 'sent',
              isLocal: m.senderId === localUserId,
            });
          }
        }
        rebuildOrderedList();
        setHydrating(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[CallChat] history fetch failed:', err?.response?.data?.error || err.message);
        setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [callId, localUserId]);

  // ─── Listen to LiveKit useChat — merge into local state, dedupe by clientMsgId ──
  useEffect(() => {
    if (!liveChatMessages || liveChatMessages.length === 0) return;
    let changed = false;

    for (const m of liveChatMessages) {
      // Try to extract our clientMsgId from attributes. If the message came
      // from a client that doesn't tag (e.g. very old client), fall back to
      // LiveKit's own message id — still safe for dedup within the room.
      const clientMsgId = (m as any).attributes?.clientMsgId || m.id;
      const senderId = (m as any).from?.identity || null;
      const senderName = (m as any).from?.name || (m as any).from?.identity || 'User';
      const isLocal = senderId === localUserId;

      const existing = messagesById.current.get(clientMsgId);
      if (existing) {
        // We already have this — update status if our own optimistic message just got confirmed
        if (existing.status !== 'sent') {
          existing.status = 'sent';
          changed = true;
        }
        continue;
      }

      // Brand new message — add it.
      messagesById.current.set(clientMsgId, {
        clientMsgId,
        senderId,
        senderDisplayName: senderName,
        content: m.message,
        createdAt: new Date(m.timestamp).toISOString(),
        status: 'sent',
        isLocal,
      });
      changed = true;

      // Unread bump: only count NEW messages from OTHER users that arrive while panel hidden
      if (!isLocal && !visibleRef.current) {
        setUnread((n) => n + 1);
      }
    }

    if (changed) rebuildOrderedList();
  }, [liveChatMessages, localUserId]);

  // ─── Notify parent of unread changes ───────────────────────────────────────
  useEffect(() => {
    onUnreadChange?.(unread);
  }, [unread, onUnreadChange]);

  // ─── Reset unread when panel becomes visible ───────────────────────────────
  useEffect(() => {
    if (visible) {
      setUnread(0);
      // Focus input + scroll to bottom on open
      setTimeout(() => {
        inputRef.current?.focus();
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
      }, 0);
    }
  }, [visible]);

  // ─── Auto-scroll to bottom on new messages (only when visible) ────────────
  useEffect(() => {
    if (!visible || !scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, visible]);

  function rebuildOrderedList() {
    const sorted = Array.from(messagesById.current.values())
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    setMessages(sorted);
  }

  // ─── Send a message ────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = draft.trim();
    if (!text || livekitIsSending) return;

    const clientMsgId = uuid();
    const nowIso = new Date().toISOString();

    // 1. Optimistic add to local state
    const optimisticMsg: ChatMsg = {
      clientMsgId,
      senderId: localUserId || null,
      senderDisplayName: localUserName,
      content: text,
      createdAt: nowIso,
      status: 'sending',
      isLocal: true,
    };
    messagesById.current.set(clientMsgId, optimisticMsg);
    rebuildOrderedList();
    setDraft('');

    // 2. Send via LiveKit (real-time to current participants)
    //    Pass clientMsgId in attributes so receivers can dedupe.
    const livekitPromise = livekitSend(text, { attributes: { clientMsgId } })
      .catch((err: any) => {
        console.warn('[CallChat] LiveKit send failed (will still try backend):', err.message);
      });

    // 3. Persist to backend (so late joiners get history)
    const backendPromise = livekitApi.sendCallChatMessage(callId, clientMsgId, text);

    try {
      await Promise.all([livekitPromise, backendPromise]);
      const entry = messagesById.current.get(clientMsgId);
      if (entry) {
        entry.status = 'sent';
        rebuildOrderedList();
      }
    } catch (err: any) {
      console.error('[CallChat] backend persist failed:', err?.response?.data?.error || err.message);
      const entry = messagesById.current.get(clientMsgId);
      if (entry) {
        entry.status = 'failed';
        rebuildOrderedList();
      }
    }
  };

  const handleRetry = async (msg: ChatMsg) => {
    if (msg.status !== 'failed') return;
    msg.status = 'sending';
    rebuildOrderedList();
    try {
      await Promise.all([
        livekitSend(msg.content, { attributes: { clientMsgId: msg.clientMsgId } }),
        livekitApi.sendCallChatMessage(callId, msg.clientMsgId, msg.content),
      ]);
      msg.status = 'sent';
    } catch {
      msg.status = 'failed';
    }
    rebuildOrderedList();
  };

  // ─── Group consecutive messages from the same sender (Teams-style) ────────
  const groupedMessages = useMemo(() => {
    const groups: Array<{ senderId: string | null; senderDisplayName: string; isLocal: boolean; messages: ChatMsg[] }> = [];
    let current: typeof groups[number] | null = null;
    for (const m of messages) {
      if (current && current.senderId === m.senderId) {
        current.messages.push(m);
      } else {
        current = {
          senderId: m.senderId,
          senderDisplayName: m.senderDisplayName,
          isLocal: !!m.isLocal,
          messages: [m],
        };
        groups.push(current);
      }
    }
    return groups;
  }, [messages]);

  return (
    <div
      style={{
        // We render the same DOM whether visible or not so useChat keeps tracking.
        // Hiding via display:none also prevents focus from being trapped inside.
        display: visible ? 'flex' : 'none',
        width: 340,
        flexShrink: 0,
        background: '#1A1A2E',
        borderLeft: '1px solid #2A2A45',
        flexDirection: 'column',
        color: '#fff',
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid #2A2A45',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MessageSquare size={16} />
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Meeting chat</h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Close chat panel"
          style={{
            width: 26, height: 26, borderRadius: 6,
            background: 'transparent', border: 'none', color: '#8B8CA7',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#2A2A45'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#8B8CA7'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: 'auto', minHeight: 0,
          padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        {hydrating && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8B8CA7', fontSize: 12 }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )}

        {!hydrating && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: '#8B8CA7', fontSize: 12, lineHeight: 1.6 }}>
            <MessageSquare size={28} style={{ opacity: 0.4, marginBottom: 12 }} />
            <div style={{ fontWeight: 600, color: '#fff', marginBottom: 4 }}>No messages yet</div>
            <div>Be the first to say something.</div>
          </div>
        )}

        {groupedMessages.map((group, gi) => (
          <div key={gi} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: group.isLocal ? 'flex-end' : 'flex-start' }}>
            {/* Sender label (other people only — own messages don't need a label) */}
            {!group.isLocal && (
              <div style={{ fontSize: 11, fontWeight: 600, color: '#A5A7F0', marginBottom: 2 }}>
                {group.senderDisplayName}
              </div>
            )}
            {group.messages.map((m, mi) => {
              const failed = m.status === 'failed';
              const sending = m.status === 'sending';
              return (
                <div
                  key={m.clientMsgId + ':' + mi}
                  style={{
                    maxWidth: '85%',
                    padding: '8px 12px',
                    borderRadius: group.isLocal
                      ? (mi === group.messages.length - 1 ? '14px 14px 4px 14px' : '14px 14px 14px 14px')
                      : (mi === group.messages.length - 1 ? '14px 14px 14px 4px' : '14px 14px 14px 14px'),
                    background: group.isLocal
                      ? (failed ? '#7F1D1D' : '#6264A7')
                      : '#2A2A45',
                    color: '#fff',
                    fontSize: 13,
                    lineHeight: 1.45,
                    opacity: sending ? 0.7 : 1,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                    position: 'relative',
                  }}
                >
                  {m.content}
                  {failed && (
                    <button
                      onClick={() => handleRetry(m)}
                      style={{
                        display: 'block', marginTop: 4,
                        fontSize: 10, color: '#FECACA',
                        background: 'transparent', border: 'none',
                        textDecoration: 'underline', cursor: 'pointer', padding: 0,
                      }}
                    >
                      Failed — tap to retry
                    </button>
                  )}
                </div>
              );
            })}
            {/* Timestamp on the last message of the group */}
            <div style={{ fontSize: 10, color: '#8B8CA7', marginTop: 1 }}>
              {formatTime(group.messages[group.messages.length - 1].createdAt)}
              {group.isLocal && group.messages[group.messages.length - 1].status === 'sending' && ' · Sending…'}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div
        style={{
          padding: '10px 14px 14px',
          borderTop: '1px solid #2A2A45',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#0F0F1F',
            border: '1px solid #2A2A45',
            borderRadius: 10,
            padding: '8px 10px',
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type a message…"
            maxLength={4000}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: '#fff', fontSize: 13, fontFamily: 'inherit', minWidth: 0,
            }}
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || livekitIsSending}
            aria-label="Send message"
            style={{
              width: 30, height: 30, borderRadius: 8,
              background: draft.trim() && !livekitIsSending ? '#6264A7' : '#3A3A55',
              color: '#fff', border: 'none',
              cursor: draft.trim() && !livekitIsSending ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { if (draft.trim() && !livekitIsSending) e.currentTarget.style.background = '#7172B3'; }}
            onMouseLeave={(e) => { if (draft.trim() && !livekitIsSending) e.currentTarget.style.background = '#6264A7'; }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth() &&
                  d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
