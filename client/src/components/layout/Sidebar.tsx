import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  MessageSquare,
  Users,
  Phone,
  Calendar,
  Mail,
  Settings,
  LogOut,
  Plus,
  Search,
  Shield,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { useMailStore } from '@/stores/mailStore';
import { useUIStore } from '@/stores/uiStore';
import ConversationList from '../chat/ConversationList';
import CreateConversationModal from '../chat/CreateConversationModal';
import ContactsList from '../contacts/ContactsList';
import CallHistory from '../calls/CallHistory';
import SettingsModal from '../settings/SettingsModal';

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { conversations } = useChatStore();
  const { createGroupOpen, setCreateGroupOpen, sidebarTab, setSidebarTab } = useUIStore();
  const activeTab = sidebarTab;
  const setActiveTab = setSidebarTab;
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const totalUnread = conversations.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);
  const mailUnread = useMailStore((s) => s.unreadCount);
  const isAdmin = location.pathname === '/admin';

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <>
      {/* Sidebar container — all layout via inline styles */}
      <aside
        style={{
          width: '100%',
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'row',
          flexShrink: 0,
          borderRight: '1px solid #E0E0E0',
          background: '#FFFFFF',
        }}
      >
        {/* Icon Rail */}
        <div
          style={{
            width: 68,
            minWidth: 68,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '12px 0',
            background: '#292A3E',
            flexShrink: 0,
          }}
        >
          {/* Logo */}
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#5B5FC7',
              marginBottom: 24,
            }}
          >
            <MessageSquare size={20} color="#fff" />
          </div>

          {/* Nav Tabs */}
          <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <NavButton
              icon={<MessageSquare size={20} />}
              active={activeTab === 'chat' && !isAdmin}
              onClick={() => { setActiveTab('chat'); setSearchQuery(''); if (isAdmin) navigate('/'); }}
              badge={totalUnread}
              label="Chat"
            />
            <NavButton
              icon={<Users size={20} />}
              active={activeTab === 'contacts' && !isAdmin}
              onClick={() => { setActiveTab('contacts'); setSearchQuery(''); if (isAdmin) navigate('/'); }}
              label="Contacts"
            />
            <NavButton
              icon={<Phone size={20} />}
              active={activeTab === 'calls' && !isAdmin}
              onClick={() => { setActiveTab('calls'); setSearchQuery(''); if (isAdmin) navigate('/'); }}
              label="Calls"
            />
            <NavButton
              icon={<Calendar size={20} />}
              active={activeTab === 'calendar' && !isAdmin}
              onClick={() => { setActiveTab('calendar'); setSearchQuery(''); if (isAdmin) navigate('/'); }}
              label="Calendar"
            />
            <NavButton
              icon={<Mail size={20} />}
              active={activeTab === 'email' && !isAdmin}
              onClick={() => { setActiveTab('email'); setSearchQuery(''); if (isAdmin) navigate('/'); }}
              badge={mailUnread}
              label="Email"
            />
            {user?.role === 'admin' && (
              <NavButton
                icon={<Shield size={20} />}
                active={isAdmin}
                onClick={() => navigate('/admin')}
                label="Admin"
              />
            )}
          </nav>

          {/* Bottom Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, marginTop: 'auto' }}>
            <NavButton
              icon={<Settings size={20} />}
              active={false}
              onClick={() => setShowSettings(true)}
              label="Settings"
            />
            <NavButton
              icon={<LogOut size={20} />}
              active={false}
              onClick={handleLogout}
              label="Logout"
            />
            {/* User Avatar */}
            <div style={{ marginTop: 12, position: 'relative' }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: '#5B5FC7',
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                {user?.display_name?.[0]?.toUpperCase() || 'U'}
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  right: 0,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: '#6BB700',
                  border: '2px solid #292A3E',
                }}
              />
            </div>
          </div>
        </div>

        {/* Panel — hidden when email, calls, or admin route is active (icon rail only) */}
        <div
          style={{
            flex: 1,
            display: (activeTab === 'email' || activeTab === 'calls' || activeTab === 'calendar' || isAdmin) ? 'none' : 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: '#FFFFFF',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #E0E0E0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#242424', margin: 0 }}>
                {activeTab === 'chat' ? 'Chat' : activeTab === 'contacts' ? 'Contacts' : activeTab === 'calls' ? 'Calls' : 'Email'}
              </h2>
              {activeTab === 'chat' && (
                <button
                  onClick={() => setCreateGroupOpen(true)}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: '#616161',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="New conversation"
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#F0F0F0'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Plus size={18} />
                </button>
              )}
            </div>
            {/* Search bar for Chat and Contacts tabs */}
            {(activeTab === 'chat' || activeTab === 'contacts') && (
              <div style={{ position: 'relative' }}>
                <Search
                  size={14}
                  style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#A0A0A0' }}
                />
                <input
                  type="text"
                  placeholder={activeTab === 'chat' ? 'Search conversations...' : 'Search contacts...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    paddingLeft: 32,
                    paddingRight: 12,
                    paddingTop: 6,
                    paddingBottom: 6,
                    background: '#F5F5F5',
                    borderRadius: 6,
                    fontSize: 13,
                    border: '1px solid transparent',
                    outline: 'none',
                    color: '#242424',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  }}
                  onFocus={(e) => {
                    e.target.style.background = '#FFFFFF';
                    e.target.style.borderColor = 'rgba(98,100,167,0.3)';
                    e.target.style.boxShadow = '0 0 0 2px rgba(98,100,167,0.15)';
                  }}
                  onBlur={(e) => {
                    e.target.style.background = '#F5F5F5';
                    e.target.style.borderColor = 'transparent';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {activeTab === 'chat' && <ConversationList searchQuery={searchQuery} />}
            {activeTab === 'contacts' && <ContactsList searchQuery={searchQuery} />}
            {activeTab === 'calls' && <CallHistory />}
          </div>
        </div>
      </aside>

      {/* Create Conversation Modal */}
      {createGroupOpen && (
        <CreateConversationModal onClose={() => setCreateGroupOpen(false)} />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

function NavButton({
  icon,
  active,
  onClick,
  badge,
  label,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        position: 'relative',
        width: 56,
        height: 52,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        transition: 'all 0.15s',
        background: active ? '#5B5FC7' : 'transparent',
        color: active ? '#FFFFFF' : '#B8B9D0',
        padding: 0,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = '#3D3D56';
          e.currentTarget.style.color = '#FFFFFF';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#B8B9D0';
        }
      }}
    >
      {icon}
      <span style={{ fontSize: 9, fontWeight: 500, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 54 }}>{label}</span>
      {badge && badge > 0 ? (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 18,
            height: 18,
            background: '#D13438',
            color: '#FFFFFF',
            fontSize: 10,
            fontWeight: 700,
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
          }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}
