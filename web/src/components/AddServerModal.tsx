import { useState } from 'react';
import { useAddServer } from '../api/hooks';

const empty = { name: '', host: '', port: 22, ssh_username: '', password: '' };

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

// Adds a server: connects once with the service account's password, installs Healthcheck's own SSH
// key, and discovers what's installed. `onAdded` gets the new server and what was discovered.
export default function AddServerModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (server: { id: number; name: string; discovered: string[] }) => void;
}) {
  const addServer = useAddServer();
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await addServer.mutateAsync({ ...form, name: form.name.trim(), host: form.host.trim() });
      onAdded({ id: result.id, name: result.name, discovered: result.discovered ?? [] });
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-header">
          <span>Add server</span>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted">
          Enter the service account's password just once — Healthcheck generates its own SSH key, installs it on
          the server, and uses that key for every connection afterward. The password itself is never stored. It
          then checks which of the catalog's components are installed on the server.
        </p>
        <form className="stacked-form" onSubmit={submit}>
          <label>
            Server name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. mgt-trx"
              autoFocus
            />
          </label>
          <label>
            Host
            <input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="hostname or IP"
            />
          </label>
          <label>
            Port
            <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
          </label>
          <label>
            SSH username
            <input value={form.ssh_username} onChange={(e) => setForm({ ...form, ssh_username: e.target.value })} />
          </label>
          <label>
            Password
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <button type="submit" className="primary" disabled={addServer.isPending}>
            {addServer.isPending ? 'Connecting…' : 'Add server'}
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}
