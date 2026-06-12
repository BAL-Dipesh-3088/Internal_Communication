/**
 * LoginHelpModal — "Need help?" on the login page. Three self-service options
 * for users who can't sign in (so they don't have to walk to IT):
 *
 *   1. Forgot Password — user submits their username/employee ID + phone no.
 *      → every admin gets an email → admin resets the password and calls the
 *      user with the temporary one (forced-change applies at first login).
 *   2. Contact Admin — live list of admins (name + email) + the IT support
 *      phone number, fetched from the backend (never hardcoded).
 *   3. Give Feedback — mood + category + message → emailed to all admins.
 *
 * All three use PUBLIC rate-limited endpoints (the user can't log in, so
 * there's no token). The modal is fully keyboard/escape dismissible.
 */

import { useEffect, useState } from 'react';
import {
  X, ArrowLeft, KeyRound, Users, Heart, Phone, Mail,
  Loader2, CheckCircle2, Send,
} from 'lucide-react';
import api from '@/services/api';

type View = 'menu' | 'forgot' | 'contact';

const MOODS = [
  { emoji: '😍', label: 'Love it' },
  { emoji: '🙂', label: 'Good' },
  { emoji: '😐', label: 'Okay' },
  { emoji: '🙁', label: 'Not great' },
  { emoji: '😡', label: 'Frustrated' },
];

const CATEGORIES = ['Login issue', 'Bug report', 'Feature idea', 'Calls / meetings', 'Email', 'Other'];

export default function LoginHelpModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>('menu');

  // Esc closes the modal from any view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        // Light veil — the login page's colors stay visible through the glass
        background: 'rgba(20,25,45,0.35)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, maxHeight: '88vh', overflowY: 'auto',
          // Frosted-glass card — same language as the login form panel
          background: 'rgba(255,255,255,0.12)',
          backdropFilter: 'blur(26px) saturate(140%)',
          WebkitBackdropFilter: 'blur(26px) saturate(140%)',
          border: '1px solid rgba(255,255,255,0.25)',
          borderRadius: 18, color: '#fff',
          boxShadow: '0 24px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25)',
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.18)' }}>
          {view !== 'menu' && (
            <button onClick={() => setView('menu')} aria-label="Back" style={iconBtn}>
              <ArrowLeft size={16} />
            </button>
          )}
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1 }}>
            {view === 'menu' && 'Need help?'}
            {view === 'forgot' && 'Forgot password'}
            {view === 'contact' && 'Contact admin'}
          </h2>
          <button onClick={onClose} aria-label="Close" style={iconBtn}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          {view === 'menu' && <MenuView onPick={setView} />}
          {view === 'forgot' && <ForgotView />}
          {view === 'contact' && <ContactView />}
        </div>
      </div>
    </div>
  );
}

/**
 * LoginFeedbackModal — standalone "Give feedback" dialog, opened from its own
 * link on the login page (management wanted it separate from "Need help?",
 * since feedback isn't a sign-in problem). Same glass shell, same FeedbackView.
 */
export function LoginFeedbackModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(20,25,45,0.35)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, maxHeight: '88vh', overflowY: 'auto',
          background: 'rgba(255,255,255,0.12)',
          backdropFilter: 'blur(26px) saturate(140%)',
          WebkitBackdropFilter: 'blur(26px) saturate(140%)',
          border: '1px solid rgba(255,255,255,0.25)',
          borderRadius: 18, color: '#fff',
          boxShadow: '0 24px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25)',
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.18)' }}>
          <Heart size={16} />
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1 }}>Give feedback</h2>
          <button onClick={onClose} aria-label="Close" style={iconBtn}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: 18 }}>
          <FeedbackView />
        </div>
      </div>
    </div>
  );
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

function MenuView({ onPick }: { onPick: (v: View) => void }) {
  const items: Array<{ view: View; icon: React.ReactNode; title: string; desc: string }> = [
    { view: 'forgot', icon: <KeyRound size={18} />, title: 'Forgot password', desc: 'Request a reset — an admin will call you with a temporary password' },
    { view: 'contact', icon: <Users size={18} />, title: 'Contact admin', desc: 'See who can help and how to reach them' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it) => (
        <button
          key={it.view}
          onClick={() => onPick(it.view)}
          style={{
            display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
            background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.22)',
            borderRadius: 12, padding: '14px 16px', color: '#fff', cursor: 'pointer',
            fontFamily: 'inherit', transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
        >
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#6264A7,#7B7DC9)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {it.icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{it.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)', lineHeight: 1.4 }}>{it.desc}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Forgot password ──────────────────────────────────────────────────────────

function ForgotView() {
  const [identifier, setIdentifier] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');

  const canSubmit = identifier.trim() && phone.replace(/\D/g, '').length >= 10 && state === 'idle';

  const submit = async () => {
    if (!canSubmit) return;
    setError('');
    setState('sending');
    try {
      await api.post('/auth/help/forgot-password', { identifier: identifier.trim(), phone: phone.trim() });
      setState('done');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to send the request');
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <SuccessBox
        title="Request sent to the admins"
        body="An admin will reset your password and call you on the number you gave with a temporary password. You'll set your own new password at first login."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={helpText}>
        Tell us who you are and how to reach you. An admin will reset your password and <strong style={{ color: '#fff' }}>call you</strong> with a temporary one.
      </p>
      <div>
        <label style={label}>Username / Employee ID</label>
        <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="e.g. dipesh.mondal or 3088" style={input} autoFocus />
      </div>
      <div>
        <label style={label}>Phone number</label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Your contact number" inputMode="tel" style={input} />
      </div>
      {error && <div style={errBox}>{error}</div>}
      <PrimaryBtn onClick={submit} disabled={!canSubmit} busy={state === 'sending'} label="Send request" />
    </div>
  );
}

// ─── Contact admin ────────────────────────────────────────────────────────────

function ContactView() {
  const [admins, setAdmins] = useState<Array<{ name: string; email: string }> | null>(null);
  const [supportPhone, setSupportPhone] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/auth/help/admins')
      .then(({ data }) => { setAdmins(data.admins || []); setSupportPhone(data.supportPhone || ''); })
      .catch((err) => setError(err?.response?.data?.error || 'Failed to load admin contacts'));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {supportPhone && (
        <a
          href={`tel:${supportPhone}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none',
            background: 'linear-gradient(135deg,#6264A7,#7B7DC9)', borderRadius: 12,
            padding: '14px 16px', color: '#fff',
          }}
        >
          <Phone size={18} />
          <div>
            <div style={{ fontSize: 11, opacity: 0.8 }}>IT support line</div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.5 }}>{supportPhone}</div>
          </div>
        </a>
      )}

      {error && <div style={errBox}>{error}</div>}
      {!admins && !error && (
        <div style={{ textAlign: 'center', padding: 18, color: 'rgba(255,255,255,0.5)' }}>
          <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      )}
      {admins && admins.length === 0 && <p style={helpText}>No admin contacts are configured yet.</p>}
      {admins && admins.map((a) => (
        <div key={a.email} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#6264A7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
            {a.name?.[0]?.toUpperCase() || '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
            <a href={`mailto:${a.email}`} style={{ fontSize: 11.5, color: '#A5A7F0', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Mail size={11} /> {a.email}
            </a>
          </div>
        </div>
      ))}
      <style>{`@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

function FeedbackView() {
  const [mood, setMood] = useState('');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');

  const canSubmit = message.trim().length > 0 && state === 'idle';

  const submit = async () => {
    if (!canSubmit) return;
    setError('');
    setState('sending');
    try {
      await api.post('/auth/help/feedback', {
        mood, category: category || 'Other', message: message.trim(), name: name.trim(),
      });
      setState('done');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to send feedback');
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <SuccessBox
        title="Thank you! 🎉"
        body="Your feedback has been recorded and the admins will review it. It genuinely shapes what gets built next."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={label}>How do you feel about ICP?</label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {MOODS.map((m) => (
            <button
              key={m.emoji}
              onClick={() => setMood(mood === m.emoji ? '' : m.emoji)}
              title={m.label}
              style={{
                flex: 1, padding: '10px 0', fontSize: 22, borderRadius: 10, cursor: 'pointer',
                background: mood === m.emoji ? 'rgba(98,100,167,0.55)' : 'rgba(255,255,255,0.10)',
                border: mood === m.emoji ? '1.5px solid #A5A7F0' : '1.5px solid rgba(255,255,255,0.22)',
                transform: mood === m.emoji ? 'scale(1.12)' : 'scale(1)',
                transition: 'all 0.15s', fontFamily: 'inherit',
              }}
            >
              {m.emoji}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label style={label}>What's it about?</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(category === c ? '' : c)}
              style={{
                padding: '6px 12px', borderRadius: 16, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                background: category === c ? '#6264A7' : 'rgba(255,255,255,0.10)',
                border: '1px solid ' + (category === c ? '#8B8DD9' : 'rgba(255,255,255,0.22)'),
                color: '#fff', fontWeight: category === c ? 700 : 400,
                transition: 'all 0.15s',
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label style={label}>Your feedback</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What's broken, confusing, or missing? Or what do you love? 💜"
          rows={4}
          maxLength={2000}
          style={{ ...input, resize: 'vertical', minHeight: 90 }}
        />
      </div>

      <div>
        <label style={label}>Your name (optional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Anonymous is fine too" style={input} />
      </div>

      {error && <div style={errBox}>{error}</div>}
      <PrimaryBtn onClick={submit} disabled={!canSubmit} busy={state === 'sending'} label="Send feedback" icon={<Send size={14} />} />
    </div>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function SuccessBox({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '22px 6px' }}>
      <CheckCircle2 size={44} color="#4ADE80" style={{ marginBottom: 14 }} />
      <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{title}</h3>
      <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, margin: 0 }}>{body}</p>
    </div>
  );
}

function PrimaryBtn({ onClick, disabled, busy, label, icon }: {
  onClick: () => void; disabled: boolean; busy: boolean; label: string; icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', padding: '12px', borderRadius: 10, border: 'none',
        background: disabled ? 'rgba(255,255,255,0.10)' : 'linear-gradient(135deg,#6264A7,#7B7DC9)',
        color: disabled ? 'rgba(255,255,255,0.35)' : '#fff',
        fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}
    >
      {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : icon}
      {busy ? 'Sending…' : label}
    </button>
  );
}

const iconBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.16)',
  color: 'rgba(255,255,255,0.85)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const label: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)',
  marginBottom: 7, letterSpacing: '0.4px', textTransform: 'uppercase',
};
const input: React.CSSProperties = {
  // Mirrors the login page's glass inputs
  width: '100%', padding: '11px 14px', fontSize: 13.5, color: '#fff',
  background: 'rgba(255,255,255,0.12)', border: '1.5px solid rgba(255,255,255,0.28)',
  borderRadius: 10, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};
const errBox: React.CSSProperties = {
  padding: '9px 13px', borderRadius: 9, background: 'rgba(220,38,38,0.15)',
  border: '1px solid rgba(220,38,38,0.35)', color: '#FCA5A5', fontSize: 12,
};
const helpText: React.CSSProperties = {
  fontSize: 12.5, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6, margin: 0,
};
