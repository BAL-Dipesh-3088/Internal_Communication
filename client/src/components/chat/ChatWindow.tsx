import { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Phone, Video, MoreVertical, Search, Users,
  MessageSquare, Shield, X, PhoneCall, UserPlus,
  BellOff, Trash2, Pin, ArrowLeft, Menu,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { useCallStore } from '@/stores/callStore';
import { useUIStore } from '@/stores/uiStore';
import { useWindowSize, BREAKPOINTS } from '@/hooks/useWindowSize';
import { getSocket } from '@/services/socket';
import api from '@/services/api';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import CallDialog from '@/components/calls/CallDialog';
import AddMemberModal from './AddMemberModal';
import ActiveMeetingBanner from '@/components/calls/ActiveMeetingBanner';
import type { Conversation } from '@/types';

export default function ChatWindow() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const {
    conversations,
    activeConversation,
    setActiveConversation,
    fetchMessages,
    messages,
    typingUsers,
    isLoadingMessages,
    hasMoreMessages,
  } = useChatStore();
  const { setSidebarOpen } = useUIStore();
  const { width } = useWindowSize();
  const isMobile = width < BREAKPOINTS.tablet;

  const [showSearch, setShowSearch] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [callNotice, setCallNotice] = useState<string | null>(null);
  const [showCallDialog, setShowCallDialog] = useState(false);
  const [pendingCallType, setPendingCallType] = useState<'audio' | 'video'>('audio');
  const [replyTo, setReplyTo] = useState<import('@/types').Message | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use ref to avoid infinite loop
  const prevConvIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!conversationId) {
      prevConvIdRef.current = undefined;
      return;
    }

    const conv = conversations.find((c) => c.id === conversationId);

    // If conversation not in store yet (just created), fetch it from API
    if (!conv) {
      if (prevConvIdRef.current !== conversationId) {
        prevConvIdRef.current = conversationId;
        api.get(`/conversations/${conversationId}`).then(({ data }) => {
          useChatStore.getState().fetchConversations();
          setActiveConversation(data);
          fetchMessages(conversationId);
        }).catch(() => {});
      }
      return;
    }

    // Load conversation if changed or not yet active
    if (conversationId !== prevConvIdRef.current || !activeConversation) {
      prevConvIdRef.current = conversationId;
      setActiveConversation(conv);
      fetchMessages(conversationId);

      // Fetch full conversation details (includes members array) for group chats
      if (conv.type === 'group' && (!conv.members || conv.members.length === 0)) {
        api.get(`/conversations/${conversationId}`).then(({ data }) => {
          if (data.members) {
            const members = data.members.map((m: any) => ({
              user_id: m.id || m.user_id,
              username: m.username,
              display_name: m.display_name,
              avatar_url: m.avatar_url || null,
              role: m.role,
              status: m.status,
            }));
            useChatStore.getState().updateConversation(conversationId, { members });
            const current = useChatStore.getState().activeConversation;
            if (current && current.id === conversationId) {
              useChatStore.getState().setActiveConversation({ ...current, members });
            }
          }
        }).catch((err) => console.error('Failed to fetch conversation details:', err));
      }

      // Reset panels when switching conversations
      setShowSearch(false);
      setShowMembers(false);
      setShowMore(false);
      setSearchText('');
    }

    return () => {
      setActiveConversation(null);
      prevConvIdRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conversations.length]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  const conv = activeConversation;
  const convMessages = conversationId ? messages[conversationId] || [] : [];
  const typing = conversationId ? typingUsers[conversationId] : undefined;
  const typingArr = typing ? Array.from(typing).filter((u) => u !== user?.username) : [];

  const handleLoadMore = useCallback(() => {
    if (conversationId && convMessages.length > 0 && hasMoreMessages[conversationId]) {
      fetchMessages(conversationId, convMessages[0].created_at);
    }
  }, [conversationId, convMessages, hasMoreMessages, fetchMessages]);

  const handleCall = (type: 'audio' | 'video') => {
    const { isReady } = useCallStore.getState();
    if (!isReady) {
      setCallNotice('Connecting... Please wait.');
      setTimeout(() => setCallNotice(null), 4000);
      return;
    }
    setPendingCallType(type);
    setShowCallDialog(true);
  };

  const handleCallConfirm = (type: 'audio' | 'video') => {
    setShowCallDialog(false);
    if (!conv) return;

    if (conv.type === 'direct') {
      const targetUserId = (conv.other_user as any)?.id;
      if (!targetUserId) {
        setCallNotice('Unable to call this user. Please try again.');
        setTimeout(() => setCallNotice(null), 5000);
        return;
      }
      useCallStore.getState().makeCall(targetUserId, type, conv.other_user?.display_name || conv.other_user?.username, conv.id);
    } else {
      // Group call — backend mints LiveKit token and rings everyone via socket
      const groupName = conv.name || 'Group Call';
      useCallStore.getState().startGroupCall(conv.id, type, groupName).catch((err) => {
        console.error('[ChatWindow] startGroupCall failed:', err);
      });
    }
  };

  if (!conv) {
    return <EmptyState isMobile={isMobile} onOpenSidebar={() => setSidebarOpen(true)} />;
  }

  const name = getConversationDisplayName(conv);
  const isOnline = conv.type === 'direct' && conv.other_user?.status === 'online';

  const handleBack = () => {
    navigate('/');
    setSidebarOpen(true);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'row', height: '100%', background: '#fff' }}>
      {/* Main chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
        {/* Header */}
        <div
          style={{
            height: 56,
            minHeight: 56,
            padding: isMobile ? '0 10px' : '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #EDEBE9',
            background: '#FAFAFA',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 12, minWidth: 0 }}>
            {/* Mobile back button */}
            {isMobile && (
              <button
                onClick={handleBack}
                style={{
                  padding: 6, borderRadius: 6, background: 'none', border: 'none',
                  cursor: 'pointer', color: '#605E5C', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <ChatAvatar conversation={conv} />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#242424', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </h3>
              {conv.type === 'group' && conv.member_count && (
                <p style={{ fontSize: 12, color: '#605E5C', margin: 0 }}>{conv.member_count} members</p>
              )}
              {conv.type === 'direct' && conv.other_user && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: isOnline ? '#6BB700' : '#8A8886',
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#605E5C', textTransform: 'capitalize' }}>
                    {conv.other_user.status || 'offline'}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <HeaderButton icon={<Phone size={18} />} title="Audio call" onClick={() => handleCall('audio')} />
            <HeaderButton icon={<Video size={18} />} title="Video call" onClick={() => handleCall('video')} />
            <HeaderButton
              icon={<Search size={18} />}
              title="Search in conversation"
              active={showSearch}
              onClick={() => { setShowSearch(!showSearch); setShowMembers(false); setShowMore(false); }}
            />
            {conv.type === 'group' && (
              <HeaderButton
                icon={<Users size={18} />}
                title="Members"
                active={showMembers}
                onClick={() => { setShowMembers(!showMembers); setShowSearch(false); setShowMore(false); }}
              />
            )}
            <HeaderButton
              icon={<MoreVertical size={18} />}
              title="More options"
              active={showMore}
              onClick={() => { setShowMore(!showMore); setShowSearch(false); setShowMembers(false); }}
            />
          </div>
        </div>

        {/* Call notice */}
        {callNotice && (
          <div
            style={{
              padding: '10px 20px',
              background: '#FFF4CE',
              borderBottom: '1px solid #F3D06B',
              fontSize: 13,
              color: '#6B5900',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <PhoneCall size={16} color="#986F0B" />
            <span style={{ flex: 1 }}>{callNotice}</span>
            <button
              onClick={() => setCallNotice(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#986F0B', padding: 2 }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Search bar */}
        {showSearch && (
          <div
            style={{
              padding: '10px 20px',
              borderBottom: '1px solid #EDEBE9',
              background: '#FAFAFA',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <Search size={16} color="#A19F9D" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search messages in this conversation..."
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
                color: '#242424',
                fontFamily: 'inherit',
              }}
            />
            {searchText && (
              <span style={{ fontSize: 12, color: '#A19F9D' }}>
                {convMessages.filter((m) => m.content.toLowerCase().includes(searchText.toLowerCase())).length} results
              </span>
            )}
            <button
              onClick={() => { setShowSearch(false); setSearchText(''); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#605E5C', padding: 4, display: 'flex' }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Active meeting banner — appears when a group call is in progress in
            this conversation. Rendered for ALL conversation types (not just
            'group') because a 1:1 call escalated with "Add people" becomes a
            group call inside a DIRECT conversation — the person who left must
            still see the Join banner. The banner self-hides when no call is active. */}
        {conversationId && <ActiveMeetingBanner conversationId={conversationId} />}

        {/* Messages */}
        <MessageList
          messages={searchText
            ? convMessages.filter((m) => m.content.toLowerCase().includes(searchText.toLowerCase()))
            : convMessages
          }
          isLoading={isLoadingMessages}
          hasMore={!searchText && (hasMoreMessages[conversationId!] ?? false)}
          onLoadMore={handleLoadMore}
          currentUserId={user?.id}
          onReply={(msg) => setReplyTo(msg)}
        />

        {/* Typing Indicator */}
        {typingArr.length > 0 && (
          <div style={{ padding: '6px 20px', fontSize: 12, color: '#605E5C', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'flex', gap: 3 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#6264A7', animation: 'typingBounce 1.4s infinite ease-in-out', animationDelay: '0ms' }} />
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#6264A7', animation: 'typingBounce 1.4s infinite ease-in-out', animationDelay: '200ms' }} />
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#6264A7', animation: 'typingBounce 1.4s infinite ease-in-out', animationDelay: '400ms' }} />
            </span>
            {typingArr.length === 1
              ? `${typingArr[0]} is typing...`
              : `${typingArr.join(', ')} are typing...`}
            <style>{`@keyframes typingBounce { 0%, 80%, 100% { transform: scale(0); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }`}</style>
          </div>
        )}

        {/* Input */}
        <MessageInput conversationId={conversationId!} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
      </div>

      {/* Members side panel — overlay on mobile, inline on desktop */}
      {showMembers && conv.type === 'group' && !isMobile && (
        <MembersPanel conversation={conv} onClose={() => setShowMembers(false)} />
      )}
      {showMembers && conv.type === 'group' && isMobile && (
        <>
          <div onClick={() => setShowMembers(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 80 }} />
          <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: Math.min(300, width - 48), zIndex: 90, boxShadow: '-4px 0 24px rgba(0,0,0,0.15)' }}>
            <MembersPanel conversation={conv} onClose={() => setShowMembers(false)} />
          </div>
        </>
      )}

      {/* More options dropdown */}
      {showMore && (
        <MoreOptionsPanel conversation={conv} onClose={() => setShowMore(false)} />
      )}

      {/* Call confirmation dialog */}
      {showCallDialog && conv && (
        <CallDialog
          conversation={conv}
          initialCallType={pendingCallType}
          onConfirm={handleCallConfirm}
          onClose={() => setShowCallDialog(false)}
        />
      )}
    </div>
  );
}

/* ============ Members Side Panel ============ */
function MembersPanel({ conversation: conv, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const { updateConversation, fetchConversations } = useChatStore();

  const handleMembersAdded = (members: any[], memberCount: number) => {
    // Update the active conversation's member list in real time
    updateConversation(conv.id, {
      members: members.map((m: any) => ({
        user_id: m.user_id,
        username: m.username,
        display_name: m.display_name,
        avatar_url: m.avatar_url,
        role: m.role,
        status: m.status,
      })),
      member_count: memberCount,
    });
    // Also refresh conversations list to get updated member counts
    fetchConversations();
  };

  return (
    <div
      style={{
        width: 280,
        minWidth: 280,
        borderLeft: '1px solid #EDEBE9',
        background: '#FAFAFA',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 56,
          minHeight: 56,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid #EDEBE9',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: '#242424' }}>
          Members ({conv.member_count || conv.members?.length || 0})
        </span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#605E5C', padding: 4, borderRadius: 4, display: 'flex' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#EDEBE9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Add member button — only for group conversations */}
      {conv.type === 'group' && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #EDEBE9' }}>
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px dashed #C8C6C4',
              background: 'transparent',
              cursor: 'pointer',
              color: '#6264A7',
              fontSize: 13,
              fontWeight: 500,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F0F0FA'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <UserPlus size={16} />
            Add member
          </button>
        </div>
      )}

      {/* Members list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {conv.members && conv.members.length > 0 ? (
          conv.members.map((member) => (
            <div
              key={member.user_id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 16px',
                cursor: 'default',
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#5B5FC7',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {member.display_name?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#242424', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {member.display_name}
                </div>
                <div style={{ fontSize: 11, color: '#A19F9D' }}>
                  {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'}
                  {member.status === 'online' && (
                    <span style={{ color: '#6BB700', marginLeft: 6 }}> Online</span>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: '#A19F9D', fontSize: 13 }}>
            {conv.member_count || 0} members in this group
          </div>
        )}
      </div>

      {/* Add Member Modal */}
      {showAddModal && (
        <AddMemberModal
          conversation={conv}
          onClose={() => setShowAddModal(false)}
          onMembersAdded={handleMembersAdded}
        />
      )}
    </div>
  );
}

/* ============ More Options Panel ============ */
function MoreOptionsPanel({ conversation: conv, onClose }: { conversation: Conversation; onClose: () => void }) {
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 40,
        }}
      />
      {/* Dropdown */}
      <div
        style={{
          position: 'absolute',
          top: 52,
          right: 20,
          width: 220,
          background: '#fff',
          borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
          border: '1px solid #EDEBE9',
          zIndex: 50,
          padding: '4px 0',
        }}
      >
        <MoreOption icon={<Pin size={16} />} label="Pin conversation" onClick={onClose} />
        <MoreOption icon={<BellOff size={16} />} label="Mute notifications" onClick={onClose} />
        <div style={{ height: 1, background: '#EDEBE9', margin: '4px 0' }} />
        <MoreOption icon={<Trash2 size={16} />} label="Delete conversation" danger onClick={onClose} />
      </div>
    </>
  );
}

function MoreOption({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        color: danger ? '#D13438' : '#242424',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? '#FDE7E9' : '#F5F5F5'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ color: danger ? '#D13438' : '#605E5C', display: 'flex' }}>{icon}</span>
      {label}
    </button>
  );
}

/* ============ Header Button ============ */
function HeaderButton({ icon, title, active, onClick }: { icon: React.ReactNode; title: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: 8,
        borderRadius: 6,
        background: active ? '#EDEBE9' : 'none',
        border: 'none',
        cursor: 'pointer',
        color: active ? '#6264A7' : '#605E5C',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = '#EDEBE9';
          e.currentTarget.style.color = '#242424';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'none';
          e.currentTarget.style.color = '#605E5C';
        }
      }}
    >
      {icon}
    </button>
  );
}

/* ============ Empty State ============ */
function EmptyState({ isMobile, onOpenSidebar }: { isMobile: boolean; onOpenSidebar: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#FAFAFA', position: 'relative' }}>
      {/* Mobile hamburger */}
      {isMobile && (
        <button
          onClick={onOpenSidebar}
          style={{
            position: 'absolute', top: 14, left: 14,
            padding: 8, borderRadius: 8, background: '#fff', border: '1px solid #EDEBE9',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
        >
          <Menu size={20} color="#605E5C" />
        </button>
      )}
      <div style={{ textAlign: 'center', maxWidth: 400, padding: '0 24px' }}>
        <div
          style={{
            width: isMobile ? 64 : 80, height: isMobile ? 64 : 80, borderRadius: isMobile ? 16 : 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
            background: 'linear-gradient(135deg, #6264A7, #5B5FC7)',
            boxShadow: '0 8px 24px rgba(98, 100, 167, 0.25)',
          }}
        >
          <MessageSquare size={isMobile ? 28 : 36} color="#fff" />
        </div>
        <h2 style={{ fontSize: isMobile ? 18 : 22, fontWeight: 700, color: '#242424', margin: '0 0 8px' }}>Welcome to BAL Connect</h2>
        <p style={{ fontSize: isMobile ? 13 : 14, color: '#605E5C', lineHeight: 1.6, margin: '0 0 20px' }}>
          {isMobile
            ? 'Tap the menu to open your conversations.'
            : 'Select a conversation from the sidebar or start a new chat to begin messaging with your team.'}
        </p>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, fontSize: 12, color: '#A19F9D' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Shield size={14} />
              <span>Secure messaging</span>
            </div>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#C8C6C4' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={14} />
              <span>300+ employees</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ Chat Avatar ============ */
function ChatAvatar({ conversation: conv }: { conversation: Conversation }) {
  const isGroup = conv.type === 'group';
  const avatar = isGroup ? conv.avatar_url : conv.other_user?.avatar_url;
  const name = getConversationDisplayName(conv);
  const initial = name[0]?.toUpperCase() || '?';

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {avatar ? (
        <img src={avatar} alt={name} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <div
          style={{
            width: 36, height: 36, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 14, fontWeight: 600,
            background: isGroup ? '#0078D4' : '#5B5FC7',
          }}
        >
          {isGroup ? <Users size={16} /> : initial}
        </div>
      )}
      {conv.type === 'direct' && conv.other_user?.status === 'online' && (
        <div
          style={{
            position: 'absolute', bottom: -1, right: -1,
            width: 10, height: 10, borderRadius: '50%',
            background: '#6BB700', border: '2px solid #FAFAFA',
          }}
        />
      )}
    </div>
  );
}

function getConversationDisplayName(conv: Conversation): string {
  if (conv.type === 'direct' && conv.other_user) {
    return conv.other_user.display_name || conv.other_user.username;
  }
  return conv.name || 'Unnamed Group';
}
