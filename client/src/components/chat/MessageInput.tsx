import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Paperclip, Smile, X, Image, CornerDownRight, Plus, Mic, Square, Play, Pause, Trash2, Sparkles, Loader2, Undo2 } from 'lucide-react';
import EmojiPickerReact, { Theme, Categories, EmojiStyle } from 'emoji-picker-react';
import { getSocket } from '@/services/socket';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import api from '@/services/api';
import { aiRewrite, aiSuggestReplies, REWRITE_MODES, type RewriteMode } from '@/services/ai';
import MentionDropdown, { getMentionFilteredCount, getMentionItemAtIndex } from './MentionDropdown';
import type { Message, MentionData, ConversationMember } from '@/types';

const SEND_TIMEOUT_MS = 8000;

interface Props {
  conversationId: string;
  replyTo?: Message | null;
  onClearReply?: () => void;
}

export default function MessageInput({ conversationId, replyTo, onClearReply }: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [showEmojiBar, setShowEmojiBar] = useState(false);
  const [showFullPicker, setShowFullPicker] = useState(false);
  // Voice recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  // @mention state
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number | null>(null);
  const [pendingMentions, setPendingMentions] = useState<MentionData[]>([]);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emojiContainerRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  // ── AI: Smart Compose (rewrite) + Smart Reply state ──
  const [showAiMenu, setShowAiMenu] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUndo, setAiUndo] = useState<string | null>(null);   // pre-rewrite snapshot
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const lastSuggestedMsgIdRef = useRef<string | null>(null);
  const { user } = useAuthStore();
  const { addMessage, updateMessageStatus } = useChatStore();
  const activeConversation = useChatStore((s) => s.activeConversation);
  const convMessages = useChatStore((s) => s.messages[conversationId]);
  const mentionMembers = (activeConversation?.members || []).filter((m) => m.user_id !== user?.id);

  // Focus textarea when reply is set
  useEffect(() => {
    if (replyTo) {
      textareaRef.current?.focus();
    }
  }, [replyTo]);

  // Close emoji on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (emojiContainerRef.current && !emojiContainerRef.current.contains(e.target as Node)) {
        setShowEmojiBar(false);
        setShowFullPicker(false);
      }
    };
    if (showEmojiBar || showFullPicker) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEmojiBar, showFullPicker]);

  // Close mention dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setShowMentions(false);
      }
    };
    if (showMentions) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMentions]);

  // Close the AI rewrite menu on click outside
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) setShowAiMenu(false);
    };
    if (showAiMenu) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showAiMenu]);

  // ── Smart Reply: when the newest message is from the OTHER person, ask the
  // LLM for 3 quick replies. Generated once per message id (no spam), and only
  // for normal text messages. Failures are silent — chips just don't appear.
  useEffect(() => {
    const msgs = convMessages || [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    if (!last || last.sender_id === user?.id || last.type === 'system' || last.is_deleted || !last.content?.trim()) {
      setQuickReplies([]);
      return;
    }
    if (lastSuggestedMsgIdRef.current === last.id) return;
    lastSuggestedMsgIdRef.current = last.id;

    // Map to chat roles: the other party = "user" (speaking to us), our own
    // messages = "assistant" (so the model continues as US for the next line).
    const ctx = msgs
      .slice(-6)
      .map((m) => ({
        role: (m.sender_id === user?.id ? 'assistant' : 'user') as 'user' | 'assistant',
        content: (m.content || '').trim(),
      }))
      .filter((m) => m.content);
    if (ctx.length === 0) { setQuickReplies([]); return; }

    setQuickRepliesLoading(true);
    setQuickReplies([]);
    aiSuggestReplies(ctx)
      .then((r) => setQuickReplies(r))
      .catch(() => setQuickReplies([]))
      .finally(() => setQuickRepliesLoading(false));
  }, [convMessages, user?.id]);

  // ── Smart Compose: rewrite the current draft in the chosen style ──
  const handleRewrite = async (mode: RewriteMode) => {
    const current = text.trim();
    if (!current || aiBusy) return;
    setShowAiMenu(false);
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await aiRewrite(current, mode);
      if (result) {
        setAiUndo(text);          // snapshot so the user can revert
        setText(result);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    } catch (err: any) {
      setAiError(err?.response?.data?.error || 'AI is unavailable right now');
      setTimeout(() => setAiError(null), 4000);
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiUndo = () => {
    if (aiUndo !== null) {
      setText(aiUndo);
      setAiUndo(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  // Insert a suggested quick reply into the composer (user can edit, then Enter).
  const useQuickReply = (reply: string) => {
    setText(reply);
    setQuickReplies([]);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Detect @mention trigger in text
  const detectMention = useCallback((value: string, cursorPos: number) => {
    const textBefore = value.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex === -1) { setShowMentions(false); return; }
    // "@" must be at start or preceded by whitespace
    if (atIndex > 0 && !/\s/.test(textBefore[atIndex - 1])) { setShowMentions(false); return; }
    const query = textBefore.slice(atIndex + 1);
    // If query has a space, user moved on
    if (query.includes(' ')) { setShowMentions(false); return; }
    setMentionQuery(query);
    setMentionStartPos(atIndex);
    setMentionIndex(0);
    setShowMentions(true);
  }, []);

  // Handle selecting a member from mention dropdown
  const handleMentionSelect = useCallback((member: ConversationMember | 'everyone') => {
    if (mentionStartPos === null) return;
    const isEveryone = member === 'everyone';
    const displayText = isEveryone ? '@everyone' : `@${(member as ConversationMember).display_name}`;
    const cursorPos = textareaRef.current?.selectionStart || text.length;
    const before = text.slice(0, mentionStartPos);
    const after = text.slice(cursorPos);
    const newText = before + displayText + ' ' + after;
    setText(newText);
    // Track mention (deduplicate)
    const mentionData: MentionData = isEveryone
      ? { userId: 'everyone', username: 'everyone', displayName: 'everyone' }
      : { userId: (member as ConversationMember).user_id, username: (member as ConversationMember).username, displayName: (member as ConversationMember).display_name };
    setPendingMentions((prev) => {
      if (prev.some((m) => m.userId === mentionData.userId)) return prev;
      return [...prev, mentionData];
    });
    setShowMentions(false);
    setMentionStartPos(null);
    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = before.length + displayText.length + 1;
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursorPos;
      }
    }, 0);
  }, [text, mentionStartPos]);

  // Frequent emojis stored in localStorage
  const getFrequentEmojis = (): string[] => {
    try {
      const stored = localStorage.getItem('connecthub_frequent_emojis');
      return stored ? JSON.parse(stored) : ['😊', '👍', '❤️', '😂', '🔥', '🎉', '👌', '😍'];
    } catch { return ['😊', '👍', '❤️', '😂', '🔥', '🎉', '👌', '😍']; }
  };

  const trackEmojiUsage = (emoji: string) => {
    try {
      const freq: string[] = getFrequentEmojis();
      const filtered = freq.filter((e) => e !== emoji);
      filtered.unshift(emoji);
      localStorage.setItem('connecthub_frequent_emojis', JSON.stringify(filtered.slice(0, 20)));
    } catch { /* ignore */ }
  };

  const insertEmoji = (emoji: string) => {
    trackEmojiUsage(emoji);
    const ta = textareaRef.current;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newText = text.slice(0, start) + emoji + text.slice(end);
      setText(newText);
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + emoji.length;
      }, 0);
    } else {
      setText((prev) => prev + emoji);
    }
  };

  const handleEmojiClick = (emojiData: { emoji: string }) => {
    insertEmoji(emojiData.emoji);
    setShowFullPicker(false);
    setShowEmojiBar(false);
  };

  // Voice recording functions
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
      alert('Please allow microphone access to record voice messages.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setIsRecording(false);
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    setIsRecording(false);
    setAudioBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setRecordingTime(0);
  };

  const togglePreviewPlayback = () => {
    if (!previewAudioRef.current || !audioUrl) return;
    if (isPlayingPreview) {
      previewAudioRef.current.pause();
      setIsPlayingPreview(false);
    } else {
      previewAudioRef.current.src = audioUrl;
      previewAudioRef.current.play();
      setIsPlayingPreview(true);
      previewAudioRef.current.onended = () => setIsPlayingPreview(false);
    }
  };

  const sendVoiceMessage = async () => {
    if (!audioBlob) return;
    setIsSending(true);
    try {
      const ext = audioBlob.type.includes('webm') ? 'webm' : 'ogg';
      const file = new File([audioBlob], `voice-message-${Date.now()}.${ext}`, { type: audioBlob.type });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('content', `Voice message (${formatTime(recordingTime)})`);

      const { data } = await api.post(`/files/conversations/${conversationId}/files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      if (data.message) {
        const socket = getSocket();
        const voiceMsg = {
          ...data.message,
          sender_id: user?.id,
          sender_username: user?.username,
          sender_display_name: user?.display_name,
          file_url: data.message.metadata?.fileUrl || data.file?.fileUrl,
          file_name: data.message.metadata?.fileName || data.file?.original_name,
          file_size: data.message.metadata?.fileSize || data.file?.size_bytes,
        };
        addMessage(conversationId, voiceMsg);
        socket?.emit('message:file', { conversationId, message: voiceMsg });
      }

      // Cleanup
      setAudioBlob(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setRecordingTime(0);
      if (previewAudioRef.current) previewAudioRef.current.pause();
      setIsPlayingPreview(false);
    } catch (err) {
      console.error('Voice send failed:', err);
    } finally {
      setIsSending(false);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, []);

  const handleTyping = useCallback(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('typing:start', { conversationId });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('typing:stop', { conversationId });
    }, 2000);
  }, [conversationId]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    if (isSending) return;

    setIsSending(true);

    try {
      const socket = getSocket();
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      socket?.emit('typing:stop', { conversationId });

      if (files.length > 0) {
        for (const file of files) {
          const formData = new FormData();
          formData.append('file', file);
          if (trimmed) formData.append('content', trimmed);
          if (replyTo) formData.append('replyToId', replyTo.id);

          const { data } = await api.post(`/files/conversations/${conversationId}/files`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });

          // Add the file message locally + notify other users via socket
          if (data.message) {
            const fileMsg = {
              ...data.message,
              sender_id: user?.id,
              sender_username: user?.username,
              sender_display_name: user?.display_name,
              file_url: data.message.metadata?.fileUrl || data.file?.fileUrl,
              file_name: data.message.metadata?.fileName || data.file?.original_name,
              file_size: data.message.metadata?.fileSize || data.file?.size_bytes,
            };
            addMessage(conversationId, fileMsg);
            socket?.emit('message:file', { conversationId, message: fileMsg });
          }
        }
      } else {
        // Optimistic send with client-generated ID for idempotency
        const clientId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2)));
        const optimisticMsg = {
          id: `optimistic-${clientId}`,
          conversation_id: conversationId,
          sender_id: user?.id,
          sender_username: user?.username,
          sender_display_name: user?.display_name,
          sender_avatar: user?.avatar_url || null,
          content: trimmed,
          type: 'text' as const,
          reply_to: replyTo?.id || null,
          reply_message: replyTo ? {
            id: replyTo.id,
            content: replyTo.content,
            sender_display_name: replyTo.sender_display_name,
            sender_username: replyTo.sender_username,
          } : null,
          metadata: pendingMentions.length > 0 ? { mentions: pendingMentions } : {},
          is_edited: false,
          is_deleted: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_url: null,
          file_name: null,
          file_size: null,
          client_id: clientId,
          status: 'sending' as const,
          reactions: [],
        };

        // Show message immediately
        addMessage(conversationId, optimisticMsg);

        // Emit with callback for server confirmation
        const timeout = setTimeout(() => {
          updateMessageStatus(conversationId, clientId, { status: 'failed' });
        }, SEND_TIMEOUT_MS);

        socket?.emit('message:send', {
          conversationId,
          content: trimmed,
          type: 'text',
          replyToId: replyTo?.id || null,
          metadata: pendingMentions.length > 0 ? { mentions: pendingMentions } : undefined,
          clientId,
        }, (response: any) => {
          clearTimeout(timeout);
          if (!response?.success) {
            updateMessageStatus(conversationId, clientId, { status: 'failed' });
          }
          // On success, the server broadcasts message:new which triggers addMessage
          // which will replace the optimistic message via client_id match
        });
      }

      setText('');
      setFiles([]);
      setPendingMentions([]);
      setAiUndo(null);
      setQuickReplies([]);
      onClearReply?.();
      textareaRef.current?.focus();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @mention keyboard navigation takes priority
    if (showMentions) {
      const totalItems = getMentionFilteredCount(mentionMembers, mentionQuery);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => Math.min(prev + 1, totalItems - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = getMentionItemAtIndex(mentionMembers, mentionQuery, mentionIndex);
        if (item) handleMentionSelect(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && replyTo) {
      onClearReply?.();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  // Paste-to-attach: when the clipboard holds a file (e.g. a screenshot copied
  // with Win+Shift+S / PrintScreen, or a copied image/document), attach it like
  // any picked file. Screenshots arrive with no filename, so we name them.
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (!f) continue;
        const ext = (f.type.split('/')[1] || 'png').split('+')[0];
        const named = f.name && f.name !== 'image.png'
          ? f
          : new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
        pasted.push(named);
      }
    }
    if (pasted.length > 0) {
      e.preventDefault(); // don't also dump raw image data into the text box
      setFiles((prev) => [...prev, ...pasted]);
    }
  };

  const removeFile = (idx: number) => {
    setFiles((f) => f.filter((_, i) => i !== idx));
  };

  const canSend = text.trim() || files.length > 0;

  return (
    <div
      style={{
        padding: '12px 20px 16px',
        background: '#fff',
        flexShrink: 0,
      }}
    >
      {/* Reply Preview */}
      {replyTo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            marginBottom: 8,
            background: '#F5F5FA',
            borderRadius: 8,
            borderLeft: '3px solid #6264A7',
          }}
        >
          <CornerDownRight size={14} color="#6264A7" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: '#6264A7', margin: '0 0 1px 0' }}>
              Replying to {replyTo.sender_display_name || replyTo.sender_username || 'Unknown'}
            </p>
            <p style={{
              fontSize: 12, color: '#605E5C', margin: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {replyTo.content}
            </p>
          </div>
          <button
            onClick={onClearReply}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#A19F9D', padding: 4, borderRadius: 4, display: 'flex',
              flexShrink: 0, transition: 'color 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#D13438'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#A19F9D'; }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Hidden audio element for preview playback */}
      <audio ref={previewAudioRef} style={{ display: 'none' }} />

      {/* Recording Mode UI */}
      {isRecording && (
        <div
          style={{
            border: '1px solid #D13438',
            borderRadius: 8,
            background: '#FFF5F5',
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {/* Pulsing red dot */}
          <div style={{
            width: 12, height: 12, borderRadius: 6, background: '#D13438', flexShrink: 0,
            animation: 'voicePulse 1.2s ease-in-out infinite',
          }} />
          <style>{`@keyframes voicePulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }`}</style>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#D13438' }}>Recording...</span>
          <span style={{ fontSize: 20, fontWeight: 600, color: '#242424', fontFamily: 'monospace', minWidth: 52 }}>
            {formatTime(recordingTime)}
          </span>
          <div style={{ flex: 1 }} />
          {/* Cancel button */}
          <button
            onClick={cancelRecording}
            title="Cancel"
            style={{
              width: 36, height: 36, borderRadius: 18, border: 'none',
              background: '#FDE7E9', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#D13438',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F5C6CB'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#FDE7E9'; }}
          >
            <Trash2 size={16} />
          </button>
          {/* Stop button */}
          <button
            onClick={stopRecording}
            title="Stop recording"
            style={{
              width: 40, height: 40, borderRadius: 20, border: 'none',
              background: '#D13438', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#fff',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#B52E31'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#D13438'; }}
          >
            <Square size={16} fill="#fff" />
          </button>
        </div>
      )}

      {/* Voice Preview Mode UI */}
      {!isRecording && audioBlob && (
        <div
          style={{
            border: '1px solid #6264A7',
            borderRadius: 8,
            background: '#F5F5FA',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          {/* Play/Pause */}
          <button
            onClick={togglePreviewPlayback}
            style={{
              width: 40, height: 40, borderRadius: 20, border: 'none',
              background: '#6264A7', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#fff',
              transition: 'background 0.12s', flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#5558B2'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#6264A7'; }}
          >
            {isPlayingPreview ? <Pause size={16} fill="#fff" /> : <Play size={16} fill="#fff" />}
          </button>
          {/* Waveform placeholder bar */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              flex: 1, height: 4, borderRadius: 2, background: '#D8D6F5',
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{ width: '100%', height: '100%', borderRadius: 2, background: '#6264A7' }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6264A7', fontFamily: 'monospace', flexShrink: 0 }}>
              {formatTime(recordingTime)}
            </span>
          </div>
          {/* Delete */}
          <button
            onClick={cancelRecording}
            title="Delete recording"
            style={{
              width: 36, height: 36, borderRadius: 18, border: 'none',
              background: '#FDE7E9', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#D13438',
              transition: 'background 0.12s', flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F5C6CB'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#FDE7E9'; }}
          >
            <Trash2 size={16} />
          </button>
          {/* Send */}
          <button
            onClick={sendVoiceMessage}
            disabled={isSending}
            title="Send voice message"
            style={{
              width: 40, height: 40, borderRadius: 20, border: 'none',
              background: '#6264A7', cursor: isSending ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              transition: 'background 0.12s', flexShrink: 0,
              opacity: isSending ? 0.6 : 1,
            }}
            onMouseEnter={(e) => { if (!isSending) e.currentTarget.style.background = '#5558B2'; }}
            onMouseLeave={(e) => { if (!isSending) e.currentTarget.style.background = '#6264A7'; }}
          >
            <Send size={16} />
          </button>
        </div>
      )}

      {/* Smart Reply chips — AI suggestions for the latest incoming message */}
      {!isRecording && !audioBlob && (quickRepliesLoading || quickReplies.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#8B8CA7', fontWeight: 600 }}>
            <Sparkles size={12} color="#6264A7" /> Smart replies
          </span>
          {quickRepliesLoading && quickReplies.length === 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#A19F9D' }}>
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> thinking…
            </span>
          )}
          {quickReplies.map((r, i) => (
            <button
              key={i}
              onClick={() => useQuickReply(r)}
              title={r}
              style={{
                padding: '6px 12px', borderRadius: 16, border: '1px solid #D8D6F5',
                background: '#F3F2FA', color: '#4338CA', fontSize: 13, cursor: 'pointer',
                fontFamily: 'inherit', maxWidth: 340, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#E8E6F5'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#F3F2FA'; }}
            >
              {r}
            </button>
          ))}
        </div>
      )}

      {/* Normal Compose box (hidden during recording/preview) */}
      {!isRecording && !audioBlob && (
        <div
          style={{
            border: isFocused ? '1px solid #6264A7' : '1px solid #E1DFDD',
            borderRadius: 8,
            background: '#fff',
            boxShadow: isFocused ? '0 0 0 2px rgba(98, 100, 167, 0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            overflow: 'visible',
          }}
        >
          {/* File Previews */}
          {files.length > 0 && (
            <div style={{ padding: '10px 14px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {files.map((file, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#F5F5F5',
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 12,
                    border: '1px solid #E1DFDD',
                  }}
                >
                  <Paperclip size={12} color="#605E5C" />
                  <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#242424' }}>
                    {file.name}
                  </span>
                  <span style={{ color: '#A19F9D', fontSize: 11 }}>
                    {(file.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    onClick={() => removeFile(idx)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#A19F9D', padding: 2, display: 'flex' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#D13438'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#A19F9D'; }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* @Mention Dropdown */}
          {showMentions && (
            <div
              ref={mentionContainerRef}
              style={{ position: 'relative' }}
            >
              <div style={{ position: 'absolute', bottom: 0, left: 12, zIndex: 100 }}>
                <MentionDropdown
                  members={mentionMembers}
                  query={mentionQuery}
                  selectedIndex={mentionIndex}
                  onSelect={handleMentionSelect}
                  onClose={() => setShowMentions(false)}
                />
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              const value = e.target.value;
              const cursorPos = e.target.selectionStart || 0;
              setText(value);
              handleTyping();
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              detectMention(value, cursorPos);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={replyTo ? 'Type your reply...' : 'Type a message...'}
            rows={1}
            style={{
              width: '100%',
              resize: 'none',
              border: 'none',
              outline: 'none',
              padding: '14px 16px 6px',
              fontSize: 14,
              lineHeight: 1.5,
              color: '#242424',
              background: 'transparent',
              maxHeight: 120,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />

          {/* Bottom toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 8px 8px',
            }}
          >
            {/* Left actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <ToolbarButton
                icon={<Paperclip size={18} />}
                title="Attach file"
                onClick={() => fileInputRef.current?.click()}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <ToolbarButton icon={<Image size={18} />} title="Insert image" onClick={() => fileInputRef.current?.click()} />
              <div style={{ position: 'relative' }} ref={emojiContainerRef}>
                <ToolbarButton
                  icon={<Smile size={18} />}
                  title="Emoji"
                  onClick={() => {
                    if (showFullPicker || showEmojiBar) {
                      setShowFullPicker(false);
                      setShowEmojiBar(false);
                    } else {
                      setShowEmojiBar(true);
                    }
                  }}
                />

                {/* Quick frequent emoji bar with + button */}
                {showEmojiBar && !showFullPicker && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 42,
                      left: -8,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0,
                      background: '#fff',
                      boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                      borderRadius: 28,
                      border: '1px solid #E1DFDD',
                      padding: '4px 6px',
                      zIndex: 100,
                      width: 'max-content',
                    }}
                  >
                    {getFrequentEmojis().slice(0, 8).map((emoji) => (
                      <span
                        key={emoji}
                        onClick={() => { insertEmoji(emoji); setShowEmojiBar(false); }}
                        style={{
                          width: 36, height: 36,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 20, cursor: 'pointer', borderRadius: 8,
                          userSelect: 'none',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#F0F0FA'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
                      >
                        {emoji}
                      </span>
                    ))}
                    {/* Divider line */}
                    <span style={{ display: 'inline-block', width: 1, height: 24, background: '#E1DFDD', margin: '0 4px', flexShrink: 0 }} />
                    {/* "+" button — opens full emoji picker */}
                    <span
                      onClick={() => setShowFullPicker(true)}
                      style={{
                        width: 36, height: 36,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: '#F3F2FA', borderRadius: 8,
                        cursor: 'pointer', color: '#6264A7', border: '1.5px solid #D8D6F5',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#E8E6F5'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#F3F2FA'; }}
                      title="All emojis"
                    >
                      <Plus size={16} />
                    </span>
                  </div>
                )}

                {/* Full emoji picker (opens when clicking +) */}
                {showFullPicker && (
                  <div style={{
                    position: 'absolute',
                    bottom: 42,
                    left: -8,
                    zIndex: 100,
                    borderRadius: 12,
                    overflow: 'hidden',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                    border: '1px solid #E1DFDD',
                    background: '#fff',
                  }}>
                    <EmojiPickerReact
                      onEmojiClick={handleEmojiClick}
                      theme={Theme.LIGHT}
                      emojiStyle={EmojiStyle.NATIVE}
                      width={380}
                      height={450}
                      searchPlaceholder="Find an emoji"
                      lazyLoadEmojis
                      skinTonesDisabled
                      previewConfig={{ showPreview: false }}
                      autoFocusSearch={false}
                      suggestedEmojisMode={"recent" as any}
                      categories={[
                        { name: 'Recent', category: Categories.SUGGESTED },
                        { name: 'Smileys & People', category: Categories.SMILEYS_PEOPLE },
                        { name: 'Animals & Nature', category: Categories.ANIMALS_NATURE },
                        { name: 'Food & Drink', category: Categories.FOOD_DRINK },
                        { name: 'Travel & Places', category: Categories.TRAVEL_PLACES },
                        { name: 'Activities', category: Categories.ACTIVITIES },
                        { name: 'Objects', category: Categories.OBJECTS },
                        { name: 'Symbols', category: Categories.SYMBOLS },
                        { name: 'Flags', category: Categories.FLAGS },
                      ]}
                    />
                  </div>
                )}
              </div>
              {/* Voice Record Button */}
              <ToolbarButton
                icon={<Mic size={18} />}
                title="Record voice message"
                onClick={startRecording}
              />

              {/* AI Smart Compose — rewrite the current draft */}
              <div style={{ position: 'relative' }} ref={aiMenuRef}>
                <ToolbarButton
                  icon={aiBusy
                    ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                    : <Sparkles size={18} color={text.trim() ? '#6264A7' : undefined} />}
                  title={text.trim() ? 'AI — rewrite your draft' : 'Type something first, then rewrite with AI'}
                  onClick={() => { if (!aiBusy && text.trim()) setShowAiMenu((v) => !v); }}
                />
                {showAiMenu && (
                  <div
                    style={{
                      position: 'absolute', bottom: 42, left: -8, background: '#fff',
                      border: '1px solid #E1DFDD', borderRadius: 10,
                      boxShadow: '0 8px 28px rgba(0,0,0,0.16)', padding: 6, zIndex: 100,
                      width: 'max-content', minWidth: 180,
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#8B8CA7', textTransform: 'uppercase', letterSpacing: 0.4, padding: '4px 10px 6px' }}>
                      Rewrite with AI
                    </div>
                    {REWRITE_MODES.map(({ mode, label }) => (
                      <button
                        key={mode}
                        onClick={() => handleRewrite(mode)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          textAlign: 'left', padding: '8px 10px', border: 'none',
                          background: 'transparent', borderRadius: 6, cursor: 'pointer',
                          fontSize: 13, color: '#242424', fontFamily: 'inherit',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#F3F2FA'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Sparkles size={13} color="#6264A7" /> {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={isSending || !canSend}
              title="Send (Enter)"
              style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                border: 'none',
                cursor: canSend && !isSending ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: canSend && !isSending ? '#6264A7' : '#F0F0F0',
                color: canSend && !isSending ? '#fff' : '#C8C6C4',
                transition: 'all 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (canSend && !isSending) {
                  e.currentTarget.style.background = '#5558B2';
                }
              }}
              onMouseLeave={(e) => {
                if (canSend && !isSending) {
                  e.currentTarget.style.background = '#6264A7';
                }
              }}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {/* AI status: rewrite error or undo affordance */}
      {(aiError || aiUndo !== null) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 6 }}>
          {aiError && <span style={{ fontSize: 11, color: '#D13438' }}>{aiError}</span>}
          {aiUndo !== null && !aiError && (
            <button
              onClick={handleAiUndo}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
                color: '#6264A7', background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontWeight: 600,
              }}
            >
              <Undo2 size={12} /> Undo AI rewrite
            </button>
          )}
        </div>
      )}

      {/* Hint text */}
      <div style={{ textAlign: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: '#C8C6C4' }}>
          Press <strong style={{ color: '#A19F9D' }}>Enter</strong> to send, <strong style={{ color: '#A19F9D' }}>Shift+Enter</strong> for new line
          {replyTo && <>, <strong style={{ color: '#A19F9D' }}>Esc</strong> to cancel reply</>}
        </span>
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 32,
        height: 32,
        borderRadius: 4,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: '#605E5C',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.1s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#F5F5F5';
        e.currentTarget.style.color = '#242424';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = '#605E5C';
      }}
    >
      {icon}
    </button>
  );
}


