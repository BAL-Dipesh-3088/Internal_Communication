import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Eye, EyeOff, Loader2, ArrowRight,
  Shield, Zap, Users, Lock, HelpCircle, Heart,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useWindowSize, BREAKPOINTS } from '@/hooks/useWindowSize';
import LoginHelpModal, { LoginFeedbackModal } from './LoginHelpModal';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [username, setUsername]         = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showHelp, setShowHelp]         = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const { width } = useWindowSize();

  const isMobile          = width < BREAKPOINTS.mobile;
  const isTablet          = width >= BREAKPOINTS.mobile && width < BREAKPOINTS.tablet;
  const showBrandingPanel = width >= BREAKPOINTS.tablet;

  // If we were redirected here from a protected route (e.g. someone shared a
  // /meeting/:callId link with a not-yet-logged-in user), bounce back there
  // after successful login. ProtectedRoute writes the original path into
  // location.state.from. Falls back to home if no return URL.
  const returnTo: string = (location.state as any)?.from || '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await login(username, password); navigate(returnTo, { replace: true }); }
    catch { /* error set in store */ }
  };

  const canSubmit = username.trim() && password.trim() && !isLoading;

  const inputStyle = (field: string): React.CSSProperties => ({
    width: '100%',
    padding: isMobile ? '11px 14px' : '13px 16px',
    fontSize: 14,
    color: '#fff',
    background: focusedField === field
      ? 'rgba(255,255,255,0.18)'
      : 'rgba(255,255,255,0.10)',
    border: focusedField === field
      ? '1.5px solid rgba(255,255,255,0.55)'
      : '1.5px solid rgba(255,255,255,0.20)',
    borderRadius: 10,
    outline: 'none',
    transition: 'all 0.2s ease',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
    boxShadow: focusedField === field
      ? '0 0 0 3px rgba(255,255,255,0.08)'
      : 'none',
  });

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      position: 'relative',
      fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Roboto', sans-serif",
    }}>

      {/* ── Background image ── */}
      <img
        src="/BALASORE-BACKGROUND.PNG"
        alt=""
        draggable={false}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          objectFit: 'fill',
          zIndex: 0,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />

      {/* ── Dark overlay ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1,
        background: 'rgba(0,0,0,0.42)',
        pointerEvents: 'none',
      }} />

      {/* ── Center wrapper ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isMobile ? '16px' : '24px',
      }}>

        {/* ══ Single Glass Container ══ */}
        <div
          className="login-container"
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            width: '100%',
            maxWidth: isMobile ? 380 : isTablet ? 640 : 820,
            maxHeight: '92vh',
            borderRadius: 24,
            background: 'rgba(255,255,255,0.12)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '1px solid rgba(255,255,255,0.26)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.22)',
            overflow: 'hidden',
            animation: 'fadeSlideUp 0.55s ease-out',
          }}
        >

          {/* ══ LEFT — Branding ══ */}
          {showBrandingPanel && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: isTablet ? '28px 24px' : '32px 36px',
                borderRight: '1px solid rgba(255,255,255,0.16)',
                textAlign: 'center',
                background: 'rgba(255,255,255,0.05)',
                animation: 'fadeSlideLeft 0.55s ease-out',
              }}
            >
              {/* Logo */}
              <div style={{ width: 150, height: 150, marginBottom: 18, flexShrink: 0 }}>
                <img
                  src="/BAL-CONNECT-LOGO.PNG"
                  alt="BAL Connect"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>

              {/* Brand title */}
              <h1 style={{
                fontSize: isTablet ? 20 : 24,
                fontWeight: 800, color: '#fff',
                lineHeight: 1.2, margin: '0 0 10px',
                letterSpacing: '-0.5px',
                textShadow: '0 2px 12px rgba(0,0,0,0.35)',
              }}>
                Balasore Alloys<br />
                <span style={{
                  background: 'linear-gradient(90deg, #FF8C00, #FFB347)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}>
                  Internal Communication
                </span>
              </h1>

              <p style={{
                fontSize: 13, color: 'rgba(255,255,255,0.65)',
                lineHeight: 1.6, margin: '0 0 16px',
                maxWidth: 280,
              }}>
                Secure messaging, HD voice & video calls, and file sharing — built for the BAL team.
              </p>

              {/* Feature cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
                <FeatureCard emoji="⚡" title="Real-time Messaging" desc="Channels, DMs, threads & reactions" />
                <FeatureCard emoji="📹" title="HD Voice & Video Calls" desc="Powered by Pure WebRTC" />
                <FeatureCard emoji="🛡️" title="Enterprise Security" desc="Private network, admin compliance tools" />
              </div>

              {/* Footer */}
              <div style={{
                marginTop: 18,
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, color: 'rgba(255,255,255,0.35)',
              }}>
                <Lock size={10} color="rgba(255,255,255,0.35)" />
                Internal use only — Private network &nbsp;|&nbsp; TLS Encrypted
              </div>
            </div>
          )}

          {/* ══ RIGHT — Login Form ══ */}
          <div
            style={{
              width: isMobile ? '100%' : isTablet ? 300 : 360,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: isMobile ? '28px 24px' : isTablet ? '28px 24px' : '32px 36px',
              animation: 'fadeSlideRight 0.55s ease-out',
            }}
          >
            {/* Mobile logo */}
            {!showBrandingPanel && (
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ width: 100, height: 100, margin: '0 auto 12px' }}>
                  <img src="/BAL-CONNECT-LOGO.PNG" alt="BAL Connect" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                </div>
                <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: 0 }}>BAL Connect</h1>
              </div>
            )}

            {/* Form title */}
            <h2 style={{
              fontSize: isMobile ? 22 : 25,
              fontWeight: 700, color: '#fff',
              margin: '0 0 6px', letterSpacing: '-0.4px',
              textAlign: 'center',
              textShadow: '0 2px 10px rgba(0,0,0,0.25)',
            }}>
              Welcome back
            </h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.52)', margin: '0 0 26px', textAlign: 'center' }}>
              Sign in to continue to BAL Connect
            </p>

            {/* Error banner */}
            {error && (
              <div
                style={{
                  width: '100%',
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 14px', borderRadius: 10,
                  background: 'rgba(220,38,38,0.20)',
                  border: '1px solid rgba(220,38,38,0.40)',
                  marginBottom: 18, fontSize: 13, fontWeight: 500, color: '#FCA5A5',
                  animation: 'fadeSlideUp 0.3s ease-out',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'rgba(220,38,38,0.30)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, flexShrink: 0, color: '#FCA5A5',
                }}>!</div>
                {error}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ width: '100%' }}>
              {/* Username */}
              <div style={{ marginBottom: 16 }}>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'rgba(255,255,255,0.60)', marginBottom: 7,
                  letterSpacing: '0.5px', textTransform: 'uppercase',
                }}>
                  Username / Employee ID
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); clearError(); }}
                  onFocus={() => setFocusedField('username')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Enter your username or employee ID"
                  required autoFocus autoComplete="username"
                  style={inputStyle('username')}
                />
              </div>

              {/* Password */}
              <div style={{ marginBottom: isMobile ? 22 : 26 }}>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'rgba(255,255,255,0.60)', marginBottom: 7,
                  letterSpacing: '0.5px', textTransform: 'uppercase',
                }}>
                  Password
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); clearError(); }}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="Enter your password"
                    required autoComplete="current-password"
                    style={{ ...inputStyle('password'), paddingRight: 48 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: 'absolute', right: 12, top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'rgba(255,255,255,0.40)',
                      padding: 6, display: 'flex', alignItems: 'center', borderRadius: 6,
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.80)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.40)'; }}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              {/* Sign In Button */}
              <button
                type="submit"
                disabled={!canSubmit}
                style={{
                  width: '100%',
                  padding: isMobile ? '13px 20px' : '14px 24px',
                  fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
                  color: !canSubmit ? 'rgba(255,255,255,0.35)' : '#fff',
                  background: !canSubmit
                    ? 'rgba(255,255,255,0.10)'
                    : 'linear-gradient(135deg, #6264A7 0%, #5558C8 100%)',
                  border: !canSubmit ? '1px solid rgba(255,255,255,0.15)' : 'none',
                  borderRadius: 10,
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                  boxShadow: canSubmit ? '0 6px 22px rgba(98,100,167,0.50)' : 'none',
                  transition: 'all 0.2s',
                  marginBottom: 20,
                }}
              >
                {isLoading ? (
                  <><Loader2 size={17} style={{ animation: 'spin 1s linear infinite' }} /> Signing in...</>
                ) : (
                  <><span>Sign In</span><ArrowRight size={16} /></>
                )}
              </button>
            </form>

            {/* Help desk — forgot password / contact admin */}
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.55)', fontSize: 12.5, fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', borderRadius: 8, transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}
              >
                <HelpCircle size={13} /> Need help signing in?
              </button>
              {/* Feedback is its own entry — it's not a sign-in problem */}
              <button
                type="button"
                onClick={() => setShowFeedback(true)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.55)', fontSize: 12.5, fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', borderRadius: 8, transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}
              >
                <Heart size={13} /> Give feedback
              </button>
            </div>

            {/* Self-service registration is disabled — accounts are provisioned by IT/admin only.
                If management approves public sign-up later, restore the "OR" divider + Register link
                block here. The /register route + RegisterPage component still exist for that day. */}
          </div>

        </div>
      </div>

      {/* Footer */}
      <div style={{
        position: 'absolute', bottom: 14, left: 0, right: 0,
        textAlign: 'center', zIndex: 3,
        fontSize: 11, color: 'rgba(255,255,255,0.30)',
        letterSpacing: '0.3px',
      }}>
        BAL Connect v1.0 — Balasore Alloys Internal Communication
      </div>

      {/* Help desk modal — forgot password / contact admin */}
      {showHelp && <LoginHelpModal onClose={() => setShowHelp(false)} />}

      {/* Standalone feedback modal */}
      {showFeedback && <LoginFeedbackModal onClose={() => setShowFeedback(false)} />}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeSlideUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeSlideLeft { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes fadeSlideRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        input::placeholder { color: rgba(255,255,255,0.32) !important; }
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus {
          -webkit-text-fill-color: #fff !important;
          -webkit-box-shadow: 0 0 0px 1000px rgba(50,50,100,0.60) inset !important;
          transition: background-color 5000s ease-in-out 0s;
        }
      `}</style>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   Feature Card
═══════════════════════════════════════════════════════ */
function FeatureCard({ emoji, title, desc }: {
  emoji: string; title: string; desc: string;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '11px 14px', borderRadius: 12,
        background: 'rgba(255,255,255,0.09)',
        border: '1px solid rgba(255,255,255,0.14)',
        cursor: 'default', textAlign: 'left',
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 9,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,140,30,0.18)',
        border: '1px solid rgba(255,140,30,0.30)',
        fontSize: 16, flexShrink: 0,
      }}>
        {emoji}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.50)', lineHeight: 1.4 }}>{desc}</div>
      </div>
    </div>
  );
}
