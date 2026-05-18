/**
 * MeetingJoinPage — the "preview + click to join" page reached by sharing the
 * meeting link (https://<app>/meeting/<callId>).
 *
 * UX matches Microsoft Teams' meeting join page:
 *   - Show meeting title (or default "Group video call"), host name,
 *     participant count, started-at time
 *   - "Join now" button → uses existing /api/calls/group/:callId/join → enters
 *     the LiveKit room via the same callStore flow as banner late-join
 *   - "Meeting has ended" state if the backend reconciles the call as ended
 *
 * Authorization: any authenticated BAL Connect user with the link can join.
 * The callId is a UUID — unguessable — so the link itself acts as the
 * shared-secret. Once they join they're added to call_history.participants
 * for audit.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Video, Phone, Users, Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import * as livekitApi from '@/services/livekit';
import { useCallStore } from '@/stores/callStore';
import { useAuthStore } from '@/stores/authStore';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; info: livekitApi.MeetingInfo }
  | { kind: 'ended' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

export default function MeetingJoinPage() {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const groupCall = useCallStore((s) => s.groupCall);
  const acceptGroupInvite = useCallStore((s) => s.acceptGroupInvite);
  const setActiveGroupCall = useCallStore((s) => s.setActiveGroupCall);

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);

  // ─── Fetch meeting info on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!callId) {
      setPhase({ kind: 'not-found' });
      return;
    }

    let cancelled = false;
    livekitApi.getMeetingInfo(callId)
      .then((info) => {
        if (cancelled) return;
        if (info.status === 'ended') {
          setPhase({ kind: 'ended' });
          return;
        }
        // Seed callStore's activeGroupCalls so acceptGroupInvite has the context it needs
        setActiveGroupCall({
          callId: info.callId,
          conversationId: info.conversationId || '',
          callType: info.callType,
          hostId: info.hostId,
          hostName: info.hostName,
          roomName: '',  // resolved when /join returns
          startedAt: info.startedAt,
        });
        setPhase({ kind: 'ready', info });
      })
      .catch((err: any) => {
        if (cancelled) return;
        const status = err?.response?.status;
        const message = err?.response?.data?.error || err.message || 'Failed to load meeting';
        if (status === 404) setPhase({ kind: 'not-found' });
        else setPhase({ kind: 'error', message });
      });

    return () => { cancelled = true; };
  }, [callId, setActiveGroupCall]);

  // ─── If user is ALREADY in this call, redirect home (GroupCallOverlay shows over the layout) ──
  useEffect(() => {
    if (groupCall?.callId === callId) {
      navigate('/', { replace: true });
    }
  }, [groupCall?.callId, callId, navigate]);

  const handleJoin = async () => {
    if (!callId || joining) return;
    setJoining(true);
    try {
      await acceptGroupInvite(callId);
      // Once joined, GroupCallOverlay (mounted globally in AppLayout) takes over.
      // Navigate home so the URL doesn't stay on /meeting/... after the call ends.
      navigate('/', { replace: true });
    } catch (err: any) {
      const message = err?.response?.data?.error || err.message || 'Failed to join';
      setPhase({ kind: 'error', message });
      setJoining(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0F0F1F',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 460,
          background: '#1A1A2E',
          border: '1px solid #2A2A45',
          borderRadius: 16,
          padding: 32,
          color: '#fff',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        }}
      >
        <button
          onClick={() => navigate('/', { replace: true })}
          style={{
            background: 'transparent', border: 'none', color: '#8B8CA7',
            fontSize: 13, fontFamily: 'inherit', display: 'flex', alignItems: 'center',
            gap: 6, cursor: 'pointer', padding: 0, marginBottom: 20,
          }}
        >
          <ArrowLeft size={14} /> Back to BAL Connect
        </button>

        {phase.kind === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Loader2 size={32} style={{ color: '#6264A7', animation: 'spin 1s linear infinite' }} />
            <p style={{ marginTop: 16, color: '#8B8CA7', fontSize: 13 }}>Loading meeting…</p>
          </div>
        )}

        {phase.kind === 'not-found' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <AlertCircle size={40} color="#DC2626" />
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 16, marginBottom: 8 }}>Meeting not found</h2>
            <p style={{ color: '#8B8CA7', fontSize: 13, lineHeight: 1.5 }}>
              The meeting link is invalid or the meeting has been deleted.
            </p>
          </div>
        )}

        {phase.kind === 'ended' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <Phone size={40} color="#8B8CA7" />
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 16, marginBottom: 8 }}>Meeting has ended</h2>
            <p style={{ color: '#8B8CA7', fontSize: 13, lineHeight: 1.5 }}>
              This meeting is no longer active.
            </p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <AlertCircle size={40} color="#DC2626" />
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 16, marginBottom: 8 }}>Couldn't join</h2>
            <p style={{ color: '#FECACA', fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' }}>
              {phase.message}
            </p>
          </div>
        )}

        {phase.kind === 'ready' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
              <div
                style={{
                  width: 52, height: 52, borderRadius: 14,
                  background: 'linear-gradient(135deg, #6264A7 0%, #7172B3 100%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {phase.info.callType === 'video' ? <Video size={26} /> : <Phone size={26} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
                  {phase.info.title || (phase.info.callType === 'video' ? 'Group video call' : 'Group audio call')}
                </h1>
                <p style={{ fontSize: 12, color: '#8B8CA7', margin: '4px 0 0' }}>
                  Hosted by <strong style={{ color: '#fff', fontWeight: 600 }}>{phase.info.hostName}</strong>
                </p>
              </div>
            </div>

            {/* Stats row */}
            <div
              style={{
                display: 'flex',
                gap: 20,
                padding: '12px 16px',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 10,
                marginBottom: 24,
                fontSize: 12,
                color: '#A5A7F0',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Users size={13} /> {phase.info.participantCount} in meeting
              </span>
              <span style={{ color: '#8B8CA7' }}>·</span>
              <span style={{ color: '#8B8CA7' }}>
                Started {formatRelativeTime(phase.info.startedAt)}
              </span>
            </div>

            {user && (
              <div style={{ fontSize: 12, color: '#8B8CA7', marginBottom: 16, textAlign: 'center' }}>
                Joining as <strong style={{ color: '#fff', fontWeight: 600 }}>{user.display_name || user.username}</strong>
              </div>
            )}

            <button
              onClick={handleJoin}
              disabled={joining}
              style={{
                width: '100%',
                padding: '14px',
                borderRadius: 10,
                background: joining ? '#3A3A55' : '#6264A7',
                color: '#fff',
                border: 'none',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor: joining ? 'wait' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { if (!joining) e.currentTarget.style.background = '#7172B3'; }}
              onMouseLeave={(e) => { if (!joining) e.currentTarget.style.background = '#6264A7'; }}
            >
              {joining ? (
                <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Joining…</>
              ) : (
                <>{phase.info.callType === 'video' ? <Video size={16} /> : <Phone size={16} />} Join now</>
              )}
            </button>
          </>
        )}

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  const hours = Math.floor(diffSec / 3600);
  return `${hours}h ${Math.floor((diffSec % 3600) / 60)}m ago`;
}
