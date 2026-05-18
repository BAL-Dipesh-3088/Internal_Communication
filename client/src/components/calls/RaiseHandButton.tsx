/**
 * RaiseHandButton — toggle the local user's "hand raised" state.
 *
 * State is stored as a LiveKit participant attribute (`handRaised: "1"`)
 * which is automatically synced to all other clients in the room. The
 * `handRaisedAt` ISO timestamp powers the ordered queue in the participants
 * panel ("first hand up speaks first").
 *
 * Clients can only update their OWN attributes via the client SDK. The host
 * "lower someone else's hand" action goes through our backend (which uses
 * the LiveKit server API).
 */

import { Hand } from 'lucide-react';
import { useLocalParticipant, useParticipantAttributes } from '@livekit/components-react';

export default function RaiseHandButton() {
  const { localParticipant } = useLocalParticipant();
  const { attributes } = useParticipantAttributes({ participant: localParticipant });

  const raised = attributes?.handRaised === '1';

  const handleToggle = async () => {
    if (!localParticipant) return;
    if (raised) {
      // Empty-string value unsets the attribute on LiveKit's side
      await localParticipant.setAttributes({ handRaised: '', handRaisedAt: '' });
    } else {
      await localParticipant.setAttributes({
        handRaised: '1',
        handRaisedAt: new Date().toISOString(),
      });
    }
  };

  return (
    <button
      onClick={handleToggle}
      aria-pressed={raised}
      aria-label={raised ? 'Lower your hand' : 'Raise your hand'}
      title={raised ? 'Lower your hand' : 'Raise your hand'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderRadius: 22,
        // Yellow when active to match the icon overlay on tiles
        background: raised ? '#F59E0B' : 'rgba(255,255,255,0.06)',
        color: raised ? '#1A1A2E' : '#fff',
        border: '1px solid ' + (raised ? '#F59E0B' : 'rgba(255,255,255,0.12)'),
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      <Hand
        size={16}
        style={{
          // Subtle wiggle animation when raised
          animation: raised ? 'hand-wave 1.4s ease-in-out infinite' : 'none',
          transformOrigin: 'bottom center',
        }}
      />
      {raised ? 'Lower hand' : 'Raise hand'}
      <style>{`
        @keyframes hand-wave {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-14deg); }
          75% { transform: rotate(14deg); }
        }
      `}</style>
    </button>
  );
}
