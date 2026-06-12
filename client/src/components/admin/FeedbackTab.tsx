/**
 * FeedbackTab — Admin Panel view of all feedback submitted from the login
 * page's "Give feedback" dialog. Feedback is stored in the `feedback` table
 * (NOT emailed) and shown here as cards, newest first. Admins can delete a
 * card once it's been handled.
 */

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Trash2, Loader2, AlertCircle, Heart } from 'lucide-react';
import api from '@/services/api';

interface FeedbackItem {
  id: string;
  mood: string | null;
  category: string | null;
  message: string;
  name: string | null;
  created_at: string;
}

export default function FeedbackTab() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/admin/feedback');
      setItems(data.feedback || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to load feedback');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((f) =>
      f.message?.toLowerCase().includes(q) ||
      f.category?.toLowerCase().includes(q) ||
      f.name?.toLowerCase().includes(q),
    );
  }, [items, filter]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this feedback? This cannot be undone.')) return;
    setDeleting(id);
    try {
      await api.delete(`/admin/feedback/${id}`);
      setItems((prev) => prev.filter((f) => f.id !== id));
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to delete');
    }
    setDeleting(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header row: count + search + refresh */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: '#1A1A2E', marginRight: 'auto' }}>
          <Heart size={16} color="#6264A7" /> {items.length} feedback {items.length === 1 ? 'entry' : 'entries'}
        </div>
        <div style={{ width: 320, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #ECECF4', borderRadius: 10, padding: '9px 14px' }}>
          <Search size={14} color="#8B8CA7" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search feedback…"
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', background: 'transparent' }}
          />
        </div>
        <button
          onClick={load}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 10, border: '1px solid #ECECF4', background: '#fff', fontSize: 13, fontWeight: 600, color: '#424242', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ textAlign: 'center', color: '#DC2626', fontSize: 13, padding: 30 }}>
          <AlertCircle size={32} style={{ marginBottom: 8 }} />
          <div>{error}</div>
          <button onClick={load} style={{ marginTop: 12, padding: '8px 22px', borderRadius: 8, border: 'none', background: '#6264A7', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
        </div>
      )}

      {loading && !error && (
        <div style={{ textAlign: 'center', padding: 40, color: '#8B8CA7', fontSize: 13 }}>
          <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
          <div style={{ marginTop: 8 }}>Loading feedback…</div>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#8B8CA7' }}>
          <Heart size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#424242', marginBottom: 4 }}>
            {filter ? `No feedback matches "${filter}"` : 'No feedback yet'}
          </div>
          {!filter && <div style={{ fontSize: 12 }}>Feedback submitted from the login page will appear here.</div>}
        </div>
      )}

      {/* Card grid */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filtered.map((f) => (
            <div
              key={f.id}
              style={{
                background: '#fff', border: '1px solid #ECECF4', borderRadius: 14,
                padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
                boxShadow: '0 1px 3px rgba(20,20,40,0.04)',
              }}
            >
              {/* Top row: mood + category + delete */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>{f.mood || '💬'}</span>
                {f.category && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12, background: '#F4F4FC', color: '#6264A7' }}>
                    {f.category}
                  </span>
                )}
                <button
                  onClick={() => handleDelete(f.id)}
                  disabled={deleting === f.id}
                  title="Delete feedback"
                  style={{
                    marginLeft: 'auto', width: 28, height: 28, borderRadius: 7, border: 'none',
                    background: 'transparent', color: '#C0C1D4', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#DC2626'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#C0C1D4'; }}
                >
                  {deleting === f.id ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={13} />}
                </button>
              </div>

              {/* Message */}
              <p style={{ fontSize: 13, color: '#333', lineHeight: 1.55, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                {f.message}
              </p>

              {/* Footer: who + when */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: '#8B8CA7', borderTop: '1px solid #F5F5FA', paddingTop: 10 }}>
                <span style={{ fontWeight: 600 }}>{f.name || 'Anonymous'}</span>
                <span>{formatDate(f.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Today, ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
