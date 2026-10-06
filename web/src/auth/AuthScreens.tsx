import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../api/client';
import { useAuth, type User } from './AuthContext';
import { PasswordField, PasswordRules } from './PasswordField';

// Wide two-panel card: what Healthcheck is on the left (red), the form on the right. One column on phones.
function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <aside className="auth-side">
          <div className="auth-brand">
            <span className="auth-logo-wrap">
              <img src="/logo.png" alt="" className="auth-logo" />
            </span>
            <span>
              Healthcheck
              <small>Loyalty Platform Ops</small>
            </span>
          </div>
          <p className="auth-side-lead">Start, stop and watch the loyalty platform on every server, in the right order.</p>
          <ul className="auth-side-list">
            <li>Live health of every service</li>
            <li>Start All, Restart All and Stop All, in order</li>
            <li>Warnings for WildFly and Artemis</li>
          </ul>
        </aside>
        <section className="auth-main">
          <h1>{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
        </section>
      </main>
    </div>
  );
}

// ---- reset with a one-time link from the server (/reset-password?token=...) -------------------------------------
export function ResetPasswordPage() {
  const { signedIn, minLength } = useAuth();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [who, setWho] = useState<{ valid: boolean; username?: string; display_name?: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .post<{ valid: boolean; username?: string; display_name?: string }>('/auth/reset/check', { token })
      .then(setWho)
      .catch(() => setWho({ valid: false }));
  }, [token]);

  const navigate = useNavigate();
  const leave = (user?: User) => {
    // drop the token from the address bar and history
    navigate('/', { replace: true });
    if (user) signedIn(user);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/auth/reset', { token, new_password: password });
      leave(user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!who) return <AuthShell title="Reset your password">Checking the link…</AuthShell>;
  if (!who.valid) {
    return (
      <AuthShell
        title="This link doesn't work"
        subtitle="It has expired or was already used. A reset link works once, for a short time. Ask whoever looks after the Healthcheck server for a new one."
      >
        <button className="primary auth-submit" onClick={() => leave()}>
          Back to sign in
        </button>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle={<>For {who.display_name} ({who.username}). You'll be signed out on every other browser.</>}>
      <ErrorBox text={error} />
      <form onSubmit={submit} className="auth-form">
        <input type="text" autoComplete="username" value={who.username} readOnly hidden />
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" describedBy="rp-rules" autoFocus />
        <PasswordRules id="rp-rules" password={password} username={who.username ?? ''} minLength={minLength} />
        <PasswordField label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <button className="primary auth-submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password and sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

function ErrorBox({ text }: { text: string | null }) {
  return text ? (
    <div className="auth-error" role="alert">
      {text}
    </div>
  ) : null;
}

// ---- sign in ------------------------------------------------------------------------------------------------
export function LoginPage() {
  const { signedIn, notice } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/auth/login', { username, password });
      signedIn(user);
    } catch (err) {
      setError(errorText(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in">
      {notice && !error && <div className="auth-info">{notice}</div>}
      <ErrorBox text={error} />
      <form onSubmit={submit} className="auth-form">
        <div className="auth-field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            required
            maxLength={64}
          />
        </div>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        <button className="primary auth-submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <button type="button" className="auth-link" aria-expanded={forgot} onClick={() => setForgot(!forgot)}>
        Forgot your password?
      </button>
      {forgot && (
        <div className="auth-help">
          <p>
            <b>Ask a Healthcheck admin to reset it.</b> They'll give you a temporary password that works once, for a
            limited time. You'll choose a new password as soon as you sign in with it.
          </p>
          <p>
            <b>Are you an admin?</b> Another admin can reset it the same way. If there's no one else, whoever looks
            after the Healthcheck server can give you a one-time reset link.
          </p>
        </div>
      )}
    </AuthShell>
  );
}

// ---- first admin (only when nobody exists yet) -------------------------------------------------------------------
export function SetupPage() {
  const { signedIn, minLength } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>('/auth/setup', { username, display_name: displayName, password });
      signedIn(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create the first admin" subtitle="Nobody has an account yet. This account can add the others.">
      <ErrorBox text={error} />
      <form onSubmit={submit} className="auth-form">
        <div className="auth-field">
          <label htmlFor="setup-name">Your name</label>
          <input id="setup-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" autoFocus required maxLength={80} />
        </div>
        <div className="auth-field">
          <label htmlFor="setup-username">Username</label>
          <input
            id="setup-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            required
            pattern="[A-Za-z0-9._\-]{3,32}"
            title="3-32 letters, digits, dots, dashes or underscores"
          />
        </div>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" describedBy="setup-rules" />
        <PasswordRules id="setup-rules" password={password} username={username} minLength={minLength} />
        <PasswordField label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <button className="primary auth-submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create admin and sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

// ---- change password (own) ---------------------------------------------------------------------------------------
export function ChangePasswordForm({ onDone, forced }: { onDone: (user: User) => void; forced?: boolean }) {
  const { user, minLength } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const { user: updated } = await api.post<{ user: User }>('/auth/change-password', { current_password: current, new_password: next });
      onDone(updated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="auth-form">
      <ErrorBox text={error} />
      {/* lets password managers attach the new password to the right account */}
      <input type="text" name="username" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
      <PasswordField
        label={forced ? 'Temporary password' : 'Current password'}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        autoFocus
      />
      <PasswordField label="New password" value={next} onChange={setNext} autoComplete="new-password" describedBy="change-rules" />
      <PasswordRules id="change-rules" password={next} username={user?.username ?? ''} minLength={minLength} />
      <PasswordField label="Type the new password again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      <button className="primary auth-submit" disabled={busy}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

// After an admin reset or a new account: nothing else until a new password is chosen.
export function ForcedChangePasswordPage() {
  const { user, signedIn, signOut } = useAuth();
  return (
    <AuthShell
      title="Choose a new password"
      subtitle={<>Hi {user?.display_name}. You signed in with a temporary password, so choose your own before going on.</>}
    >
      <ChangePasswordForm forced onDone={signedIn} />
      <button type="button" className="auth-link" onClick={() => signOut()}>
        Sign out
      </button>
    </AuthShell>
  );
}
