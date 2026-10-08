import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR, roleName, type Permission } from '../auth/permissions';
import PermissionsEditor from './PermissionsEditor';

// Change what someone may do. Takes effect on their next click - no need to sign in again.
function PermissionsDialog({ user, self, onSave, onClose }: { user: ListedUser; self: boolean; onSave: (body: { display_name: string; permissions: Permission[] }) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState<Permission[]>(user.permissions);
  const [name, setName] = useState(user.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal perm-dialog" role="dialog" aria-labelledby="perm-title">
        <div className="modal-header">
          <h2 id="perm-title">Edit {user.display_name}</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="perm-dialog-fields">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
        </div>
        <PermissionsEditor value={value} onChange={setValue} lockManageUsers={self} />
        {error && (
          <div className="alert alert-bad" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="perm-dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSave({ display_name: name, permissions: value });
                onClose();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ListedUser {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  permissions: Permission[];
  must_change_password: boolean;
  has_authenticator: boolean;
  disabled: boolean;
  locked: boolean;
  last_login_at: string | null;
  password_changed_at: string;
  created_at: string;
}

interface AuthEvent {
  at: string;
  event: string;
  username: string | null;
  actor: string | null;
  ip: string | null;
  detail: string | null;
}

const EVENT_TEXT: Record<string, string> = {
  login: 'signed in',
  logout: 'signed out',
  login_failed: 'wrong password',
  account_locked: 'locked after too many wrong passwords',
  login_refused_disabled: 'tried to sign in (account disabled)',
  login_refused_temp_expired: 'tried an expired temporary password',
  password_changed: 'changed their password',
  password_change_failed: 'wrong current password on Change password',
  password_reset: 'password reset',
  reset_link_created: 'reset link made on the server',
  password_reset_by_link: 'chose a new password with a reset link',
  authenticator_set_up: 'set up their authenticator app',
  authenticator_replaced: 'moved their authenticator app to a new phone',
  password_reset_by_authenticator: 'reset their password with their authenticator app',
  authenticator_reset_failed: 'wrong authenticator code on Forgot password',
  user_created: 'account created',
  user_updated: 'account changed',
  setup_admin_created: 'first admin created',
};

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// The temporary password, shown once: the admin passes it on; the user must change it at sign-in.
function TempPasswordDialog({ title, user, password, hours, onClose }: { title: string; user: string; password: string; hours: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return createPortal(
    <div className="modal-overlay">
      <div className="dm-card an-info users-temp" role="dialog" aria-labelledby="temp-title">
        <h2 id="temp-title" className="dm-title">{title}</h2>
        <p className="dm-message">
          Give this temporary password to <b>{user}</b> in person or over a private message. It works for {hours} hours,
          and they must choose their own password as soon as they sign in.
        </p>
        <div className="users-temp-pw">
          <code>{password}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="dm-hint">It won't be shown again. If it's lost, reset the password again.</p>
        <div className="dm-actions">
          <button className="dm-btn dm-btn-main" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function UsersPage() {
  const { user: me, refresh: refreshMe } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<ListedUser[]>('/users') });
  const events = useQuery({ queryKey: ['auth-events'], queryFn: () => api.get<AuthEvent[]>('/auth/events') });
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ title: string; user: string; password: string; hours: number } | null>(null);
  const [form, setForm] = useState<{ display_name: string; username: string; permissions: Permission[] }>({ display_name: '', username: '', permissions: OPERATOR });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ListedUser | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['auth-events'] });
  };
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (err) => setError(errorText(err)),
  });

  async function addUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ user: ListedUser; temporary_password: string; expires_in_hours: number }>('/users', form);
      setTemp({ title: `Account created for ${r.user.display_name}`, user: r.user.username, password: r.temporary_password, hours: r.expires_in_hours });
      setForm({ display_name: '', username: '', permissions: OPERATOR });
      setAdding(false);
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  function reset(u: ListedUser) {
    if (!confirm(`Reset ${u.display_name}'s password? They'll be signed out everywhere and get a temporary password from you.`)) return;
    setError(null);
    act.mutate(async () => {
      const r = await api.post<{ temporary_password: string; expires_in_hours: number }>(`/users/${u.id}/reset-password`);
      setTemp({ title: `New temporary password for ${u.display_name}`, user: u.username, password: r.temporary_password, hours: r.expires_in_hours });
    });
  }

  const patch = (u: ListedUser, body: Record<string, unknown>, question?: string) => {
    if (question && !confirm(question)) return;
    setError(null);
    act.mutate(() => api.patch(`/users/${u.id}`, body));
  };
  const onlyAdmin = users.data !== undefined && users.data.filter((u) => u.is_admin && !u.disabled).length === 1;

  return (
    <div>
      <p className="page-eyebrow">Configure</p>
      <h1 className="page-title">Users</h1>
      <p className="muted users-intro">
        Everyone who can sign in to Healthcheck. Admins can add people, reset forgotten passwords and manage accounts. New
        accounts and resets get a temporary password that must be changed at the next sign-in.
      </p>

      {error && (
        <div className="alert alert-bad" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="section-head">
        <h2>People</h2>
        {!adding && (
          <button className="primary" onClick={() => setAdding(true)}>
            Add user
          </button>
        )}
      </div>

      {adding && (
        <form className="card users-add" onSubmit={addUser}>
          <label>
            Name
            <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required maxLength={80} autoFocus />
          </label>
          <label>
            Username
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              autoCapitalize="off"
              spellCheck={false}
              pattern="[A-Za-z0-9._\-]{3,32}"
              title="3-32 letters, digits, dots, dashes or underscores"
            />
          </label>
          <div className="users-add-perm">
            <div className="users-add-perm-title">What can they do?</div>
            <PermissionsEditor value={form.permissions} onChange={(permissions) => setForm({ ...form, permissions })} />
          </div>
          <span className="users-add-actions">
            <button className="primary">Create account</button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </span>
        </form>
      )}

      {onlyAdmin && (
        <div className="alert users-note">
          <span>
            <b>You're the only admin.</b> If you ever lose both your password and your phone, only a command on the
            Healthcheck server can let you back in. Add a second admin (Edit → Admin), so you can help each other.
          </span>
        </div>
      )}

      <div className="card users-table-wrap">
        <table className="users-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id} className={u.disabled ? 'users-off' : ''}>
                  <td>
                    <b>{u.display_name}</b>
                    {self && <span className="users-you">you</span>}
                    <div className="mono muted">{u.username}</div>
                  </td>
                  <td>
                    {roleName(u.permissions)}
                    {roleName(u.permissions) === 'Custom' && <div className="muted users-perm-count">{u.permissions.length} permissions</div>}
                    {u.is_admin && (
                      <div className={`users-perm-count ${u.has_authenticator ? 'muted' : 'users-warn'}`}>
                        {u.has_authenticator ? 'Authenticator app set up' : 'Authenticator app: at next sign-in'}
                      </div>
                    )}
                  </td>
                  <td>
                    {u.disabled ? (
                      <span className="users-tag users-tag-off">Disabled</span>
                    ) : u.locked ? (
                      <span className="users-tag users-tag-bad">Locked (wrong passwords)</span>
                    ) : u.must_change_password ? (
                      <span className="users-tag users-tag-wait">Waiting for first sign-in</span>
                    ) : (
                      <span className="users-tag users-tag-ok">Active</span>
                    )}
                  </td>
                  <td className="muted">{when(u.last_login_at)}</td>
                  <td className="users-actions">
                    {!self && !u.disabled && <button onClick={() => reset(u)}>Reset password</button>}
                    {u.locked && <button onClick={() => patch(u, { unlock: true })}>Unlock</button>}
                    {!self && u.has_authenticator && (
                      <button
                        onClick={() =>
                          patch(
                            u,
                            { remove_authenticator: true },
                            `Remove ${u.display_name}'s authenticator app? Do this when they lost their phone. They'll set it up again on their next sign-in.`,
                          )
                        }
                      >
                        Remove authenticator
                      </button>
                    )}
                    <button onClick={() => setEditing(u)}>Edit</button>
                    {!self && (
                      <button
                        className={u.disabled ? '' : 'danger'}
                        onClick={() =>
                          patch(u, { disabled: !u.disabled }, u.disabled ? undefined : `Disable ${u.display_name}? They'll be signed out and can't sign in until enabled again.`)
                        }
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="card users-events">
        <summary>Recent sign-in activity</summary>
        <ul>
          {(events.data ?? []).slice(0, 50).map((e, i) => (
            <li key={i} className={/failed|locked|refused/.test(e.event) ? 'bad' : ''}>
              <span className="muted">{when(e.at)}</span> <b>{e.username ?? '—'}</b> {EVENT_TEXT[e.event] ?? e.event}
              {e.actor && e.actor !== e.username ? <span className="muted"> by {e.actor}</span> : null}
              {e.ip ? <span className="muted mono"> · {e.ip}</span> : null}
            </li>
          ))}
        </ul>
      </details>

      {temp && <TempPasswordDialog {...temp} onClose={() => setTemp(null)} />}
      {editing && (
        <PermissionsDialog
          user={editing}
          self={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await api.patch(`/users/${editing.id}`, body);
            refresh();
            // my own permissions changed: the sidebar and buttons follow
            if (editing.id === me?.id) await refreshMe();
          }}
        />
      )}
    </div>
  );
}
