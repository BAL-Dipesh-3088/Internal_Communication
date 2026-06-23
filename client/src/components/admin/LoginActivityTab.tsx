/**
 * LoginActivityTab — Admin Panel → "Users Login".
 * Shows who signed in to the ICP portal, filtered by date range (Today /
 * Yesterday / Last 7 days / Last 2 weeks / Last month). Backed by the
 * login_events audit table via GET /api/admin/login-activity.
 * Modeled on Azure AD sign-in logs: per-event rows + a window summary.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, Search, Loader2, AlertCircle, LogIn, Users, Monitor,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import api from '@/services/api';

// Keep keys/labels in sync with LOGIN_RANGES on the server.
const RANGES: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last14', label: 'Last 2 weeks' },
  { key: 'last30', label: 'Last month' },
];

interface LoginEvent {
  id: string;
  logged_in_at: string;
  ip_address: string | null;
  user_agent: string | null;
  device: string;
  user_id: string;
  display_name: string;
  username: string;
  employee_id: string | null;
  department: string | null;
  avatar_url: string | null;
}

interface ApiResponse {
  range: string;
  rangeLabel: string;
  summary: { total_logins: number; unique_users: number };
  page: number;
  limit: number;
  events: LoginEvent[];
}

const PURPLE = '#6264A7';

export default function LoginActivityTab() {
  const [range, setRange] = useState('today');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState(''); // debounced value sent to API
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Debounce the search box so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(q); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get<ApiResponse>('/admin/login-activity', {
        params: { range, q: search, page, limit: 50 },
      });
      setData(data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to load login activity');
    }
    setLoading(false);
  }, [range, search, page]);

  useEffect(() => { load(); }, [load]);

  const events = data?.events || [];
  const summary = data?.summary || { total_logins: 0, unique_users: 0 };
  const hasNext = events.length === (data?.limit || 50);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header: title + search + refresh */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: '#1A1A2E', marginRight: 'auto' }}>
          <LogIn size={16} color={PURPLE} /> Users Login
          {data && <span style={{ fontWeight: 500, color: '#8B8CA7' }}>· {data.rangeLabel}</span>}
        </div>
        <div style={{ width: 300, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #ECECF4', borderRadius: 10, padding: '9px 14px' }}>
          <Search size={14} color="#8B8CA7" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or employee ID…"
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

      {/* Date-range filter chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {RANGES.map((r) => {
          const active = range === r.key;
          return (
            <button
              key={r.key}
              onClick={() => { setRange(r.key); setPage(1); }}
              style={{
                padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'inherit', transition: 'all 0.15s',
                border: active ? `1px solid ${PURPLE}` : '1px solid #ECECF4',
                background: active ? PURPLE : '#fff',
                color: active ? '#fff' : '#5A5A72',
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        <SummaryCard icon={<Users size={20} />} label="Unique users" value={summary.unique_users} color={PURPLE} bg="#F0F0FA" />
        <SummaryCard icon={<LogIn size={20} />} label="Total logins" value={summary.total_logins} color="#0078D4" bg="#E8F4FD" />
      </div>

      {/* States */}
      {error && (
        <div style={{ textAlign: 'center', color: '#DC2626', fontSize: 13, padding: 30 }}>
          <AlertCircle size={32} style={{ marginBottom: 8 }} />
          <div>{error}</div>
          <button onClick={load} style={{ marginTop: 12, padding: '8px 22px', borderRadius: 8, border: 'none', background: PURPLE, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
        </div>
      )}

      {loading && !error && (
        <div style={{ textAlign: 'center', padding: 40, color: '#8B8CA7', fontSize: 13 }}>
          <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
          <div style={{ marginTop: 8 }}>Loading login activity…</div>
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#8B8CA7' }}>
          <LogIn size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#424242', marginBottom: 4 }}>
            {search ? `No logins match "${search}"` : 'No logins in this period'}
          </div>
          <div style={{ fontSize: 12 }}>Try a wider date range, or check back after users sign in.</div>
        </div>
      )}

      {/* Table */}
      {!loading && !error && events.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #ECECF4', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ background: '#FAFAFD', textAlign: 'left' }}>
                  <Th>User</Th>
                  <Th>Signed in</Th>
                  <Th>Department</Th>
                  <Th>IP address</Th>
                  <Th>Device</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid #F2F2F8' }}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={e.display_name} url={e.avatar_url} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#1A1A2E', whiteSpace: 'nowrap' }}>{e.display_name}</div>
                          <div style={{ fontSize: 11, color: '#8B8CA7' }}>
                            {e.employee_id ? `ID ${e.employee_id}` : `@${e.username}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#424242', whiteSpace: 'nowrap' }}>{formatDateTime(e.logged_in_at)}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#5A5A72' }}>{e.department || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#5A5A72', fontFamily: 'monospace' }}>{e.ip_address || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#5A5A72' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Monitor size={13} color="#A0A1BC" /> {e.device}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {(page > 1 || hasNext) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #F2F2F8' }}>
              <span style={{ fontSize: 12, color: '#8B8CA7', marginRight: 'auto' }}>Page {page}</span>
              <PageBtn disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft size={15} /> Prev</PageBtn>
              <PageBtn disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={15} /></PageBtn>
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function SummaryCard({ icon, label, value, color, bg }: { icon: React.ReactNode; label: string; value: number; color: string; bg: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #ECECF4', borderRadius: 14, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 44, height: 44, borderRadius: 11, background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#1A1A2E', lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 12, color: '#8B8CA7', fontWeight: 500 }}>{label}</div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '11px 16px', fontSize: 11, fontWeight: 700, color: '#8B8CA7', textTransform: 'uppercase', letterSpacing: 0.4 }}>{children}</th>;
}

function PageBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8,
        border: '1px solid #ECECF4', background: '#fff', fontSize: 12, fontWeight: 600,
        color: disabled ? '#C0C1D4' : '#424242', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return <img src={url} alt={name} style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#E7E7F4', color: PURPLE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
      {initials}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
