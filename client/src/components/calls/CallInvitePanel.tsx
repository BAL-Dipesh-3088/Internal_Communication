/**
 * CallInvitePanel — Teams-style "Add people to this meeting" panel.
 *
 * Mounted inside <GroupCallOverlay> when the user clicks the "Add" button.
 * Lives in the same right-side slot as <ParticipantsPanel> (mutually exclusive).
 *
 * Flow:
 *   1. User types in the search box
 *   2. Component fetches /api/users?search=<query> (debounced ~250ms)
 *   3. Each result row has an "Invite" button
 *   4. Click → POST /api/calls/group/:callId/invite { userId }
 *   5. Server records the invite + rings the invitee's socket
 *   6. Invitee sees the IncomingGroupCallModal → accepts → joins the call
 *
 * The invitee does NOT need to be a member of the underlying conversation —
 * invitations are per-call passes (matches Teams).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, UserPlus, Check, X, Loader2 } from 'lucide-react';
import api from '@/services/api';
import * as livekitApi from '@/services/livekit';
import { useParticipants } from '@livekit/components-react';

interface Props {
  callId: string;
  /** Called when the user clicks the close (X) button in the panel header. */
  onClose: () => void;
}

interface SearchableUser {
  id: string;
  display_name: string;
  email: string;
  department: string | null;
  designation: string | null;
  avatar_url: string | null;
  status?: string;
}

type InviteState =
  | { status: 'idle' }
  | { status: 'inviting' }
  | { status: 'invited'; at: number }
  | { status: 'error'; message: string };

export default function CallInvitePanel({ callId, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchableUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteStates, setInviteStates] = useState<Record<string, InviteState>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live LiveKit participants — used to disable "Invite" for people already in the call
  const livekitParticipants = useParticipants();
  const inCallIdentities = useMemo(
    () => new Set(livekitParticipants.map((p) => p.identity)),
    [livekitParticipants],
  );

  // Focus the search field as soon as the panel mounts
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search — fetches /api/users with the query, 250ms after typing stops
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      // Empty query — show the first chunk of users (alphabetical) so the panel
      // isn't empty when first opened. Backend default limit is now 1000.
      setLoading(true);
      setError(null);
      api.get('/users')
        .then(({ data }) => {
          setResults(data?.users || []);
          setLoading(false);
        })
        .catch((err) => {
          setError(err?.response?.data?.error || err.message || 'Failed to load users');
          setResults([]);
          setLoading(false);
        });
      return;
    }

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      api.get('/users', { params: { search: trimmed } })
        .then(({ data }) => {
          setResults(data?.users || []);
          setLoading(false);
        })
        .catch((err) => {
          setError(err?.response?.data?.error || err.message || 'Search failed');
          setResults([]);
          setLoading(false);
        });
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleInvite = async (user: SearchableUser) => {
    if (inviteStates[user.id]?.status === 'inviting') return;
    setInviteStates((s) => ({ ...s, [user.id]: { status: 'inviting' } }));

    try {
      await livekitApi.inviteToGroupCall(callId, user.id);
      setInviteStates((s) => ({ ...s, [user.id]: { status: 'invited', at: Date.now() } }));
    } catch (err: any) {
      const msg = err?.response?.data?.error || err.message || 'Invite failed';
      setInviteStates((s) => ({ ...s, [user.id]: { status: 'error', message: msg } }));
    }
  };

  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        background: '#1A1A2E',
        borderLeft: '1px solid #2A2A45',
        display: 'flex',
        flexDirection: 'column',
        color: '#fff',
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
          <UserPlus size={16} />
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Add people</h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Close invite panel"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: 'transparent',
            border: 'none',
            color: '#8B8CA7',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#2A2A45'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#8B8CA7'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Search input */}
      <div style={{ padding: '12px 16px 8px', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#0F0F1F',
            border: '1px solid #2A2A45',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          <Search size={14} color="#8B8CA7" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#fff',
              fontSize: 13,
              fontFamily: 'inherit',
              minWidth: 0,
            }}
          />
          {loading && <Loader2 size={14} color="#8B8CA7" style={{ animation: 'spin 1s linear infinite' }} />}
        </div>
      </div>

      {/* Results list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          padding: '4px 8px 12px',
        }}
      >
        {error && (
          <div style={{ padding: '12px 8px', fontSize: 12, color: '#FECACA' }}>
            {error}
          </div>
        )}

        {!error && !loading && results.length === 0 && query.trim() && (
          <div style={{ padding: '20px 8px', fontSize: 12, color: '#8B8CA7', textAlign: 'center' }}>
            No users match "{query}".
          </div>
        )}

        {results.map((u) => {
          const isInCall = inCallIdentities.has(u.id);
          const state = inviteStates[u.id] || { status: 'idle' as const };

          return (
            <div
              key={u.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 8,
                marginBottom: 2,
                background: 'transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#6264A7',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                  position: 'relative',
                }}
              >
                {u.avatar_url ? (
                  <img
                    src={u.avatar_url}
                    alt=""
                    style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                  />
                ) : (
                  (u.display_name || u.email || '?').charAt(0).toUpperCase()
                )}
                {/* Online status dot */}
                {u.status === 'online' && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: -1,
                      right: -1,
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: '#16A34A',
                      border: '2px solid #1A1A2E',
                    }}
                  />
                )}
              </div>

              {/* Name + email/dept */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {u.display_name || u.email}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: '#8B8CA7',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {u.department || u.email}
                </div>
              </div>

              {/* Action button — reflects current invite state for this user */}
              {isInCall ? (
                <div
                  title="Already in the call"
                  style={{
                    fontSize: 11,
                    color: '#16A34A',
                    fontWeight: 600,
                    padding: '4px 8px',
                    background: 'rgba(22, 163, 74, 0.12)',
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <Check size={11} /> In call
                </div>
              ) : state.status === 'inviting' ? (
                <button
                  disabled
                  style={inviteButtonStyle('#3A3A55', '#8B8CA7', 'wait')}
                >
                  <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Inviting…
                </button>
              ) : state.status === 'invited' ? (
                <div
                  title="Invitation sent"
                  style={{
                    fontSize: 11,
                    color: '#6264A7',
                    fontWeight: 600,
                    padding: '4px 8px',
                    background: 'rgba(98, 100, 167, 0.18)',
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <Check size={11} /> Invited
                </div>
              ) : state.status === 'error' ? (
                <button
                  onClick={() => handleInvite(u)}
                  title={state.message}
                  style={inviteButtonStyle('transparent', '#FECACA', 'pointer', '1px solid #DC2626')}
                >
                  Retry
                </button>
              ) : (
                <button
                  onClick={() => handleInvite(u)}
                  style={inviteButtonStyle('#6264A7', '#fff', 'pointer')}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#7172B3'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#6264A7'; }}
                >
                  <UserPlus size={11} /> Invite
                </button>
              )}
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function inviteButtonStyle(
  bg: string,
  color: string,
  cursor: 'pointer' | 'wait',
  border?: string,
): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 10px',
    borderRadius: 6,
    background: bg,
    color,
    border: border || 'none',
    cursor,
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
    transition: 'background 0.15s',
  };
}
