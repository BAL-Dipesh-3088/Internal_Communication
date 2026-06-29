import { useEffect, useMemo, useRef } from 'react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { Loader2 } from 'lucide-react';
import type { Message } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import MessageBubble from './MessageBubble';

interface Props {
  conversationId?: string;
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  currentUserId?: string;
  onReply?: (message: Message) => void;
}

export default function MessageList({ conversationId, messages, isLoading, hasMore, onLoadMore, currentUserId, onReply }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);
  // Whether we've already jumped to the bottom for the CURRENT conversation.
  const didInitialScrollRef = useRef(false);

  // When the conversation changes, reset so the next render jumps to the newest
  // message. (The component isn't remounted on conversation switch, so without
  // this it would stay scrolled wherever the previous chat left it — the bug.)
  useEffect(() => {
    didInitialScrollRef.current = false;
    prevLengthRef.current = 0;
  }, [conversationId]);

  useEffect(() => {
    if (messages.length === 0) return;

    if (!didInitialScrollRef.current) {
      // First time this conversation's messages render → jump straight to the
      // bottom (no animation). A double rAF lets layout (incl. images) settle
      // so we land truly at the newest message.
      const jump = () => bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      requestAnimationFrame(() => requestAnimationFrame(jump));
      didInitialScrollRef.current = true;
    } else if (messages.length > prevLengthRef.current) {
      // A new message arrived → smooth-scroll only if it's ours or we're already
      // near the bottom (don't yank the user up if they're reading history).
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.sender_id === currentUserId || isNearBottom(containerRef.current)) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, conversationId, currentUserId]);

  // Infinite scroll — load more when scrolling to top
  const handleScroll = () => {
    if (!containerRef.current || isLoading || !hasMore) return;
    if (containerRef.current.scrollTop < 100) {
      onLoadMore();
    }
  };

  // ── "Seen" indicator (Teams-style) ────────────────────────────────────────
  // Subscribe to this conversation's read receipts and compute the latest OWN
  // message another member has read. Teams shows ONE marker that moves down as
  // the reader progresses, so we tag only that single message.
  const readState = useChatStore((s) => (conversationId ? s.readState[conversationId] : undefined));
  const { lastSeenOwnId, seenTooltip, seenText } = useMemo(() => {
    const empty = { lastSeenOwnId: null as string | null, seenTooltip: '', seenText: '' };
    if (!readState || !currentUserId) return empty;
    const readers = Object.values(readState);
    if (readers.length === 0) return empty;
    // Highest sequence anyone other than me has read up to.
    const maxSeenSeq = readers.reduce((mx, r) => (r.sequence != null && r.sequence > mx ? r.sequence : mx), -1);
    if (maxSeenSeq < 0) return empty;
    // Bottom-most own, non-system message at or below that sequence.
    let found: Message | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender_id === currentUserId && m.type !== 'system' && !m.is_deleted
          && m.sequence_number != null && m.sequence_number <= maxSeenSeq) {
        found = m;
        break;
      }
    }
    if (!found) return empty;
    const seq = found.sequence_number!;
    const seers = readers.filter((r) => r.sequence != null && r.sequence >= seq);
    // 1:1 → just "Seen"; group → "Seen by N" with names in the tooltip.
    if (readers.length <= 1) {
      return { lastSeenOwnId: found.id, seenTooltip: 'Seen', seenText: '' };
    }
    const names = seers.map((r) => r.name).filter(Boolean).join(', ');
    return {
      lastSeenOwnId: found.id,
      seenTooltip: names ? `Seen by ${names}` : `Seen by ${seers.length}`,
      seenText: String(seers.length),
    };
  }, [readState, messages, currentUserId]);

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {/* BAL Logo Watermark — fixed behind messages */}
      <img
        src="/BAL_logo.png"
        alt=""
        draggable={false}
        style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 250, height: 'auto',
          opacity: 0.30,
          pointerEvents: 'none', userSelect: 'none',
          zIndex: 0,
        }}
      />

      {/* Scrollable messages container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          position: 'absolute', inset: 0,
          overflowY: 'auto', overflowX: 'hidden',
          paddingTop: 8, paddingBottom: 8,
          zIndex: 1,
        }}
      >
      {/* Load More Indicator */}
      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
          <Loader2 size={20} style={{ color: '#6264A7', animation: 'spin 1s linear infinite' }} />
        </div>
      )}

      {hasMore && !isLoading && (
        <button
          onClick={onLoadMore}
          style={{
            width: '100%',
            textAlign: 'center',
            padding: '8px 0',
            fontSize: 12,
            color: '#6264A7',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Load older messages
        </button>
      )}

      {/* Messages */}
      {messages.map((msg, idx) => {
        const prev = idx > 0 ? messages[idx - 1] : null;
        const showDateSep = !prev || !isSameDay(new Date(msg.created_at), new Date(prev.created_at));
        const showAvatar = !prev || prev.sender_id !== msg.sender_id || showDateSep;

        return (
          <div key={msg.id}>
            {showDateSep && <DateSeparator date={new Date(msg.created_at)} />}
            <MessageBubble
              message={msg}
              isOwn={msg.sender_id === currentUserId}
              showAvatar={showAvatar}
              onReply={onReply}
              seen={msg.id === lastSeenOwnId}
              seenTooltip={seenTooltip}
              seenText={seenText}
            />
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
    </div>
  );
}

function DateSeparator({ date }: { date: Date }) {
  let label: string;
  if (isToday(date)) label = 'Today';
  else if (isYesterday(date)) label = 'Yesterday';
  else label = format(date, 'EEEE, MMMM d, yyyy');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 20px', userSelect: 'none' }}>
      <div style={{ flex: 1, height: 1, background: '#EDEBE9' }} />
      <span style={{ fontSize: 12, color: '#A19F9D', fontWeight: 500, padding: '0 4px' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: '#EDEBE9' }} />
    </div>
  );
}

function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
}
