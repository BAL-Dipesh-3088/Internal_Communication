/**
 * EmployeeIdsTab — admin mapping between ICP accounts and the corporate
 * SAP employee master (replaces the retired UCM extensions tab).
 *
 * Flow:
 *   - Table lists every ICP user with their mapped employee ID (or "—").
 *   - "Assign / Change" opens an inline editor: admin types the employee ID,
 *     clicks Verify → backend looks it up in the corporate directory and
 *     returns the employee's name/dept for visual confirmation → Confirm saves.
 *   - "Clear" unmaps. Every change is audit-logged server-side.
 *
 * Employees mapped here can log in with their employee ID instead of username.
 */

import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, IdCard, Check, X, Loader2, AlertCircle, BadgeCheck } from 'lucide-react';
import api from '@/services/api';

interface IcpUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  department: string | null;
  designation: string | null;
  employee_id: string | null;
  is_active: boolean;
}

interface DirectoryHit {
  empId: string;
  name: string;
  designation: string | null;
  department: string | null;
}

type EditorState =
  | { phase: 'closed' }
  | { phase: 'input'; userId: string; value: string; error?: string }
  | { phase: 'verifying'; userId: string; value: string }
  | { phase: 'confirm'; userId: string; value: string; employee: DirectoryHit }
  | { phase: 'saving'; userId: string; value: string };

export default function EmployeeIdsTab() {
  const [users, setUsers] = useState<IcpUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<EditorState>({ phase: 'closed' });
  const [dirHealth, setDirHealth] = useState<{ ok: boolean; employees?: number; error?: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersRes, healthRes] = await Promise.allSettled([
        api.get('/admin/users'),
        api.get('/admin/employees/health'),
      ]);
      if (usersRes.status === 'fulfilled') setUsers(usersRes.value.data.users || []);
      else setError(usersRes.reason?.response?.data?.error || usersRes.reason?.message || 'Failed to load users');
      if (healthRes.status === 'fulfilled') setDirHealth(healthRes.value.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to load');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.display_name?.toLowerCase().includes(q) ||
      u.username?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.employee_id?.toLowerCase().includes(q) ||
      u.department?.toLowerCase().includes(q),
    );
  }, [users, filter]);

  const mappedCount = users.filter((u) => u.employee_id).length;

  const handleVerify = async (userId: string, value: string) => {
    const empId = value.trim();
    if (!empId) {
      setEditor({ phase: 'input', userId, value, error: 'Enter an employee ID' });
      return;
    }
    setEditor({ phase: 'verifying', userId, value: empId });
    try {
      const { data } = await api.get(`/admin/employees/lookup/${encodeURIComponent(empId)}`);
      const mappedTo = data.mappedTo as { username: string } | null;
      if (mappedTo) {
        setEditor({ phase: 'input', userId, value: empId, error: `Already mapped to "${mappedTo.username}"` });
        return;
      }
      setEditor({ phase: 'confirm', userId, value: empId, employee: data.employee });
    } catch (err: any) {
      setEditor({
        phase: 'input', userId, value: empId,
        error: err?.response?.data?.error || 'Lookup failed',
      });
    }
  };

  const handleSave = async (userId: string, empId: string | null) => {
    if (empId !== null) setEditor({ phase: 'saving', userId, value: empId });
    try {
      await api.put(`/admin/users/${userId}/employee-id`, { employeeId: empId });
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, employee_id: empId } : u)));
      setEditor({ phase: 'closed' });
    } catch (err: any) {
      setEditor({
        phase: 'input', userId, value: empId || '',
        error: err?.response?.data?.error || 'Save failed',
      });
    }
  };

  const card = (label: string, value: React.ReactNode, color = '#242424') => (
    <div style={{ flex: 1, minWidth: 180, background: '#fff', border: '1px solid #ECECF4', borderRadius: 12, padding: '18px 22px' }}>
      <div style={{ fontSize: 12, color: '#8B8CA7', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats row */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {card('Total ICP Users', users.length)}
        {card('Mapped to Employee ID', mappedCount, '#16A34A')}
        {card('Not Mapped', users.length - mappedCount, '#D97706')}
        {card(
          'Corporate Directory',
          dirHealth === null ? '…' : dirHealth.ok ? `${dirHealth.employees ?? '—'} active` : 'Offline',
          dirHealth?.ok ? '#16A34A' : '#DC2626',
        )}
      </div>

      {/* Directory offline warning */}
      {dirHealth && !dirHealth.ok && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>
          <AlertCircle size={15} />
          Corporate employee directory unreachable — {dirHealth.error}. Lookups and new mappings won't work until it's back.
        </div>
      )}

      {/* Search + refresh */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #ECECF4', borderRadius: 10, padding: '10px 14px' }}>
          <Search size={15} color="#8B8CA7" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, username, employee ID, or department…"
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', background: 'transparent' }}
          />
        </div>
        <button
          onClick={load}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: '1px solid #ECECF4', background: '#fff', fontSize: 13, fontWeight: 600, color: '#424242', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Error / loading */}
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
          <div style={{ marginTop: 8 }}>Loading users…</div>
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div style={{ background: '#fff', border: '1px solid #ECECF4', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr style={{ background: '#FAFAFE' }}>
                {['USER', 'DEPARTMENT', 'EMPLOYEE ID', 'ACTIONS'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '12px 18px', fontSize: 11, fontWeight: 700, color: '#8B8CA7', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const isEditing = editor.phase !== 'closed' && editor.userId === u.id;
                return (
                  <tr key={u.id} style={{ borderTop: '1px solid #F5F5FA', opacity: u.is_active ? 1 : 0.5 }}>
                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#242424' }}>{u.display_name}</div>
                      <div style={{ fontSize: 11, color: '#8B8CA7' }}>@{u.username}{!u.is_active && ' · disabled'}</div>
                    </td>
                    <td style={{ padding: '12px 18px', fontSize: 12, color: '#605E5C' }}>{u.department || '—'}</td>
                    <td style={{ padding: '12px 18px' }}>
                      {u.employee_id ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>
                          <BadgeCheck size={12} /> {u.employee_id}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: '#C0C0CE' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 18px' }}>
                      {!isEditing ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => setEditor({ phase: 'input', userId: u.id, value: u.employee_id || '' })}
                            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid #D5D6F0', background: '#F6F6FD', color: '#5B5FC7', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                          >
                            <IdCard size={12} /> {u.employee_id ? 'Change' : 'Assign'}
                          </button>
                          {u.employee_id && (
                            <button
                              onClick={() => handleSave(u.id, null)}
                              style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 380 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              autoFocus
                              value={editor.phase === 'confirm' ? editor.value : (editor as any).value}
                              disabled={editor.phase === 'verifying' || editor.phase === 'saving' || editor.phase === 'confirm'}
                              onChange={(e) => setEditor({ phase: 'input', userId: u.id, value: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter' && editor.phase === 'input') handleVerify(u.id, editor.value); }}
                              placeholder="Employee ID (e.g. 100001)"
                              style={{ width: 160, padding: '6px 10px', borderRadius: 7, border: '1px solid #D5D6F0', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
                            />
                            {editor.phase === 'input' && (
                              <button onClick={() => handleVerify(u.id, editor.value)} style={{ padding: '6px 12px', borderRadius: 7, border: 'none', background: '#6264A7', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                Verify
                              </button>
                            )}
                            {(editor.phase === 'verifying' || editor.phase === 'saving') && (
                              <Loader2 size={15} color="#6264A7" style={{ animation: 'spin 1s linear infinite' }} />
                            )}
                            <button onClick={() => setEditor({ phase: 'closed' })} title="Cancel" style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', color: '#8B8CA7', cursor: 'pointer', display: 'flex' }}>
                              <X size={14} />
                            </button>
                          </div>
                          {editor.phase === 'input' && editor.error && (
                            <div style={{ fontSize: 11, color: '#DC2626' }}>{editor.error}</div>
                          )}
                          {editor.phase === 'confirm' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '7px 10px' }}>
                              <BadgeCheck size={14} color="#15803D" />
                              <div style={{ flex: 1, fontSize: 12, color: '#15803D' }}>
                                <strong>{editor.employee.name}</strong>
                                {editor.employee.designation ? ` · ${editor.employee.designation}` : ''}
                                {editor.employee.department ? ` · ${editor.employee.department}` : ''}
                              </div>
                              <button onClick={() => handleSave(u.id, editor.value)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#16A34A', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                                <Check size={12} /> Confirm
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 40, textAlign: 'center', fontSize: 13, color: '#8B8CA7' }}>
                    No users match "{filter}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
