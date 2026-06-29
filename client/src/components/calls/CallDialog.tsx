import { useState } from 'react';
import { Phone, Video, X, Users, FileText, Check } from 'lucide-react';
import type { Conversation } from '@/types';

const AVATAR_COLORS = [
  '#6264A7', '#0078D4', '#038387', '#8764B8',
  '#CA5010', '#498205', '#DA3B01', '#005B70',
  '#C239B3', '#69797E', '#7A7574', '#0099BC',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const STATUS_COLORS: Record<string, string> = {
  online: '#16A34A',
  away: '#D97706',
  busy: '#DC2626',
  dnd: '#DC2626',
  offline: '#C0C1D4',
};

interface Props {
  conversation: Conversation;
  initialCallType: 'audio' | 'video';
  onConfirm: (type: 'audio' | 'video', transcribe: boolean) => void;
  onClose: () => void;
}

export default function CallDialog({ conversation: conv, initialCallType, onConfirm, onClose }: Props) {
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  // AI meeting notes — opt-in by the meeting starter (group meetings only).
  const [transcribe, setTranscribe] = useState(false);

  const isDirect = conv.type === 'direct';
  const otherUser = conv.other_user;
  const displayName = isDirect
    ? (otherUser?.display_name || otherUser?.username || 'Unknown')
    : (conv.name || 'Group');
  const initial = displayName[0]?.toUpperCase() || '?';
  const avatarColor = getAvatarColor(displayName);
  const status = isDirect ? (otherUser?.status || 'offline') : null;
  const statusColor = status ? (STATUS_COLORS[status] || STATUS_COLORS.offline) : null;

  const canCall = true;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#FFFFFF',
          borderRadius: 20,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)',
          padding: '36px 32px 32px',
          textAlign: 'center',
          maxWidth: 380, width: '100%',
          position: 'relative',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 14, right: 14,
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#A19F9D', padding: 4, borderRadius: 6, display: 'flex',
            transition: 'color 0.12s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#605E5C'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#A19F9D'; }}
        >
          <X size={18} />
        </button>

        {/* Avatar */}
        <div style={{ position: 'relative', display: 'inline-block', marginBottom: 16 }}>
          <div
            style={{
              width: 80, height: 80, borderRadius: '50%',
              background: isDirect ? avatarColor : 'linear-gradient(135deg, #6264A7, #5B5FC7)',
              color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: isDirect ? 30 : 0, fontWeight: 700,
              boxShadow: `0 4px 20px ${isDirect ? avatarColor : 'rgba(98,100,167,0.3)'}40`,
            }}
          >
            {isDirect ? initial : <Users size={32} />}
          </div>
          {/* Status dot for direct */}
          {statusColor && (
            <div
              style={{
                position: 'absolute', bottom: 2, right: 2,
                width: 14, height: 14, borderRadius: '50%',
                background: statusColor, border: '3px solid #fff',
              }}
            />
          )}
        </div>

        {/* Name */}
        <h3 style={{ fontSize: 20, fontWeight: 600, color: '#1A1A2E', margin: '0 0 4px 0' }}>
          {displayName}
        </h3>

        {/* Subtitle */}
        {isDirect ? (
          <p style={{ fontSize: 13, color: '#8B8CA7', margin: '0 0 4px 0' }}>
            {status && status.charAt(0).toUpperCase() + status.slice(1)}
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#8B8CA7', margin: '0 0 4px 0' }}>
            {conv.member_count || conv.members?.length || 0} members
          </p>
        )}

        {/* Call type label */}
        <p style={{ fontSize: 14, color: '#605E5C', margin: '0 0 20px 0' }}>
          {isDirect ? 'Start a call' : 'Start a group call'}
        </p>

        {/* Group call notice */}
        {!isDirect && canCall && (
          <div
            style={{
              padding: '8px 14px', marginBottom: 16,
              background: '#F0F0FA', borderRadius: 8,
              fontSize: 12, color: '#6264A7',
            }}
          >
            All group members will be notified when the call starts
          </div>
        )}

        {/* AI meeting-notes opt-in — group meetings only */}
        {!isDirect && canCall && (
          <button
            onClick={() => setTranscribe((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 14px', marginBottom: 18, textAlign: 'left',
              background: transcribe ? '#F3F2FA' : '#FAFAFC',
              border: `1px solid ${transcribe ? '#6264A7' : '#E1DFDD'}`,
              borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              transition: 'all 0.12s',
            }}
          >
            <span
              style={{
                width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                border: `1.5px solid ${transcribe ? '#6264A7' : '#C8C6C4'}`,
                background: transcribe ? '#6264A7' : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {transcribe && <Check size={14} color="#fff" />}
            </span>
            <FileText size={16} color="#6264A7" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#242424' }}>
                Record AI meeting notes
              </span>
              <span style={{ display: 'block', fontSize: 11, color: '#8B8CA7', marginTop: 1 }}>
                Transcript, summary & action items emailed to attendees afterward
              </span>
            </span>
          </button>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          {/* Audio Call */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => canCall && onConfirm('audio', transcribe)}
              disabled={!canCall}
              onMouseEnter={() => setHoveredBtn('audio')}
              onMouseLeave={() => setHoveredBtn(null)}
              style={{
                width: 56, height: 56, borderRadius: '50%',
                background: !canCall ? '#E0E0E0' : hoveredBtn === 'audio' ? '#5AA400' : '#6BB700',
                color: !canCall ? '#A0A0A0' : '#fff',
                border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: canCall ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
                boxShadow: canCall ? '0 4px 16px rgba(107,183,0,0.35)' : 'none',
                transform: hoveredBtn === 'audio' && canCall ? 'scale(1.08)' : 'scale(1)',
              }}
            >
              <Phone size={24} />
            </button>
            <span style={{ fontSize: 12, color: '#605E5C', fontWeight: 500 }}>Audio Call</span>
          </div>

          {/* Video Call */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => canCall && onConfirm('video', transcribe)}
              disabled={!canCall}
              onMouseEnter={() => setHoveredBtn('video')}
              onMouseLeave={() => setHoveredBtn(null)}
              style={{
                width: 56, height: 56, borderRadius: '50%',
                background: !canCall ? '#E0E0E0' : hoveredBtn === 'video' ? '#0074CC' : '#0078D4',
                color: !canCall ? '#A0A0A0' : '#fff',
                border: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: canCall ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
                boxShadow: canCall ? '0 4px 16px rgba(0,120,212,0.35)' : 'none',
                transform: hoveredBtn === 'video' && canCall ? 'scale(1.08)' : 'scale(1)',
              }}
            >
              <Video size={24} />
            </button>
            <span style={{ fontSize: 12, color: '#605E5C', fontWeight: 500 }}>Video Call</span>
          </div>
        </div>

        {/* Cancel link */}
        <button
          onClick={onClose}
          onMouseEnter={() => setHoveredBtn('cancel')}
          onMouseLeave={() => setHoveredBtn(null)}
          style={{
            marginTop: 20, background: 'none', border: 'none',
            color: hoveredBtn === 'cancel' ? '#605E5C' : '#A19F9D',
            fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            transition: 'color 0.12s',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
