/**
 * ReactionsLayer — Teams/Meet-style floating emoji animation.
 *
 * Listens on LiveKit's data channel for messages with topic 'reaction'.
 * When a reaction arrives, spawns a floating emoji that rises from the
 * bottom of the call view and fades out at the top.
 *
 * Reactions are ephemeral by design — they don't persist anywhere and aren't
 * synced for late joiners (matches Microsoft Teams behaviour).
 *
 * Multiple concurrent reactions are allowed; each gets a random horizontal
 * offset and a fresh DOM node so they don't visually stack.
 *
 * IMPORTANT: this layer is positioned ABOVE the video tiles but with
 * `pointer-events: none` so it doesn't intercept clicks.
 */

import { useEffect, useRef, useState } from 'react';
import { useDataChannel } from '@livekit/components-react';

export const REACTION_TOPIC = 'reaction';

interface ActiveReaction {
  id: string;
  emoji: string;
  /** Horizontal position as a percentage from the left (15%..85%). */
  xPercent: number;
  /** Optional sender display name shown briefly below the emoji. */
  senderName?: string;
}

interface ReactionPayload {
  emoji: string;
  senderName?: string;
  senderId?: string;
}

// How long each emoji lives on screen before being removed (matches the CSS animation duration)
const REACTION_DURATION_MS = 3000;
// Hard cap on simultaneous emojis to prevent runaway spam from blowing up the DOM
const MAX_CONCURRENT = 25;

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ReactionsLayer() {
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Subscribe to the 'reaction' topic on the LiveKit data channel
  useDataChannel(REACTION_TOPIC, (msg) => {
    try {
      const decoded = new TextDecoder().decode(msg.payload);
      const payload: ReactionPayload = JSON.parse(decoded);
      if (!payload?.emoji) return;

      const newReaction: ActiveReaction = {
        id: genId(),
        emoji: payload.emoji,
        // Random offset between 15% and 85% — keeps emojis away from the very edges
        xPercent: 15 + Math.random() * 70,
        senderName: payload.senderName,
      };

      setReactions((prev) => {
        // Cap to prevent runaway DOM
        const next = prev.length >= MAX_CONCURRENT ? prev.slice(-MAX_CONCURRENT + 1) : prev;
        return [...next, newReaction];
      });

      // Auto-remove after animation completes
      const timer = setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== newReaction.id));
        timersRef.current.delete(newReaction.id);
      }, REACTION_DURATION_MS);
      timersRef.current.set(newReaction.id, timer);
    } catch (err) {
      // Malformed payload — ignore silently
      console.warn('[ReactionsLayer] bad payload:', err);
    }
  });

  // Cleanup any pending timers on unmount
  useEffect(() => {
    const timersAtMount = timersRef.current;
    return () => {
      timersAtMount.forEach((t) => clearTimeout(t));
      timersAtMount.clear();
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      {reactions.map((r) => (
        <div
          key={r.id}
          style={{
            position: 'absolute',
            left: `${r.xPercent}%`,
            bottom: 24,
            transform: 'translateX(-50%)',
            fontSize: 56,
            animation: `reaction-float ${REACTION_DURATION_MS}ms ease-out forwards`,
            filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.45))',
            whiteSpace: 'nowrap',
          }}
        >
          {r.emoji}
          {r.senderName && (
            <div
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.85)',
                textAlign: 'center',
                marginTop: 4,
                textShadow: '0 1px 2px rgba(0,0,0,0.6)',
              }}
            >
              {r.senderName}
            </div>
          )}
        </div>
      ))}
      <style>{`
        @keyframes reaction-float {
          0%   { transform: translate(-50%, 0)      scale(0.4); opacity: 0; }
          12%  { transform: translate(-50%, -40px)  scale(1.15); opacity: 1; }
          70%  { transform: translate(-50%, -260px) scale(1);   opacity: 1; }
          100% { transform: translate(-50%, -480px) scale(0.75); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
