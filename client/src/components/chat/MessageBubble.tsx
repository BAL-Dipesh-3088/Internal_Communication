import { useState, useRef } from 'react';
import { format } from 'date-fns';
import { Pencil, Trash2, Reply, SmilePlus, FileIcon, Download, X, CornerDownRight, Play, Pause, Clock, AlertCircle, RefreshCw, Phone, Video, PhoneMissed, PhoneOff, Eye, Languages, Loader2 } from 'lucide-react';
import { getSocket } from '@/services/socket';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { aiTranslate, TRANSLATE_LANGS, type TranslateLang } from '@/services/ai';
import api from '@/services/api';  // still needed for edit/delete
import type { Message, MentionData } from '@/types';

interface Props {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  onReply?: (message: Message) => void;
  /** True only for the latest OWN message that's been read (Teams-style: one
   *  moving "Seen" marker). */
  seen?: boolean;
  /** Tooltip text, e.g. "Seen" or "Seen by Pramit, Admin". */
  seenTooltip?: string;
  /** Optional small count shown next to the eye (group chats only). */
  seenText?: string;
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🎉', '👏'];

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

// Detect URLs (http/https and bare www.) and render them as clickable links —
// Teams/WhatsApp style. Splits a plain string into text + <a> nodes.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

function linkifyText(text: string, isOwn: boolean, keyBase: number): React.ReactNode {
  if (!text || !URL_RE.test(text)) {
    return <span key={keyBase} style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
  }
  URL_RE.lastIndex = 0; // regex has /g — reset before reuse
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={`${keyBase}-t${i}`} style={{ whiteSpace: 'pre-wrap' }}>{text.slice(last, m.index)}</span>);
    }
    const raw = m[0];
    // Trailing punctuation shouldn't be part of the link (e.g. "see http://x.com.")
    const trimmed = raw.replace(/[.,;:!?)\]]+$/, '');
    const href = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    nodes.push(
      <a
        key={`${keyBase}-l${i}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          color: isOwn ? '#DCE3FF' : '#0078D4',
          textDecoration: 'underline',
          wordBreak: 'break-all',
        }}
      >
        {trimmed}
      </a>,
    );
    if (raw.length > trimmed.length) {
      nodes.push(<span key={`${keyBase}-p${i}`}>{raw.slice(trimmed.length)}</span>);
    }
    last = m.index + raw.length;
    i++;
  }
  if (last < text.length) {
    nodes.push(<span key={`${keyBase}-t${i}`} style={{ whiteSpace: 'pre-wrap' }}>{text.slice(last)}</span>);
  }
  return <>{nodes}</>;
}

function renderContentWithMentions(content: string, mentions: MentionData[] | undefined, isOwn: boolean, currentUserId: string | undefined): React.ReactNode {
  if (!mentions || mentions.length === 0) {
    return linkifyText(content, isOwn, 0);
  }
  // Build a regex that matches all @DisplayName patterns from mentions
  const parts: React.ReactNode[] = [];
  let remaining = content;
  let key = 0;
  while (remaining.length > 0) {
    let earliestIdx = remaining.length;
    let matchedMention: MentionData | null = null;
    let matchedText = '';
    for (const m of mentions) {
      const pattern = m.userId === 'everyone' ? '@everyone' : `@${m.displayName}`;
      const idx = remaining.indexOf(pattern);
      if (idx !== -1 && idx < earliestIdx) {
        earliestIdx = idx;
        matchedMention = m;
        matchedText = pattern;
      }
    }
    if (!matchedMention) {
      parts.push(linkifyText(remaining, isOwn, key++));
      break;
    }
    if (earliestIdx > 0) {
      parts.push(linkifyText(remaining.slice(0, earliestIdx), isOwn, key++));
    }
    const isSelfOrEveryone = matchedMention.userId === currentUserId || matchedMention.userId === 'everyone';
    parts.push(
      <span
        key={key++}
        style={{
          background: isOwn
            ? (isSelfOrEveryone ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.18)')
            : (isSelfOrEveryone ? '#E0E7FF' : '#F0F0FA'),
          color: isOwn
            ? '#fff'
            : (isSelfOrEveryone ? '#4338CA' : '#6264A7'),
          fontWeight: 600,
          padding: '1px 4px',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
        }}
      >
        {matchedText}
      </span>
    );
    remaining = remaining.slice(earliestIdx + matchedText.length);
  }
  return <>{parts}</>;
}

export default function MessageBubble({ message: msg, isOwn, showAvatar, onReply, seen, seenTooltip, seenText }: Props) {
  const [showActions, setShowActions] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content);
  const [imagePreview, setImagePreview] = useState(false);
  const { user } = useAuthStore();
  const { addReaction, removeReaction, updateMessage } = useChatStore();
  // ── Inline translation state ──
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<{ lang: TranslateLang; text: string } | null>(null);
  const translateCacheRef = useRef<Record<string, string>>({});

  const handleTranslate = async (lang: TranslateLang) => {
    setShowLangMenu(false);
    const source = (msg.content || '').trim();
    if (!source) return;
    // Serve from cache if we've already translated this message to this language.
    if (translateCacheRef.current[lang]) {
      setTranslation({ lang, text: translateCacheRef.current[lang] });
      return;
    }
    setTranslating(true);
    try {
      const result = await aiTranslate(source, lang);
      translateCacheRef.current[lang] = result;
      setTranslation({ lang, text: result });
    } catch {
      setTranslation({ lang, text: '⚠️ Translation failed — please try again.' });
    } finally {
      setTranslating(false);
    }
  };

  const translateLinkStyle: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#6264A7', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', padding: 0,
  };

  if (msg.type === 'system') {
    // Check if this is a call-related system message
    const meta = typeof msg.metadata === 'string' ? (() => { try { return JSON.parse(msg.metadata); } catch { return msg.metadata; } })() : (msg.metadata || {});
    const isCallMsg = meta?.callType || meta?.status;

    if (isCallMsg) {
      const status = meta.status || 'completed';
      const isCompleted = status === 'completed';
      const isMissed = status === 'missed';
      const isDeclined = status === 'declined';
      const isVideo = meta.callType === 'video';

      const iconColor = isCompleted ? '#107C10' : isMissed ? '#D83B01' : isDeclined ? '#A4262C' : '#8A8886';
      const CallIcon = isMissed ? PhoneMissed : isDeclined ? PhoneOff : isVideo ? Video : Phone;

      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 20px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 12,
            background: '#F8F8FC', border: '1px solid #EDEBE9',
            maxWidth: 280,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: isCompleted ? '#E6F4E6' : isMissed ? '#FDE7E0' : isDeclined ? '#FCECEA' : '#F0F0F0',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <CallIcon size={16} color={iconColor} />
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#242424', margin: 0, whiteSpace: 'nowrap' }}>
                {msg.content}
              </p>
              <p style={{ fontSize: 10, color: '#8A8886', margin: 0 }}>
                {format(new Date(msg.created_at), 'h:mm a')}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Generic system message (non-call)
    return (
      <div style={{ textAlign: 'center', fontSize: 12, color: '#8A8886', padding: '8px 20px', fontStyle: 'italic' }}>
        {msg.content}
      </div>
    );
  }

  if (msg.is_deleted) {
    return (
      <div style={{ display: 'flex', justifyContent: isOwn ? 'flex-end' : 'flex-start', padding: '2px 20px' }}>
        <div style={{ padding: '8px 14px', borderRadius: 12, background: '#F0F0F0', color: '#8A8886', fontSize: 13, fontStyle: 'italic' }}>
          This message was deleted
        </div>
      </div>
    );
  }

  const handleEdit = async () => {
    if (editText.trim() && editText !== msg.content) {
      try {
        await api.put(`/conversations/messages/${msg.id}`, { content: editText.trim() });
        // Optimistic: update local message immediately
        updateMessage(msg.conversation_id, { ...msg, content: editText.trim(), is_edited: true });
        getSocket()?.emit('message:edit', {
          messageId: msg.id,
          conversationId: msg.conversation_id,
          content: editText.trim(),
        });
      } catch (err) {
        console.error('Edit failed:', err);
      }
    }
    setIsEditing(false);
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/conversations/messages/${msg.id}`);
      // Optimistic: update local message to show [deleted] immediately
      updateMessage(msg.conversation_id, { ...msg, content: '[deleted]', deleted_at: new Date().toISOString(), type: 'text' });
      getSocket()?.emit('message:delete', {
        messageId: msg.id,
        conversationId: msg.conversation_id,
      });
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleReaction = async (emoji: string) => {
    try {
      // Optimistic update: check if we already reacted with this emoji
      const alreadyReacted = msg.reactions?.some(
        (r) => r.user_id === user?.id && r.emoji === emoji
      );

      // Optimistic local update
      if (alreadyReacted) {
        removeReaction(msg.conversation_id, msg.id, user!.id, emoji);
      } else {
        addReaction(msg.conversation_id, msg.id, user!.id, user!.username, emoji);
      }

      setShowReactions(false);

      // Use socket to save + broadcast (server handles DB insert/delete + room broadcast)
      getSocket()?.emit('message:reaction', {
        messageId: msg.id,
        emoji,
      });
    } catch (err) {
      console.error('Reaction failed:', err);
      // Rollback on error — re-fetch messages would be ideal but for now just log
    }
  };

  const handleReply = () => {
    setShowActions(false);
    if (onReply) {
      onReply(msg);
    }
  };

  const time = format(new Date(msg.created_at), 'HH:mm');
  const senderName = msg.sender_display_name || msg.sender_username || 'Unknown';
  const senderInitial = senderName[0]?.toUpperCase() || '?';
  const avatarColor = isOwn ? '#6264A7' : getAvatarColor(senderName);
  const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : (msg.metadata || {});
  const isAudio = (msg.type === 'file' && (meta.category === 'audio' || meta.mimeType?.startsWith('audio/')));
  const isFile = !isAudio && (msg.type === 'file' || msg.type === 'image');

  const isSending = msg.status === 'sending';
  const isFailed = msg.status === 'failed';

  const handleRetry = () => {
    const socket = getSocket();
    if (!socket || !msg.client_id) return;
    useChatStore.getState().updateMessageStatus(msg.conversation_id, msg.client_id, { status: 'sending' });
    const timeout = setTimeout(() => {
      useChatStore.getState().updateMessageStatus(msg.conversation_id, msg.client_id!, { status: 'failed' });
    }, 8000);
    socket.emit('message:send', {
      conversationId: msg.conversation_id,
      content: msg.content,
      type: msg.type,
      replyToId: msg.reply_to || null,
      metadata: msg.metadata || undefined,
      clientId: msg.client_id,
    }, (response: any) => {
      clearTimeout(timeout);
      if (!response?.success) {
        useChatStore.getState().updateMessageStatus(msg.conversation_id, msg.client_id!, { status: 'failed' });
      }
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isOwn ? 'row-reverse' : 'row',
        alignItems: 'flex-end',
        padding: '2px 20px',
        marginTop: showAvatar ? 16 : 2,
        position: 'relative',
        opacity: isSending ? 0.7 : 1,
        transition: 'opacity 0.2s',
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowReactions(false); }}
    >
      {/* Avatar */}
      <div style={{ width: 32, minWidth: 32, flexShrink: 0, [isOwn ? 'marginLeft' : 'marginRight']: 10 }}>
        {showAvatar && (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: avatarColor,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {senderInitial}
          </div>
        )}
      </div>

      {/* Bubble container */}
      <div style={{ maxWidth: '65%', display: 'flex', flexDirection: 'column', alignItems: isOwn ? 'flex-end' : 'flex-start' }}>
        {/* Sender name */}
        {showAvatar && !isOwn && (
          <span style={{ fontSize: 12, fontWeight: 600, color: avatarColor, marginBottom: 4, paddingLeft: 4 }}>
            {senderName}
          </span>
        )}
        {showAvatar && isOwn && (
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6264A7', marginBottom: 4, paddingRight: 4 }}>
            You
          </span>
        )}

        {/* Message bubble */}
        <div style={{ position: 'relative' }}>
          {/* Reply reference */}
          {msg.reply_message && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px',
                marginBottom: 2,
                borderRadius: '12px 12px 4px 4px',
                background: isOwn ? '#5558B2' : '#E8E8E8',
                borderLeft: `3px solid ${isOwn ? '#8B8FE0' : '#6264A7'}`,
                fontSize: 12,
                color: isOwn ? 'rgba(255,255,255,0.8)' : '#605E5C',
                maxWidth: '100%',
                overflow: 'hidden',
              }}
            >
              <CornerDownRight size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 11 }}>
                  {msg.reply_message.sender_display_name || msg.reply_message.sender_username || 'Unknown'}
                </span>
                <p style={{
                  margin: '1px 0 0 0', fontSize: 11,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  opacity: 0.8,
                }}>
                  {msg.reply_message.content}
                </p>
              </div>
            </div>
          )}

          <div
            style={{
              padding: isFile ? '10px 14px' : '10px 14px',
              borderRadius: isOwn
                ? (showAvatar && !msg.reply_message ? '16px 16px 4px 16px' : '16px 4px 4px 16px')
                : (showAvatar && !msg.reply_message ? '16px 16px 16px 4px' : '4px 16px 16px 4px'),
              background: isOwn ? '#6264A7' : '#F0F0F0',
              color: isOwn ? '#fff' : '#242424',
              fontSize: 14,
              lineHeight: 1.5,
              wordBreak: 'break-word' as const,
              boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
            }}
          >
            {isEditing ? (
              <div>
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleEdit();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  style={{
                    width: '100%',
                    background: isOwn ? 'rgba(255,255,255,0.15)' : '#fff',
                    border: `1px solid ${isOwn ? 'rgba(255,255,255,0.3)' : '#6264A7'}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 13,
                    color: isOwn ? '#fff' : '#242424',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                  }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 12 }}>
                  <button
                    onClick={handleEdit}
                    style={{ color: isOwn ? '#fff' : '#6264A7', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setIsEditing(false)}
                    style={{ color: isOwn ? 'rgba(255,255,255,0.7)' : '#605E5C', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : isAudio ? (
              <AudioPlayer fileUrl={msg.file_url} duration={msg.content} isOwn={isOwn} />
            ) : isFile ? (
              <div>
                {/* File attachment block */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {msg.type === 'image' && msg.file_url ? (
                    <img
                      src={msg.file_url}
                      alt={msg.file_name || 'Image'}
                      style={{ maxWidth: 300, maxHeight: 300, borderRadius: 8, cursor: 'pointer', objectFit: 'cover' }}
                      onClick={() => setImagePreview(true)}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <>
                      <div style={{
                        width: 36, height: 36, borderRadius: 8,
                        background: isOwn ? 'rgba(255,255,255,0.15)' : '#E1DFDD',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        <FileIcon size={18} color={isOwn ? 'rgba(255,255,255,0.8)' : '#605E5C'} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {msg.file_name}
                        </div>
                        {msg.file_size && (
                          <div style={{ fontSize: 11, opacity: 0.7 }}>{(msg.file_size / 1024).toFixed(0)} KB</div>
                        )}
                      </div>
                      {msg.file_url && (
                        <a href={msg.file_url} download style={{ color: isOwn ? '#fff' : '#6264A7', flexShrink: 0, padding: 4 }}>
                          <Download size={16} />
                        </a>
                      )}
                    </>
                  )}
                </div>
                {/* Show text content alongside file if provided (and it's not just the filename) */}
                {msg.content && msg.content !== msg.file_name && (
                  <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                    {msg.content}
                  </div>
                )}
              </div>
            ) : (
              renderContentWithMentions(msg.content, msg.metadata?.mentions, isOwn, user?.id)
            )}
          </div>

          {/* Inline translation (AI) */}
          {(showLangMenu || translating || translation) && (
            <div style={{ marginTop: 6 }}>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              {showLangMenu && !translation && !translating && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#8B8CA7', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Languages size={12} color="#6264A7" /> Translate to
                  </span>
                  {TRANSLATE_LANGS.map((l) => (
                    <button
                      key={l.lang}
                      onClick={() => handleTranslate(l.lang)}
                      title={`Translate to ${l.label}`}
                      style={{
                        padding: '4px 10px', borderRadius: 14, border: '1px solid #D8D6F5',
                        background: '#F3F2FA', color: '#4338CA', fontSize: 12, cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#E8E6F5'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#F3F2FA'; }}
                    >
                      {l.native}
                    </button>
                  ))}
                  <button onClick={() => setShowLangMenu(false)} style={translateLinkStyle} title="Cancel">Cancel</button>
                </div>
              )}
              {translating && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8B8CA7' }}>
                  <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Translating…
                </div>
              )}
              {translation && (
                <div
                  style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: isOwn ? 'rgba(98,100,167,0.08)' : '#F7F7FB',
                    border: '1px solid #E6E6F2', maxWidth: '100%',
                  }}
                >
                  <div style={{ fontSize: 14, color: '#242424', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {translation.text}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11, color: '#8B8CA7', flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Languages size={11} /> {TRANSLATE_LANGS.find((l) => l.lang === translation.lang)?.native}
                    </span>
                    <span>·</span>
                    <button onClick={() => { setTranslation(null); setShowLangMenu(true); }} style={translateLinkStyle}>Other language</button>
                    <span>·</span>
                    <button onClick={() => { setTranslation(null); setShowLangMenu(false); }} style={translateLinkStyle}>Hide</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Time + edited label + status indicators below bubble */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 3,
              justifyContent: isOwn ? 'flex-end' : 'flex-start',
              padding: '0 4px',
            }}
          >
            {isSending && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#A19F9D' }}>
                <Clock size={10} /> Sending...
              </span>
            )}
            {isFailed && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#D13438' }}>
                <AlertCircle size={10} /> Failed
                <button
                  onClick={handleRetry}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 2,
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: '#6264A7', fontSize: 10, fontWeight: 600,
                    padding: 0, fontFamily: 'inherit',
                  }}
                >
                  <RefreshCw size={10} /> Retry
                </button>
              </span>
            )}
            {!isSending && !isFailed && (
              <>
                {msg.is_edited && <span style={{ fontSize: 10, color: '#A19F9D', fontStyle: 'italic' }}>edited</span>}
                <span style={{ fontSize: 10, color: '#A19F9D' }}>{time}</span>
                {/* Teams-style "Seen" indicator — only on the latest own read message */}
                {isOwn && seen && (
                  <span
                    title={seenTooltip || 'Seen'}
                    aria-label={seenTooltip || 'Seen'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: '#6264A7', marginLeft: 2 }}
                  >
                    <Eye size={12} />
                    {seenText ? <span style={{ fontSize: 10, fontWeight: 600 }}>{seenText}</span> : null}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Reactions */}
          {msg.reactions && msg.reactions.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: isOwn ? 'flex-end' : 'flex-start' }}>
              {groupReactions(msg.reactions).map(([emoji, count, hasOwn]) => (
                <button
                  key={emoji}
                  onClick={() => handleReaction(emoji)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '2px 8px', borderRadius: 12,
                    background: hasOwn ? '#E8E8FA' : '#F0F0FA',
                    border: hasOwn ? '1px solid #6264A7' : '1px solid #E0E1F5',
                    cursor: 'pointer', fontSize: 13,
                    transition: 'all 0.12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#DDDDF5'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = hasOwn ? '#E8E8FA' : '#F0F0FA'; }}
                >
                  <span>{emoji}</span>
                  {count > 1 && <span style={{ fontSize: 11, color: hasOwn ? '#6264A7' : '#605E5C', fontWeight: hasOwn ? 600 : 400 }}>{count}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Hover Actions */}
          {showActions && !isEditing && (
            <div
              style={{
                position: 'absolute',
                top: -12,
                [isOwn ? 'left' : 'right']: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                background: '#fff',
                boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
                borderRadius: 6,
                border: '1px solid #E1DFDD',
                padding: 2,
                zIndex: 10,
              }}
            >
              <ActionButton icon={<SmilePlus size={14} />} onClick={() => setShowReactions(!showReactions)} title="React" />
              <ActionButton icon={<Reply size={14} />} onClick={handleReply} title="Reply" />
              {!!(msg.content && msg.content.trim()) && (
                <ActionButton
                  icon={<Languages size={14} />}
                  onClick={() => { setShowActions(false); setTranslation(null); setShowLangMenu(true); }}
                  title="Translate"
                />
              )}
              {isOwn && (
                <>
                  <ActionButton icon={<Pencil size={14} />} onClick={() => { setIsEditing(true); setEditText(msg.content); }} title="Edit" />
                  <ActionButton icon={<Trash2 size={14} />} onClick={handleDelete} title="Delete" />
                </>
              )}
            </div>
          )}

          {/* Emoji picker */}
          {showReactions && (
            <div
              style={{
                position: 'absolute',
                [isOwn ? 'right' : 'left']: 0,
                top: -44,
                display: 'flex', gap: 2,
                background: '#fff',
                boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
                borderRadius: 20,
                border: '1px solid #E1DFDD',
                padding: '6px 10px',
                zIndex: 20,
              }}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => handleReaction(emoji)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 20, padding: '2px 4px', borderRadius: 6,
                    transition: 'transform 0.12s, background 0.12s',
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.3)'; e.currentTarget.style.background = '#F0F0FA'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = 'none'; }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Image Preview Modal */}
      {imagePreview && msg.file_url && (
        <div
          onClick={() => setImagePreview(false)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999,
            cursor: 'zoom-out',
          }}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <img
              src={msg.file_url}
              alt={msg.file_name || 'Image'}
              style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 8, objectFit: 'contain' }}
            />
            <div style={{
              position: 'absolute', bottom: -40, left: 0, right: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
            }}>
              <span style={{ color: '#fff', fontSize: 13 }}>{msg.file_name}</span>
              <a
                href={msg.file_url}
                download
                onClick={(e) => e.stopPropagation()}
                style={{
                  color: '#fff', background: 'rgba(255,255,255,0.15)',
                  padding: '6px 14px', borderRadius: 6, fontSize: 12,
                  textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <Download size={14} /> Download
              </a>
            </div>
            <button
              onClick={() => setImagePreview(false)}
              style={{
                position: 'absolute', top: -12, right: -12,
                width: 32, height: 32, borderRadius: 16,
                background: 'rgba(255,255,255,0.2)', border: 'none',
                color: '#fff', fontSize: 18, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AudioPlayer({ fileUrl, duration, isOwn }: { fileUrl?: string | null; duration?: string; isOwn: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);

  const toggle = () => {
    if (!audioRef.current || !fileUrl) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play();
      setPlaying(true);
    }
  };

  const onTimeUpdate = () => {
    if (!audioRef.current) return;
    const cur = audioRef.current.currentTime;
    const dur = audioRef.current.duration || 1;
    setProgress((cur / dur) * 100);
    setCurTime(cur);
  };

  const onLoaded = () => {
    if (audioRef.current && isFinite(audioRef.current.duration)) {
      setTotalDuration(audioRef.current.duration);
    }
  };

  const onEnded = () => { setPlaying(false); setProgress(0); setCurTime(0); };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * (audioRef.current.duration || 0);
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  // Extract duration hint from content like "Voice message (01:23)"
  const durationHint = duration?.match(/\((\d{2}:\d{2})\)/)?.[1] || '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
      <audio
        ref={audioRef}
        src={fileUrl || ''}
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoaded}
        onEnded={onEnded}
        style={{ display: 'none' }}
      />
      <button
        onClick={toggle}
        style={{
          width: 36, height: 36, borderRadius: 18, border: 'none',
          background: isOwn ? 'rgba(255,255,255,0.2)' : '#6264A7',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: isOwn ? '#fff' : '#fff', flexShrink: 0,
          transition: 'background 0.12s',
        }}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Progress bar */}
        <div
          onClick={seek}
          style={{
            height: 4, borderRadius: 2, cursor: 'pointer',
            background: isOwn ? 'rgba(255,255,255,0.25)' : '#E1DFDD',
            position: 'relative', overflow: 'hidden',
          }}
        >
          <div style={{
            width: `${progress}%`, height: '100%', borderRadius: 2,
            background: isOwn ? '#fff' : '#6264A7',
            transition: playing ? 'none' : 'width 0.2s',
          }} />
        </div>
        <span style={{
          fontSize: 11, fontFamily: 'monospace',
          color: isOwn ? 'rgba(255,255,255,0.75)' : '#605E5C',
        }}>
          {playing || currentTime > 0 ? fmt(currentTime) : (durationHint || fmt(totalDuration))}
          {totalDuration > 0 && ` / ${fmt(totalDuration)}`}
        </span>
      </div>
      {fileUrl && (
        <a href={fileUrl} download style={{ color: isOwn ? 'rgba(255,255,255,0.7)' : '#6264A7', flexShrink: 0, padding: 4 }}>
          <Download size={14} />
        </a>
      )}
    </div>
  );
}

function ActionButton({ icon, onClick, title }: { icon: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: 5, borderRadius: 4, background: 'none', border: 'none',
        cursor: 'pointer', color: '#605E5C', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.1s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#F5F5F5'; e.currentTarget.style.color = '#242424'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#605E5C'; }}
    >
      {icon}
    </button>
  );
}

function groupReactions(reactions: { emoji: string; user_id?: string }[]): [string, number, boolean][] {
  const userId = useAuthStore.getState().user?.id;
  const map = new Map<string, { count: number; hasOwn: boolean }>();
  reactions.forEach((r) => {
    const existing = map.get(r.emoji) || { count: 0, hasOwn: false };
    existing.count++;
    if (r.user_id === userId) existing.hasOwn = true;
    map.set(r.emoji, existing);
  });
  return Array.from(map.entries()).map(([emoji, { count, hasOwn }]) => [emoji, count, hasOwn]);
}
