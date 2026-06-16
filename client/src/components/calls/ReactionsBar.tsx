/**
 * ReactionsBar — 6 emoji buttons that publish a "reaction" event over the
 * LiveKit data channel. The corresponding <ReactionsLayer> component listens
 * and renders the floating animations on every client (including the sender's).
 *
 * Throttled to 1 reaction per second per user to prevent spam.
 */

import { useRef, useState } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import { REACTION_TOPIC, emitLocalReaction } from './ReactionsLayer';

const REACTIONS: string[] = ['👍', '❤️', '😂', '👏', '🎉', '🙌'];

// Minimum interval between sends from this user (ms). Throttles spam-clickers.
const THROTTLE_MS = 800;

export default function ReactionsBar() {
  const { send, isSending } = useDataChannel(REACTION_TOPIC);
  const { localParticipant } = useLocalParticipant();
  const [lastSentAt, setLastSentAt] = useState(0);
  const burstButtonRef = useRef<string | null>(null);

  const handleReact = async (emoji: string) => {
    const now = Date.now();
    if (now - lastSentAt < THROTTLE_MS) return; // throttled
    if (isSending) return;

    setLastSentAt(now);
    burstButtonRef.current = emoji;
    setTimeout(() => { burstButtonRef.current = null; }, 220); // brief bounce animation flag

    const payload = {
      emoji,
      senderId: localParticipant?.identity,
      senderName: localParticipant?.name || localParticipant?.identity,
    };

    // Show it on our OWN screen immediately (LiveKit won't echo our data
    // message back to us, so without this the sender never sees their react).
    emitLocalReaction(payload);

    try {
      await send(new TextEncoder().encode(JSON.stringify(payload)), {
        // `reliable: false` → low-latency, best-effort. Fine for reactions —
        // a dropped reaction is harmless; we don't retry.
        reliable: false,
        topic: REACTION_TOPIC,
      });
    } catch (err) {
      console.warn('[ReactionsBar] send failed:', err);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '4px 6px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 22,
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {REACTIONS.map((emoji) => {
        const isBursting = burstButtonRef.current === emoji;
        return (
          <button
            key={emoji}
            onClick={() => handleReact(emoji)}
            aria-label={`React with ${emoji}`}
            title={`React with ${emoji}`}
            style={{
              width: 34,
              height: 34,
              borderRadius: 18,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'transform 0.15s, background 0.15s',
              transform: isBursting ? 'scale(1.35)' : 'scale(1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
