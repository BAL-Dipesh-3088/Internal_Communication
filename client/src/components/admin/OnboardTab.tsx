import React, { useEffect, useMemo, useState } from 'react';
import {
  UserPlus, Mail, Lock, Eye, EyeOff, ChevronLeft, ChevronRight,
  CheckCircle, AlertCircle, Copy, Loader, Printer,
} from 'lucide-react';
import api from '@/services/api';

/**
 * Onboard new employee — guided 4-step wizard.
 *
 * Steps:
 *   1) Personal Info
 *   2) BAL Connect login password (admin-set)
 *   3) Mail Account (create / assign / skip)
 *   4) Review & Submit  → Success screen with credentials shown ONCE
 *
 * Designed to feel enterprise: live validation, clear progress, atomic submit.
 */

type Role = 'admin' | 'manager' | 'employee';
type MailMode = 'create' | 'assign' | 'skip';

interface PersonalInfo {
  employee_id: string;
  display_name: string;
  username: string;
  email: string;
  department: string;
  designation: string;
  role: Role;
}

/** Shape returned by GET /admin/employees/lookup/:empId (corporate SAP master). */
export interface DirectoryEmployee {
  empId: string;
  name: string;
  designation: string | null;
  department: string | null;
  email: string | null;
}

interface MailConfig {
  mode: MailMode;
  customEmail: string;
  existingPassword: string;
}

interface AvailabilityState {
  username: { checking: boolean; available: boolean | null; reason: string | null };
  email: { checking: boolean; available: boolean | null; reason: string | null };
}

const initialPersonal: PersonalInfo = {
  employee_id: '',
  display_name: '',
  username: '',
  email: '',
  department: '',
  designation: '',
  role: 'employee',
};

const initialMail: MailConfig = {
  mode: 'create',
  customEmail: '',
  existingPassword: '',
};

// ---- Styling tokens (match existing AdminDashboard look) -----------------
const C = {
  primary: '#6264A7',
  primaryLight: '#F4F4FC',
  border: '#E8E8F0',
  borderLight: '#F0F0F5',
  text: '#1A1A2E',
  textSecondary: '#3D3D56',
  textMuted: '#6E6F8A',
  textFaint: '#A0A1BC',
  bg: '#fff',
  bgAlt: '#F8F9FC',
  bgFaint: '#FAFAFF',
  success: '#16A34A',
  successBg: '#F0FDF4',
  successBorder: '#BBF7D0',
  danger: '#DC2626',
  dangerBg: '#FEF2F2',
  dangerBorder: '#FECACA',
  warn: '#D97706',
  warnBg: '#FFFBEB',
  warnBorder: '#FDE68A',
};

const cardStyle: React.CSSProperties = {
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  padding: 28,
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: `2px solid ${C.border}`,
  borderRadius: 10,
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
  background: '#fff',
  color: C.textSecondary,
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: C.textMuted,
  fontWeight: 600,
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  color: C.textFaint,
  marginTop: 4,
  marginBottom: 0,
};

// -------------------------------------------------------------------------

export default function OnboardTab() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [personal, setPersonal] = useState<PersonalInfo>(initialPersonal);
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  const [loginPassword, setLoginPassword] = useState('');
  const [loginPasswordConfirm, setLoginPasswordConfirm] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  const [mail, setMail] = useState<MailConfig>(initialMail);

  const [availability, setAvailability] = useState<AvailabilityState>({
    username: { checking: false, available: null, reason: null },
    email: { checking: false, available: null, reason: null },
  });

  const [success, setSuccess] = useState<{
    user: any;
    loginPassword: string;
    mailEmail: string | null;
    mailPassword: string | null;
  } | null>(null);

  const [copyState, setCopyState] = useState<Record<string, boolean>>({});

  // ---- Auto-suggest username + email from display_name ----
  function nameToSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, '')
      .trim()
      .replace(/\s+/g, '.')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.|\.$/g, '')
      .slice(0, 50);
  }

  function onDisplayNameChange(val: string) {
    setPersonal((p) => {
      const next = { ...p, display_name: val };
      const slug = nameToSlug(val);
      if (!usernameTouched) next.username = slug;
      if (!emailTouched && slug) next.email = `${slug}@balasorealloys.in`;
      return next;
    });
  }

  // ---- Auto-fill from the corporate SAP directory (employee ID fetch) ----
  // Single functional update so the slug suggestions and fetched fields can't
  // race each other. The corporate email wins when present; otherwise we keep
  // the usual slug-based suggestion.
  function applyEmployeeFetch(emp: DirectoryEmployee) {
    setPersonal((p) => {
      const next = { ...p, employee_id: emp.empId, display_name: emp.name };
      if (emp.department) next.department = emp.department;
      if (emp.designation) next.designation = emp.designation;
      const slug = nameToSlug(emp.name);
      if (!usernameTouched) next.username = slug;
      if (emp.email) next.email = emp.email;
      else if (!emailTouched && slug) next.email = `${slug}@balasorealloys.in`;
      return next;
    });
  }

  // ---- Live availability check (debounced) ----
  useEffect(() => {
    if (!personal.username) {
      setAvailability((a) => ({ ...a, username: { checking: false, available: null, reason: null } }));
      return;
    }
    setAvailability((a) => ({ ...a, username: { checking: true, available: null, reason: null } }));
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/users/check-availability', {
          params: { username: personal.username },
        });
        setAvailability((a) => ({ ...a, username: { checking: false, ...data.username } }));
      } catch {
        setAvailability((a) => ({ ...a, username: { checking: false, available: null, reason: null } }));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [personal.username]);

  useEffect(() => {
    if (!personal.email) {
      setAvailability((a) => ({ ...a, email: { checking: false, available: null, reason: null } }));
      return;
    }
    setAvailability((a) => ({ ...a, email: { checking: true, available: null, reason: null } }));
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/users/check-availability', {
          params: { email: personal.email },
        });
        setAvailability((a) => ({ ...a, email: { checking: false, ...data.email } }));
      } catch {
        setAvailability((a) => ({ ...a, email: { checking: false, available: null, reason: null } }));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [personal.email]);

  // ---- Step validators ----
  const step1Valid = useMemo(() => {
    if (!personal.display_name.trim()) return false;
    if (!personal.username || availability.username.available === false) return false;
    if (!personal.email || availability.email.available === false) return false;
    if (!personal.department.trim()) return false;
    return true;
  }, [personal, availability]);

  const step2Valid = useMemo(() => {
    if (loginPassword.length < 8) return false;
    if (loginPassword !== loginPasswordConfirm) return false;
    return true;
  }, [loginPassword, loginPasswordConfirm]);

  const step3Valid = useMemo(() => {
    if (mail.mode === 'assign' && !mail.existingPassword) return false;
    return true;
  }, [mail]);

  const canSubmit = step1Valid && step2Valid && step3Valid;

  // ---- Submit ----
  async function handleSubmit() {
    setSubmitError('');
    setSubmitting(true);
    try {
      const { data } = await api.post('/admin/users/onboard', {
        employee_id: personal.employee_id.trim() || undefined,
        display_name: personal.display_name.trim(),
        username: personal.username.trim().toLowerCase(),
        email: personal.email.trim().toLowerCase(),
        department: personal.department.trim(),
        designation: personal.designation.trim() || undefined,
        role: personal.role,
        loginPassword,
        mail: {
          mode: mail.mode,
          customEmail: mail.customEmail.trim() || undefined,
          existingPassword: mail.mode === 'assign' ? mail.existingPassword : undefined,
        },
      });
      setSuccess({
        user: data.user,
        loginPassword: data.credentials.loginPassword,
        mailEmail: data.credentials.mailEmail,
        mailPassword: data.credentials.mailPassword,
      });
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to onboard employee');
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setPersonal(initialPersonal);
    setUsernameTouched(false);
    setEmailTouched(false);
    setLoginPassword('');
    setLoginPasswordConfirm('');
    setShowLoginPassword(false);
    setMail(initialMail);
    setSubmitError('');
    setStep(1);
    setSuccess(null);
    setCopyState({});
  }

  function copyToClipboard(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopyState((c) => ({ ...c, [key]: true }));
      setTimeout(() => setCopyState((c) => ({ ...c, [key]: false })), 1600);
    });
  }

  // ---- Success screen ----
  if (success) {
    return <SuccessScreen success={success} onCopy={copyToClipboard} copyState={copyState} onDone={reset} />;
  }

  // ---- Wizard UI ----
  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <ProgressBar step={step} />

      <div style={{ ...cardStyle, marginTop: 16 }}>
        {step === 1 && (
          <Step1Personal
            personal={personal}
            onChange={(p) => setPersonal(p)}
            onDisplayNameChange={onDisplayNameChange}
            onEmployeeFetch={applyEmployeeFetch}
            usernameTouched={usernameTouched}
            setUsernameTouched={setUsernameTouched}
            emailTouched={emailTouched}
            setEmailTouched={setEmailTouched}
            availability={availability}
          />
        )}

        {step === 2 && (
          <Step2Login
            loginPassword={loginPassword}
            setLoginPassword={setLoginPassword}
            loginPasswordConfirm={loginPasswordConfirm}
            setLoginPasswordConfirm={setLoginPasswordConfirm}
            showLoginPassword={showLoginPassword}
            setShowLoginPassword={setShowLoginPassword}
          />
        )}

        {step === 3 && (
          <Step3Mail mail={mail} setMail={setMail} fallbackEmail={personal.email} />
        )}

        {step === 4 && (
          <Step4Review
            personal={personal}
            mail={mail}
            submitError={submitError}
          />
        )}

        {/* Footer navigation */}
        <div
          style={{
            marginTop: 28,
            paddingTop: 20,
            borderTop: `1px solid ${C.borderLight}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => (s - 1) as any)}
              disabled={submitting}
              style={navBtn(false)}
            >
              <ChevronLeft size={14} /> Back
            </button>
          ) : (
            <span />
          )}

          {step < 4 ? (
            <button
              disabled={
                (step === 1 && !step1Valid) ||
                (step === 2 && !step2Valid) ||
                (step === 3 && !step3Valid)
              }
              onClick={() => setStep((s) => (s + 1) as any)}
              style={navBtn(true)}
            >
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={!canSubmit || submitting} style={navBtn(true)}>
              {submitting ? <Loader size={14} className="spin" /> : <CheckCircle size={14} />}
              {submitting ? 'Creating...' : 'Create Employee'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Reusable nav button factory ----
function navBtn(primary: boolean): React.CSSProperties {
  if (primary) {
    return {
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '10px 20px',
      background: C.primary,
      color: '#fff',
      border: 'none',
      borderRadius: 10,
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: 'inherit',
    };
  }
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '10px 20px',
    background: '#fff',
    color: C.textMuted,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

// =========================================================================
// Progress bar
// =========================================================================
function ProgressBar({ step }: { step: 1 | 2 | 3 | 4 }) {
  const labels = ['Personal', 'Login', 'Mail', 'Review'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '4px 8px' }}>
      {labels.map((label, i) => {
        const idx = (i + 1) as 1 | 2 | 3 | 4;
        const done = idx < step;
        const active = idx === step;
        return (
          <React.Fragment key={label}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 60 }}>
              <div
                style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: done ? C.primary : active ? C.primary : '#fff',
                  color: done || active ? '#fff' : C.textFaint,
                  border: `2px solid ${done || active ? C.primary : C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700,
                }}
              >
                {done ? <CheckCircle size={14} /> : idx}
              </div>
              <span
                style={{
                  fontSize: 11, fontWeight: 600,
                  color: done || active ? C.primary : C.textFaint,
                }}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                style={{
                  flex: 1, height: 2, background: idx < step ? C.primary : C.border,
                  margin: '0 4px', marginBottom: 18,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// =========================================================================
// STEP 1 — Personal Info
// =========================================================================
function Step1Personal({
  personal, onChange, onDisplayNameChange, onEmployeeFetch,
  usernameTouched, setUsernameTouched, emailTouched, setEmailTouched,
  availability,
}: {
  personal: PersonalInfo;
  onChange: (p: PersonalInfo) => void;
  onDisplayNameChange: (val: string) => void;
  onEmployeeFetch: (emp: DirectoryEmployee) => void;
  usernameTouched: boolean; setUsernameTouched: (b: boolean) => void;
  emailTouched: boolean; setEmailTouched: (b: boolean) => void;
  availability: AvailabilityState;
}) {
  // Employee ID fetch — local UI state for the lookup round-trip
  const [fetchState, setFetchState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; name: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function handleFetch() {
    const empId = personal.employee_id.trim();
    if (!empId) { setFetchState({ kind: 'error', message: 'Enter an employee ID first' }); return; }
    setFetchState({ kind: 'loading' });
    try {
      const { data } = await api.get(`/admin/employees/lookup/${encodeURIComponent(empId)}`);
      if (data.mappedTo) {
        setFetchState({ kind: 'error', message: `Already mapped to ICP user "${data.mappedTo.username}"` });
        return;
      }
      onEmployeeFetch(data.employee);
      setFetchState({ kind: 'ok', name: data.employee.name });
    } catch (err: any) {
      setFetchState({ kind: 'error', message: err?.response?.data?.error || 'Lookup failed' });
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 6px 0' }}>Personal Information</h2>
      <p style={{ fontSize: 12, color: C.textFaint, margin: '0 0 24px 0' }}>
        Start with the employee ID — name and details auto-fill from the corporate directory. Or fill manually.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label="Employee ID (auto-fills from corporate directory)" full>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={personal.employee_id}
              onChange={(e) => {
                onChange({ ...personal, employee_id: e.target.value });
                if (fetchState.kind !== 'idle') setFetchState({ kind: 'idle' });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleFetch(); } }}
              placeholder="e.g. 100001"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={handleFetch}
              disabled={fetchState.kind === 'loading'}
              style={{
                padding: '0 18px', borderRadius: 8, border: 'none',
                background: fetchState.kind === 'loading' ? '#A0A1D6' : C.primary,
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: fetchState.kind === 'loading' ? 'wait' : 'pointer',
                fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}
            >
              {fetchState.kind === 'loading' ? 'Fetching…' : 'Fetch details'}
            </button>
          </div>
          {fetchState.kind === 'ok' && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#15803D' }}>
              ✓ Found <strong>{fetchState.name}</strong> — details filled below
            </div>
          )}
          {fetchState.kind === 'error' && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#DC2626' }}>{fetchState.message}</div>
          )}
        </Field>

        <Field label="Display Name *" full>
          <input
            type="text"
            value={personal.display_name}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="e.g. Rajesh Kumar Sharma"
            style={inputStyle}
          />
        </Field>

        <Field label="Username *" availability={availability.username}>
          <input
            type="text"
            value={personal.username}
            onChange={(e) => {
              setUsernameTouched(true);
              onChange({ ...personal, username: e.target.value.toLowerCase() });
            }}
            placeholder="e.g. rajesh.kumar"
            style={inputStyle}
          />
        </Field>

        <Field label="Email *" availability={availability.email}>
          <input
            type="email"
            value={personal.email}
            onChange={(e) => {
              setEmailTouched(true);
              onChange({ ...personal, email: e.target.value.toLowerCase() });
            }}
            placeholder="e.g. rajesh.kumar@balasorealloys.in"
            style={inputStyle}
          />
        </Field>

        <Field label="Department *">
          <input
            type="text"
            value={personal.department}
            onChange={(e) => onChange({ ...personal, department: e.target.value })}
            placeholder="e.g. Engineering"
            style={inputStyle}
          />
        </Field>

        <Field label="Designation">
          <input
            type="text"
            value={personal.designation}
            onChange={(e) => onChange({ ...personal, designation: e.target.value })}
            placeholder="e.g. Senior Engineer"
            style={inputStyle}
          />
        </Field>

        <Field label="Role *">
          <select
            value={personal.role}
            onChange={(e) => onChange({ ...personal, role: e.target.value as Role })}
            style={inputStyle}
          >
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function Field({
  label, children, availability, full,
}: {
  label: string; children: React.ReactNode;
  availability?: AvailabilityState['username'];
  full?: boolean;
}) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {availability && availability.available !== null && (
        availability.available ? (
          <p style={{ ...helpStyle, color: C.success, display: 'flex', alignItems: 'center', gap: 4 }}>
            <CheckCircle size={11} /> Available
          </p>
        ) : (
          <p style={{ ...helpStyle, color: C.danger, display: 'flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={11} /> {availability.reason === 'taken' ? 'Already in use' : availability.reason === 'invalid' ? 'Invalid format' : 'Not available'}
          </p>
        )
      )}
      {availability && availability.checking && (
        <p style={{ ...helpStyle, color: C.textFaint, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Loader size={11} className="spin" /> Checking...
        </p>
      )}
    </div>
  );
}

// =========================================================================
// STEP 2 — Login Password
// =========================================================================
function Step2Login({
  loginPassword, setLoginPassword,
  loginPasswordConfirm, setLoginPasswordConfirm,
  showLoginPassword, setShowLoginPassword,
}: {
  loginPassword: string; setLoginPassword: (s: string) => void;
  loginPasswordConfirm: string; setLoginPasswordConfirm: (s: string) => void;
  showLoginPassword: boolean; setShowLoginPassword: (b: boolean) => void;
}) {
  const strength = passwordStrength(loginPassword);
  const matches = loginPassword.length > 0 && loginPassword === loginPasswordConfirm;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 6px 0' }}>BAL Connect Login Password</h2>
      <p style={{ fontSize: 12, color: C.textFaint, margin: '0 0 24px 0' }}>
        Set a password the employee will use to log into the BAL Connect app. They can change it after first login.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 460 }}>
        <div>
          <label style={labelStyle}>New password *</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showLoginPassword ? 'text' : 'password'}
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              style={{ ...inputStyle, paddingRight: 40 }}
            />
            <button
              type="button"
              onClick={() => setShowLoginPassword(!showLoginPassword)}
              style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted,
                display: 'flex', alignItems: 'center',
              }}
            >
              {showLoginPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {loginPassword && <PasswordStrengthMeter strength={strength} />}
        </div>

        <div>
          <label style={labelStyle}>Confirm password *</label>
          <input
            type={showLoginPassword ? 'text' : 'password'}
            value={loginPasswordConfirm}
            onChange={(e) => setLoginPasswordConfirm(e.target.value)}
            placeholder="Type the same password again"
            style={inputStyle}
          />
          {loginPasswordConfirm && (
            <p
              style={{
                ...helpStyle,
                color: matches ? C.success : C.danger,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {matches ? <CheckCircle size={11} /> : <AlertCircle size={11} />}
              {matches ? 'Passwords match' : "Passwords don't match"}
            </p>
          )}
        </div>

        <div
          style={{
            padding: '12px 14px', background: C.bgFaint, border: `1px solid ${C.borderLight}`,
            borderRadius: 10, fontSize: 11, color: C.textMuted, lineHeight: 1.6,
          }}
        >
          <strong style={{ color: C.text }}>💡 Tip:</strong> Use a password that's easy to share verbally
          (no special characters that are hard to spell). The employee should change it after first login.
        </div>
      </div>
    </div>
  );
}

function passwordStrength(pwd: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (score <= 1) return { score, label: 'Weak', color: C.danger };
  if (score === 2) return { score, label: 'Fair', color: C.warn };
  if (score === 3) return { score, label: 'Good', color: '#0078D4' };
  return { score, label: 'Strong', color: C.success };
}

function PasswordStrengthMeter({ strength }: { strength: ReturnType<typeof passwordStrength> }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: C.borderLight, borderRadius: 3, overflow: 'hidden' }}>
        <div
          style={{
            width: `${(strength.score / 5) * 100}%`,
            height: '100%',
            background: strength.color,
            transition: 'width 200ms',
          }}
        />
      </div>
      <span style={{ fontSize: 10, fontWeight: 600, color: strength.color }}>{strength.label}</span>
    </div>
  );
}

// =========================================================================
// STEP 3 — Mail Account
// =========================================================================
function Step3Mail({
  mail, setMail, fallbackEmail,
}: {
  mail: MailConfig; setMail: (m: MailConfig) => void; fallbackEmail: string;
}) {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 6px 0' }}>Mail Account</h2>
      <p style={{ fontSize: 12, color: C.textFaint, margin: '0 0 24px 0' }}>
        Configure the employee's mail account on the company mail server (Stalwart). You can also skip this and add it later from the Users tab.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ModeOption
          checked={mail.mode === 'create'}
          onSelect={() => setMail({ ...mail, mode: 'create' })}
          icon={<Mail size={18} color={C.primary} />}
          title="Create new mail account"
          description="Recommended. Auto-creates a fresh mailbox in Stalwart. A secure password will be generated and shown once."
          recommended
        />
        <ModeOption
          checked={mail.mode === 'assign'}
          onSelect={() => setMail({ ...mail, mode: 'assign' })}
          icon={<Lock size={18} color={C.primary} />}
          title="Assign existing mail account"
          description="For migration cases — the mailbox already exists in Stalwart. Provide the existing password and we'll verify it."
        />
        <ModeOption
          checked={mail.mode === 'skip'}
          onSelect={() => setMail({ ...mail, mode: 'skip' })}
          icon={<UserPlus size={18} color={C.textMuted} />}
          title="Skip — no mail account"
          description="Employee won't have email. You can configure it later from the Users tab."
        />

        {mail.mode === 'assign' && (
          <div style={{ marginTop: 8, padding: 16, background: C.bgFaint, border: `1px solid ${C.borderLight}`, borderRadius: 10 }}>
            <label style={labelStyle}>Existing mail password *</label>
            <input
              type="password"
              value={mail.existingPassword}
              onChange={(e) => setMail({ ...mail, existingPassword: e.target.value })}
              placeholder="Password of existing Stalwart account"
              style={inputStyle}
            />
            <p style={helpStyle}>
              We'll test this against IMAP before saving. The mailbox name is taken from the employee's email address (
              <code style={{ background: C.borderLight, padding: '1px 5px', borderRadius: 4 }}>
                {(fallbackEmail || '<email>').split('@')[0]}
              </code>
              ).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeOption({
  checked, onSelect, icon, title, description, recommended,
}: {
  checked: boolean; onSelect: () => void;
  icon: React.ReactNode; title: string; description: string; recommended?: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        padding: '14px 16px',
        border: `2px solid ${checked ? C.primary : C.border}`,
        background: checked ? C.primaryLight : '#fff',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        transition: 'all 120ms',
      }}
    >
      <div
        style={{
          width: 18, height: 18, borderRadius: '50%',
          border: `2px solid ${checked ? C.primary : C.border}`,
          background: checked ? C.primary : '#fff',
          flexShrink: 0,
          marginTop: 2,
          position: 'relative',
        }}
      >
        {checked && (
          <div
            style={{
              position: 'absolute', inset: 4,
              borderRadius: '50%',
              background: '#fff',
            }}
          />
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          {icon}
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{title}</span>
          {recommended && (
            <span
              style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                background: C.successBg, color: C.success, marginLeft: 4,
              }}
            >
              Recommended
            </span>
          )}
        </div>
        <p style={{ fontSize: 12, color: C.textMuted, margin: 0, lineHeight: 1.5 }}>{description}</p>
      </div>
    </div>
  );
}

// =========================================================================
// STEP 4 — Review
// =========================================================================
function Step4Review({
  personal, mail, submitError,
}: {
  personal: PersonalInfo; mail: MailConfig; submitError: string;
}) {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 6px 0' }}>Review & Confirm</h2>
      <p style={{ fontSize: 12, color: C.textFaint, margin: '0 0 24px 0' }}>
        Verify all details below. Once you click <strong>Create Employee</strong>, the BAL Connect account and (optionally) the mail account will be created in one atomic operation.
      </p>

      <ReviewSection title="Personal Information">
        <ReviewItem label="Display Name" value={personal.display_name} />
        <ReviewItem label="Username" value={personal.username} mono />
        <ReviewItem label="Email" value={personal.email} mono />
        <ReviewItem label="Department" value={personal.department} />
        {personal.designation && <ReviewItem label="Designation" value={personal.designation} />}
        <ReviewItem label="Role" value={personal.role} />
      </ReviewSection>

      <ReviewSection title="BAL Connect Login">
        <ReviewItem label="Password" value="•••••••• (set)" mono />
      </ReviewSection>

      <ReviewSection title="Mail Account">
        <ReviewItem
          label="Action"
          value={
            mail.mode === 'create'
              ? 'Create new mail account in Stalwart'
              : mail.mode === 'assign'
              ? 'Assign existing Stalwart account'
              : 'Skip — no mail access'
          }
        />
        {mail.mode !== 'skip' && (
          <ReviewItem
            label="Email"
            value={(mail.customEmail || personal.email)}
            mono
          />
        )}
      </ReviewSection>

      {submitError && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 14px',
            background: C.dangerBg,
            border: `1px solid ${C.dangerBorder}`,
            borderRadius: 10,
            color: C.danger,
            fontSize: 13,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{submitError}</span>
        </div>
      )}
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16, padding: 16, background: C.bgAlt, borderRadius: 10, border: `1px solid ${C.borderLight}` }}>
      <h3 style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, margin: '0 0 12px 0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {title}
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 8, columnGap: 12 }}>
        {children}
      </div>
    </div>
  );
}

function ReviewItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span style={{ fontSize: 12, color: C.textFaint }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          color: C.text,
          fontFamily: mono ? 'monospace' : 'inherit',
          fontWeight: mono ? 600 : 500,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </>
  );
}

// =========================================================================
// SUCCESS SCREEN
// =========================================================================
function SuccessScreen({
  success, onCopy, copyState, onDone,
}: {
  success: { user: any; loginPassword: string; mailEmail: string | null; mailPassword: string | null };
  onCopy: (key: string, value: string) => void;
  copyState: Record<string, boolean>;
  onDone: () => void;
}) {
  const handlePrint = () => window.print();

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div style={{ ...cardStyle, textAlign: 'center', padding: '36px 28px' }}>
        <div
          style={{
            width: 64, height: 64, borderRadius: '50%',
            background: C.successBg, color: C.success,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <CheckCircle size={32} />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: '0 0 6px 0' }}>
          Employee created successfully!
        </h2>
        <p style={{ fontSize: 13, color: C.textMuted, margin: '0 0 24px 0' }}>
          <strong>{success.user.display_name}</strong> ({success.user.username}) has been onboarded.
        </p>

        <div
          style={{
            padding: 20,
            background: C.warnBg,
            border: `1px solid ${C.warnBorder}`,
            borderRadius: 12,
            textAlign: 'left',
            marginBottom: 20,
          }}
        >
          <p style={{ fontSize: 12, fontWeight: 700, color: C.warn, margin: '0 0 14px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertCircle size={14} />
            Save these credentials before closing — they will NOT be shown again
          </p>

          <CredentialRow
            label="BAL Connect Username"
            value={success.user.username}
            onCopy={() => onCopy('username', success.user.username)}
            copied={copyState.username}
          />
          <CredentialRow
            label="BAL Connect Login Password"
            value={success.loginPassword}
            onCopy={() => onCopy('loginPassword', success.loginPassword)}
            copied={copyState.loginPassword}
          />
          {success.mailEmail && (
            <CredentialRow
              label="Mail Email Address"
              value={success.mailEmail}
              onCopy={() => onCopy('mailEmail', success.mailEmail!)}
              copied={copyState.mailEmail}
            />
          )}
          {success.mailPassword && (
            <CredentialRow
              label="Mail Password"
              value={success.mailPassword}
              onCopy={() => onCopy('mailPassword', success.mailPassword!)}
              copied={copyState.mailPassword}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={handlePrint}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 18px',
              background: '#fff',
              color: C.primary,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Printer size={14} /> Print Credential Sheet
          </button>
          <button
            onClick={onDone}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 18px',
              background: C.primary,
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <CheckCircle size={14} /> Done — Onboard Another
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialRow({
  label, value, onCopy, copied,
}: {
  label: string; value: string; onCopy: () => void; copied?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.warnBorder}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 11, color: C.textMuted, margin: '0 0 2px 0', fontWeight: 600 }}>{label}</p>
        <p
          style={{
            fontSize: 14, fontFamily: 'monospace', fontWeight: 700,
            color: C.text, margin: 0, wordBreak: 'break-all',
          }}
        >
          {value}
        </p>
      </div>
      <button
        onClick={onCopy}
        style={{
          flexShrink: 0,
          padding: '6px 12px',
          background: copied ? C.success : '#fff',
          color: copied ? '#fff' : C.primary,
          border: `1px solid ${copied ? C.success : C.border}`,
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {copied ? <CheckCircle size={11} /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
