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

// ---- authenticator app (admins) --------------------------------------------------------------------------------
// Scan a QR code with Microsoft / Google Authenticator, then type one code to prove it worked. Works offline: the
// phone and the server both compute the codes from the time. Replacing an existing one asks for the password.
interface AuthenticatorStart {
  secret: string;
  qr_svg: string;
  server_time: string;
  replacing: boolean;
}

export function AuthenticatorSetup({ onDone }: { onDone: (user: User) => void }) {
  const { user } = useAuth();
  const [start, setStart] = useState<AuthenticatorStart | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offsetMs, setOffsetMs] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    let current = true;
    api
      .post<AuthenticatorStart>('/auth/authenticator/start')
      .then((s) => {
        if (!current) return;
        setStart(s);
        setOffsetMs(new Date(s.server_time).getTime() - Date.now());
      })
      .catch((err) => current && setError(errorText(err)));
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      current = false;
      clearInterval(t);
    };
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>('/auth/authenticator/confirm', { code, password: start?.replacing ? password : undefined });
      onDone(r.user);
    } catch (err) {
      setError(errorText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (!start) return error ? <ErrorBox text={error} /> : <p className="auth-sub">Preparing your QR code…</p>;
  const serverNow = new Date(Date.now() + offsetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <form onSubmit={confirm} className="totp">
      <ol className="totp-steps">
        <li>
          <b>Install an authenticator app</b> on your phone, if you don't have one: Microsoft Authenticator or Google
          Authenticator, from the app store.
        </li>
        <li>
          <b>In the app, add an account and scan this code.</b>
          <div className="totp-qr" role="img" aria-label="QR code to scan with the authenticator app" dangerouslySetInnerHTML={{ __html: start.qr_svg }} />
          <details className="totp-key">
            <summary>Can't scan it? Type a key instead</summary>
            <p>
              Choose "enter a setup key" in the app. Account: <b>Healthcheck ({user?.username})</b>, time-based. Key:
            </p>
            <code>{start.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </details>
        </li>
        <li>
          <b>Type the 6-digit code</b> the app now shows for Healthcheck.
          <div className="auth-field">
            <label htmlFor="totp-code" className="sr-only">
              6-digit code
            </label>
            <input
              id="totp-code"
              className="totp-input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              maxLength={7}
              required
            />
          </div>
        </li>
      </ol>
      {start.replacing && (
        <>
          <input type="text" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
          <PasswordField label="Your password, to confirm the change" value={password} onChange={setPassword} autoComplete="current-password" />
        </>
      )}
      <ErrorBox text={error} />
      <button className="primary auth-submit" disabled={busy || code.replace(/\s/g, '').length !== 6 || (start.replacing && !password)}>
        {busy ? 'Checking…' : start.replacing ? 'Use this phone from now on' : 'Confirm'}
      </button>
      <p className="totp-time">
        Healthcheck server's time: <b>{serverNow}</b>. Your phone should show the same time, give or take a minute.
      </p>
    </form>
  );
}

// An admin with no authenticator app yet: nothing else until it's set up.
export function AuthenticatorRequiredPage() {
  const { signedIn, signOut } = useAuth();
  return (
    <AuthShell
      title="Set up your authenticator app"
      subtitle="As an admin, it's your way back in if you forget your password. You only need it then, not to sign in. It works without internet."
    >
      <AuthenticatorSetup onDone={signedIn} />
      <button type="button" className="auth-link" onClick={() => signOut()}>
        Sign out
      </button>
    </AuthShell>
  );
}

// "Forgot password" for admins: username + the app's code + a new password.
function RecoverWithAuthenticatorPage({ username: initial, onBack }: { username: string; onBack: () => void }) {
  const { signedIn, minLength } = useAuth();
  const [username, setUsername] = useState(initial);
  const [code, setCode] = useState('');
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
      const r = await api.post<{ user: User }>('/auth/recover-with-authenticator', { username, code, new_password: password });
      signedIn(r.user);
    } catch (err) {
      setError(errorText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Reset with your authenticator app" subtitle="For admins. Open the app on your phone and use the code it shows for Healthcheck.">
      <ErrorBox text={error} />
      <form onSubmit={submit} className="auth-form">
        <div className="auth-field">
          <label htmlFor="ra-username">Username</label>
          <input id="ra-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} required autoFocus={!initial} />
        </div>
        <div className="auth-field">
          <label htmlFor="ra-code">6-digit code from the app</label>
          <input
            id="ra-code"
            className="totp-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            maxLength={7}
            required
            autoFocus={Boolean(initial)}
          />
        </div>
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" describedBy="ra-rules" />
        <PasswordRules id="ra-rules" password={password} username={username} minLength={minLength} />
        <PasswordField label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <button className="primary auth-submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>
          {busy ? 'Checking…' : 'Set new password and sign in'}
        </button>
      </form>
      <button type="button" className="auth-link" onClick={onBack}>
        Back to sign in
      </button>
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
  const [recovering, setRecovering] = useState(false);

  if (recovering) return <RecoverWithAuthenticatorPage username={username} onBack={() => setRecovering(false)} />;

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
            <b>Are you an admin?</b> Reset it yourself with the code from your authenticator app.
          </p>
          <button type="button" className="auth-secondary" onClick={() => setRecovering(true)}>
            Reset with my authenticator app
          </button>
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
