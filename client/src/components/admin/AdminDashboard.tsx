import React, { useEffect, useState } from 'react';
import {
  Users, MessageSquare, FileText, Phone, Activity,
  Search, Shield, HardDrive, Wifi, WifiOff,
  RefreshCw, Clock, Database, Server,
  CheckCircle, XCircle, AlertTriangle, IdCard, Heart,
  Link, Unlink, Loader, X, Eye, Paperclip, Image, Download,
  UserPlus,
} from 'lucide-react';
import api from '@/services/api';
import MailAccountSection, { MailStatusBadge } from './MailAccountSection';
import OnboardTab from './OnboardTab';
import EmployeeIdsTab from './EmployeeIdsTab';
import FeedbackTab from './FeedbackTab';

interface DashboardStats {
  users: { total: number; online: number };
  conversations: number;
  messages: number;
  files: { count: number; totalSizeBytes: number };
  callsToday: number;
  onlineUsers: { id: string; username: string; display_name: string }[] | string[];
}

interface SystemHealth {
  status: string;
  checks: Record<string, any>;
}

type Tab = 'overview' | 'users' | 'onboard' | 'employees' | 'conversations' | 'feedback' | 'search' | 'health';

const TAB_LIST: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: 'Overview', icon: <Activity size={15} /> },
  { key: 'users', label: 'Users', icon: <Users size={15} /> },
  { key: 'onboard', label: 'Onboard', icon: <UserPlus size={15} /> },
  { key: 'employees', label: 'Employee IDs', icon: <IdCard size={15} /> },
  { key: 'conversations', label: 'Conversations', icon: <MessageSquare size={15} /> },
  { key: 'feedback', label: 'Feedback', icon: <Heart size={15} /> },
  { key: 'search', label: 'Search', icon: <Search size={15} /> },
  { key: 'health', label: 'Health', icon: <Server size={15} /> },
];

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hoverRefresh, setHoverRefresh] = useState(false);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    setIsLoading(true);
    try {
      const [statsRes, healthRes, analyticsRes] = await Promise.allSettled([
        api.get('/admin/dashboard'),
        api.get('/admin/health'),
        api.get('/admin/dashboard/analytics'),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
      if (healthRes.status === 'fulfilled') setHealth(healthRes.value.data);
      if (analyticsRes.status === 'fulfilled') setAnalytics(analyticsRes.value.data);
    } catch (err) { console.error('Failed to load dashboard:', err); }
    setIsLoading(false);
  };

  const loadUsers = async () => {
    try { const { data } = await api.get('/admin/users'); setUsers(data.users || []); }
    catch (err) { console.error('Failed to load users:', err); }
  };

  const loadConversations = async () => {
    try { const { data } = await api.get('/admin/conversations'); setConversations(data.conversations || []); }
    catch (err) { console.error('Failed to load conversations:', err); }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try { const { data } = await api.get('/admin/messages/search', { params: { q: searchQuery } }); setSearchResults(data.messages || []); }
    catch (err) { console.error('Search failed:', err); }
  };

  useEffect(() => {
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'conversations') loadConversations();
  }, [activeTab]);

  if (isLoading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8F9FC' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 36, height: 36, border: '3px solid #E8E8F0', borderTopColor: '#6264A7', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 13, color: '#8B8CA7' }}>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const healthStatus = health?.status || 'unknown';
  const healthColor = healthStatus === 'healthy' ? '#16A34A' : healthStatus === 'degraded' ? '#D97706' : '#DC2626';
  const healthBg = healthStatus === 'healthy' ? '#F0FDF4' : healthStatus === 'degraded' ? '#FFFBEB' : '#FEF2F2';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: "'Segoe UI', -apple-system, sans-serif" }}>
      {/* Header */}
      <div
        style={{
          height: 60, minHeight: 60, padding: '0 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid #E8E8F0', background: '#FFFFFF', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg, #6264A7, #5B5FC7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={17} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 16, fontWeight: 700, color: '#1A1A2E', margin: 0 }}>Admin Panel</h1>
            <p style={{ fontSize: 11, color: '#8B8CA7', margin: 0 }}>System management & compliance</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: healthColor, background: healthBg, padding: '4px 12px', borderRadius: 20, textTransform: 'capitalize' }}>
            {healthStatus}
          </span>
          <button
            onClick={loadDashboard}
            onMouseEnter={() => setHoverRefresh(true)}
            onMouseLeave={() => setHoverRefresh(false)}
            style={{
              width: 34, height: 34, borderRadius: 8, border: '1px solid #E8E8F0',
              background: hoverRefresh ? '#F4F4FC' : '#fff', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#6264A7', transition: 'all 0.15s',
            }}
            title="Refresh"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #E8E8F0', background: '#FFFFFF', padding: '0 20px', flexShrink: 0, gap: 2, overflowX: 'auto' }}>
        {TAB_LIST.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '12px 16px', fontSize: 13, fontWeight: isActive ? 600 : 500,
                color: isActive ? '#6264A7' : '#6E6F8A',
                background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: isActive ? '2px solid #6264A7' : '2px solid transparent',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = '#3D3D56'; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = '#6E6F8A'; }}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: '#F8F9FC' }}>
        {activeTab === 'overview' && stats && <OverviewTab stats={stats} analytics={analytics} />}
        {activeTab === 'users' && <UsersTab users={users} onRefresh={loadUsers} />}
        {activeTab === 'onboard' && <OnboardTab />}
        {activeTab === 'employees' && <EmployeeIdsTab />}
        {activeTab === 'feedback' && <FeedbackTab />}
        {activeTab === 'conversations' && <ConversationsTab conversations={conversations} />}
        {activeTab === 'search' && <SearchTab query={searchQuery} onQueryChange={setSearchQuery} onSearch={handleSearch} results={searchResults} />}
        {activeTab === 'health' && health && <HealthTab health={health} />}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ======================== MESSAGE VOLUME LINE GRAPH ======================== */
function MessageVolumeChart({ data }: { data: { day: string; count: number }[] }) {
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: '0 0 20px 0' }}>Message Volume — Last 7 Days</h3>
        <p style={{ fontSize: 13, color: '#8B8CA7', textAlign: 'center', padding: '30px 0' }}>No message data available</p>
      </div>
    );
  }

  const maxCount = Math.max(...data.map(d => d.count), 1);
  // Round up to a nice number for Y-axis
  const niceMax = maxCount <= 5 ? 5 : maxCount <= 10 ? 10 : maxCount <= 20 ? 20 : maxCount <= 50 ? 50 : Math.ceil(maxCount / 10) * 10;
  const yTicks = [0, Math.round(niceMax * 0.25), Math.round(niceMax * 0.5), Math.round(niceMax * 0.75), niceMax];

  // SVG dimensions
  const W = 600, H = 220;
  const padLeft = 40, padRight = 20, padTop = 20, padBottom = 35;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  // Compute points
  const points = data.map((d, i) => ({
    x: padLeft + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2),
    y: padTop + chartH - (d.count / niceMax) * chartH,
    count: d.count,
    day: d.day,
  }));

  // Smooth bezier curve path
  const buildSmoothPath = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y}`;
    let path = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const curr = pts[i];
      const next = pts[i + 1];
      const cpx = (curr.x + next.x) / 2;
      path += ` C ${cpx} ${curr.y}, ${cpx} ${next.y}, ${next.x} ${next.y}`;
    }
    return path;
  };

  const linePath = buildSmoothPath(points);
  // Area path (same curve, closed at bottom)
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padTop + chartH} L ${points[0].x} ${padTop + chartH} Z`;

  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: '24px 24px 16px 24px', border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>Message Volume — Last 7 Days</h3>
        <span style={{ fontSize: 11, color: '#A0A1BC', fontWeight: 500 }}>
          Total: {data.reduce((s, d) => s + d.count, 0)} messages
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', overflow: 'visible' }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6264A7" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#6264A7" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6264A7" />
            <stop offset="100%" stopColor="#8B8DF0" />
          </linearGradient>
          <filter id="dotShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#6264A7" floodOpacity="0.3" />
          </filter>
        </defs>

        {/* Horizontal grid lines */}
        {yTicks.map((tick, i) => {
          const y = padTop + chartH - (tick / niceMax) * chartH;
          return (
            <g key={`grid-${i}`}>
              <line x1={padLeft} y1={y} x2={W - padRight} y2={y} stroke="#E8E8F0" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '4 3'} />
              <text x={padLeft - 8} y={y + 4} textAnchor="end" fill="#A0A1BC" fontSize="10" fontFamily="inherit">{tick}</text>
            </g>
          );
        })}

        {/* Gradient area fill */}
        <path d={areaPath} fill="url(#areaGrad)" />

        {/* Main line */}
        <path d={linePath} fill="none" stroke="url(#lineGrad)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover vertical line */}
        {hoverIdx !== null && (
          <line
            x1={points[hoverIdx].x} y1={padTop}
            x2={points[hoverIdx].x} y2={padTop + chartH}
            stroke="#6264A7" strokeWidth="1" strokeDasharray="4 3" opacity="0.5"
          />
        )}

        {/* Data points */}
        {points.map((pt, i) => (
          <g key={`dot-${i}`}>
            {/* Invisible wider hit area for hover */}
            <rect
              x={pt.x - (chartW / data.length / 2)}
              y={padTop}
              width={chartW / data.length}
              height={chartH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
            {/* Outer glow on hover */}
            {hoverIdx === i && (
              <circle cx={pt.x} cy={pt.y} r={8} fill="#6264A7" opacity="0.12" />
            )}
            {/* White ring */}
            <circle cx={pt.x} cy={pt.y} r={hoverIdx === i ? 5 : 4} fill="#fff" stroke="#6264A7" strokeWidth="2" filter="url(#dotShadow)" style={{ transition: 'r 0.15s ease' }} />
            {/* Inner dot */}
            <circle cx={pt.x} cy={pt.y} r={hoverIdx === i ? 2.5 : 2} fill="#6264A7" style={{ transition: 'r 0.15s ease' }} />
          </g>
        ))}

        {/* Hover tooltip */}
        {hoverIdx !== null && (() => {
          const pt = points[hoverIdx];
          const dateStr = new Date(pt.day).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
          const tooltipW = 110;
          const tooltipH = 44;
          let tx = pt.x - tooltipW / 2;
          if (tx < padLeft) tx = padLeft;
          if (tx + tooltipW > W - padRight) tx = W - padRight - tooltipW;
          const ty = pt.y - tooltipH - 12;
          return (
            <g>
              {/* Arrow */}
              <polygon points={`${pt.x - 5},${ty + tooltipH} ${pt.x + 5},${ty + tooltipH} ${pt.x},${ty + tooltipH + 6}`} fill="#1A1A2E" />
              {/* Box */}
              <rect x={tx} y={ty} width={tooltipW} height={tooltipH} rx="8" fill="#1A1A2E" />
              <text x={tx + tooltipW / 2} y={ty + 17} textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700" fontFamily="inherit">{pt.count} messages</text>
              <text x={tx + tooltipW / 2} y={ty + 33} textAnchor="middle" fill="#A0A1BC" fontSize="10" fontFamily="inherit">{dateStr}</text>
            </g>
          );
        })()}

        {/* X-axis labels */}
        {points.map((pt, i) => {
          const dayName = new Date(data[i].day).toLocaleDateString('en', { weekday: 'short' });
          return (
            <text key={`label-${i}`} x={pt.x} y={H - 8} textAnchor="middle" fill={hoverIdx === i ? '#6264A7' : '#A0A1BC'} fontSize="11" fontWeight={hoverIdx === i ? '600' : '400'} fontFamily="inherit" style={{ transition: 'fill 0.15s' }}>{dayName}</text>
          );
        })}
      </svg>
    </div>
  );
}

/* ======================== OVERVIEW TAB ======================== */
function OverviewTab({ stats, analytics }: { stats: DashboardStats; analytics: any }) {
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const msgToday = analytics?.messagesToday ?? 0;
  const msgYesterday = analytics?.messagesYesterday ?? 0;
  const msgTrend = msgYesterday > 0 ? Math.round(((msgToday - msgYesterday) / msgYesterday) * 100) : 0;

  const statCards: { icon: React.ReactNode; label: string; value: number; sub: string; color: string; bgColor: string; trend?: number }[] = [
    { icon: <Users size={20} />, label: 'Total Users', value: stats.users.total, sub: `${stats.users.online} online`, color: '#6264A7', bgColor: '#F0F0FA' },
    { icon: <MessageSquare size={20} />, label: 'Messages Today', value: msgToday, sub: `${stats.messages} total`, color: '#0078D4', bgColor: '#E8F4FD', trend: msgTrend },
    { icon: <FileText size={20} />, label: 'Files', value: stats.files.count, sub: formatBytes(stats.files.totalSizeBytes), color: '#16A34A', bgColor: '#F0FDF4' },
    { icon: <Phone size={20} />, label: 'Calls Today', value: stats.callsToday, sub: 'via UCM6304', color: '#D97706', bgColor: '#FFFBEB' },
  ];

  // 7-day message data for line graph
  const days7 = analytics?.messagesLast7Days || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
        {statCards.map((card) => (
          <div key={card.label} style={{ background: '#fff', borderRadius: 14, padding: '22px 24px', border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: card.bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                {card.icon}
              </div>
              {card.trend !== undefined && card.trend !== 0 && (
                <span style={{ fontSize: 11, fontWeight: 600, color: card.trend > 0 ? '#16A34A' : '#DC2626', background: card.trend > 0 ? '#F0FDF4' : '#FEF2F2', padding: '3px 8px', borderRadius: 8 }}>
                  {card.trend > 0 ? '↑' : '↓'} {Math.abs(card.trend)}%
                </span>
              )}
            </div>
            <p style={{ fontSize: 28, fontWeight: 700, color: '#1A1A2E', margin: '0 0 4px 0', lineHeight: 1 }}>{card.value.toLocaleString()}</p>
            <p style={{ fontSize: 13, fontWeight: 500, color: '#6E6F8A', margin: '0 0 2px 0' }}>{card.label}</p>
            <p style={{ fontSize: 11, color: '#A0A1BC', margin: 0 }}>{card.sub}</p>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        {/* 7-Day Message Volume */}
        <MessageVolumeChart data={days7} />

        {/* Top Active Users */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: '0 0 16px 0' }}>Top Active Users</h3>
          {(analytics?.topUsers || []).map((u: any, i: number) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i > 0 ? '1px solid #F0F0F5' : 'none' }}>
              <span style={{ width: 20, fontSize: 12, fontWeight: 700, color: i < 3 ? '#6264A7' : '#A0A1BC', textAlign: 'center' }}>{i + 1}</span>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#6264A7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                {(u.display_name || u.username)?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1A2E', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name || u.username}</p>
                <p style={{ fontSize: 10, color: '#A0A1BC', margin: 0 }}>{u.department || '—'}</p>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#6264A7' }}>{u.message_count}</span>
            </div>
          ))}
          {(!analytics?.topUsers || analytics.topUsers.length === 0) && (
            <p style={{ fontSize: 13, color: '#8B8CA7', textAlign: 'center' }}>No activity data</p>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Department Distribution */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: '0 0 16px 0' }}>Department Distribution</h3>
          {(analytics?.departments || []).map((d: any, i: number) => {
            const maxCount = Math.max(...(analytics?.departments || []).map((x: any) => x.count), 1);
            const pct = (d.count / maxCount) * 100;
            const colors = ['#6264A7', '#0078D4', '#16A34A', '#D97706', '#DC2626', '#8B5CF6', '#EC4899'];
            return (
              <div key={d.department} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#3D3D56', fontWeight: 500 }}>{d.department}</span>
                  <span style={{ fontSize: 12, color: '#8B8CA7', fontWeight: 600 }}>{d.count}</span>
                </div>
                <div style={{ height: 6, background: '#F0F0F5', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: colors[i % colors.length], borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Online Users */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#16A34A' }} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>
              Online Users ({stats.onlineUsers.length})
            </h3>
          </div>
          {stats.onlineUsers.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {stats.onlineUsers.map((user) => {
                const isObj = typeof user === 'object' && user !== null;
                const key = isObj ? (user as any).id : user;
                const name = isObj ? ((user as any).display_name || (user as any).username) : String(user).slice(0, 8) + '...';
                return (
                  <span key={key} style={{ padding: '5px 12px', borderRadius: 20, background: '#F0FDF4', color: '#16A34A', fontSize: 12, fontWeight: 500, border: '1px solid #DCFCE7' }}>
                    {name}
                  </span>
                );
              })}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: '#8B8CA7' }}>No users currently online</p>
          )}

          {/* Storage */}
          {analytics?.storage && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #F0F0F5' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <HardDrive size={14} color="#8B8CA7" />
                <span style={{ fontSize: 12, fontWeight: 500, color: '#6E6F8A' }}>Storage Usage</span>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: '#1A1A2E', margin: '0 0 2px 0' }}>{formatBytes(analytics.storage.totalBytes)}</p>
              <p style={{ fontSize: 11, color: '#A0A1BC', margin: 0 }}>{analytics.storage.count} files stored</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================== USERS TAB ======================== */
function UsersTab({ users, onRefresh }: { users: any[]; onRefresh: () => void }) {
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  const [deptFilter, setDeptFilter] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [tempPassword, setTempPassword] = useState('');

  const departments = [...new Set(users.map((u: any) => u.department).filter(Boolean))].sort();

  const filtered = users.filter((u: any) => {
    const matchesDept = !deptFilter || u.department === deptFilter;
    const matchesSearch = !userSearch ||
      (u.display_name || '').toLowerCase().includes(userSearch.toLowerCase()) ||
      (u.username || '').toLowerCase().includes(userSearch.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(userSearch.toLowerCase());
    return matchesDept && matchesSearch;
  });

  const handleToggleActive = async (userId: string) => {
    setActionLoading(true);
    try {
      await api.put(`/admin/users/${userId}/toggle-active`);
      onRefresh();
      if (selectedUser?.id === userId) {
        setSelectedUser((prev: any) => prev ? { ...prev, is_active: !prev.is_active } : null);
      }
    } catch (err: any) { alert(err.response?.data?.error || 'Failed'); }
    setActionLoading(false);
  };

  const handleResetPassword = async (userId: string) => {
    // The admin types the temporary password themselves (easy to read out over
    // the phone). The user is then FORCED to set their own at next login.
    const chosen = prompt(
      'Type the temporary password for this user (min 6 characters).\n' +
      'Their current password will be replaced, and they must set their own password at next login.',
    );
    if (chosen === null) return; // cancelled
    const newPassword = chosen.trim();
    if (newPassword.length < 6) { alert('Temporary password must be at least 6 characters.'); return; }
    setActionLoading(true);
    try {
      const { data } = await api.put(`/admin/users/${userId}/reset-password`, { newPassword });
      setTempPassword(data.tempPassword);
    } catch (err: any) { alert(err.response?.data?.error || 'Failed'); }
    setActionLoading(false);
  };

  const handleSaveField = async (userId: string, field: string, value: string) => {
    setActionLoading(true);
    try {
      await api.put(`/admin/users/${userId}`, { [field]: value });
      onRefresh();
      if (selectedUser?.id === userId) setSelectedUser((prev: any) => prev ? { ...prev, [field]: value } : null);
    } catch (err: any) { alert(err.response?.data?.error || 'Failed'); }
    setEditingField(null);
    setActionLoading(false);
  };

  const thStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 12, fontWeight: 600, color: '#6E6F8A', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.5px' };
  const tdStyle: React.CSSProperties = { padding: '14px 16px', fontSize: 13, color: '#3D3D56', borderTop: '1px solid #F0F0F5' };

  return (
    <div style={{ display: 'flex', gap: 20 }}>
      {/* Left: User Table */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            type="text" value={userSearch} onChange={(e) => setUserSearch(e.target.value)}
            placeholder="Search users..."
            style={{ flex: 1, minWidth: 200, padding: '10px 14px', border: '2px solid #E8E8F0', borderRadius: 10, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: '#fff' }}
          />
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
            style={{ padding: '10px 14px', border: '2px solid #E8E8F0', borderRadius: 10, fontSize: 13, background: '#fff', fontFamily: 'inherit', color: '#3D3D56', minWidth: 150 }}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', background: '#fff', border: '1px solid #E8E8F0', borderRadius: 10, fontSize: 13, color: '#6264A7', cursor: 'pointer', fontFamily: 'inherit' }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {/* Table */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
              <thead>
                <tr style={{ background: '#F8F9FC' }}>
                  <th style={thStyle}>User</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Department</th>
                  <th style={thStyle}>Employee ID</th>
                  <th style={thStyle}>Mail</th>
                  <th style={thStyle}>Messages</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user: any) => (
                  <tr key={user.id}
                    onClick={() => { setSelectedUser(user); setTempPassword(''); setEditingField(null); }}
                    style={{ cursor: 'pointer', background: selectedUser?.id === user.id ? '#F4F4FC' : '#fff', opacity: user.is_active === false ? 0.5 : 1 }}
                    onMouseEnter={(e) => { if (selectedUser?.id !== user.id) e.currentTarget.style.background = '#FAFAFF'; }}
                    onMouseLeave={(e) => { if (selectedUser?.id !== user.id) e.currentTarget.style.background = '#fff'; }}>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: user.is_active === false ? '#C0C1D4' : '#6264A7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                          {(user.display_name || user.username)?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>{user.display_name || user.username}</p>
                          <p style={{ fontSize: 11, color: '#A0A1BC', margin: 0 }}>@{user.username}</p>
                        </div>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 12,
                        background: user.role === 'admin' ? '#F0F0FA' : user.role === 'manager' ? '#E8F4FD' : '#F5F5F5',
                        color: user.role === 'admin' ? '#6264A7' : user.role === 'manager' ? '#0078D4' : '#6E6F8A',
                      }}>
                        {user.role}
                      </span>
                    </td>
                    <td style={tdStyle}>{user.department || <span style={{ color: '#C0C1D4' }}>—</span>}</td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{user.employee_id || <span style={{ color: '#C0C1D4' }}>—</span>}</td>
                    <td style={tdStyle}><MailStatusBadge status={user.mail_status} /></td>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{user.message_count ?? 0}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: user.status === 'online' ? '#16A34A' : user.status === 'away' ? '#D97706' : user.status === 'busy' || user.status === 'dnd' ? '#DC2626' : '#C0C1D4' }} />
                        <span style={{ fontSize: 12, color: user.status === 'online' ? '#16A34A' : '#8B8CA7', fontWeight: 500, textTransform: 'capitalize' }}>{user.status || 'offline'}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#8B8CA7', fontSize: 13 }}>
              {users.length === 0 ? 'Loading users...' : 'No users match your filters'}
            </div>
          )}
        </div>
      </div>

      {/* Right: User Detail Panel */}
      {selectedUser && (
        <div style={{ width: 340, flexShrink: 0, background: '#fff', borderRadius: 14, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden', alignSelf: 'flex-start', position: 'sticky', top: 0 }}>
          {/* Header */}
          <div style={{ padding: '24px 20px 16px', textAlign: 'center', borderBottom: '1px solid #F0F0F5' }}>
            <button onClick={() => setSelectedUser(null)} style={{ position: 'absolute', right: 12, top: 12, background: 'none', border: 'none', cursor: 'pointer', color: '#A0A1BC', fontSize: 18 }}>×</button>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: selectedUser.is_active === false ? '#C0C1D4' : '#6264A7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, margin: '0 auto 12px' }}>
              {(selectedUser.display_name || selectedUser.username)?.[0]?.toUpperCase() || '?'}
            </div>
            <p style={{ fontSize: 16, fontWeight: 700, color: '#1A1A2E', margin: '0 0 2px 0' }}>{selectedUser.display_name || selectedUser.username}</p>
            <p style={{ fontSize: 12, color: '#8B8CA7', margin: '0 0 8px 0' }}>@{selectedUser.username}</p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: selectedUser.role === 'admin' ? '#F0F0FA' : '#F5F5F5', color: selectedUser.role === 'admin' ? '#6264A7' : '#6E6F8A' }}>{selectedUser.role}</span>
              {selectedUser.is_active === false && <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: '#FEF2F2', color: '#DC2626' }}>Disabled</span>}
              {selectedUser.employee_id && <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: '#F0FDF4', color: '#16A34A', fontFamily: 'monospace' }}>ID {selectedUser.employee_id}</span>}
            </div>
          </div>

          {/* Details */}
          <div style={{ padding: '16px 20px' }}>
            {[
              { label: 'Email', value: selectedUser.email, field: '' },
              { label: 'Department', value: selectedUser.department, field: 'department' },
              { label: 'Designation', value: selectedUser.designation, field: 'designation' },
              { label: 'Display Name', value: selectedUser.display_name, field: 'display_name' },
            ].map((item) => (
              <div key={item.label} style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11, color: '#8B8CA7', margin: '0 0 3px 0', fontWeight: 500 }}>{item.label}</p>
                {editingField === item.field && item.field ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={editValue} onChange={(e) => setEditValue(e.target.value)}
                      style={{ flex: 1, padding: '5px 8px', border: '1px solid #6264A7', borderRadius: 6, fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                      autoFocus onKeyDown={(e) => e.key === 'Enter' && handleSaveField(selectedUser.id, item.field, editValue)} />
                    <button onClick={() => handleSaveField(selectedUser.id, item.field, editValue)}
                      style={{ padding: '5px 10px', background: '#6264A7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>Save</button>
                  </div>
                ) : (
                  <p
                    onClick={() => { if (item.field) { setEditingField(item.field); setEditValue(item.value || ''); } }}
                    style={{ fontSize: 13, color: '#3D3D56', margin: 0, cursor: item.field ? 'pointer' : 'default', padding: '4px 0', borderBottom: item.field ? '1px dashed #E8E8F0' : 'none' }}
                    title={item.field ? 'Click to edit' : ''}
                  >
                    {item.value || <span style={{ color: '#C0C1D4', fontStyle: 'italic' }}>Not set</span>}
                  </p>
                )}
              </div>
            ))}

            {/* Role dropdown */}
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: '#8B8CA7', margin: '0 0 3px 0', fontWeight: 500 }}>Role</p>
              <select value={selectedUser.role}
                onChange={(e) => handleSaveField(selectedUser.id, 'role', e.target.value)}
                style={{ width: '100%', padding: '6px 10px', border: '1px solid #E8E8F0', borderRadius: 6, fontSize: 13, background: '#fff', fontFamily: 'inherit', color: '#3D3D56' }}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
              <div style={{ padding: '10px 12px', background: '#F8F9FC', borderRadius: 8, textAlign: 'center' }}>
                <p style={{ fontSize: 18, fontWeight: 700, color: '#6264A7', margin: 0 }}>{selectedUser.message_count ?? 0}</p>
                <p style={{ fontSize: 10, color: '#8B8CA7', margin: 0 }}>Messages</p>
              </div>
              <div style={{ padding: '10px 12px', background: '#F8F9FC', borderRadius: 8, textAlign: 'center' }}>
                <p style={{ fontSize: 18, fontWeight: 700, color: '#0078D4', margin: 0 }}>{selectedUser.file_count ?? 0}</p>
                <p style={{ fontSize: 10, color: '#8B8CA7', margin: 0 }}>Files</p>
              </div>
            </div>

            {/* Last Seen */}
            <p style={{ fontSize: 11, color: '#A0A1BC', margin: '0 0 16px 0' }}>
              Last seen: {selectedUser.last_seen ? new Date(selectedUser.last_seen).toLocaleString() : 'Never'}
            </p>

            {/* Mail Account (Stalwart) */}
            <MailAccountSection
              user={selectedUser}
              onChanged={(status) => {
                // Reflect the new status in the parent list + selection
                setSelectedUser((prev: any) => prev ? { ...prev, mail_status: status } : prev);
                onRefresh();
              }}
            />

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => handleToggleActive(selectedUser.id)} disabled={actionLoading}
                style={{ width: '100%', padding: '10px', background: selectedUser.is_active === false ? '#F0FDF4' : '#FEF2F2', border: `1px solid ${selectedUser.is_active === false ? '#BBF7D0' : '#FECACA'}`, borderRadius: 8, fontSize: 13, fontWeight: 600, color: selectedUser.is_active === false ? '#16A34A' : '#DC2626', cursor: 'pointer', fontFamily: 'inherit' }}>
                {selectedUser.is_active === false ? 'Enable Account' : 'Disable Account'}
              </button>
              <button onClick={() => handleResetPassword(selectedUser.id)} disabled={actionLoading}
                style={{ width: '100%', padding: '10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#D97706', cursor: 'pointer', fontFamily: 'inherit' }}>
                Reset Password
              </button>
              {tempPassword && (
                <div style={{ padding: '10px 12px', background: '#F0FDF4', borderRadius: 8, border: '1px solid #BBF7D0' }}>
                  <p style={{ fontSize: 11, color: '#16A34A', margin: '0 0 4px 0', fontWeight: 600 }}>Temporary Password:</p>
                  <p style={{ fontSize: 15, fontFamily: 'monospace', fontWeight: 700, color: '#1A1A2E', margin: 0, letterSpacing: '1px' }}>{tempPassword}</p>
                  <p style={{ fontSize: 10, color: '#8B8CA7', margin: '4px 0 0 0' }}>Share this with the user. They will be required to set their own password at next login.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ======================== CONVERSATION VIEWER MODAL ======================== */
function ConversationViewerModal({ conversation, onClose }: { conversation: any; onClose: () => void }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  const convDisplayName = conversation.name || conversation.member_names || 'Conversation';

  // ─── Export Utilities ────────────────────────────────────────
  const triggerDownload = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sanitizeFilename = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').substring(0, 60);

  const formatExportDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };

  const formatExportTime = (iso: string) => {
    return new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getMsgText = (msg: any) => {
    if (msg.deleted_at) return '[DELETED]';
    const parts: string[] = [];
    if (msg.content) parts.push(msg.content);
    if (msg.type === 'file' || msg.type === 'image') {
      const meta = msg.metadata || {};
      const fname = meta.fileName || meta.filename || 'attachment';
      parts.push(`[File: ${fname}]`);
    }
    if (msg.is_edited) parts.push('[edited]');
    return parts.join(' ') || '[empty]';
  };

  const handleExport = async (format: 'csv' | 'txt') => {
    setExporting(true);
    try {
      const res = await api.get(`/admin/conversations/${conversation.id}/export`);
      const { messages: allMsgs, exportedAt, exportedBy } = res.data;
      const dateStr = new Date().toISOString().slice(0, 10);
      const safeName = sanitizeFilename(convDisplayName);

      if (format === 'csv') {
        const header = 'Date,Time,Sender,Message,Type,Status,Attachment';
        const rows = allMsgs.map((m: any) => {
          const date = new Date(m.created_at).toLocaleDateString('en-CA');
          const time = formatExportTime(m.created_at);
          const sender = (m.sender?.displayName || m.sender?.username || 'System').replace(/"/g, '""');
          const content = (m.deleted_at ? '[DELETED]' : (m.content || '')).replace(/"/g, '""').replace(/\n/g, ' ');
          const type = m.type || 'text';
          const status = m.deleted_at ? 'deleted' : m.is_edited ? 'edited' : 'normal';
          const meta = m.metadata || {};
          const attachment = (meta.fileName || meta.filename || '').replace(/"/g, '""');
          return `"${date}","${time}","${sender}","${content}","${type}","${status}","${attachment}"`;
        });
        const csv = [header, ...rows].join('\n');
        triggerDownload('\uFEFF' + csv, `Chat_${safeName}_${dateStr}.csv`, 'text/csv;charset=utf-8');
      } else {
        const border = String.fromCharCode(9552).repeat(55);
        const thin = String.fromCharCode(9472).repeat(55);
        const lines: string[] = [];
        lines.push(border);
        lines.push('  CONVERSATION TRANSCRIPT \u2014 CONFIDENTIAL');
        lines.push(border);
        lines.push(`  Conversation : ${convDisplayName}`);
        lines.push(`  Type         : ${conversation.type === 'direct' ? 'Direct Message' : 'Group Conversation'} | ${conversation.member_count} members`);
        lines.push(`  Total Msgs   : ${allMsgs.length}`);
        lines.push(`  Exported     : ${new Date(exportedAt).toLocaleString('en', { dateStyle: 'full', timeStyle: 'short' })}`);
        lines.push(`  Exported By  : ${exportedBy}`);
        lines.push(thin);
        lines.push('');

        let lastDate = '';
        for (const msg of allMsgs) {
          const date = formatExportDate(msg.created_at);
          if (date !== lastDate) {
            lines.push('');
            lines.push(`--- ${date} ---`);
            lines.push('');
            lastDate = date;
          }
          const time = formatExportTime(msg.created_at);
          const sender = msg.sender?.displayName || msg.sender?.username || 'System';
          const text = getMsgText(msg);
          lines.push(`[${time}] ${sender}: ${text}`);
        }

        lines.push('');
        lines.push(thin);
        lines.push(`END OF TRANSCRIPT | ${allMsgs.length} messages`);
        lines.push(border);

        triggerDownload(lines.join('\n'), `Transcript_${safeName}_${dateStr}.txt`, 'text/plain;charset=utf-8');
      }
    } catch (err: any) {
      console.error('Export failed:', err);
      alert('Export failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    const fetchMessages = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/admin/conversations/${conversation.id}/messages?limit=200`);
        setMessages(res.data.messages || []);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to load messages');
      } finally {
        setLoading(false);
      }
    };
    fetchMessages();
  }, [conversation.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getInitial = (name: string) => (name || '?')[0].toUpperCase();

  const avatarColors = ['#6264A7', '#0078D4', '#498205', '#CA5010', '#8764B8', '#DA3B01', '#00B294'];
  const getAvatarColor = (id: string) => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return avatarColors[Math.abs(hash) % avatarColors.length];
  };

  const renderMessageContent = (msg: any) => {
    if (msg.deleted_at) {
      return (
        <span style={{ fontStyle: 'italic', color: '#C0C1D4', fontSize: 13 }}>This message was deleted</span>
      );
    }
    const parts: React.ReactNode[] = [];
    if (msg.content) {
      parts.push(<span key="text" style={{ fontSize: 13, color: '#1A1A2E', lineHeight: 1.5, wordBreak: 'break-word' }}>{msg.content}</span>);
    }
    if (msg.type === 'file' || msg.type === 'image') {
      const meta = msg.metadata || {};
      const fileName = meta.fileName || meta.filename || 'Attachment';
      const isImage = msg.type === 'image' || (meta.mimeType || '').startsWith('image/');
      parts.push(
        <div key="file" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: msg.content ? 6 : 0, padding: '8px 12px', background: '#F5F5FA', borderRadius: 8, border: '1px solid #E8E8F0' }}>
          {isImage ? <Image size={16} color="#6264A7" /> : <Paperclip size={16} color="#6264A7" />}
          <span style={{ fontSize: 12, color: '#6264A7', fontWeight: 500 }}>{fileName}</span>
          {meta.fileSize && <span style={{ fontSize: 10, color: '#A0A1BC' }}>({(meta.fileSize / 1024).toFixed(1)} KB)</span>}
        </div>
      );
    }
    return <>{parts}</>;
  };

  // Group messages by date
  const groupedMessages: { date: string; msgs: any[] }[] = [];
  let lastDate = '';
  messages.forEach(msg => {
    const date = new Date(msg.created_at).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (date !== lastDate) {
      groupedMessages.push({ date, msgs: [] });
      lastDate = date;
    }
    groupedMessages[groupedMessages.length - 1].msgs.push(msg);
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      {/* Backdrop */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }} />

      {/* Modal */}
      <div
        style={{ position: 'relative', width: '90%', maxWidth: 720, height: '80vh', maxHeight: 700, background: '#fff', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #E8E8F0', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0, background: '#FAFAFF' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: conversation.type === 'group' ? '#E8F4FD' : '#F0F0FA',
            color: conversation.type === 'group' ? '#0078D4' : '#6264A7',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {conversation.type === 'group' ? <Users size={18} /> : <MessageSquare size={18} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#1A1A2E', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{convDisplayName}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: conversation.type === 'group' ? '#E8F4FD' : '#F5F5F5', color: conversation.type === 'group' ? '#0078D4' : '#6E6F8A' }}>{conversation.type}</span>
              <span style={{ fontSize: 11, color: '#8B8CA7' }}>{conversation.member_count} members</span>
              <span style={{ fontSize: 11, color: '#8B8CA7' }}>{conversation.message_count} messages</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 8, color: '#6E6F8A', display: 'flex' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F0F0F5'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
            <X size={20} />
          </button>
        </div>

        {/* Messages Area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', background: '#FAFBFE' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8B8CA7' }}>
              <Loader size={24} style={{ animation: 'spin 1s linear infinite' }} />
              <p style={{ fontSize: 13, marginTop: 12 }}>Loading messages...</p>
            </div>
          )}
          {error && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#D13438' }}>
              <AlertTriangle size={24} />
              <p style={{ fontSize: 13, marginTop: 12 }}>{error}</p>
            </div>
          )}
          {!loading && !error && messages.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8B8CA7' }}>
              <MessageSquare size={28} />
              <p style={{ fontSize: 13, marginTop: 12 }}>No messages in this conversation</p>
            </div>
          )}
          {!loading && !error && groupedMessages.map((group) => (
            <div key={group.date}>
              {/* Date separator */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 12px 0' }}>
                <div style={{ flex: 1, height: 1, background: '#E8E8F0' }} />
                <span style={{ fontSize: 10, fontWeight: 600, color: '#A0A1BC', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{group.date}</span>
                <div style={{ flex: 1, height: 1, background: '#E8E8F0' }} />
              </div>
              {/* Messages for this date */}
              {group.msgs.map((msg: any) => {
                const senderName = msg.sender?.displayName || msg.sender?.username || 'System';
                const senderId = msg.sender?.id || msg.sender_id || 'system';
                return (
                  <div key={msg.id} style={{ display: 'flex', gap: 10, marginBottom: 12, padding: '8px 12px', borderRadius: 10, background: msg.deleted_at ? '#FFF5F5' : '#fff', border: '1px solid ' + (msg.deleted_at ? '#FFE0E0' : '#F0F0F5'), transition: 'box-shadow 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}>
                    {/* Avatar */}
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: getAvatarColor(senderId), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>
                      {getInitial(senderName)}
                    </div>
                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#1A1A2E' }}>{senderName}</span>
                        <span style={{ fontSize: 10, color: '#A0A1BC' }}>{formatTime(msg.created_at)}</span>
                        {msg.is_edited && !msg.deleted_at && (
                          <span style={{ fontSize: 9, color: '#A0A1BC', fontStyle: 'italic' }}>(edited)</span>
                        )}
                      </div>
                      {renderMessageContent(msg)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid #E8E8F0', background: '#FAFAFF', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#A0A1BC' }}>
            <Eye size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Admin view — read only | {messages.length} of {conversation.message_count} messages
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => handleExport('csv')}
              disabled={exporting}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, border: '1px solid #E0E0F0', background: '#fff', color: '#6264A7', fontSize: 12, fontWeight: 600, cursor: exporting ? 'wait' : 'pointer', opacity: exporting ? 0.6 : 1, transition: 'all 0.15s' }}
              onMouseEnter={(e) => { if (!exporting) { e.currentTarget.style.background = '#F0F0FA'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
            >
              <Download size={13} />
              Export CSV
            </button>
            <button
              onClick={() => handleExport('txt')}
              disabled={exporting}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, border: 'none', background: '#6264A7', color: '#fff', fontSize: 12, fontWeight: 600, cursor: exporting ? 'wait' : 'pointer', opacity: exporting ? 0.6 : 1, transition: 'all 0.15s' }}
              onMouseEnter={(e) => { if (!exporting) { e.currentTarget.style.background = '#4F5196'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#6264A7'; }}
            >
              <Download size={13} />
              {exporting ? 'Exporting...' : 'Export Transcript'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ======================== CONVERSATIONS TAB ======================== */
function ConversationsTab({ conversations }: { conversations: any[] }) {
  const [viewConversation, setViewConversation] = useState<any | null>(null);
  const thStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 12, fontWeight: 600, color: '#6E6F8A', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.5px' };
  const tdStyle: React.CSSProperties = { padding: '14px 16px', fontSize: 13, color: '#3D3D56', borderTop: '1px solid #F0F0F5' };

  const getConvName = (conv: any) => {
    if (conv.name) return conv.name;
    if (conv.member_names) return conv.member_names;
    return conv.type === 'direct' ? 'Direct Message' : 'Unnamed Group';
  };

  return (
    <>
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 650 }}>
            <thead>
              <tr style={{ background: '#F8F9FC' }}>
                <th style={thStyle}>Conversation</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Members</th>
                <th style={thStyle}>Messages</th>
                <th style={thStyle}>Last Activity</th>
                <th style={{ ...thStyle, width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((conv) => (
                <tr key={conv.id} onMouseEnter={(e) => { e.currentTarget.style.background = '#FAFAFF'; }} onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: '#1A1A2E', maxWidth: 280 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: conv.type === 'group' ? '#E8F4FD' : '#F0F0FA',
                        color: conv.type === 'group' ? '#0078D4' : '#6264A7',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        {conv.type === 'group' ? <Users size={15} /> : <MessageSquare size={15} />}
                      </div>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getConvName(conv)}
                      </span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 12,
                      background: conv.type === 'group' ? '#E8F4FD' : '#F5F5F5',
                      color: conv.type === 'group' ? '#0078D4' : '#6E6F8A',
                    }}>
                      {conv.type}
                    </span>
                  </td>
                  <td style={tdStyle}>{conv.member_count}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{conv.message_count}</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: '#8B8CA7' }}>
                    {conv.last_message_at ? new Date(conv.last_message_at).toLocaleString() : <span style={{ color: '#C0C1D4' }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => setViewConversation(conv)}
                      style={{ background: '#F0F0FA', border: '1px solid #E0E0F0', cursor: 'pointer', color: '#6264A7', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 8, transition: 'all 0.15s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#6264A7'; e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#F0F0FA'; e.currentTarget.style.color = '#6264A7'; }}>
                      <Eye size={12} /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {conversations.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#8B8CA7', fontSize: 13 }}>No conversations found</div>
        )}
      </div>

      {/* Message Viewer Modal */}
      {viewConversation && (
        <ConversationViewerModal conversation={viewConversation} onClose={() => setViewConversation(null)} />
      )}
    </>
  );
}

/* ======================== SEARCH TAB ======================== */
function SearchTab({ query: searchQuery, onQueryChange, onSearch, results }: { query: string; onQueryChange: (q: string) => void; onSearch: () => void; results: any[] }) {
  const [hoverSearch, setHoverSearch] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Search Bar */}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#A0A1BC' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search all messages (compliance monitoring)..."
            style={{
              width: '100%', paddingLeft: 42, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
              border: focused ? '2px solid #6264A7' : '2px solid #E8E8F0',
              borderRadius: 12, fontSize: 14, color: '#1A1A2E', background: '#fff',
              outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
              boxShadow: focused ? '0 0 0 3px rgba(98,100,167,0.1)' : '0 1px 3px rgba(0,0,0,0.04)',
              transition: 'all 0.2s',
            }}
          />
        </div>
        <button
          onClick={onSearch}
          onMouseEnter={() => setHoverSearch(true)}
          onMouseLeave={() => setHoverSearch(false)}
          style={{
            padding: '12px 24px', background: hoverSearch ? '#4F51A0' : '#6264A7',
            color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600,
            cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit',
            boxShadow: '0 2px 8px rgba(98,100,167,0.3)', whiteSpace: 'nowrap',
          }}
        >
          Search
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
          {results.map((msg, idx) => (
            <div key={msg.id} style={{ padding: '16px 20px', borderTop: idx > 0 ? '1px solid #F0F0F5' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#6264A7' }}>{msg.sender?.displayName || msg.sender?.display_name || 'Unknown'}</span>
                <span style={{ fontSize: 11, color: '#C0C1D4' }}>in</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: '#8B8CA7' }}>{msg.conversation_name || 'DM'}</span>
                <span style={{ fontSize: 11, color: '#C0C1D4', marginLeft: 'auto' }}>{new Date(msg.created_at).toLocaleString()}</span>
              </div>
              <p style={{ fontSize: 13, color: '#3D3D56', margin: 0, lineHeight: 1.5 }}>{msg.content}</p>
            </div>
          ))}
        </div>
      )}

      {results.length === 0 && searchQuery && (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <Search size={32} style={{ color: '#D0D0E0', marginBottom: 12 }} />
          <p style={{ fontSize: 14, color: '#8B8CA7', margin: 0 }}>No messages found for "{searchQuery}"</p>
        </div>
      )}

      {!searchQuery && (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <Shield size={32} style={{ color: '#D0D0E0', marginBottom: 12 }} />
          <p style={{ fontSize: 14, fontWeight: 500, color: '#6E6F8A', margin: '0 0 4px 0' }}>Compliance Search</p>
          <p style={{ fontSize: 12, color: '#A0A1BC', margin: 0 }}>Search all messages across every conversation for compliance monitoring</p>
        </div>
      )}
    </div>
  );
}

/* ======================== EXTENSIONS TAB ======================== */
function HealthTab({ health }: { health: SystemHealth }) {
  const checks = health.checks || {};

  const healthCards: { name: string; icon: React.ReactNode; status: string; detail?: string }[] = [
    {
      name: 'PostgreSQL',
      icon: <Database size={22} />,
      status: checks.database?.status || 'unknown',
      detail: checks.database?.latencyMs ? `${checks.database.latencyMs}ms latency` : undefined,
    },
    {
      name: 'Redis',
      icon: <Activity size={22} />,
      status: checks.redis?.status || 'unknown',
      detail: checks.redis?.onlineUsers !== undefined ? `${checks.redis.onlineUsers} users tracked` : undefined,
    },
    {
      name: 'UCM6304 SIP',
      icon: checks.ucm6304?.status === 'ok' ? <Wifi size={22} /> : <WifiOff size={22} />,
      status: checks.ucm6304?.status || 'unknown',
      detail: checks.ucm6304?.latencyMs ? `${checks.ucm6304.latencyMs}ms — 192.168.7.2` : '192.168.7.2',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Health Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {healthCards.map((card) => {
          const isOk = card.status === 'ok';
          const statusColor = isOk ? '#16A34A' : card.status === 'error' ? '#DC2626' : '#D97706';
          const statusBg = isOk ? '#F0FDF4' : card.status === 'error' ? '#FEF2F2' : '#FFFBEB';
          const StatusIcon = isOk ? CheckCircle : card.status === 'error' ? XCircle : AlertTriangle;

          return (
            <div key={card.name} style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ color: statusColor }}>{card.icon}</div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: statusColor, background: statusBg, padding: '4px 10px', borderRadius: 12 }}>
                  <StatusIcon size={12} />
                  {card.status}
                </span>
              </div>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#1A1A2E', margin: '0 0 4px 0' }}>{card.name}</p>
              {card.detail && <p style={{ fontSize: 12, color: '#8B8CA7', margin: 0 }}>{card.detail}</p>}
            </div>
          );
        })}
      </div>

      {/* Server Info */}
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #E8E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <Server size={16} color="#6264A7" />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1A1A2E', margin: 0 }}>Server Info</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <ServerInfoItem label="Uptime" value={formatUptime(checks.uptime)} icon={<Clock size={14} />} />
          <ServerInfoItem label="Heap Used" value={checks.memory ? `${(checks.memory.heapUsed / 1024 / 1024).toFixed(1)} MB` : '—'} icon={<HardDrive size={14} />} />
          <ServerInfoItem label="Heap Total" value={checks.memory ? `${(checks.memory.heapTotal / 1024 / 1024).toFixed(1)} MB` : '—'} icon={<HardDrive size={14} />} />
          <ServerInfoItem label="RSS Memory" value={checks.memory ? `${(checks.memory.rss / 1024 / 1024).toFixed(1)} MB` : '—'} icon={<HardDrive size={14} />} />
        </div>
      </div>
    </div>
  );
}

function ServerInfoItem({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px', background: '#F8F9FC', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: '#A0A1BC' }}>{icon}</span>
        <p style={{ fontSize: 11, color: '#8B8CA7', margin: 0, fontWeight: 500 }}>{label}</p>
      </div>
      <p style={{ fontSize: 15, fontWeight: 700, color: '#1A1A2E', margin: 0 }}>{value}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
