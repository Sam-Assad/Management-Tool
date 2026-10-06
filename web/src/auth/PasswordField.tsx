import { useId, useState } from 'react';

// A password input with a Show/Hide button. `autoComplete` tells password managers what it is:
// "current-password" to fill a saved one, "new-password" to offer a generated one.
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-pw">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={describedBy}
          maxLength={256}
          required
        />
        <button type="button" className="auth-pw-toggle" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? 'Hide password' : 'Show password'}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

// The rules as you type. The server checks them all again (and a list of common passwords) when you save.
export function PasswordRules({ id, password, username, minLength }: { id: string; password: string; username: string; minLength: number }) {
  const length = [...password.normalize('NFKC')].length;
  const u = username.trim().toLowerCase();
  const rules = [
    { ok: length >= minLength, text: `At least ${minLength} characters${length ? ` (${length} so far)` : ''}` },
    { ok: !(u.length >= 3 && password.toLowerCase().includes(u)), text: "Doesn't contain your username" },
    { ok: length > 0 && new Set([...password.toLowerCase()]).size > 2, text: 'Not one or two characters repeated' },
  ];
  return (
    <div id={id} className="auth-rules">
      <ul>
        {rules.map((r) => (
          <li key={r.text} className={password ? (r.ok ? 'ok' : 'bad') : ''}>
            <span aria-hidden="true">{password ? (r.ok ? '✓' : '✗') : '•'}</span> {r.text}
          </li>
        ))}
      </ul>
      <p>Tip: a few unrelated words make a long password that's easy to remember. Symbols aren't required.</p>
    </div>
  );
}
