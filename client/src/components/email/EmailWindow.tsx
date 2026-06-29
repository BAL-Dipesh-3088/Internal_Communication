import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Mail, Send, Paperclip, Bold, Italic, Underline, Link2, Image,
  Reply, ReplyAll, Forward, Trash2, Archive, Star, StarOff,
  ChevronDown, Plus, Inbox, SendHorizontal, FileText, Users,
  Search, MoreVertical, X, RefreshCw, Loader, Pin, PinOff, Sparkles, Languages,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { useAuthStore } from '@/stores/authStore';
import api from '@/services/api';
import { useMailStore } from '@/stores/mailStore';
import { aiRewrite, aiTranslate, REWRITE_MODES, TRANSLATE_LANGS, type RewriteMode, type TranslateLang } from '@/services/ai';

/* ===================================================================
   FOLDER DEFINITIONS — counts are fetched dynamically from API
   =================================================================== */


/* ===================================================================
   HELPER FUNCTIONS
   =================================================================== */
function formatEmailDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 24 * 3600000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (diff < 48 * 3600000) return 'Yesterday';
  if (diff < 7 * 24 * 3600000) return d.toLocaleDateString('en', { weekday: 'short' });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

const AVATAR_COLORS = ['#0078D4', '#107C10', '#D83B01', '#5C2D91', '#008272', '#B4009E', '#E81123', '#00188F'];
function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/* ===================================================================
   MAIN EMAIL WINDOW
   =================================================================== */
export default function EmailWindow() {
  const { user } = useAuthStore();
  const [activeFolder, setActiveFolder] = useState('inbox');
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [editingDraft, setEditingDraft] = useState<any>(null);
  const [replyTo, setReplyTo] = useState<any>(null);
  const [forwardEmail, setForwardEmail] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [emails, setEmails] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({ sent: 0, draft: 0, deleted: 0 });
  const prevInboxCountRef = useRef<number>(0);
  const isRefreshing = useRef(false);

  // Persist read email IDs in localStorage so they survive refresh
  const getReadIds = (): Set<string> => {
    try {
      const stored = localStorage.getItem('bal_read_emails');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  };
  const readEmailIds = useRef<Set<string>>(getReadIds());
  const markAsRead = (id: string) => {
    readEmailIds.current.add(id);
    try {
      localStorage.setItem('bal_read_emails', JSON.stringify([...readEmailIds.current]));
    } catch { /* ignore */ }
    // Sidebar unread badge follows the same read-set — update it immediately
    useMailStore.getState().recomputeUnread();
  };

  // ─── Pins (Outlook-style "keep at top of folder") ────────────────────────
  // Server-persisted per user (email_pins table) so pins survive refreshes
  // and follow the user across machines.
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get('/email/pins')
      .then(({ data }) => setPinnedIds(new Set((data?.pins || []).map(String))))
      .catch(() => { /* pins are non-critical; start empty */ });
  }, []);

  const handleTogglePin = async (id: string) => {
    const key = String(id);
    const isPinned = pinnedIds.has(key);
    // Optimistic update — revert on failure
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (isPinned) next.delete(key); else next.add(key);
      return next;
    });
    try {
      if (isPinned) await api.delete(`/email/pins/${encodeURIComponent(key)}`);
      else await api.post('/email/pins', { emailKey: key });
    } catch {
      setPinnedIds(prev => {
        const next = new Set(prev);
        if (isPinned) next.add(key); else next.delete(key);
        return next;
      });
    }
  };

  // Fetch folder counts
  const loadCounts = async () => {
    try {
      const { data } = await api.get('/email/counts');
      setFolderCounts(data);
    } catch { /* ignore */ }
  };

  // Fetch emails for active folder
  const loadEmails = async (folder?: string) => {
    const f = folder || activeFolder;
    const isSilentRefresh = isRefreshing.current;
    if (!isSilentRefresh) setLoading(true);
    try {
      let endpoint = '/email/sent';
      if (f === 'drafts') endpoint = '/email/drafts';
      else if (f === 'deleted') endpoint = '/email/deleted';
      else if (f === 'inbox') endpoint = '/email/inbox';

      const { data } = await api.get(endpoint);
      // Normalize DB rows to email display format
      const normalized = (data.emails || []).map((e: any) => ({
        id: e.id || e.uid?.toString(),
        from: e.from || user?.display_name || 'You',
        // Sent/drafts/deleted rows come from our own sent_emails table which has
        // no sender columns — the sender IS the logged-in user. Inbox rows carry
        // the real sender from IMAP; never substitute anything there.
        fromEmail: e.fromEmail || (f === 'inbox' ? '' : (user?.email || '')),
        to: typeof e.to_addresses === 'string' ? JSON.parse(e.to_addresses) : (e.to_addresses || e.to || []),
        cc: typeof e.cc_addresses === 'string' ? JSON.parse(e.cc_addresses) : (e.cc_addresses || e.cc || []),
        subject: e.subject || '(No subject)',
        preview: e.text_body?.substring(0, 120) || e.preview || '',
        body: e.html_body || e.body || e.text_body || '',
        date: e.created_at || e.date || new Date().toISOString(),
        // Inbox read-state = the REAL IMAP \Seen flag from Stalwart (persists
        // across logout/devices) OR our instant localStorage cache (for snappy
        // UI before the server round-trip). Union of the two. Sent/drafts/
        // deleted are always "read".
        isRead: f === 'inbox'
          ? (e.isRead === true || readEmailIds.current.has((e.id || e.uid)?.toString() || ''))
          : true,
        isStarred: e.isStarred || false,
        attachments: e.attachments || [],
        status: e.status,
        folder: f,
        // ── Threading headers — REQUIRED for reply chains, attachments in conversation history ──
        // Without these, replies have no In-Reply-To header → threading is broken
        messageId: e.messageId || e.message_id || undefined,
        inReplyTo: e.inReplyTo || e.in_reply_to || undefined,
        references: e.references || (e.email_references ? e.email_references.split(/\s+/).filter(Boolean) : undefined),
      }));

      // New-mail sound/notification + sidebar badge are owned by the GLOBAL
      // mailStore watcher (works app-wide, not just on this tab). Feeding our
      // fetch into it keeps it current and prevents double notifications.
      if (f === 'inbox') {
        useMailStore.getState().ingestInbox(
          normalized.map((m: any) => ({ id: String(m.id), from: m.from, subject: m.subject, seen: m.isRead === true })),
        );
        prevInboxCountRef.current = normalized.length;
      }

      setEmails(normalized);
    } catch (err: any) {
      if (f === 'inbox') {
        if (!isSilentRefresh) setEmails([]);
      } else {
        console.error('Failed to load emails:', err.message);
      }
    } finally {
      if (!isSilentRefresh) setLoading(false);
    }
  };

  useEffect(() => { loadEmails(); loadCounts(); }, [activeFolder]);

  // Auto-refresh inbox every 30 seconds silently (no loading spinner, no blink)
  useEffect(() => {
    if (activeFolder !== 'inbox') return;
    const interval = setInterval(() => {
      isRefreshing.current = true;
      loadEmails('inbox').finally(() => { isRefreshing.current = false; });
    }, 30000);
    return () => clearInterval(interval);
  }, [activeFolder]);

  const filteredEmails = searchQuery
    ? emails.filter(e => e.subject.toLowerCase().includes(searchQuery.toLowerCase()) || e.from?.toLowerCase().includes(searchQuery.toLowerCase()))
    : emails;

  const selectedEmail = emails.find(e => e.id === selectedEmailId) || null;

  const folders = [
    { id: 'inbox', name: 'Inbox', icon: 'inbox', count: 0 },
    { id: 'sent', name: 'Sent Items', icon: 'send', count: 0 },
    { id: 'drafts', name: 'Drafts', icon: 'file', count: folderCounts.draft || 0 },
    { id: 'deleted', name: 'Deleted Items', icon: 'trash', count: 0 },
  ];

  const handleSelectEmail = (id: string) => {
    setSelectedEmailId(id);
    setComposing(false);
    setReplyTo(null);
    setForwardEmail(null);
    setEditingDraft(null);
    // Mark read in two places:
    //  1. localStorage + badge (instant, local) — markAsRead
    //  2. Stalwart's \Seen flag (persistent across logout/devices) — fire-and-forget
    markAsRead(id);
    setEmails(prev => prev.map(e => e.id === id ? { ...e, isRead: true } : e));
    if (activeFolder === 'inbox') {
      api.post(`/email/inbox/${encodeURIComponent(id)}/seen`).catch(() => { /* non-fatal */ });
    }
  };

  const handleCompose = () => {
    setComposing(true);
    setSelectedEmailId(null);
    setReplyTo(null);
    setForwardEmail(null);
    setEditingDraft(null);
  };

  const handleOpenDraft = (email: any) => {
    setComposing(true);
    setEditingDraft(email);
    setSelectedEmailId(null);
    setReplyTo(null);
    setForwardEmail(null);
  };

  const handleReply = (email: any, all?: boolean) => {
    setComposing(true);
    setReplyTo({ ...email, replyAll: all });
    setSelectedEmailId(null);
  };

  const handleForward = (email: any) => {
    setComposing(true);
    setForwardEmail(email);
    setReplyTo(null);
    setSelectedEmailId(null);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/email/${id}`);
      setEmails(prev => prev.filter(e => e.id !== id));
      if (selectedEmailId === id) setSelectedEmailId(null);
      loadCounts();
    } catch { /* ignore */ }
  };

  const handleRestore = async (id: string) => {
    try {
      await api.put(`/email/${id}/restore`);
      setEmails(prev => prev.filter(e => e.id !== id));
      loadCounts();
    } catch { /* ignore */ }
  };

  const handleToggleStar = (id: string) => {
    setEmails(prev => prev.map(e => e.id === id ? { ...e, isStarred: !e.isStarred } : e));
  };

  const handleSend = async (data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments?: File[]; inReplyTo?: string; references?: string[] }) => {
    try {
      if (data.attachments && data.attachments.length > 0) {
        // Use FormData for attachments
        const formData = new FormData();
        formData.append('to', JSON.stringify(data.to));
        if (data.cc.length > 0) formData.append('cc', JSON.stringify(data.cc));
        if (data.bcc.length > 0) formData.append('bcc', JSON.stringify(data.bcc));
        formData.append('subject', data.subject);
        formData.append('html', data.body);
        if (editingDraft?.id) formData.append('draftId', editingDraft.id);
        if (data.inReplyTo) formData.append('inReplyTo', data.inReplyTo);
        if (data.references?.length) formData.append('references', JSON.stringify(data.references));
        data.attachments.forEach(file => formData.append('attachments', file));
        await api.post('/email/send', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.post('/email/send', {
          to: data.to,
          cc: data.cc.length > 0 ? data.cc : undefined,
          bcc: data.bcc.length > 0 ? data.bcc : undefined,
          subject: data.subject,
          html: data.body,
          draftId: editingDraft?.id || undefined,
          inReplyTo: data.inReplyTo || undefined,
          references: data.references || undefined,
        });
      }
      setComposing(false);
      setReplyTo(null);
      setForwardEmail(null);
      setEditingDraft(null);
      // Refresh sent items and counts
      if (activeFolder === 'sent') loadEmails('sent');
      loadCounts();
    } catch (err: any) {
      alert('Failed to send email: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleSaveDraft = async (data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }) => {
    try {
      if (editingDraft?.id) {
        await api.put(`/email/draft/${editingDraft.id}`, { to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject, html: data.body });
      } else {
        await api.post('/email/draft', { to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject, html: data.body });
      }
      setComposing(false);
      setEditingDraft(null);
      if (activeFolder === 'drafts') loadEmails('drafts');
      loadCounts();
    } catch (err: any) {
      alert('Failed to save draft: ' + (err.response?.data?.error || err.message));
    }
  };

  // ─── Resizable panel widths ───
  const [folderWidth, setFolderWidth] = useState(220);
  const [listWidth, setListWidth] = useState(360);
  const dragging = useRef<'folder' | 'list' | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = (panel: 'folder' | 'list', e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = panel;
    startX.current = e.clientX;
    startWidth.current = panel === 'folder' ? folderWidth : listWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX.current;
      if (dragging.current === 'folder') {
        setFolderWidth(Math.max(160, Math.min(350, startWidth.current + delta)));
      } else if (dragging.current === 'list') {
        setListWidth(Math.max(250, Math.min(600, startWidth.current + delta)));
      }
    };

    const handleMouseUp = () => {
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const userEmail = user?.email || `${user?.username || 'user'}@balasorealloys.in`;

  return (
    <div style={{ display: 'flex', height: '100%', background: '#F5F5F5' }}>
      {/* ─── Folder Panel (resizable) ─── */}
      <div style={{ width: folderWidth, background: '#FAFAFA', borderRight: 'none', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {/* Compose Button */}
        <div style={{ padding: 16 }}>
          <button
            onClick={handleCompose}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
              background: '#0078D4', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: '0 2px 6px rgba(0,120,212,0.3)', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#106EBE'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#0078D4'; }}
          >
            <Plus size={16} /> New Email
          </button>
        </div>

        {/* Folder List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '0 8px' }}>
            <p style={{ fontSize: 10, fontWeight: 600, color: '#8B8CA7', textTransform: 'uppercase', letterSpacing: 1, padding: '8px 12px', margin: 0 }}>Folders</p>
            {folders.map(folder => (
              <FolderItem
                key={folder.id}
                folder={folder}
                active={activeFolder === folder.id}
                onClick={() => { setActiveFolder(folder.id); setSelectedEmailId(null); }}
              />
            ))}
          </div>
        </div>

        {/* Account Info */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #E8E8E8', fontSize: 11, color: '#8B8CA7' }}>
          <p style={{ margin: 0, fontWeight: 600, color: '#242424' }}>{user?.display_name}</p>
          <p style={{ margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userEmail}</p>
        </div>
      </div>

      {/* ─── Resize Handle: Folder ↔ List ─── */}
      <div
        onMouseDown={(e) => handleMouseDown('folder', e)}
        style={{ width: 4, cursor: 'col-resize', background: 'transparent', flexShrink: 0, position: 'relative', zIndex: 5 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#0078D4'; }}
        onMouseLeave={(e) => { if (!dragging.current) e.currentTarget.style.background = 'transparent'; }}
      />

      {/* ─── Email List Panel (resizable) ─── */}
      <div style={{ width: listWidth, borderRight: 'none', display: 'flex', flexDirection: 'column', background: '#fff', flexShrink: 0 }}>
        {/* Search */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #F0F0F0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#F5F5F5', borderRadius: 8 }}>
            <Search size={14} color="#8B8CA7" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search emails..."
              style={{ border: 'none', background: 'none', outline: 'none', flex: 1, fontSize: 13, color: '#242424' }}
            />
          </div>
        </div>

        {/* Focused / Other toggle */}
        <div style={{ display: 'flex', borderBottom: '1px solid #F0F0F0' }}>
          <button style={{ flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: '#0078D4', borderBottom: '2px solid #0078D4', cursor: 'pointer' }}>Focused</button>
          <button style={{ flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, color: '#8B8CA7', cursor: 'pointer' }}>Other</button>
        </div>

        {/* Email Items */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
              <Loader size={20} color="#0078D4" style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13, color: '#8B8CA7' }}>Loading...</span>
              <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            </div>
          ) : activeFolder === 'inbox' && filteredEmails.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
              <div style={{ width: 56, height: 56, borderRadius: 14, background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Inbox size={28} color="#0078D4" />
              </div>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#242424', margin: 0 }}>
                Inbox
              </p>
              <p style={{ fontSize: 12, color: '#8B8CA7', margin: 0, lineHeight: 1.6 }}>
                To view received emails, open your mailbox<br/>in Outlook Web App.
              </p>
              <button
                onClick={() => window.open('https://outlook.office.com/mail/', '_blank')}
                style={{
                  marginTop: 4, padding: '9px 24px', borderRadius: 8, border: 'none',
                  background: '#0078D4', color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  boxShadow: '0 2px 6px rgba(0,120,212,0.3)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#106EBE'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#0078D4'; }}
              >
                <Mail size={14} /> Open Outlook
              </button>
              <p style={{ fontSize: 10, color: '#B0B0B0', margin: '6px 0 0', lineHeight: 1.5 }}>
                Compose, send, drafts, and sent items work directly in BAL Connect.<br/>
                Inbox reading will be available when OAuth2 is configured by admin.
              </p>
            </div>
          ) : filteredEmails.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
              <Mail size={32} color="#D0D0D0" />
              <p style={{ fontSize: 13, color: '#8B8CA7', margin: 0 }}>No emails in this folder</p>
            </div>
          ) : (
            (() => {
              // Outlook-style: pinned messages float in a "Pinned" section on top
              const pinned = filteredEmails.filter(e => pinnedIds.has(String(e.id)));
              const rest = filteredEmails.filter(e => !pinnedIds.has(String(e.id)));
              const renderItem = (email: any) => (
                <EmailListItem
                  key={email.id}
                  email={email}
                  selected={selectedEmailId === email.id}
                  pinned={pinnedIds.has(String(email.id))}
                  onSelect={() => activeFolder === 'drafts' ? handleOpenDraft(email) : handleSelectEmail(email.id)}
                  onStar={() => handleToggleStar(email.id)}
                  onPin={() => handleTogglePin(email.id)}
                  onDelete={() => activeFolder === 'deleted' ? handleRestore(email.id) : handleDelete(email.id)}
                />
              );
              return (
                <>
                  {pinned.length > 0 && (
                    <>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px 4px',
                        fontSize: 11, fontWeight: 700, color: '#605E5C', textTransform: 'uppercase', letterSpacing: 0.4,
                      }}>
                        <Pin size={11} /> Pinned
                      </div>
                      {pinned.map(renderItem)}
                      {rest.length > 0 && (
                        <div style={{
                          padding: '8px 16px 4px',
                          fontSize: 11, fontWeight: 700, color: '#605E5C', textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          Other
                        </div>
                      )}
                    </>
                  )}
                  {rest.map(renderItem)}
                </>
              );
            })()
          )}
        </div>
      </div>

      {/* ─── Resize Handle: List ↔ Reader ─── */}
      <div
        onMouseDown={(e) => handleMouseDown('list', e)}
        style={{ width: 4, cursor: 'col-resize', background: 'transparent', flexShrink: 0, position: 'relative', zIndex: 5 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#0078D4'; }}
        onMouseLeave={(e) => { if (!dragging.current) e.currentTarget.style.background = 'transparent'; }}
      />

      {/* ─── Reader / Compose Panel ─── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff', minWidth: 0 }}>
        {composing ? (
          <EmailCompose
            userEmail={userEmail}
            userName={user?.display_name || user?.username || ''}
            userDesignation={user?.designation || ''}
            userDepartment={user?.department || ''}
            replyTo={replyTo}
            forwardEmail={forwardEmail}
            editingDraft={editingDraft}
            onSend={handleSend}
            onSaveDraft={handleSaveDraft}
            onDiscard={() => { setComposing(false); setReplyTo(null); setForwardEmail(null); setEditingDraft(null); }}
          />
        ) : selectedEmail ? (
          <EmailReader
            email={selectedEmail}
            onReply={() => handleReply(selectedEmail)}
            onReplyAll={() => handleReply(selectedEmail, true)}
            onForward={() => handleForward(selectedEmail)}
            onDelete={() => handleDelete(selectedEmail.id)}
            onStar={() => handleToggleStar(selectedEmail.id)}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#C0C0C0' }}>
            <Mail size={48} strokeWidth={1} />
            <p style={{ fontSize: 15, fontWeight: 500, color: '#8B8CA7', margin: 0 }}>Select an email to read</p>
            <p style={{ fontSize: 12, color: '#B0B0B0', margin: 0 }}>Or click "New Email" to compose</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================================================================
   FOLDER ITEM
   =================================================================== */
function FolderItem({ folder, active, onClick }: { folder: any; active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const IconMap: Record<string, any> = { inbox: Inbox, send: SendHorizontal, file: FileText, trash: Trash2, users: Users };
  const Icon = IconMap[folder.icon] || Mail;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px',
        borderRadius: 6, border: 'none', cursor: 'pointer', textAlign: 'left',
        background: active ? '#E8F0FE' : hovered ? '#F0F0F0' : 'transparent',
        color: active ? '#0078D4' : '#424242', fontSize: 13, fontWeight: active ? 600 : 400,
        transition: 'all 0.12s',
      }}
    >
      <Icon size={16} color={active ? '#0078D4' : '#8B8CA7'} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</span>
      {folder.count > 0 && (
        <span style={{ fontSize: 11, fontWeight: 600, color: active ? '#0078D4' : '#8B8CA7', minWidth: 18, textAlign: 'right' }}>{folder.count}</span>
      )}
    </button>
  );
}

/* ===================================================================
   EMAIL LIST ITEM
   =================================================================== */
/** "swastik.roychoudhury@x.in" → "Swastik Roychoudhury" — display name from an address. */
function nameFromAddress(addr: string): string {
  const local = String(addr || '').split('@')[0];
  if (!local) return addr || '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Outlook-style recipient line for Sent/Drafts: "Partha Bhattacharya" or "A, B +2". */
function recipientLabel(to: string[] | undefined): string {
  const list = Array.isArray(to) ? to.filter(Boolean) : [];
  if (list.length === 0) return '(No recipients)';
  const names = list.map(nameFromAddress);
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

function EmailListItem({ email, selected, pinned, onSelect, onStar, onPin, onDelete }: { email: any; selected: boolean; pinned?: boolean; onSelect: () => void; onStar: () => void; onPin?: () => void; onDelete: () => void }) {
  const [hovered, setHovered] = useState(false);
  // Outlook behaviour: folders of OUTGOING mail (Sent, Drafts, Deleted-from-sent)
  // show WHO IT WAS SENT TO; the inbox shows who it came from.
  const isOutgoing = email.folder === 'sent' || email.folder === 'drafts' || email.folder === 'deleted';
  const displayName = isOutgoing ? recipientLabel(email.to) : email.from;
  const avatarSeed = isOutgoing ? (email.to?.[0] ? nameFromAddress(email.to[0]) : 'No recipients') : email.from;
  const color = getAvatarColor(avatarSeed);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', gap: 12, padding: '12px 16px', cursor: 'pointer',
        background: selected ? '#E8F0FE' : hovered ? '#F8F8FC' : 'transparent',
        borderBottom: '1px solid #F5F5F5', borderLeft: selected ? '3px solid #0078D4' : '3px solid transparent',
        transition: 'all 0.12s',
      }}
    >
      {/* Unread dot + Avatar */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {!email.isRead && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#0078D4' }} />}
        <div style={{
          width: 36, height: 36, borderRadius: '50%', background: color,
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600, marginTop: email.isRead ? 12 : 0,
        }}>
          {getInitials(avatarSeed)}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: email.isRead ? 400 : 700, color: '#242424', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {displayName}
          </span>
          <span style={{ fontSize: 11, color: '#8B8CA7', flexShrink: 0, marginLeft: 8 }}>
            {formatEmailDate(email.date)}
          </span>
        </div>
        <p style={{ fontSize: 12, fontWeight: email.isRead ? 400 : 600, color: '#424242', margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {email.subject}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <p style={{ fontSize: 11, color: '#8B8CA7', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {email.preview}
          </p>
          {email.attachments?.length > 0 && <Paperclip size={12} color="#8B8CA7" style={{ flexShrink: 0 }} />}
          {/* Always-visible pin indicator (Outlook shows the pin even unhovered) */}
          {pinned && !hovered && <Pin size={12} color="#0078D4" fill="#0078D4" style={{ flexShrink: 0 }} />}
          {hovered && (
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
              <button onClick={onStar} style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {email.isStarred ? <Star size={13} fill="#FFB900" color="#FFB900" /> : <Star size={13} color="#8B8CA7" />}
              </button>
              {onPin && (
                <button
                  onClick={onPin}
                  title={pinned ? 'Unpin this message' : 'Keep this message at the top of your folder'}
                  style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {pinned ? <PinOff size={13} color="#0078D4" /> : <Pin size={13} color="#8B8CA7" />}
                </button>
              )}
              <button onClick={onDelete} style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 size={13} color="#D83B01" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===================================================================
   EMAIL BODY PARSER — Splits reply chains into individual messages
   =================================================================== */

/** A single message in an email conversation */
interface EmailSection {
  type: 'main' | 'quoted';
  html: string;
  from?: string;
  fromEmail?: string;
  date?: string;
  to?: string;
  cc?: string;
  subject?: string;
}

/** Sanitize HTML to prevent XSS and CSS bleed */
function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'div', 'span', 'a', 'b', 'i', 'u', 'strong', 'em', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'img', 'blockquote', 'pre', 'code', 'hr', 'sub', 'sup', 'font', 'center',
      'small', 'big', 'abbr', 'cite', 'del', 'ins', 'mark', 'dl', 'dt', 'dd',
      'caption', 'colgroup', 'col', 'figure', 'figcaption', 'section', 'article', 'header', 'footer',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'width', 'height', 'style', 'class', 'id',
      'target', 'rel', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border',
      'align', 'valign', 'bgcolor', 'color', 'size', 'face', 'dir', 'lang',
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
  });
  return clean;
}

/**
 * Extract metadata from "On [date] [name] <email> wrote:" or "On [date], [name] wrote:" lines.
 * Must correctly handle:
 *   - Gmail: "On Tue, May 5, 2026, 10:29 AM DIPESH MONDAL <dipesh@gmail.com> wrote:"
 *   - BAL Connect: "On 5/12/2026, 1:52:58 AM, Admin User wrote:"
 *   - Generic: "On Mon, Apr 27, 2026 at 6:05 PM John Doe <john@example.com> wrote:"
 */
function parseWroteLine(text: string): { from?: string; fromEmail?: string; date?: string } | null {
  // ── Format 1: with <email> ──
  // "On [date+time] [name] <email> wrote:"
  const withEmail = text.match(/^On\s+(.+)\s+<([^>]+)>\s*wrote:\s*$/);
  if (withEmail) {
    const beforeEmail = withEmail[1].trim(); // e.g. "Tue, May 5, 2026, 10:29 AM DIPESH MONDAL"
    const email = withEmail[2].trim();
    // Strategy: the name is the alphabetic words at the end.
    // The date contains the last digit or AM/PM. Everything after that is the name.
    const split = beforeEmail.match(/^(.*(?:\d|AM|PM))[,\s]+([A-Za-z].+)$/i);
    if (split) {
      return { date: split[1].trim(), from: split[2].trim(), fromEmail: email };
    }
    // Fallback: whole thing as name
    return { from: beforeEmail, fromEmail: email };
  }

  // ── Format 2: without <email> (BAL Connect, Thunderbird, etc.) ──
  // "On 5/12/2026, 1:52:58 AM, Admin User wrote:"
  // Key: use GREEDY (.+) for date so it matches up to the LAST comma, leaving only the name after it.
  const withoutEmail = text.match(/^On\s+(.+),\s+([A-Za-z][A-Za-z\s.'\-]+?)\s+wrote:\s*$/);
  if (withoutEmail) {
    return { date: withoutEmail[1].trim(), from: withoutEmail[2].trim() };
  }

  return null;
}

/** Extract Outlook-style "From: ... Sent: ... To: ..." block metadata */
function parseOutlookHeader(text: string): Partial<EmailSection> {
  const result: Partial<EmailSection> = {};
  const fromMatch = text.match(/From:\s*(.+?)(?:\n|$)/i);
  const sentMatch = text.match(/(?:Sent|Date):\s*(.+?)(?:\n|$)/i);
  const toMatch = text.match(/To:\s*(.+?)(?:\n|$)/i);
  const ccMatch = text.match(/Cc:\s*(.+?)(?:\n|$)/i);
  const subjMatch = text.match(/Subject:\s*(.+?)(?:\n|$)/i);
  if (fromMatch) {
    const emailInFrom = fromMatch[1].match(/<([^>]+)>/);
    result.from = fromMatch[1].replace(/<[^>]+>/, '').trim();
    if (emailInFrom) result.fromEmail = emailInFrom[1];
  }
  if (sentMatch) result.date = sentMatch[1].trim();
  if (toMatch) result.to = toMatch[1].trim();
  if (ccMatch) result.cc = ccMatch[1].trim();
  if (subjMatch) result.subject = subjMatch[1].trim();
  return result;
}

/**
 * Get the body HTML of an element, EXCLUDING nested blockquotes / gmail_quote divs.
 * This extracts only THIS reply's content, not deeper replies.
 */
function getOwnBodyHtml(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  // Remove nested gmail_quote wrappers
  clone.querySelectorAll('.gmail_quote').forEach(q => q.remove());
  // Remove nested blockquotes (reply chains)
  clone.querySelectorAll('blockquote').forEach(q => q.remove());
  // Remove "On ... wrote:" lines that precede blockquotes
  clone.querySelectorAll('div, p, span').forEach(p => {
    const txt = (p.textContent || '').trim();
    if (/^On\s.+wrote:\s*$/.test(txt)) p.remove();
  });
  return clone.innerHTML;
}

/**
 * Recursively parse Gmail-style nested blockquotes into individual sections.
 * Gmail structure: "On ... wrote:" text → <blockquote class="gmail_quote"> with body + nested quote
 *
 * IMPORTANT: Gmail blockquotes often have class="gmail_quote" — we must NOT
 * process them via both the class handler AND the "On wrote" handler, or we
 * get exponential duplication (2^n sections instead of n).
 */
function parseGmailQuoteRecursive(container: Element, sections: EmailSection[], processed: Set<Element> = new Set()): void {
  const children = Array.from(container.childNodes);

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;

    // Skip elements we've already processed (prevents double recursion)
    if (processed.has(el)) continue;

    // Check for gmail_quote DIV wrapper (NOT blockquote — those are handled below)
    if (el.tagName !== 'BLOCKQUOTE' && el.classList?.contains('gmail_quote')) {
      processed.add(el);
      parseGmailQuoteRecursive(el, sections, processed);
      continue;
    }

    // Check if this is an "On ... wrote:" line
    const text = (el.textContent || '').trim();
    if (/^On\s.+wrote:\s*$/.test(text)) {
      const meta = parseWroteLine(text);
      const nextEl = el.nextElementSibling;
      if (nextEl && nextEl.tagName === 'BLOCKQUOTE') {
        processed.add(nextEl); // Mark blockquote as processed
        const bodyHtml = getOwnBodyHtml(nextEl);
        sections.push({
          type: 'quoted',
          html: sanitizeEmailHtml(bodyHtml),
          from: meta?.from,
          fromEmail: meta?.fromEmail,
          date: meta?.date,
        });
        // Recurse into the blockquote for deeper nested replies
        parseGmailQuoteRecursive(nextEl, sections, processed);
      }
      continue;
    }

    // Standalone blockquote (not preceded by "On wrote:", not already processed)
    if (el.tagName === 'BLOCKQUOTE') {
      processed.add(el);
      const bodyHtml = getOwnBodyHtml(el);
      if (bodyHtml.trim()) {
        sections.push({ type: 'quoted', html: sanitizeEmailHtml(bodyHtml) });
      }
      parseGmailQuoteRecursive(el, sections, processed);
    }
  }
}

/**
 * Parse an email HTML body into individual message sections.
 * Each reply becomes its own section with metadata — rendered as separate cards.
 */
function parseEmailSections(html: string): EmailSection[] {
  if (!html) return [{ type: 'main', html: '' }];

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const sections: EmailSection[] = [];

  // ===== Strategy 1: Outlook-style (multiple #divRplyFwdMsg markers) =====
  const outlookDividers = doc.querySelectorAll(
    '#divRplyFwdMsg, [id^="divRply"], [id^="divRpt"], div.OutlookMessageHeader'
  );

  if (outlookDividers.length > 0) {
    // Get content BEFORE the first divider = main message
    const firstDivider = outlookDividers[0];
    const mainRange = doc.createRange();
    mainRange.setStartBefore(doc.body.firstChild || doc.body);
    mainRange.setEndBefore(firstDivider);
    const mainFrag = mainRange.cloneContents();
    const mainDiv = doc.createElement('div');
    mainDiv.appendChild(mainFrag);
    sections.push({ type: 'main', html: sanitizeEmailHtml(mainDiv.innerHTML) });

    // Each divider starts a new quoted reply
    for (let i = 0; i < outlookDividers.length; i++) {
      const divider = outlookDividers[i];
      const replyRange = doc.createRange();
      replyRange.setStartBefore(divider);
      if (i + 1 < outlookDividers.length) {
        replyRange.setEndBefore(outlookDividers[i + 1]);
      } else if (doc.body.lastChild) {
        replyRange.setEndAfter(doc.body.lastChild);
      }
      const replyFrag = replyRange.cloneContents();
      const replyDiv = doc.createElement('div');
      replyDiv.appendChild(replyFrag);
      const replyText = replyDiv.textContent || '';
      const meta = parseOutlookHeader(replyText);

      // Remove the header block from the body display
      const headerEl = replyDiv.querySelector('#divRplyFwdMsg, [id^="divRply"], [id^="divRpt"], div.OutlookMessageHeader');
      if (headerEl) {
        // Find and remove the header lines (From/Sent/To/Subject) that follow the divider
        let nextSib = headerEl.nextElementSibling;
        // The header itself might contain the metadata
        headerEl.remove();
        // Also remove explicit header paragraphs that contain "From:", "Sent:", etc.
        const headerPs = replyDiv.querySelectorAll('p, div');
        let removedHeaders = 0;
        for (const p of headerPs) {
          const pText = (p.textContent || '').trim();
          if (removedHeaders < 6 && /^(From|Sent|Date|To|Cc|Subject):\s/i.test(pText)) {
            p.remove();
            removedHeaders++;
          }
        }
      }
      // Also remove any leading <hr>
      const firstChild = replyDiv.firstElementChild;
      if (firstChild?.tagName === 'HR') firstChild.remove();

      sections.push({
        type: 'quoted',
        html: sanitizeEmailHtml(replyDiv.innerHTML),
        ...meta,
      });
    }
    return sections;
  }

  // ===== Strategy 2: Gmail-style nested blockquotes =====
  const gmailQuotes = doc.querySelectorAll('.gmail_quote');
  // Also check for "On ... wrote:" + blockquote pattern (generic Gmail-like)
  const hasWrotePattern = Array.from(doc.querySelectorAll('div, p, span')).some(
    el => /^On\s.+wrote:\s*$/.test((el.textContent || '').trim())
  );

  if (gmailQuotes.length > 0 || hasWrotePattern) {
    // Main message = everything before the first gmail_quote or "On...wrote:" line
    let splitEl: Element | null = gmailQuotes[0] || null;

    if (!splitEl) {
      // Find the first "On ... wrote:" element
      for (const el of doc.querySelectorAll('div, p, span')) {
        if (/^On\s.+wrote:\s*$/.test((el.textContent || '').trim())) {
          splitEl = el;
          break;
        }
      }
    }

    if (splitEl) {
      const mainRange = doc.createRange();
      mainRange.setStartBefore(doc.body.firstChild || doc.body);
      mainRange.setEndBefore(splitEl);
      const mainFrag = mainRange.cloneContents();
      const mainDiv = doc.createElement('div');
      mainDiv.appendChild(mainFrag);
      sections.push({ type: 'main', html: sanitizeEmailHtml(mainDiv.innerHTML) });

      // Recursively parse all nested replies
      // Start from the body, looking for the quote chain
      parseGmailQuoteRecursive(doc.body, sections);
    }

    if (sections.length > 0) return sections;
  }

  // ===== Strategy 3: Plain blockquote chain (Apple Mail, Thunderbird) =====
  const blockquotes = doc.querySelectorAll('blockquote[type="cite"], blockquote.cite');
  if (blockquotes.length > 0) {
    const firstBq = blockquotes[0];
    // Content before blockquote = main message
    const mainRange = doc.createRange();
    mainRange.setStartBefore(doc.body.firstChild || doc.body);
    // Check for "wrote:" line before blockquote
    const prevEl = firstBq.previousElementSibling;
    if (prevEl && /wrote:\s*$/.test(prevEl.textContent || '')) {
      mainRange.setEndBefore(prevEl);
    } else {
      mainRange.setEndBefore(firstBq);
    }
    const mainFrag = mainRange.cloneContents();
    const mainDiv = doc.createElement('div');
    mainDiv.appendChild(mainFrag);
    sections.push({ type: 'main', html: sanitizeEmailHtml(mainDiv.innerHTML) });

    // Each nested blockquote = one reply level
    let currentBq: Element | null = firstBq;
    while (currentBq) {
      const bodyHtml = getOwnBodyHtml(currentBq);
      // Try to extract metadata from the "wrote:" line preceding this blockquote
      const prevSib = currentBq.previousElementSibling;
      let meta: Partial<EmailSection> = {};
      if (prevSib && /wrote:\s*$/.test(prevSib.textContent || '')) {
        const parsed = parseWroteLine((prevSib.textContent || '').trim());
        if (parsed) meta = parsed;
      }
      if (bodyHtml.trim()) {
        sections.push({ type: 'quoted', html: sanitizeEmailHtml(bodyHtml), ...meta });
      }
      // Go deeper
      currentBq = currentBq.querySelector('blockquote[type="cite"], blockquote.cite, blockquote');
    }
    if (sections.length > 1) return sections;
  }

  // ===== Strategy 4: HR-separated or text-pattern separated =====
  // Look for <hr> followed by "From:" headers
  const hrs = doc.querySelectorAll('hr');
  const hrSplits: Element[] = [];
  for (const hr of hrs) {
    const next = hr.nextElementSibling;
    if (next && /^(from|on\s)/i.test((next.textContent || '').trim())) {
      hrSplits.push(hr);
    }
  }

  if (hrSplits.length > 0) {
    // Main = before first HR
    const mainRange = doc.createRange();
    mainRange.setStartBefore(doc.body.firstChild || doc.body);
    mainRange.setEndBefore(hrSplits[0]);
    const mainFrag = mainRange.cloneContents();
    const mainDiv = doc.createElement('div');
    mainDiv.appendChild(mainFrag);
    sections.push({ type: 'main', html: sanitizeEmailHtml(mainDiv.innerHTML) });

    for (let i = 0; i < hrSplits.length; i++) {
      const replyRange = doc.createRange();
      replyRange.setStartBefore(hrSplits[i]);
      if (i + 1 < hrSplits.length) {
        replyRange.setEndBefore(hrSplits[i + 1]);
      } else if (doc.body.lastChild) {
        replyRange.setEndAfter(doc.body.lastChild);
      }
      const replyFrag = replyRange.cloneContents();
      const replyDiv = doc.createElement('div');
      replyDiv.appendChild(replyFrag);
      const meta = parseOutlookHeader(replyDiv.textContent || '');
      // Remove the <hr> from display
      const hrInDiv = replyDiv.querySelector('hr');
      if (hrInDiv) hrInDiv.remove();
      sections.push({ type: 'quoted', html: sanitizeEmailHtml(replyDiv.innerHTML), ...meta });
    }
    return sections;
  }

  // ===== No split detected — entire email is one body =====
  return [{ type: 'main', html: sanitizeEmailHtml(html) }];
}

/** Attachment download handler */
function downloadAttachment(att: any) {
  const folderParam = att.folder ? `?folder=${encodeURIComponent(att.folder)}` : '';
  const url = att.source === 'imap'
    ? `/email/imap-attachment/${att.uid}/${att.index}${folderParam}`
    : att.id ? `/email/attachment/${att.id}?name=${encodeURIComponent(att.name)}` : null;
  if (!url) return;
  api.get(url, { responseType: 'blob' }).then(response => {
    const blob = new Blob([response.data]);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = att.name || 'attachment';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }).catch(() => alert('Failed to download attachment'));
}

/** Attachment chips row */
function AttachmentRow({ attachments }: { attachments: any[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
      {attachments.map((att: any, i: number) => (
        <div
          key={i}
          onClick={() => downloadAttachment(att)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
            background: '#F5F5F5', borderRadius: 8, border: '1px solid #E8E8E8',
            cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#EBF5FF'; e.currentTarget.style.borderColor = '#0078D4'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#F5F5F5'; e.currentTarget.style.borderColor = '#E8E8E8'; }}
        >
          <Paperclip size={14} color="#0078D4" />
          <span style={{ fontSize: 12, fontWeight: 500, color: '#0078D4' }}>{att.name}</span>
          {att.size > 0 && <span style={{ fontSize: 10, color: '#8B8CA7' }}>({formatFileSize(att.size)})</span>}
        </div>
      ))}
    </div>
  );
}

/* ===================================================================
   EMAIL READER — Outlook-style conversation view with separate cards
   =================================================================== */
function EmailReader({ email, onReply, onReplyAll, onForward, onDelete, onStar }: {
  email: any; onReply: () => void; onReplyAll: () => void; onForward: () => void; onDelete: () => void; onStar: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  const [threadEmails, setThreadEmails] = useState<any[]>([]);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  // ── Inline translation of the email body ──
  const [xlMenu, setXlMenu] = useState(false);
  const [xlBusy, setXlBusy] = useState(false);
  const [xlText, setXlText] = useState<{ lang: TranslateLang; text: string } | null>(null);

  // Parse the email body into individual message sections (fallback)
  const sections = useMemo(() => parseEmailSections(email.body || ''), [email.body]);
  const mainSection = sections[0];
  const parsedOlderMessages = sections.slice(1);

  // Check if we can fetch the thread from IMAP using Message-ID headers
  const hasReferences = email.references && email.references.length > 0;
  const hasInReplyTo = !!email.inReplyTo;
  const canLoadThread = hasReferences || hasInReplyTo;

  // Show thread emails if loaded from IMAP, otherwise show parsed HTML sections
  const olderMessages = threadLoaded && threadEmails.length > 0 ? threadEmails : parsedOlderMessages;
  const hasHistory = olderMessages.length > 0 || canLoadThread;

  // Translate the latest message's body into the chosen language.
  const handleEmailTranslate = async (lang: TranslateLang) => {
    setXlMenu(false);
    // Extract plain text from the main section HTML (no tags, decoded entities).
    const tmp = document.createElement('div');
    tmp.innerHTML = mainSection?.html || '';
    const text = (tmp.innerText || tmp.textContent || '').trim();
    if (!text) return;
    setXlBusy(true);
    try {
      const result = await aiTranslate(text, lang);
      setXlText({ lang, text: result });
    } catch {
      setXlText({ lang, text: '⚠️ Translation failed — please try again.' });
    } finally {
      setXlBusy(false);
    }
  };

  // Reset when email changes
  useEffect(() => {
    setShowHistory(false); setExpandedCards(new Set()); setThreadEmails([]); setThreadLoaded(false);
    setXlMenu(false); setXlBusy(false); setXlText(null);
    // Diagnostic log: what threading info does the viewed email have?
    console.log('[READER] Viewing email — id=', email.id, 'subject=', email.subject, 'messageId=', email.messageId, 'inReplyTo=', email.inReplyTo, 'references=', email.references);
  }, [email.id]);

  /**
   * Fetch full thread emails from IMAP (with attachments).
   *
   * Uses ONLY Message-ID based threading (References + In-Reply-To headers).
   * Never searches by subject — that approach mixes unrelated conversations.
   *
   * For old emails without these headers: shows parsed HTML sections (text only).
   * All NEW replies from BAL Connect include proper threading headers.
   */
  const loadThread = async () => {
    if (threadLoaded || threadLoading) return;
    setThreadLoading(true);
    try {
      // Collect ALL hints we have about this email's thread.
      // The server uses these in priority order:
      //   1. Direct Message-ID search (References + In-Reply-To headers)
      //   2. Reverse lookup: find emails this reply was a parent of OR child of, via DB
      //   3. Body-based discovery: parse "On X, Y wrote:" quote markers from body content
      const messageIdSet = new Set<string>();
      if (email.references) {
        for (const ref of email.references) {
          if (ref) messageIdSet.add(ref);
        }
      }
      if (email.inReplyTo) messageIdSet.add(email.inReplyTo);

      const params: Record<string, string> = {};
      if (messageIdSet.size > 0) {
        params.messageIds = Array.from(messageIdSet).join(',');
      }
      // Pass the current email's own Message-ID so server can do reverse lookup
      // (find emails in DB that reference this one as their parent)
      if (email.messageId) params.currentMessageId = email.messageId;

      const { data } = await api.get('/email/thread', { params });
      if (data.emails?.length > 0) {
        setThreadEmails(data.emails);
      }
    } catch (err) {
      console.warn('[EMAIL] Thread load failed:', err);
    }
    setThreadLoaded(true);
    setThreadLoading(false);
  };

  const handleToggleHistory = () => {
    const newShow = !showHistory;
    setShowHistory(newShow);
    if (newShow && !threadLoaded) loadThread();
  };

  const toggleCard = (idx: number) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  /** Render a card — works for both thread emails and parsed sections */
  const renderCard = (item: any, idx: number, isThread: boolean) => {
    const senderName = isThread ? (item.from || 'Unknown') : (item.from || 'Unknown');
    const senderEmail = isThread ? (item.fromEmail || '') : (item.fromEmail || '');
    const senderDate = isThread
      ? new Date(item.date).toLocaleString('en', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : (item.date || '');
    const toLine = isThread ? (item.to || []).join('; ') : (item.to || '');
    const ccLine = isThread ? (item.cc || []).join('; ') : (item.cc || '');
    const attachments = isThread ? (item.attachments || []) : [];
    const avatarColor = getAvatarColor(senderName);
    const isExpanded = expandedCards.has(idx);

    // Body: for thread emails, parse to strip quoted chain; for parsed sections, use directly
    const bodyHtml = isThread
      ? sanitizeEmailHtml(parseEmailSections(item.body || '')[0]?.html || item.body || '')
      : item.html;
    const previewText = bodyHtml.replace(/<[^>]*>/g, '').trim().substring(0, 120);

    return (
      <div key={idx} style={{
        background: '#fff', borderRadius: 8, border: '1px solid #E8E8F0',
        overflow: 'hidden', marginBottom: 8,
      }}>
        <div
          onClick={() => toggleCard(idx)}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: isExpanded ? '14px 20px' : '10px 20px',
            background: isExpanded ? '#FAFBFC' : '#fff',
            borderBottom: isExpanded ? '1px solid #F0F0F0' : 'none',
            cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#F8F9FC'; }}
          onMouseLeave={e => { e.currentTarget.style.background = isExpanded ? '#FAFBFC' : '#fff'; }}
        >
          <div style={{
            width: isExpanded ? 40 : 34, height: isExpanded ? 40 : 34,
            borderRadius: '50%', background: avatarColor,
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: isExpanded ? 14 : 12, fontWeight: 600, flexShrink: 0,
          }}>
            {getInitials(senderName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isExpanded ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#242424' }}>{senderName}</span>
                  {senderEmail && <span style={{ fontSize: 12, color: '#8B8CA7' }}>&lt;{senderEmail}&gt;</span>}
                </div>
                {toLine && <div style={{ fontSize: 12, color: '#605E5C', marginTop: 3 }}><span style={{ fontWeight: 600, color: '#8B8CA7' }}>To: </span>{toLine}</div>}
                {ccLine && <div style={{ fontSize: 12, color: '#605E5C', marginTop: 2 }}><span style={{ fontWeight: 600, color: '#8B8CA7' }}>Cc: </span>{ccLine}</div>}
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#242424', flexShrink: 0 }}>{senderName}</span>
                <span style={{ fontSize: 12, color: '#8B8CA7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {previewText || '(No content)'}
                </span>
              </div>
            )}
          </div>
          <span style={{ fontSize: 12, color: '#8B8CA7', flexShrink: 0, whiteSpace: 'nowrap' }}>{senderDate}</span>
          <ChevronDown size={14} style={{
            color: '#8B8CA7', flexShrink: 0,
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
          }} />
        </div>
        {isExpanded && (
          <>
            {attachments.length > 0 && (
              <div style={{ padding: '8px 20px 0' }}>
                <AttachmentRow attachments={attachments} />
              </div>
            )}
            <div style={{ padding: '14px 20px 18px' }}>
              <div className="email-body-content" style={{ fontSize: 14, lineHeight: 1.7, color: '#333', fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif", wordBreak: 'break-word', overflowWrap: 'break-word' }}
                dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Action Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 20px', borderBottom: '1px solid #F0F0F0', flexShrink: 0 }}>
        <ActionBtn icon={<Reply size={16} />} label="Reply" onClick={onReply} />
        <ActionBtn icon={<ReplyAll size={16} />} label="Reply All" onClick={onReplyAll} />
        <ActionBtn icon={<Forward size={16} />} label="Forward" onClick={onForward} />
        <div style={{ width: 1, height: 20, background: '#E0E0E0', margin: '0 8px' }} />
        <ActionBtn
          icon={xlBusy ? <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Languages size={16} />}
          label="Translate"
          onClick={() => { if (!xlBusy) setXlMenu((v) => !v); }}
        />
        <div style={{ width: 1, height: 20, background: '#E0E0E0', margin: '0 8px' }} />
        <ActionBtn icon={<Trash2 size={16} />} label="Delete" onClick={onDelete} color="#D83B01" />
        <ActionBtn icon={<Archive size={16} />} label="Archive" onClick={() => {}} />
        <div style={{ flex: 1 }} />
        <ActionBtn icon={email.isStarred ? <Star size={16} fill="#FFB900" color="#FFB900" /> : <Star size={16} />} label="Star" onClick={onStar} />
      </div>

      {/* Email Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {/* Subject */}
        <h2 style={{ fontSize: 20, fontWeight: 600, color: '#1A1A2E', margin: '0 0 16px', lineHeight: 1.3 }}>
          {email.subject}
        </h2>

        {/* ── Inline translation (AI) ── */}
        {xlMenu && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: '#8B8CA7', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Languages size={14} color="#6264A7" /> Translate this email to
            </span>
            {TRANSLATE_LANGS.map((l) => (
              <button
                key={l.lang}
                onClick={() => handleEmailTranslate(l.lang)}
                title={`Translate to ${l.label}`}
                style={{
                  padding: '5px 14px', borderRadius: 16, border: '1px solid #D8D6F5',
                  background: '#F3F2FA', color: '#4338CA', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#E8E6F5'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#F3F2FA'; }}
              >
                {l.native}
              </button>
            ))}
            <button onClick={() => setXlMenu(false)} style={{ background: 'none', border: 'none', color: '#8B8CA7', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>Cancel</button>
          </div>
        )}
        {xlBusy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13, color: '#8B8CA7' }}>
            <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Translating…
          </div>
        )}
        {xlText && (
          <div style={{ marginBottom: 14, border: '1px solid #D8D6F5', borderRadius: 10, background: '#F7F7FB', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid #E6E6F2', background: '#F0EFFA' }}>
              <Languages size={14} color="#6264A7" />
              <span style={{ fontSize: 12, fontWeight: 700, color: '#4338CA' }}>
                Translated to {TRANSLATE_LANGS.find((l) => l.lang === xlText.lang)?.native}
              </span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setXlMenu(true)} style={{ background: 'none', border: 'none', color: '#6264A7', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>Other language</button>
              <button onClick={() => setXlText(null)} style={{ background: 'none', border: 'none', color: '#8B8CA7', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center' }} title="Hide translation"><X size={14} /></button>
            </div>
            <div style={{ padding: '14px 18px', fontSize: 14, lineHeight: 1.7, color: '#242424', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {xlText.text}
            </div>
          </div>
        )}

        {/* ── Latest Message — always expanded ── */}
        <div style={{
          background: '#fff', borderRadius: 8, border: '1px solid #E8E8F0',
          overflow: 'hidden', marginBottom: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '14px 20px', background: '#FAFBFC', borderBottom: '1px solid #F0F0F0',
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%', background: getAvatarColor(email.from),
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 600, flexShrink: 0, marginTop: 2,
            }}>
              {getInitials(email.from)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#242424' }}>{email.from}</span>
                {email.fromEmail && (
                  <span style={{ fontSize: 12, color: '#8B8CA7' }}>&lt;{email.fromEmail}&gt;</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#605E5C', marginTop: 3, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600, color: '#8B8CA7' }}>To: </span>{(email.to || []).join('; ')}
              </div>
              {email.cc?.length > 0 && (
                <div style={{ fontSize: 12, color: '#605E5C', marginTop: 2, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600, color: '#8B8CA7' }}>Cc: </span>{email.cc.join('; ')}
                </div>
              )}
            </div>
            <span style={{ fontSize: 12, color: '#8B8CA7', flexShrink: 0, whiteSpace: 'nowrap', marginTop: 2 }}>
              {new Date(email.date).toLocaleString('en', {
                weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true,
              })}
            </span>
          </div>
          {email.attachments?.length > 0 && (
            <div style={{ padding: '8px 20px 0' }}>
              <AttachmentRow attachments={email.attachments} />
            </div>
          )}
          <div style={{ padding: '14px 20px 18px' }}>
            <div className="email-body-content" style={{
              fontSize: 14, lineHeight: 1.7, color: '#333',
              fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
              wordBreak: 'break-word', overflowWrap: 'break-word',
            }} dangerouslySetInnerHTML={{ __html: mainSection.html }} />
          </div>
        </div>

        {/* ── Older Messages ── */}
        {hasHistory && (
          <div style={{ marginTop: 4 }}>
            <button
              onClick={handleToggleHistory}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 16px', margin: '4px 0 10px',
                background: showHistory ? '#F0F4FF' : '#F8F8FC',
                border: '1px solid #E0E0E8', borderRadius: 6, cursor: 'pointer',
                fontSize: 12, fontWeight: 500, color: '#0078D4', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#E8EFFF'; e.currentTarget.style.borderColor = '#0078D4'; }}
              onMouseLeave={e => { e.currentTarget.style.background = showHistory ? '#F0F4FF' : '#F8F8FC'; e.currentTarget.style.borderColor = '#E0E0E8'; }}
            >
              {threadLoading ? (
                <div style={{ width: 14, height: 14, border: '2px solid #0078D4', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              ) : (
                <ChevronDown size={14} style={{
                  transform: showHistory ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s',
                }} />
              )}
              <span>
                {threadLoading
                  ? 'Loading conversation history…'
                  : showHistory
                    ? 'Hide message history'
                    : canLoadThread && !threadLoaded
                      ? 'Show full conversation history'
                      : `Show message history (${olderMessages.length} earlier ${olderMessages.length === 1 ? 'message' : 'messages'})`
                }
              </span>
            </button>
            {showHistory && olderMessages.map((item, idx) => {
              const isThread = threadLoaded && threadEmails.length > 0;
              return renderCard(item, idx, isThread);
            })}
          </div>
        )}
      </div>

      {/* Scoped CSS */}
      <style>{`
        .email-body-content img { max-width: 100%; height: auto; }
        .email-body-content table { max-width: 100%; border-collapse: collapse; }
        .email-body-content a { color: #0078D4; }
        .email-body-content blockquote { border-left: 3px solid #D0D0D8; padding-left: 12px; margin: 8px 0; color: #666; }
        .email-body-content pre, .email-body-content code { background: #F5F5F5; padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: 'Consolas', monospace; }
        .email-body-content * { max-width: 100% !important; box-sizing: border-box; }
        .email-body-content style, .email-body-content link { display: none !important; }
      `}</style>
    </div>
  );
}

function ActionBtn({ icon, label, onClick, color }: { icon: React.ReactNode; label: string; onClick: () => void; color?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6,
        border: 'none', background: hovered ? '#F0F0F0' : 'transparent', cursor: 'pointer',
        fontSize: 12, fontWeight: 500, color: color || '#424242', transition: 'all 0.12s',
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/* ===================================================================
   CONTACT AUTOCOMPLETE INPUT — Outlook-style
   =================================================================== */
interface Contact {
  id: string;
  display_name: string;
  email: string;
  department?: string;
  designation?: string;
}

function RecipientField({
  label, chips, inputValue, onInputChange, onAddChip, onRemoveChip, onKeyDown,
  showBccToggle, onToggleBcc, contacts, focusField, onFocusField, fieldKey,
}: {
  label: string;
  chips: string[];
  inputValue: string;
  onInputChange: (v: string) => void;
  onAddChip: (email: string) => void;
  onRemoveChip: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  showBccToggle?: boolean;
  onToggleBcc?: () => void;
  contacts: Contact[];
  focusField: string | null;
  onFocusField: (key: string | null) => void;
  fieldKey: string;
}) {
  const isOpen = focusField === fieldKey && inputValue.trim().length >= 1;
  const query = inputValue.trim().toLowerCase();
  const suggestions = isOpen
    ? contacts.filter(c =>
        (c.display_name.toLowerCase().includes(query) || c.email.toLowerCase().includes(query)) &&
        !chips.includes(c.email)
      ).slice(0, 8)
    : [];

  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset highlight when suggestions change
  useEffect(() => { setHighlightIdx(-1); }, [suggestions.length, inputValue]);

  const handleSelect = (contact: Contact) => {
    onAddChip(contact.email);
    onInputChange('');
    onFocusField(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDownInternal = (e: React.KeyboardEvent) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx(i => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, -1));
        return;
      }
      if (e.key === 'Enter' && highlightIdx >= 0) {
        e.preventDefault();
        handleSelect(suggestions[highlightIdx]);
        return;
      }
      if (e.key === 'Escape') {
        onFocusField(null);
        return;
      }
    }
    onKeyDown(e);
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        display: 'flex', alignItems: 'center', padding: '6px 20px',
        borderBottom: '1px solid #F0F0F0', fontSize: 13, flexWrap: 'wrap', gap: 4,
        minHeight: 38,
      }}>
        <span style={{ width: 50, color: '#8B8CA7', fontWeight: 500, flexShrink: 0 }}>{label}:</span>
        {chips.map((email, i) => (
          <EmailChip key={i} email={email} onRemove={() => onRemoveChip(i)} />
        ))}
        <input
          ref={inputRef}
          value={inputValue}
          onChange={e => { onInputChange(e.target.value); onFocusField(fieldKey); }}
          onKeyDown={handleKeyDownInternal}
          onFocus={() => onFocusField(fieldKey)}
          onBlur={() => {
            // Delay so click on suggestion fires first
            setTimeout(() => {
              if (inputValue.trim().includes('@')) {
                onAddChip(inputValue.trim());
              }
              onInputChange('');
              onFocusField(null);
            }, 180);
          }}
          placeholder={chips.length === 0 ? `Add ${label.toLowerCase()} recipients...` : ''}
          style={{ border: 'none', outline: 'none', flex: 1, minWidth: 120, fontSize: 13, padding: '4px 0' }}
          autoComplete="off"
        />
        {showBccToggle && onToggleBcc && (
          <button onClick={onToggleBcc} style={{ border: 'none', background: 'none', color: '#0078D4', fontSize: 12, cursor: 'pointer', padding: '2px 6px', flexShrink: 0 }}>Bcc</button>
        )}
      </div>

      {/* Suggestion Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 70, right: 16, zIndex: 1000,
          background: '#fff', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          border: '1px solid #E8E8E8', overflow: 'hidden',
        }}>
          <div style={{ padding: '6px 12px 4px', fontSize: 10, fontWeight: 600, color: '#8B8CA7', textTransform: 'uppercase', letterSpacing: 0.8, borderBottom: '1px solid #F5F5F5' }}>
            Suggested contacts
          </div>
          {suggestions.map((contact, i) => {
            const color = getAvatarColor(contact.display_name);
            const initials = getInitials(contact.display_name);
            const isHighlighted = i === highlightIdx;
            return (
              <div
                key={contact.id}
                onMouseDown={() => handleSelect(contact)}
                onMouseEnter={() => setHighlightIdx(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                  cursor: 'pointer', background: isHighlighted ? '#F0F6FF' : '#fff',
                  transition: 'background 0.08s',
                }}
              >
                {/* Avatar */}
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: color,
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, flexShrink: 0,
                }}>
                  {initials}
                </div>
                {/* Name + Email */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A2E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {contact.display_name}
                  </div>
                  <div style={{ fontSize: 11, color: '#8B8CA7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {contact.email}
                    {contact.department && <span style={{ marginLeft: 6, color: '#B0B0B0' }}>· {contact.department}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ===================================================================
   EMAIL COMPOSE — Outlook-Style
   =================================================================== */
// Escape user-derived text before putting it into the signature HTML string.
function escapeHtmlAttr(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function EmailCompose({ userEmail, userName, userDesignation, userDepartment, replyTo, forwardEmail, editingDraft, onSend, onSaveDraft, onDiscard }: {
  userEmail: string; userName: string; userDesignation?: string; userDepartment?: string; replyTo?: any; forwardEmail?: any; editingDraft?: any;
  onSend: (data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments?: File[]; inReplyTo?: string; references?: string[] }) => void;
  onSaveDraft?: (data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }) => void;
  onDiscard: () => void;
}) {
  // Signature role line — dynamic from the DB (designation, falling back to
  // department). NOTHING hardcoded. e.g. "Dy. Manager | Balasore Alloys Limited".
  const roleLine = [userDesignation?.trim() || userDepartment?.trim(), 'Balasore Alloys Limited']
    .filter(Boolean)
    .join(' | ');
  // Signature HTML actually appended to the OUTGOING email (so recipients see it).
  const signatureHtml =
    `<br><br><div style="font-size:13px;color:#666;font-family:'Segoe UI',Calibri,sans-serif">` +
    `Regards,<br><strong>${escapeHtmlAttr(userName)}</strong>` +
    (roleLine ? `<br>${escapeHtmlAttr(roleLine)}` : '') +
    `</div>`;
  // Initialize from draft, reply, or empty
  const draftTo = editingDraft?.to ? (Array.isArray(editingDraft.to) ? editingDraft.to : JSON.parse(editingDraft.to || '[]')) : [];
  const draftCc = editingDraft?.cc ? (Array.isArray(editingDraft.cc) ? editingDraft.cc : JSON.parse(editingDraft.cc || '[]')) : [];
  const draftBcc = editingDraft?.bcc ? (Array.isArray(editingDraft.bcc) ? editingDraft.bcc : JSON.parse(editingDraft.bcc || '[]')) : [];

  const [to, setTo] = useState<string[]>(
    editingDraft ? draftTo :
    replyTo ? (replyTo.replyAll ? [...(replyTo.to || []), replyTo.fromEmail].filter((e: string) => e !== userEmail) : [replyTo.fromEmail]) : []
  );
  const [cc, setCc] = useState<string[]>(
    editingDraft ? draftCc :
    replyTo?.replyAll && replyTo.cc ? replyTo.cc.filter((e: string) => e !== userEmail) : []
  );
  const [bcc, setBcc] = useState<string[]>(editingDraft ? draftBcc : []);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(
    editingDraft ? (editingDraft.subject || '') :
    replyTo ? `Re: ${replyTo.subject.replace(/^(Re|Fwd): /i, '')}` :
    forwardEmail ? `Fwd: ${forwardEmail.subject.replace(/^(Re|Fwd): /i, '')}` : ''
  );
  const [toInput, setToInput] = useState('');
  const [ccInput, setCcInput] = useState('');
  const [bccInput, setBccInput] = useState('');
  const [focusField, setFocusField] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // AI Smart Compose (rewrite the email body)
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement>(null);

  // Close the AI menu on click outside
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) setAiMenuOpen(false);
    };
    if (aiMenuOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [aiMenuOpen]);

  // Rewrite the current body text in the chosen style. Operates on the visible
  // text (innerText) and writes the result back as plain text (XSS-safe). The
  // signature is appended only at send time, so it's never touched here.
  const handleComposeRewrite = async (mode: RewriteMode) => {
    const el = bodyRef.current;
    if (!el) return;
    const text = (el.innerText || '').trim();
    if (!text || aiBusy) return;
    setAiMenuOpen(false);
    setAiBusy(true);
    try {
      const result = await aiRewrite(text, mode);
      if (result) {
        el.innerText = result; // plain-text assignment — preserves line breaks, no HTML injection
        el.focus();
      }
    } catch (err: any) {
      alert(err?.response?.data?.error || 'AI is unavailable right now');
    } finally {
      setAiBusy(false);
    }
  };

  // Load all contacts once on mount for instant filtering
  useEffect(() => {
    api.get('/email/contacts').then(({ data }) => {
      setContacts(data.contacts || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (bodyRef.current && editingDraft?.body) {
      bodyRef.current.innerHTML = editingDraft.body;
    } else if (bodyRef.current && forwardEmail) {
      bodyRef.current.innerHTML = `<br/><br/><hr style="border:none;border-top:1px solid #ddd"/><p style="color:#888">---------- Forwarded message ----------<br/>From: ${forwardEmail.from} &lt;${forwardEmail.fromEmail}&gt;<br/>Subject: ${forwardEmail.subject}<br/>Date: ${new Date(forwardEmail.date).toLocaleString()}</p>${forwardEmail.body}`;
    } else if (bodyRef.current && replyTo) {
      bodyRef.current.innerHTML = `<br/><br/><hr style="border:none;border-top:1px solid #ddd"/><p style="color:#888">On ${new Date(replyTo.date).toLocaleString()}, ${replyTo.from} wrote:</p><blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#666">${replyTo.body}</blockquote>`;
    }
  }, []);

  const addEmail = (value: string, list: string[], setter: (v: string[]) => void) => {
    const trimmed = value.trim().replace(/,$/, '');
    if (trimmed && trimmed.includes('@') && !list.includes(trimmed)) {
      setter([...list, trimmed]);
    }
  };

  const makeKeyDownHandler = (value: string, list: string[], setter: (v: string[]) => void, inputSetter: (v: string) => void) =>
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addEmail(value, list, setter);
        inputSetter('');
      } else if (e.key === 'Backspace' && value === '' && list.length > 0) {
        setter(list.slice(0, -1));
      }
    };

  const execCmd = (cmd: string, value?: string) => {
    document.execCommand(cmd, false, value);
    bodyRef.current?.focus();
  };

  const handleSend = () => {
    if (to.length === 0) { alert('Please add at least one recipient'); return; }
    setSending(true);
    // Build threading headers when replying
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    if (replyTo?.messageId) {
      inReplyTo = replyTo.messageId;
      // References = all previous references + the message being replied to
      const prevRefs: string[] = replyTo.references || [];
      references = [...prevRefs, replyTo.messageId];
    }
    // Diagnostic log — visible in browser DevTools console
    console.log('[COMPOSE] Sending email. replyTo.messageId=', replyTo?.messageId, 'inReplyTo=', inReplyTo, 'references=', references);
    // Append the dynamic signature to the outgoing body so recipients receive it.
    const composed = (bodyRef.current?.innerHTML || '') + signatureHtml;
    onSend({ to, cc, bcc, subject, body: composed, attachments: attachments.length > 0 ? attachments : undefined, inReplyTo, references });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #E8E8E8', gap: 8, flexShrink: 0, background: '#FAFAFA' }}>
        <button
          onClick={handleSend}
          disabled={sending || to.length === 0}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 24px', borderRadius: 6,
            border: 'none', background: to.length > 0 ? '#0078D4' : '#B0B0B0', color: '#fff',
            fontSize: 14, fontWeight: 600, cursor: to.length > 0 ? 'pointer' : 'not-allowed',
            boxShadow: to.length > 0 ? '0 2px 6px rgba(0,120,212,0.3)' : 'none',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (to.length > 0) e.currentTarget.style.background = '#106EBE'; }}
          onMouseLeave={e => { if (to.length > 0) e.currentTarget.style.background = '#0078D4'; }}
        >
          <Send size={15} /> Send
        </button>
        <div style={{ flex: 1 }} />
        {onSaveDraft && (
          <button
            onClick={() => onSaveDraft({ to, cc, bcc, subject, body: bodyRef.current?.innerHTML || '' })}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: '1px solid #E0E0E0', background: '#fff', cursor: 'pointer', color: '#424242', fontSize: 12, fontWeight: 500 }}
          >
            <FileText size={14} /> Save Draft
          </button>
        )}
        <button onClick={onDiscard} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: '#8B8CA7', fontSize: 12 }}>
          <Trash2 size={14} /> Discard
        </button>
        <button onClick={onDiscard} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: '#8B8CA7' }}>
          <X size={18} />
        </button>
      </div>

      {/* From */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 20px', borderBottom: '1px solid #F0F0F0', fontSize: 13 }}>
        <span style={{ width: 50, color: '#8B8CA7', fontWeight: 500, flexShrink: 0 }}>From:</span>
        <span style={{ color: '#242424', fontWeight: 500 }}>{userEmail}</span>
      </div>

      {/* To */}
      <RecipientField
        label="To"
        chips={to}
        inputValue={toInput}
        onInputChange={setToInput}
        onAddChip={email => addEmail(email, to, setTo)}
        onRemoveChip={i => setTo(to.filter((_, j) => j !== i))}
        onKeyDown={makeKeyDownHandler(toInput, to, setTo, setToInput)}
        showBccToggle={!showBcc}
        onToggleBcc={() => setShowBcc(true)}
        contacts={contacts}
        focusField={focusField}
        onFocusField={setFocusField}
        fieldKey="to"
      />

      {/* Cc */}
      <RecipientField
        label="Cc"
        chips={cc}
        inputValue={ccInput}
        onInputChange={setCcInput}
        onAddChip={email => addEmail(email, cc, setCc)}
        onRemoveChip={i => setCc(cc.filter((_, j) => j !== i))}
        onKeyDown={makeKeyDownHandler(ccInput, cc, setCc, setCcInput)}
        contacts={contacts}
        focusField={focusField}
        onFocusField={setFocusField}
        fieldKey="cc"
      />

      {/* Bcc (toggle) */}
      {showBcc && (
        <RecipientField
          label="Bcc"
          chips={bcc}
          inputValue={bccInput}
          onInputChange={setBccInput}
          onAddChip={email => addEmail(email, bcc, setBcc)}
          onRemoveChip={i => setBcc(bcc.filter((_, j) => j !== i))}
          onKeyDown={makeKeyDownHandler(bccInput, bcc, setBcc, setBccInput)}
          contacts={contacts}
          focusField={focusField}
          onFocusField={setFocusField}
          fieldKey="bcc"
        />
      )}

      {/* Subject */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 20px', borderBottom: '1px solid #E0E0E0', fontSize: 13 }}>
        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Add a subject"
          style={{ border: 'none', outline: 'none', flex: 1, fontSize: 14, fontWeight: 500, color: '#242424' }}
        />
      </div>

      {/* Formatting Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 20px', borderBottom: '1px solid #F0F0F0', flexShrink: 0, flexWrap: 'wrap' }}>
        <ToolbarBtn icon={<Bold size={15} />} onClick={() => execCmd('bold')} title="Bold" />
        <ToolbarBtn icon={<Italic size={15} />} onClick={() => execCmd('italic')} title="Italic" />
        <ToolbarBtn icon={<Underline size={15} />} onClick={() => execCmd('underline')} title="Underline" />
        <div style={{ width: 1, height: 18, background: '#E0E0E0', margin: '0 6px' }} />
        <ToolbarBtn icon={<Link2 size={15} />} onClick={() => { const url = prompt('Enter URL:'); if (url) execCmd('createLink', url); }} title="Insert Link" />
        <ToolbarBtn icon={<Paperclip size={15} />} onClick={() => fileInputRef.current?.click()} title="Attach File" />
        <ToolbarBtn icon={<Image size={15} />} onClick={() => { fileInputRef.current?.setAttribute('accept', 'image/*'); fileInputRef.current?.click(); setTimeout(() => fileInputRef.current?.removeAttribute('accept'), 100); }} title="Insert Image" />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) setAttachments(prev => [...prev, ...files]);
            e.target.value = '';
          }}
        />
        <div style={{ width: 1, height: 18, background: '#E0E0E0', margin: '0 6px' }} />
        <select
          onChange={e => execCmd('fontSize', e.target.value)}
          style={{ border: '1px solid #E0E0E0', borderRadius: 4, padding: '2px 4px', fontSize: 12, color: '#424242', cursor: 'pointer', background: '#fff' }}
          defaultValue="3"
        >
          <option value="1">8</option>
          <option value="2">10</option>
          <option value="3">12</option>
          <option value="4">14</option>
          <option value="5">18</option>
          <option value="6">24</option>
        </select>

        <div style={{ width: 1, height: 18, background: '#E0E0E0', margin: '0 6px' }} />
        {/* AI Smart Compose — rewrite the draft */}
        <div style={{ position: 'relative' }} ref={aiMenuRef}>
          <button
            onClick={() => { if (!aiBusy) setAiMenuOpen((v) => !v); }}
            disabled={aiBusy}
            title="AI — rewrite your email"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px',
              borderRadius: 6, border: '1px solid #D8D6F5', background: '#F3F2FA',
              color: '#4338CA', fontSize: 12, fontWeight: 600,
              cursor: aiBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
            }}
          >
            <Sparkles size={14} style={aiBusy ? { animation: 'spin 1s linear infinite' } : undefined} />
            {aiBusy ? 'Rewriting…' : 'AI rewrite'}
          </button>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          {aiMenuOpen && (
            <div
              style={{
                position: 'absolute', top: 34, left: 0, background: '#fff',
                border: '1px solid #E1DFDD', borderRadius: 10,
                boxShadow: '0 8px 28px rgba(0,0,0,0.16)', padding: 6, zIndex: 200,
                width: 'max-content', minWidth: 180,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: '#8B8CA7', textTransform: 'uppercase', letterSpacing: 0.4, padding: '4px 10px 6px' }}>
                Rewrite with AI
              </div>
              {REWRITE_MODES.map(({ mode, label }) => (
                <button
                  key={mode}
                  onClick={() => handleComposeRewrite(mode)}
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

      {/* Attachments List */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 20px', borderBottom: '1px solid #F0F0F0', background: '#FAFBFC' }}>
          {attachments.map((file, i) => (
            <div key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 8px',
              background: '#fff', border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 11, color: '#424242',
            }}>
              <Paperclip size={12} color="#8B8CA7" />
              <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
              <span style={{ color: '#B0B0B0', fontSize: 10 }}>({(file.size / 1024).toFixed(0)} KB)</span>
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} style={{
                border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: '#D13438', display: 'flex',
              }}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Body (contentEditable) */}
      <div
        ref={bodyRef}
        contentEditable
        suppressContentEditableWarning
        onPaste={(e) => {
          // Paste-to-attach: clipboard images (screenshots) / documents become
          // email attachments. Normal text/HTML paste falls through untouched.
          const items = e.clipboardData?.items;
          if (!items) return;
          const pasted: File[] = [];
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
              const f = items[i].getAsFile();
              if (!f) continue;
              const ext = (f.type.split('/')[1] || 'png').split('+')[0];
              pasted.push(
                f.name && f.name !== 'image.png'
                  ? f
                  : new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type }),
              );
            }
          }
          if (pasted.length > 0) {
            e.preventDefault(); // don't inline-embed; attach instead
            setAttachments((prev) => [...prev, ...pasted]);
          }
        }}
        style={{
          flex: 1, padding: '20px 24px', overflowY: 'auto', outline: 'none',
          fontSize: 14, lineHeight: 1.7, color: '#333', fontFamily: "'Segoe UI', Calibri, sans-serif",
          minHeight: 200,
        }}
        data-placeholder="Type your message here..."
      />

      {/* Signature Preview */}
      <div style={{ padding: '12px 24px', borderTop: '1px solid #F0F0F0', fontSize: 12, color: '#8B8CA7', background: '#FAFAFA', flexShrink: 0 }}>
        <p style={{ margin: 0 }}>Regards,</p>
        <p style={{ margin: '2px 0 0', fontWeight: 600, color: '#424242' }}>{userName}</p>
        {roleLine && <p style={{ margin: '2px 0 0' }}>{roleLine}</p>}
      </div>
    </div>
  );
}

function EmailChip({ email, onRemove }: { email: string; onRemove: () => void }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px 2px 10px',
      background: '#E8F0FE', borderRadius: 12, fontSize: 12, color: '#0078D4', fontWeight: 500,
    }}>
      {email}
      <button onClick={onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: '#0078D4' }}>
        <X size={12} />
      </button>
    </span>
  );
}

function ToolbarBtn({ icon, onClick, title }: { icon: React.ReactNode; onClick: () => void; title: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={title}
      style={{
        width: 30, height: 30, borderRadius: 4, border: 'none',
        background: hovered ? '#E8E8E8' : 'transparent', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#424242',
        transition: 'background 0.12s',
      }}
    >
      {icon}
    </button>
  );
}
