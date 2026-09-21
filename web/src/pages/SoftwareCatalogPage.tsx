import { useState } from 'react';
import {
  useSoftwareDefinitions,
  useCreateSoftwareDefinition,
  useUpdateSoftwareDefinition,
  useDeleteSoftwareDefinition,
} from '../api/hooks';

const empty = {
  name: '',
  kind: 'service',
  detect_method: 'systemd',
  detect_value: '',
  start_cmd: '',
  stop_cmd: '',
  restart_method: 'systemd',
  log_path: '',
  success_pattern: '',
  error_pattern: String.raw`\b(ERROR|FATAL|SEVERE)\b|APPLICATION FAILED TO START`,
  health_timeout_s: 120,
};

export default function SoftwareCatalogPage() {
  const { data } = useSoftwareDefinitions();
  const createDef = useCreateSoftwareDefinition();
  const updateDef = useUpdateSoftwareDefinition();
  const deleteDef = useDeleteSoftwareDefinition();
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  function startEdit(def: any) {
    setEditingId(def.id);
    setForm({
      name: def.name,
      kind: def.kind,
      detect_method: def.detect_method,
      detect_value: def.detect_value,
      start_cmd: def.start_cmd ?? '',
      stop_cmd: def.stop_cmd ?? '',
      restart_method: def.restart_method,
      log_path: def.log_path ?? '',
      success_pattern: def.success_pattern ?? '',
      error_pattern: def.error_pattern ?? '',
      health_timeout_s: def.health_timeout_s,
    });
    setShowModal(true);
  }

  function startCreate() {
    setEditingId(null);
    setForm(empty);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingId(null);
    setForm(empty);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId) {
      await updateDef.mutateAsync({ id: editingId, input: form });
    } else {
      await createDef.mutateAsync(form);
    }
    closeModal();
  }

  return (
    <div>
      <div className="section-label">
        <span className="dot" />
        <span className="label-text">Catalog</span>
      </div>
      <h1>Software <span className="gradient-text">catalog</span></h1>

      <button className="primary" onClick={startCreate}>+ Add software</button>

      <table className="table" style={{ marginTop: 16 }}>
        <thead><tr><th>Name</th><th>Kind</th><th>Detect</th><th>Restart method</th><th>Start command</th><th></th></tr></thead>
        <tbody>
          {data?.map((def: any) => (
            <tr key={def.id}>
              <td>{def.name}</td>
              <td>{def.kind}</td>
              <td>{def.detect_method}: {def.detect_value}</td>
              <td>{def.restart_method}</td>
              <td className="muted">{def.start_cmd || '(none set)'}</td>
              <td>
                <button onClick={() => startEdit(def)}>Edit</button>
                <button onClick={() => deleteDef.mutate(def.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
            <div className="modal-header">
              <span>{editingId ? `Edit ${form.name}` : 'Add software'}</span>
              <button onClick={closeModal}>Close</button>
            </div>
            {editingId && (
              <p className="muted">
                Components are managed as systemd units: put the unit name in Detect value and leave the
                Start/Stop commands blank. Only fill them in to override what Healthcheck runs.
              </p>
            )}
            <form className="stacked-form" onSubmit={handleSubmit}>
              <label>
                Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label>
                Kind
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="service">service</option>
                  <option value="jar">jar</option>
                </select>
              </label>
              <label>
                Detect method
                <select
                  value={form.detect_method}
                  onChange={(e) => setForm({ ...form, detect_method: e.target.value })}
                >
                  <option value="systemd">systemd unit</option>
                  <option value="process_fragment">process fragment (pgrep -f)</option>
                  <option value="jar_path_fragment">jar path glob (ls)</option>
                </select>
              </label>
              <label>
                Detect value
                <input
                  value={form.detect_value}
                  onChange={(e) => setForm({ ...form, detect_value: e.target.value })}
                  placeholder="unit name, e.g. wso2am.service (alternatives: wso2am.service|wso2apim.service)"
                />
              </label>
              <label>
                Start command (optional override)
                <input
                  value={form.start_cmd}
                  onChange={(e) => setForm({ ...form, start_cmd: e.target.value })}
                  placeholder="leave blank for systemd units"
                />
              </label>
              <label>
                Stop command (optional override)
                <input
                  value={form.stop_cmd}
                  onChange={(e) => setForm({ ...form, stop_cmd: e.target.value })}
                  placeholder="leave blank for systemd units"
                />
              </label>
              <label>
                Restart method
                <select
                  value={form.restart_method}
                  onChange={(e) => setForm({ ...form, restart_method: e.target.value })}
                >
                  <option value="captured">captured command line (needs it already running once)</option>
                  <option value="systemd">systemd unit (systemctl start/stop on the unit name)</option>
                  <option value="script">start/stop script (uses start/stop command above)</option>
                </select>
              </label>
              <label>
                Log path
                <input
                  value={form.log_path}
                  onChange={(e) => setForm({ ...form, log_path: e.target.value })}
                  placeholder="/Data/logs/... (fixed per market, set per item as needed)"
                />
              </label>
              <label>
                Success pattern (regex)
                <input
                  value={form.success_pattern}
                  onChange={(e) => setForm({ ...form, success_pattern: e.target.value })}
                  placeholder="started in|Deployed"
                />
              </label>
              <label>
                Error pattern (regex)
                <input
                  value={form.error_pattern}
                  onChange={(e) => setForm({ ...form, error_pattern: e.target.value })}
                />
              </label>
              <label>
                Health timeout (s)
                <input
                  type="number"
                  value={form.health_timeout_s}
                  onChange={(e) => setForm({ ...form, health_timeout_s: Number(e.target.value) })}
                />
              </label>
              <div className="button-row">
                <button type="submit" className="primary">
                  {editingId ? 'Save changes' : 'Add to catalog'}
                </button>
                <button type="button" onClick={closeModal}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
