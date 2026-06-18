import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import EmailWindow from '@/components/email/EmailWindow';
import CallsWindow from '@/components/calls/CallsWindow';
import CalendarWindow from '@/components/calendar/CalendarWindow';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { getSocket } from '@/services/socket';
import { useChatStore } from '@/stores/chatStore';
import { useCallStore } from '@/stores/callStore';
import { useMailStore } from '@/stores/mailStore';
import { useWindowSize, BREAKPOINTS } from '@/hooks/useWindowSize';
import IncomingCallModal from '@/components/calls/IncomingCallModal';
import IncomingGroupCallModal from '@/components/calls/IncomingGroupCallModal';
import ActiveCallOverlay from '@/components/calls/ActiveCallOverlay';
import GroupCallOverlay from '@/components/calls/GroupCallOverlay';
import {
  initFocusTracking,
  shouldNotify,
  showDesktopNotification,
  playMessageSound,
  updateTitleBadge,
  getNotificationPrefs,
} from '@/services/notification';

export default function AppLayout() {
  const { user } = useAuthStore();
  const { fetchConversations, addMessage, updateMessage, removeMessage, setTyping, clearTyping, updateConversation, addReaction, removeReaction } =
    useChatStore();
  const conversations = useChatStore((s) => s.conversations);
  // callStore used via getState() in event handlers
  const { sidebarOpen, setSidebarOpen, sidebarTab } = useUIStore();
  const { width } = useWindowSize();
  const location = useLocation();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const isMobile = width < BREAKPOINTS.tablet;
  // Check if we're inside a chat conversation (URL like /chat/some-id)
  const isInConversation = /^\/chat\/.+/.test(location.pathname);
  const isAdminRoute = location.pathname === '/admin';
  // The shareable meeting-join page is a real route rendered through <Outlet/>.
  // The main content area below is normally driven by `sidebarTab` (calendar /
  // calls / email windows are state-based, not routes), which would otherwise
  // keep covering the Outlet. So when we're on /meeting/:callId we must force
  // the Outlet to render regardless of which tab was last active — this is what
  // makes the in-app "Join meeting" button (e.g. from the calendar) actually work.
  const isMeetingRoute = /^\/meeting\/.+/.test(location.pathname);

  // Global inbox watcher — unread badge on the Email icon + new-mail sound,
  // active wherever the user is in the app (not just the Email tab).
  useEffect(() => {
    const { startPolling, stopPolling } = useMailStore.getState();
    startPolling();
    return () => stopPolling();
  }, []);

  // On mobile, auto-close sidebar when a conversation is selected
  useEffect(() => {
    if (isMobile && isInConversation) {
      setSidebarOpen(false);
    }
  }, [isInConversation, isMobile, setSidebarOpen]);

  // On desktop, always keep sidebar open
  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(true);
    }
  }, [isMobile, setSidebarOpen]);

  // Fetch conversations on mount
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Tab focus tracking for notification suppression
  useEffect(() => {
    const cleanup = initFocusTracking();
    return cleanup;
  }, []);

  // Title badge: show unread count in browser tab title
  useEffect(() => {
    const totalUnread = conversations.reduce(
      (sum, c) => sum + (Number(c.unread_count) || 0), 0
    );
    updateTitleBadge(totalUnread);
  }, [conversations]);

  // Bumped to re-run the socket-listener effect if the socket wasn't ready yet
  // at mount (resilient attach — item 3). Without this, a startup race where
  // getSocket() is briefly null would leave live updates unbound until refresh.
  const [socketRecheck, setSocketRecheck] = useState(0);

  // Socket event listeners
  useEffect(() => {
    const socket = getSocket();
    if (!socket) {
      // Socket not created yet — re-check shortly instead of giving up forever.
      const t = setTimeout(() => setSocketRecheck((n) => n + 1), 600);
      return () => clearTimeout(t);
    }

    // On every connect (including reconnect): init WebRTC, set presence, sync messages
    const onConnect = () => {
      // Immediately tell server we're online (handles cached login + reconnect)
      socket.emit('presence:heartbeat');
      socket.emit('presence:update', { status: 'online' });
      useCallStore.getState().initWebRTC(socket);
      // Refresh the conversation list on every (re)connect so new chats, unread
      // counts, and last-message previews are current after any disconnect.
      fetchConversations();
      const allMessages = useChatStore.getState().messages;
      const conversations: Record<string, number> = {};

      for (const [convId, msgs] of Object.entries(allMessages)) {
        if (!msgs || msgs.length === 0) continue;
        // Find the highest sequence_number we have for this conversation
        let maxSeq = 0;
        for (const m of msgs) {
          if (m.sequence_number != null && m.sequence_number > maxSeq) {
            maxSeq = m.sequence_number;
          }
        }
        if (maxSeq > 0) {
          conversations[convId] = maxSeq;
        }
      }

      if (Object.keys(conversations).length === 0) return;

      socket.emit('sync:request', { conversations }, (response: any) => {
        if (!response?.success || !response.conversations) return;
        const store = useChatStore.getState();
        for (const [convId, msgs] of Object.entries(response.conversations as Record<string, any[]>)) {
          for (const msg of msgs) {
            store.addMessage(convId, msg);
          }
          // If 200 messages returned, there may be more — trigger full re-fetch
          if (msgs.length >= 200) {
            store.fetchMessages(convId);
          }
        }
      });
    };

    // Accept ALL messages including sender's own (addMessage deduplicates by ID)
    const onNewMessage = (data: any) => {
      const raw = data.message || data;
      const convId = data.conversationId || raw.conversation_id;
      // Normalize: server sends sender as nested object, client expects flat fields
      // Normalize reply_to → reply_message
      let replyMessage = raw.reply_message || null;
      if (!replyMessage && raw.reply_to) {
        replyMessage = {
          id: raw.reply_to.id,
          content: raw.reply_to.content,
          sender_display_name: raw.reply_to.sender_name || raw.reply_to.display_name,
          sender_username: raw.reply_to.sender_username,
        };
      }
      const msg = {
        ...raw,
        sender_id: raw.sender_id || raw.sender?.id,
        sender_username: raw.sender_username || raw.sender?.username,
        sender_display_name: raw.sender_display_name || raw.sender?.display_name,
        sender_avatar: raw.sender_avatar || raw.sender?.avatar_url || null,
        reply_message: replyMessage,
      };
      addMessage(convId, msg);

      // Auto-mark as read if this conversation is currently open
      const activeConv = useChatStore.getState().activeConversation;
      if (activeConv && activeConv.id === convId && msg.sender_id !== user?.id) {
        socket.emit('message:read', {
          conversationId: convId,
          messageId: msg.id,
        });
      }

      // Desktop notification for new messages
      const currentUser = useAuthStore.getState().user;
      const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : (msg.metadata || {});
      const mentionedUserIds = (meta.mentions || []).map((m: any) => m.userId);
      if (currentUser && shouldNotify({
        senderId: msg.sender_id,
        currentUserId: currentUser.id,
        conversationId: convId,
        activeConversationId: activeConv?.id || null,
        userStatus: currentUser.status,
        mentionedUserIds,
      })) {
        const prefs = getNotificationPrefs();
        if (prefs.sound) {
          playMessageSound();
        }
        const senderName = msg.sender_display_name || msg.sender_username || 'Someone';
        const isMentioned = mentionedUserIds.includes(currentUser.id) || mentionedUserIds.includes('everyone');
        const body = isMentioned
          ? `${senderName} mentioned you`
          : prefs.preview
            ? (msg.content || 'Sent an attachment').slice(0, 100)
            : 'Sent you a message';
        showDesktopNotification({
          title: isMentioned ? 'Mention' : senderName,
          body,
          tag: `msg-${convId}`,
          onClick: () => {
            navigateRef.current(`/chat/${convId}`);
          },
        });
      }
    };

    const onMessageEdited = (data: any) => {
      const msg = data.message || data;
      const convId = data.conversationId || msg.conversation_id;
      updateMessage(convId, msg);
    };

    const onMessageDeleted = (data: any) => {
      const convId = data.conversationId || data.conversation_id;
      const msgId = data.messageId || data.id;
      removeMessage(convId, msgId);
    };

    const onTypingStart = (data: any) => {
      if (data.userId !== user?.id) {
        setTyping(data.conversationId, data.username);
      }
    };

    const onTypingStop = (data: any) => {
      clearTyping(data.conversationId, data.username);
    };

    const onConversationCreated = () => {
      fetchConversations();
    };

    // Listen for presence changes to update online/offline status
    const onPresenceChanged = (data: any) => {
      const { userId, status } = data;
      const conversations = useChatStore.getState().conversations;
      conversations.forEach((conv) => {
        if (conv.other_user && conv.other_user.id === userId) {
          updateConversation(conv.id, {
            other_user: { ...conv.other_user, status },
          } as any);
        }
        if (conv.members) {
          const updatedMembers = conv.members.map((m: any) =>
            m.id === userId || m.user_id === userId ? { ...m, status } : m
          );
          updateConversation(conv.id, { members: updatedMembers } as any);
        }
      });
    };

    // Listen for reaction events
    const onMessageReaction = (data: any) => {
      const { messageId, userId, username, emoji, action } = data;
      // Find which conversation this message belongs to
      const allMessages = useChatStore.getState().messages;
      for (const [convId, msgs] of Object.entries(allMessages)) {
        if (msgs.some((m: any) => m.id === messageId)) {
          if (action === 'added') {
            addReaction(convId, messageId, userId, username, emoji);
          } else {
            removeReaction(convId, messageId, userId, emoji);
          }
          break;
        }
      }
    };

    // Group call socket listeners
    const onGroupCallStarted = (data: any) => {
      const { conversationId, callType, startedBy, groupName } = data;
      const currentUser = useAuthStore.getState().user;
      // If we started it, we already have the overlay active
      if (currentUser && startedBy === currentUser.id) return;
      // Show desktop notification with join option
      showDesktopNotification({
        title: 'Group Call Started',
        body: `A ${callType} call started in ${groupName || 'a group'}`,
        tag: `group-call-${conversationId}`,
        onClick: () => {
          useCallStore.getState().joinGroupCall(conversationId, callType, groupName || 'Group Call');
          // Notify server we joined
          socket.emit('group-call:join', { conversationId });
        },
      });
    };

    const onGroupCallParticipantJoined = (data: any) => {
      const { conversationId, userId, displayName, extension } = data;
      const callStore = useCallStore.getState();
      if (callStore.groupCall?.conversationId === conversationId) {
        callStore.addGroupParticipant({
          userId,
          displayName,
          extension: extension || '',
          status: 'connected',
          isMuted: false,
        });
      }
    };

    const onGroupCallParticipantLeft = (data: any) => {
      const { conversationId, userId } = data;
      const callStore = useCallStore.getState();
      if (callStore.groupCall?.conversationId === conversationId) {
        callStore.removeGroupParticipant(userId);
      }
    };

    const onGroupCallEnded = (data: any) => {
      const { conversationId } = data;
      const callStore = useCallStore.getState();
      if (callStore.groupCall?.conversationId === conversationId) {
        callStore.endGroupCall();
      }
    };

    socket.on('message:new', onNewMessage);
    socket.on('message:edited', onMessageEdited);
    socket.on('message:updated', onMessageEdited);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('message:reaction', onMessageReaction);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('conversation:created', onConversationCreated);
    socket.on('presence:changed', onPresenceChanged);
    socket.on('group-call:started', onGroupCallStarted);
    socket.on('group-call:participant-joined', onGroupCallParticipantJoined);
    socket.on('group-call:participant-left', onGroupCallParticipantLeft);
    socket.on('group-call:ended', onGroupCallEnded);
    // Internal mail push — recipient's client refreshes the inbox instantly
    // when someone sends them mail through ICP (item 4). No extra polling.
    const onMailNew = () => { useMailStore.getState().refreshInbox(); };
    socket.on('mail:new', onMailNew);

    socket.on('connect', onConnect);

    // If the socket was ALREADY connected before these listeners attached
    // (the common case on fresh load — 'connect' fired during checkAuth), the
    // onConnect catch-up would otherwise never run. Trigger it once now so the
    // initial sync + room state are current without needing a page refresh.
    if (socket.connected) onConnect();

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      socket.emit('presence:heartbeat');
    }, 30000);

    return () => {
      socket.off('message:new', onNewMessage);
      socket.off('message:edited', onMessageEdited);
      socket.off('message:updated', onMessageEdited);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('message:reaction', onMessageReaction);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('conversation:created', onConversationCreated);
      socket.off('presence:changed', onPresenceChanged);
      socket.off('group-call:started', onGroupCallStarted);
      socket.off('group-call:participant-joined', onGroupCallParticipantJoined);
      socket.off('group-call:participant-left', onGroupCallParticipantLeft);
      socket.off('group-call:ended', onGroupCallEnded);
      socket.off('mail:new', onMailNew);
      socket.off('connect', onConnect);
      clearInterval(heartbeat);
    };
  }, [user?.id, socketRecheck, addMessage, updateMessage, removeMessage, setTyping, clearTyping, fetchConversations, updateConversation, addReaction, removeReaction]);

  return (
    <>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative' }}>
        {/* Mobile: sidebar as overlay */}
        {isMobile ? (
          <>
            {/* Backdrop */}
            {sidebarOpen && (
              <div
                onClick={() => setSidebarOpen(false)}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
                  zIndex: 90, transition: 'opacity 0.2s',
                }}
              />
            )}
            {/* Slide-in sidebar */}
            <div
              style={{
                position: 'fixed', top: 0, left: 0, bottom: 0,
                width: Math.min(340, width - 40),
                transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                zIndex: 100,
                boxShadow: sidebarOpen ? '4px 0 24px rgba(0,0,0,0.15)' : 'none',
              }}
            >
              <Sidebar />
            </div>
          </>
        ) : (
          /* Desktop: normal sidebar with fixed width */
          <div style={{ width: (sidebarTab === 'email' || sidebarTab === 'calls' || sidebarTab === 'calendar' || isAdminRoute) ? 68 : 328, minWidth: (sidebarTab === 'email' || sidebarTab === 'calls' || sidebarTab === 'calendar' || isAdminRoute) ? 68 : 328, height: '100%', flexShrink: 0, transition: 'width 0.2s ease, min-width 0.2s ease', overflow: 'hidden' }}>
            <Sidebar />
          </div>
        )}

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {isMeetingRoute ? <Outlet /> : sidebarTab === 'email' && !isAdminRoute ? <EmailWindow /> : sidebarTab === 'calls' && !isAdminRoute ? <CallsWindow /> : sidebarTab === 'calendar' && !isAdminRoute ? <CalendarWindow /> : <Outlet />}
        </main>
      </div>
      {/* Call Overlays */}
      <IncomingCallModal />
      <IncomingGroupCallModal />
      <ActiveCallOverlay />
      <GroupCallOverlay />
    </>
  );
}
