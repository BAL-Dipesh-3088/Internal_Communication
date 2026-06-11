/**
 * GroupCallOverlay — Teams/Meet-style group call UI backed by LiveKit SFU.
 *
 * Renders only when `callStore.groupCall.isActive && groupCall.livekitToken` is set.
 * Hands media routing entirely to LiveKit's React SDK (`<LiveKitRoom>`) — we keep
 * the BAL Connect look (purple theme, Lucide icons) but reuse the battle-tested
 * SFU primitives for grid layout, mute toggles, active speaker, screen share.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LiveKitRoom,
  GridLayout,
  ControlBar,
  useTracks,
  useParticipants,
  useLocalParticipant,
  useRoomInfo,
  RoomAudioRenderer,
  ConnectionStateToast,
} from '@livekit/components-react';
import { Track, RoomEvent, type DisconnectReason } from 'livekit-client';
import '@livekit/components-styles';
import {
  PhoneOff, Users, Minimize2, Maximize2, UserPlus, MessageSquare, Hand,
  Pencil, Check, X as XIcon, Link2, ScreenShare,
} from 'lucide-react';
import { useCallStore } from '@/stores/callStore';
import * as livekitApi from '@/services/livekit';
import CallInvitePanel from './CallInvitePanel';
import CallChatPanel from './CallChatPanel';
import ReactionsLayer from './ReactionsLayer';
import ReactionsBar from './ReactionsBar';
import RaiseHandButton from './RaiseHandButton';
import ParticipantTileWithHand from './ParticipantTileWithHand';
import { PinContext } from './PinContext';

export default function GroupCallOverlay() {
  const { groupCall, endGroupCall } = useCallStore();

  // Only mount when we have a token (i.e. we're actually in a LiveKit room)
  if (!groupCall?.isActive || !groupCall.livekitToken || !groupCall.livekitWsUrl) {
    return null;
  }

  return (
    <LiveKitRoom
      serverUrl={groupCall.livekitWsUrl}
      token={groupCall.livekitToken}
      connect={true}
      video={groupCall.callType === 'video'}
      audio={true}
      onDisconnected={(reason?: DisconnectReason) => {
        console.log('[LiveKit] Disconnected:', reason);
        endGroupCall();
      }}
      onError={(err) => {
        console.error('[LiveKit] Connection error:', err);
      }}
      // ─── Bandwidth + CPU optimisations (enterprise pattern, Teams/Meet-style) ───
      // All four optimisation knobs live inside `options` (which becomes
      // LiveKit's RoomOptions). They are NOT top-level props on <LiveKitRoom>
      // — passing them at the top level would leak to the underlying DOM
      // element and trigger React warnings (which is what happened first try).
      options={{
        // adaptiveStream: each subscriber automatically asks the SFU for the
        // simulcast layer that matches the on-screen tile size. A 200px
        // sidebar thumbnail gets the LOW layer; the spotlight gets HIGH.
        // Quality looks identical while subscriber bandwidth drops ~50% in
        // any multi-tile call.
        adaptiveStream: true,
        // dynacast: the SFU stops forwarding simulcast layers nobody is
        // currently watching. If everyone has User A as a tiny tile, the
        // mid/high layers aren't sent over the wire at all — saves both
        // server and publisher bandwidth.
        dynacast: true,
        // Camera capture cap. 720p is enough for every tile size we render
        // and saves publisher CPU vs the default of "as high as your webcam
        // can give us".
        videoCaptureDefaults: {
          resolution: { width: 1280, height: 720, frameRate: 30 },
        },
        publishDefaults: {
          // Simulcast publishes 3 quality layers (h180/h360/h720 by default).
          // The SFU picks per subscriber. Slight publisher CPU bump in
          // exchange for huge subscriber-side bandwidth and CPU savings.
          simulcast: true,
          // H.264 has hardware decode support on every Intel/AMD/Apple CPU
          // from the last decade. Replacing VP9 (software-decoded, heavy)
          // typically halves subscriber CPU in 5+ person calls. Quality is
          // unchanged at our resolutions.
          videoCodec: 'h264',
        },
      }}
      // `display: contents` makes this wrapper generate NO box of its own — its
      // children render as if they were direct children of the parent. Two wins:
      //   1. It reserves NO layout space, so the dark theme background can't paint
      //      a full 100vh block that shows when the call is minimized (the
      //      original black-screen bug).
      //   2. It creates NO stacking context, so the expanded overlay's z-index:9999
      //      stays effective in the ROOT context and floats above the chat window.
      //      (position:fixed here would TRAP that z-index inside the wrapper and
      //      let the chat bleed over the call.)
      // Both visible UI states (expanded overlay + minimized pill) are themselves
      // position:fixed, so they don't need this wrapper to be sized.
      style={{ display: 'contents' }}
      data-lk-theme="default"
    >
      <RoomAudioRenderer />
      <ConnectionStateToast />
      <GroupCallContent />
    </LiveKitRoom>
  );
}

function GroupCallContent() {
  const { groupCall, leaveGroupCall, endGroupCallForAll } = useCallStore();
  const [isExpanded, setIsExpanded] = useState(true);
  const [duration, setDuration] = useState('00:00');
  const [showParticipantsPanel, setShowParticipantsPanel] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [showChatPanel, setShowChatPanel] = useState(false);
  // Unread chat count — incremented by CallChatPanel when messages arrive while
  // the panel is closed. Resets when the user opens chat.
  const [chatUnread, setChatUnread] = useState(0);
  // Pinned participant identity (per-viewer, local-only state)
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  // Title-edit state — only visible to host
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const startTimeRef = useRef(groupCall?.startTime ?? new Date());

  // Read room metadata reactively — host updates flow to all participants automatically
  const roomInfo = useRoomInfo();
  const customTitle = useMemo(() => {
    if (!roomInfo.metadata) return null;
    try {
      const parsed = JSON.parse(roomInfo.metadata);
      return typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
    } catch { return null; }
  }, [roomInfo.metadata]);

  // The right-side panels are mutually exclusive — opening one closes the others
  const openParticipantsPanel = () => {
    setShowInvitePanel(false);
    setShowChatPanel(false);
    setShowParticipantsPanel((v) => !v);
  };
  const openInvitePanel = () => {
    setShowParticipantsPanel(false);
    setShowChatPanel(false);
    setShowInvitePanel((v) => !v);
  };
  const openChatPanel = () => {
    setShowParticipantsPanel(false);
    setShowInvitePanel(false);
    setShowChatPanel((v) => !v);
  };

  // Duration timer
  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current.getTime()) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      setDuration(`${mins}:${secs}`);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Get all tracks (camera + screen share) for layout decisions
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // ── Focus-layout priority ────────────────────────────────────────────────
  // The main spotlight tile is decided by priority:
  //   1. PINNED participant (local choice) — beats everything else
  //   2. Active SCREEN SHARE — Teams default when nobody pinned
  //   3. None → fall back to equal-size grid
  //
  // The carousel (right-side strip) shows every OTHER tile.
  const screenShareTracks = tracks.filter(
    (t) => t.publication?.source === Track.Source.ScreenShare && t.publication?.track,
  );
  const cameraTracks = tracks.filter(
    (t) => t.publication?.source !== Track.Source.ScreenShare,
  );

  // 1. Pin wins if set. Look for the pinned user's CAMERA tile (not screen share).
  const pinnedCameraTrack = pinnedIdentity
    ? cameraTracks.find((t) => t.participant?.identity === pinnedIdentity)
    : undefined;
  // 2. Otherwise first screen share
  const focusTrack = pinnedCameraTrack || screenShareTracks[0];
  // True only when the focus comes from a real screen-share publication
  const focusIsScreenShare = !pinnedCameraTrack && !!screenShareTracks[0];

  const carouselTracks = focusTrack
    ? tracks.filter((t) => t !== focusTrack)
    : [];

  // Display name of whoever is currently in the focus tile (used for banner)
  const focusOwnerName: string =
    (focusTrack?.participant?.name as string | undefined)
    || (focusTrack?.participant?.identity as string | undefined)
    || '';

  const participants = useParticipants();
  const participantCount = participants.length;
  const isHost = !!groupCall?.isHost;

  const handleLeave = async () => {
    await leaveGroupCall();
  };

  const handleEndForAll = async () => {
    if (!confirm('End the call for everyone?')) return;
    await endGroupCallForAll();
  };

  // ─── Title edit (host only) ───
  const handleTitleSave = async () => {
    if (!groupCall?.callId || savingTitle) return;
    const next = titleDraft.trim();
    setSavingTitle(true);
    try {
      await livekitApi.updateMeetingTitle(groupCall.callId, next);
      setEditingTitle(false);
    } catch (err: any) {
      alert('Failed to rename meeting: ' + (err?.response?.data?.error || err.message));
    } finally {
      setSavingTitle(false);
    }
  };

  // ─── Copy meeting link ───
  const handleCopyLink = async () => {
    if (!groupCall?.callId) return;
    const url = `${window.location.origin}/meeting/${groupCall.callId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // Some browsers block clipboard in non-secure contexts — fall back to prompt
      window.prompt('Copy this meeting link:', url);
    }
  };

  // Title to display: custom from room metadata > default by call type
  const displayTitle = customTitle
    || (groupCall?.callType === 'video' ? 'Group Video Call' : 'Group Audio Call');

  // ─── Minimized bar ─────────────────────────────────────────────────────
  if (!isExpanded) {
    return (
      <div
        style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
          background: '#1A1A2E', color: '#fff', borderRadius: 16,
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
          fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Group Call</span>
          <span style={{ fontSize: 11, color: '#8B8CA7' }}>
            {participantCount} {participantCount === 1 ? 'participant' : 'participants'} · {duration}
          </span>
        </div>
        <button
          onClick={() => setIsExpanded(true)}
          title="Expand"
          style={iconBtnStyle('#3A3A55')}
        >
          <Maximize2 size={14} />
        </button>
        <button
          onClick={handleLeave}
          title="Leave"
          style={iconBtnStyle('#DC2626')}
        >
          <PhoneOff size={14} />
        </button>
      </div>
    );
  }

  // ─── Expanded full-screen overlay ──────────────────────────────────────
  return (
    <PinContext.Provider value={{ pinnedIdentity, setPinned: setPinnedIdentity }}>
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#0F0F1F',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      {/* Active-speaker outline override — LiveKit's default is purple/blue;
          we render in green so it's clearer who is currently speaking. */}
      <style>{`
        .lk-participant-tile[data-lk-speaking="true"]:not([data-lk-source="screen_share"])::after {
          border-color: #16A34A !important;
          box-shadow: 0 0 0 1px #16A34A, 0 0 16px rgba(22, 163, 74, 0.5);
        }
      `}</style>

      {/* Top bar */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px', borderBottom: '1px solid #2A2A45',
          color: '#fff', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%', background: '#16A34A',
            boxShadow: '0 0 8px #16A34A', flexShrink: 0,
          }} />
          <div style={{ minWidth: 0 }}>
            {editingTitle && isHost ? (
              // Inline edit mode (host only)
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  autoFocus
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTitleSave();
                    if (e.key === 'Escape') setEditingTitle(false);
                  }}
                  maxLength={200}
                  placeholder={groupCall?.callType === 'video' ? 'Group Video Call' : 'Group Audio Call'}
                  style={{
                    fontSize: 14, fontWeight: 700,
                    background: 'rgba(255,255,255,0.06)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.18)', borderRadius: 6,
                    padding: '4px 8px', outline: 'none', fontFamily: 'inherit',
                    minWidth: 0, maxWidth: 320,
                  }}
                />
                <button
                  onClick={handleTitleSave}
                  disabled={savingTitle}
                  title="Save title"
                  style={titleEditBtnStyle('#16A34A')}
                >
                  <Check size={13} />
                </button>
                <button
                  onClick={() => setEditingTitle(false)}
                  title="Cancel"
                  style={titleEditBtnStyle('#3A3A55')}
                >
                  <XIcon size={13} />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <p style={{
                  fontSize: 14, fontWeight: 700, margin: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  maxWidth: 320,
                }}>
                  {displayTitle}
                </p>
                {isHost && (
                  <button
                    onClick={() => { setTitleDraft(customTitle || ''); setEditingTitle(true); }}
                    aria-label="Rename meeting"
                    title="Rename meeting"
                    style={{
                      background: 'transparent', border: 'none', color: '#8B8CA7',
                      cursor: 'pointer', padding: 4, borderRadius: 4,
                      display: 'flex', alignItems: 'center',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#8B8CA7'; e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </div>
            )}
            <p style={{ fontSize: 11, color: '#8B8CA7', margin: '2px 0 0' }}>
              {duration} · {participantCount} {participantCount === 1 ? 'participant' : 'participants'}
              {isHost && <span style={{ marginLeft: 8, padding: '1px 6px', background: '#6264A7', borderRadius: 4, fontSize: 10 }}>HOST</span>}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {/* Copy meeting link */}
          <button
            onClick={handleCopyLink}
            style={topBarBtnStyle(copyState === 'copied')}
            title="Copy a shareable link to this meeting"
          >
            {copyState === 'copied' ? <><Check size={14} /> Copied</> : <><Link2 size={14} /> Copy link</>}
          </button>

          {/* Chat button with unread badge */}
          <button
            onClick={openChatPanel}
            style={{ ...topBarBtnStyle(showChatPanel), position: 'relative' }}
            title={chatUnread > 0 ? `${chatUnread} new chat message${chatUnread === 1 ? '' : 's'}` : 'Chat'}
          >
            <MessageSquare size={14} /> Chat
            {chatUnread > 0 && !showChatPanel && (
              <span
                aria-label={`${chatUnread} unread messages`}
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: '#DC2626',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 0 2px #0F0F1F',
                }}
              >
                {chatUnread > 99 ? '99+' : chatUnread}
              </span>
            )}
          </button>
          <button
            onClick={openInvitePanel}
            style={topBarBtnStyle(showInvitePanel)}
            title="Add people to this call"
          >
            <UserPlus size={14} /> Add
          </button>
          <button
            onClick={openParticipantsPanel}
            style={topBarBtnStyle(showParticipantsPanel)}
            title="Participants"
          >
            <Users size={14} /> {participantCount}
          </button>
          <button onClick={() => setIsExpanded(false)} style={topBarBtnStyle(false)} title="Minimize">
            <Minimize2 size={14} />
          </button>
        </div>
      </div>

      {/* Main area: grid (or focus+carousel when someone shares screen) + optional participants panel */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Position:relative so <ReactionsLayer> can overlay the entire main video area */}
        <div style={{ flex: 1, padding: 16, minWidth: 0, position: 'relative' }}>
          {focusTrack ? (
            // ── Teams-style spotlight ──
            // The shared screen takes the main area (left, fills available width).
            // Camera tiles stack vertically in a fixed-width sidebar (right).
            // Layout is computed from the live `tracks` array — fully dynamic, no
            // assumptions about who's sharing or how many participants there are.
            <div
              style={{
                height: '100%',
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 240px',
                gap: 12,
              }}
            >
              {/* Main spotlight — the shared screen OR a pinned participant */}
              <div
                style={{
                  minWidth: 0,
                  minHeight: 0,
                  borderRadius: 12,
                  overflow: 'hidden',
                  background: '#000',
                  position: 'relative',
                }}
              >
                <ParticipantTileWithHand trackRef={focusTrack} />

                {/* Status banner over the spotlight — "X is presenting" for screen share,
                    or "Pinned: X" for a pinned camera. Mutually exclusive with each other. */}
                {focusIsScreenShare ? (
                  <div
                    style={{
                      position: 'absolute', top: 12, left: 12,
                      padding: '6px 12px', borderRadius: 999,
                      background: 'rgba(98, 100, 167, 0.92)',
                      color: '#fff', fontSize: 12, fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 6,
                      backdropFilter: 'blur(6px)',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                      pointerEvents: 'none',
                      zIndex: 4,
                    }}
                  >
                    <ScreenShare size={12} /> {focusOwnerName} is presenting
                  </div>
                ) : pinnedCameraTrack ? (
                  <div
                    style={{
                      position: 'absolute', top: 12, left: 12,
                      padding: '6px 12px', borderRadius: 999,
                      background: 'rgba(98, 100, 167, 0.92)',
                      color: '#fff', fontSize: 12, fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 6,
                      backdropFilter: 'blur(6px)',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                      zIndex: 4,
                    }}
                  >
                    <Pencil size={12} style={{ display: 'none' }} />
                    📌 Pinned: {focusOwnerName}
                    <button
                      onClick={() => setPinnedIdentity(null)}
                      style={{
                        marginLeft: 4, padding: '2px 8px', borderRadius: 999,
                        background: 'rgba(255,255,255,0.18)', border: 'none',
                        color: '#fff', fontSize: 11, fontFamily: 'inherit',
                        fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Unpin
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Right sidebar — every participant's camera (or placeholder) as a small tile */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  overflowY: 'auto',
                  minHeight: 0,
                  paddingRight: 4,
                }}
              >
                {carouselTracks.map((tr, idx) => (
                  <div
                    key={`${tr.participant.identity}:${tr.publication?.trackSid || tr.source || idx}`}
                    style={{
                      flex: '0 0 auto',
                      aspectRatio: '16 / 9',
                      borderRadius: 10,
                      overflow: 'hidden',
                      background: '#1A1A2E',
                    }}
                  >
                    <ParticipantTileWithHand trackRef={tr} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            // No screen share — normal equal-size grid
            <GridLayout tracks={tracks} style={{ height: '100%' }}>
              <ParticipantTileWithHand />
            </GridLayout>
          )}

          {/* Floating reactions overlay — covers the entire video area but
              pointer-events: none so it doesn't intercept clicks on tiles */}
          <ReactionsLayer />
        </div>

        {/* Right-side panels — mutually exclusive (participant list OR invite search) */}
        {showParticipantsPanel && (
          <ParticipantsPanel isHost={isHost} callId={groupCall?.callId ?? null} />
        )}
        {showInvitePanel && groupCall?.callId && (
          <CallInvitePanel
            callId={groupCall.callId}
            onClose={() => setShowInvitePanel(false)}
          />
        )}
        {/* Chat panel is ALWAYS mounted (so it tracks unread when hidden via display:none).
            Its `visible` prop just controls visibility — useChat subscription stays alive. */}
        {groupCall?.callId && (
          <CallChatPanel
            callId={groupCall.callId}
            visible={showChatPanel}
            onClose={() => setShowChatPanel(false)}
            onUnreadChange={setChatUnread}
          />
        )}
      </div>

      {/* Bottom controls */}
      <div
        style={{
          padding: '12px 20px', borderTop: '1px solid #2A2A45',
          background: '#1A1A2E',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, gap: 12, flexWrap: 'wrap',
        }}
      >
        {/* Left cluster: LiveKit's built-in mic/cam/screen-share + raise hand + reactions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <ControlBar
            variation="minimal"
            controls={{
              microphone: true,
              camera: groupCall?.callType === 'video',
              screenShare: true,
              chat: false,
              leave: false, // We render our own leave button (handles "end for all" host option)
              settings: false,
            }}
          />
          <RaiseHandButton />
          <ReactionsBar />
        </div>

        {/* Right cluster: leave / end-for-all */}
        <div style={{ display: 'flex', gap: 8 }}>
          {isHost && (
            <button onClick={handleEndForAll} style={endForAllBtnStyle}>
              End for all
            </button>
          )}
          <button onClick={handleLeave} style={leaveBtnStyle} title="Leave call">
            <PhoneOff size={16} />
            <span style={{ fontWeight: 600 }}>Leave</span>
          </button>
        </div>
      </div>
    </div>
    </PinContext.Provider>
  );
}

// ─── Participants side panel ──────────────────────────────────────────────
function ParticipantsPanel({ isHost, callId }: { isHost: boolean; callId: string | null }) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const [busyOnUser, setBusyOnUser] = useState<string | null>(null);
  const [loweringAll, setLoweringAll] = useState(false);

  // Compute raised-hands list ordered by handRaisedAt (first up speaks first)
  // useParticipants is reactive to AttributesChanged events, so this recomputes
  // on every render — no need for a manual subscription.
  const raisedHands = participants
    .filter((p) => p.attributes?.handRaised === '1')
    .sort((a, b) => (a.attributes?.handRaisedAt || '').localeCompare(b.attributes?.handRaisedAt || ''));

  const handleKick = async (identity: string) => {
    if (!callId || !isHost || identity === localParticipant.identity) return;
    if (!confirm(`Remove ${identity} from the call?`)) return;
    setBusyOnUser(identity);
    try { await livekitApi.kickGroupParticipant(callId, identity); }
    catch (err: any) { alert('Kick failed: ' + (err?.response?.data?.error || err.message)); }
    finally { setBusyOnUser(null); }
  };

  const handleMuteOther = async (identity: string, isMuted: boolean) => {
    if (!callId || !isHost || identity === localParticipant.identity) return;
    setBusyOnUser(identity);
    try { await livekitApi.muteGroupParticipant(callId, identity, !isMuted); }
    catch (err: any) { alert('Mute failed: ' + (err?.response?.data?.error || err.message)); }
    finally { setBusyOnUser(null); }
  };

  const handleLowerOne = async (identity: string) => {
    if (!callId || !isHost) return;
    setBusyOnUser(identity);
    try { await livekitApi.lowerHand(callId, identity); }
    catch (err: any) { alert('Lower hand failed: ' + (err?.response?.data?.error || err.message)); }
    finally { setBusyOnUser(null); }
  };

  const handleLowerAll = async () => {
    if (!callId || !isHost || raisedHands.length === 0) return;
    setLoweringAll(true);
    try { await livekitApi.lowerHand(callId, 'all'); }
    catch (err: any) { alert('Lower all hands failed: ' + (err?.response?.data?.error || err.message)); }
    finally { setLoweringAll(false); }
  };

  return (
    <div
      style={{
        width: 280, flexShrink: 0,
        background: '#1A1A2E', borderLeft: '1px solid #2A2A45',
        padding: 16, overflowY: 'auto',
        color: '#fff',
      }}
    >
      {/* Raised hands section — only shown when at least one hand is up */}
      {raisedHands.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: 0, color: '#F59E0B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Hand size={13} /> Raised hands ({raisedHands.length})
            </h3>
            {isHost && raisedHands.length > 0 && (
              <button
                onClick={handleLowerAll}
                disabled={loweringAll}
                style={participantActionBtnStyle('#F59E0B')}
                title="Lower every raised hand"
              >
                {loweringAll ? '…' : 'Lower all'}
              </button>
            )}
          </div>
          {raisedHands.map((p, idx) => {
            const isLocal = p.identity === localParticipant.identity;
            const busy = busyOnUser === p.identity;
            return (
              <div
                key={'rh-' + p.identity}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.10)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  marginBottom: 4, fontSize: 12,
                }}
              >
                <span style={{
                  fontSize: 11, fontWeight: 700, color: '#F59E0B',
                  background: 'rgba(245, 158, 11, 0.2)',
                  width: 18, height: 18, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {idx + 1}
                </span>
                <span style={{ flex: 1, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name || p.identity}{isLocal && <span style={{ color: '#8B8CA7', fontWeight: 400 }}> (you)</span>}
                </span>
                {isHost && !isLocal && (
                  <button
                    onClick={() => handleLowerOne(p.identity)}
                    disabled={busy}
                    style={participantActionBtnStyle('#F59E0B')}
                    title={`Lower ${p.name || p.identity}'s hand`}
                  >
                    Lower
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', margin: '0 0 12px 0' }}>
        Participants ({participants.length})
      </h3>
      {participants.map((p) => {
        const isLocal = p.identity === localParticipant.identity;
        const audioPub = p.getTrackPublication(Track.Source.Microphone);
        const isMuted = !!audioPub?.isMuted;
        const busy = busyOnUser === p.identity;
        const handRaised = p.attributes?.handRaised === '1';
        return (
          <div
            key={p.identity}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 10px', borderRadius: 8,
              background: 'rgba(255,255,255,0.04)', marginBottom: 6,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: '#6264A7', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0, position: 'relative',
              }}>
                {(p.name || p.identity || '?').charAt(0).toUpperCase()}
                {handRaised && (
                  <span style={{
                    position: 'absolute', bottom: -3, right: -3,
                    width: 14, height: 14, borderRadius: '50%',
                    background: '#F59E0B', color: '#1A1A2E',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '2px solid #1A1A2E',
                  }}>
                    <Hand size={8} />
                  </span>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name || p.identity}
                  {isLocal && <span style={{ color: '#8B8CA7', fontWeight: 400 }}> (you)</span>}
                </p>
                <p style={{ margin: 0, fontSize: 10, color: '#8B8CA7' }}>
                  {isMuted ? 'Muted' : 'Speaking-allowed'}
                </p>
              </div>
            </div>
            {isHost && !isLocal && (
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  onClick={() => handleMuteOther(p.identity, isMuted)}
                  disabled={busy}
                  style={participantActionBtnStyle('#D97706')}
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  onClick={() => handleKick(p.identity)}
                  disabled={busy}
                  style={participantActionBtnStyle('#DC2626')}
                  title="Remove from call"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Style helpers ────────────────────────────────────────────────────────
const iconBtnStyle = (bg: string): React.CSSProperties => ({
  width: 32, height: 32, borderRadius: '50%',
  background: bg, color: '#fff', border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
});

const topBarBtnStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '6px 10px', borderRadius: 8,
  background: active ? '#6264A7' : '#2A2A45',
  color: '#fff', border: 'none', cursor: 'pointer',
  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
});

const leaveBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 24,
  background: '#DC2626', color: '#fff', border: 'none',
  cursor: 'pointer', fontFamily: 'inherit',
};

const endForAllBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 24,
  background: 'transparent', color: '#FECACA', border: '1px solid #DC2626',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
};

const participantActionBtnStyle = (color: string): React.CSSProperties => ({
  padding: '4px 8px', borderRadius: 6,
  background: 'transparent', color, border: `1px solid ${color}`,
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
});

const titleEditBtnStyle = (bg: string): React.CSSProperties => ({
  width: 24, height: 24, borderRadius: 6,
  background: bg, color: '#fff', border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
});
