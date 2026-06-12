/**
 * ForcePasswordChange — full-screen gate shown after logging in with a
 * TEMPORARY password (fresh onboarding or admin reset).
 *
 * The user cannot reach any part of the app until they set their own
 * password: ProtectedRoute renders this INSTEAD of the app while
 * user.must_change_password is true. There is deliberately no skip/close.
 *
 * Flow: temporary password (proves possession) + new password ×2 →
 * POST /auth/change-password → flag cleared server-side → app unlocks.
 */

import { useState } from 'react';
import { Lock, Eye, EyeOff, ShieldCheck, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';

export default function ForcePasswordChange() {
  const user = useAuthStore((s) => s.user);
  const changePassword = useAuthStore((s) => s.changePassword);
  const logout = useAuthStore((s) => s.logout);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const newTooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      // Store clears must_change_password → ProtectedRoute unlocks the app.
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to change password');
      setSubmitting(false);
    }
  };

  const inputWrap: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 10, padding: '12px 14px',
  };
  const inputStyle: React.CSSProperties = {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    color: '#fff', fontSize: 14, fontFamily: 'inherit', minWidth: 0,
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
    marginBottom: 7, letterSpacing: '0.5px', textTransform: 'uppercase',
  };

  return (
    <div
      style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #1A1A2E 0%, #2D2D52 55%, #3D3D6B 100%)',
        padding: 20, fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      <div style={{ width: '100%', maxWidth: 440 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 64, height: 64, borderRadius: 18, margin: '0 auto 16px',
              background: 'linear-gradient(135deg, #6264A7, #7B7DC9)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 12px 36px rgba(98,100,167,0.4)',
            }}
          >
            <ShieldCheck size={30} color="#fff" />
          </div>
          <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>
            Set your new password
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            Hi <strong style={{ color: '#fff' }}>{user?.display_name || user?.username}</strong> — you signed in
            with a temporary password. For your security, choose your own password to continue.
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, padding: 28,
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Temporary password</label>
            <div style={inputWrap}>
              <Lock size={15} color="rgba(255,255,255,0.5)" />
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => { setCurrentPassword(e.target.value); setError(''); }}
                placeholder="The password you just signed in with"
                autoFocus
                autoComplete="current-password"
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>New password</label>
            <div style={inputWrap}>
              <Lock size={15} color="rgba(255,255,255,0.5)" />
              <input
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                aria-label={showNew ? 'Hide password' : 'Show password'}
                style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', display: 'flex', padding: 0 }}
              >
                {showNew ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {newTooShort && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#FCA5A5' }}>Must be at least 8 characters</div>
            )}
          </div>

          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>Confirm new password</label>
            <div style={inputWrap}>
              <Lock size={15} color="rgba(255,255,255,0.5)" />
              <input
                type={showNew ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                placeholder="Type it again"
                autoComplete="new-password"
                style={inputStyle}
              />
            </div>
            {mismatch && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#FCA5A5' }}>Passwords don't match</div>
            )}
          </div>

          {error && (
            <div
              style={{
                marginBottom: 16, padding: '10px 14px', borderRadius: 10,
                background: 'rgba(220,38,38,0.15)', border: '1px solid rgba(220,38,38,0.35)',
                color: '#FCA5A5', fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              width: '100%', padding: '13px', borderRadius: 10, border: 'none',
              background: canSubmit ? 'linear-gradient(135deg, #6264A7, #7B7DC9)' : 'rgba(255,255,255,0.12)',
              color: canSubmit ? '#fff' : 'rgba(255,255,255,0.35)',
              fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.15s',
            }}
          >
            {submitting ? (
              <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
            ) : (
              <>Set password & continue</>
            )}
          </button>
        </form>

        {/* Escape hatch: wrong account / give up — back to login (still gated next time) */}
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <button
            onClick={() => logout()}
            style={{
              background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)',
              fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
