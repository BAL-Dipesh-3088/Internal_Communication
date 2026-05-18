/**
 * ParticipantTileWithHand — wraps LiveKit's <ParticipantTile> with a small
 * raised-hand badge overlay. The participant's `handRaised` attribute is
 * watched reactively via useParticipantAttributes, so the badge appears /
 * disappears the instant another client toggles their hand.
 *
 * Usable in two contexts:
 *   1. Inside <GridLayout> — no props needed (trackRef from context)
 *   2. Inside the focus layout — pass `trackRef` explicitly
 *
 * The tile underneath is the stock LiveKit ParticipantTile so we inherit all
 * its features (active-speaker glow, name plate, muted indicator, etc.).
 */

import {
  ParticipantTile,
  useEnsureTrackRef,
  useParticipantAttributes,
} from '@livekit/components-react';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import { Hand, Pin, PinOff } from 'lucide-react';
import { usePin } from './PinContext';

interface Props {
  trackRef?: TrackReferenceOrPlaceholder;
  style?: React.CSSProperties;
}

export default function ParticipantTileWithHand({ trackRef, style }: Props) {
  // Falls back to the TrackRefContext provided by <GridLayout> if no prop given
  const ref = useEnsureTrackRef(trackRef);
  const { attributes } = useParticipantAttributes({ participant: ref.participant });
  const { pinnedIdentity, setPinned } = usePin();

  const identity = ref.participant?.identity || '';
  const handRaised = attributes?.handRaised === '1';
  const isPinned = !!identity && identity === pinnedIdentity;

  const handlePinToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!identity) return;
    setPinned(isPinned ? null : identity);
  };

  return (
    <div
      className="lk-tile-with-hand"
      style={{ position: 'relative', width: '100%', height: '100%', ...style }}
    >
      <ParticipantTile trackRef={ref} style={{ height: '100%', width: '100%' }} />

      {/* Hand badge — top-left, persistent while hand is raised */}
      {handRaised && (
        <div
          aria-label={`${ref.participant?.name || 'Participant'} has raised their hand`}
          style={{
            position: 'absolute', top: 8, left: 8,
            width: 32, height: 32, borderRadius: '50%',
            background: '#F59E0B', color: '#1A1A2E',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            animation: 'tile-hand-pulse 1.6s ease-in-out infinite',
            zIndex: 3, pointerEvents: 'none',
          }}
        >
          <Hand size={16} />
        </div>
      )}

      {/* Pin button — hover-reveal, top-right.
          Stays visible if already pinned so the user can unpin without re-hovering. */}
      <button
        className="lk-tile-pin-btn"
        onClick={handlePinToggle}
        aria-label={isPinned ? 'Unpin this video' : 'Pin this video'}
        title={isPinned ? 'Unpin this video' : 'Pin this video'}
        style={{
          position: 'absolute', top: 8, right: 8,
          width: 30, height: 30, borderRadius: 8,
          background: isPinned ? '#6264A7' : 'rgba(0,0,0,0.55)',
          color: '#fff', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: isPinned ? 1 : 0,
          transition: 'opacity 0.15s, background 0.15s',
          zIndex: 4,
        }}
      >
        {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>

      <style>{`
        @keyframes tile-hand-pulse {
          0%, 100% { transform: scale(1) rotate(0deg);    box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
          25%      { transform: scale(1.08) rotate(-8deg); box-shadow: 0 2px 14px rgba(245,158,11,0.55); }
          75%      { transform: scale(1.08) rotate(8deg);  box-shadow: 0 2px 14px rgba(245,158,11,0.55); }
        }
        /* Reveal pin button on tile hover (works regardless of isPinned state) */
        .lk-tile-with-hand:hover .lk-tile-pin-btn { opacity: 1; }
      `}</style>
    </div>
  );
}
