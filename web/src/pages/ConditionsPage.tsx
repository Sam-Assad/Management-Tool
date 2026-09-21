import { useState } from 'react';
import {
  useConditions,
  useCreateCondition,
  useUpdateCondition,
  useDeleteCondition,
  useSoftwareDefinitions,
} from '../api/hooks';
import { IconConditions } from '../components/Icons';

// Add new kinds of condition here (and in the shared ConditionType) and they show up in the
// picker and the list without further UI work.
const CONDITION_TYPES = [
  { value: 'start_before', label: 'Start before', verb: 'must start before', summary: 'starts before' },
  { value: 'stop_before', label: 'Stop before', verb: 'must stop before', summary: 'stops before' },
];

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

const emptyForm = { type: 'start_before', subject_id: '', target_id: '', note: '' };

export default function ConditionsPage() {
  const { data: conditions } = useConditions();
  const { data: software } = useSoftwareDefinitions();
  const createCondition = useCreateCondition();
  const updateCondition = useUpdateCondition();
  const deleteCondition = useDeleteCondition();

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const typeInfo = CONDITION_TYPES.find((t) => t.value === form.type) ?? CONDITION_TYPES[0];
  const sortedSoftware = [...(software ?? [])].sort((a: any, b: any) => a.name.localeCompare(b.name));

  function openModal() {
    setForm(emptyForm);
    setFormError(null);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.subject_id || !form.target_id) {
      setFormError('Pick both components.');
      return;
    }
    try {
      await createCondition.mutateAsync({
        type: form.type,
        subject_id: Number(form.subject_id),
        target_id: Number(form.target_id),
        note: form.note.trim() || undefined,
      });
      setShowModal(false);
    } catch (err) {
      setFormError(messageOf(err));
    }
  }

  async function toggle(id: number, enabled: boolean) {
    setPageError(null);
    try {
      await updateCondition.mutateAsync({ id, input: { enabled } });
    } catch (err) {
      setPageError(messageOf(err));
    }
  }

  async function remove(id: number, label: string) {
    if (!confirm(`Delete this condition?\n\n${label}`)) return;
    setPageError(null);
    try {
      await deleteCondition.mutateAsync(id);
    } catch (err) {
      setPageError(messageOf(err));
    }
  }

  return (
    <div>
      <div className="section-label">
        <span className="dot" />
        <span className="label-text">Conditions</span>
      </div>
      <h1>
        Start &amp; stop <span className="gradient-text">conditions</span>
      </h1>
      <p className="muted">
        Conditions are the rules that decide the order every group starts and stops in. They replace manual
        reordering: add or change a rule here and every group's order updates to match. Start and stop are
        separate: <b>Start before</b> rules shape the start order, <b>Stop before</b> rules shape the stop order.
      </p>

      <div className="rule-card">
        <IconConditions />
        <div>
          <b>How the order is worked out</b>
          <ul className="help-list">
            <li>
              <b>Built-in:</b> services start before jars, unless a condition below says otherwise.
            </li>
            <li>
              <b>Your conditions:</b> "A must start before B" is honoured in every group that has both. Anything
              they don't constrain is ordered services first, then by name.
            </li>
            <li>
              <b>Stopping</b> runs in the reverse of the start order, unless a <b>Stop before</b> condition says
              otherwise — "A must stop before B" is honoured in every group that has both, and wins over the
              reversal. Start rules and stop rules are checked separately, so they never conflict with each other.
            </li>
          </ul>
        </div>
      </div>

      <button className="primary" onClick={openModal}>+ Add condition</button>
      {pageError && <p className="form-error" style={{ marginTop: 10 }}>{pageError}</p>}

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Condition</th><th>Type</th><th>Note</th><th>Active</th><th></th></tr>
        </thead>
        <tbody>
          {conditions?.length === 0 && (
            <tr><td colSpan={5} className="muted">No conditions yet - add one to control the start or stop order.</td></tr>
          )}
          {conditions?.map((c: any) => {
            const info = CONDITION_TYPES.find((t) => t.value === c.type);
            const label = `${c.subject_name} ${info?.summary ?? c.type} ${c.target_name}`;
            return (
              <tr key={c.id} className={c.enabled ? '' : 'cond-disabled'}>
                <td>
                  <span className="cond-expr">
                    <span className="cname">{c.subject_name}</span>
                    <span className="cverb">{info?.summary ?? c.type}</span>
                    <span className="cname">{c.target_name}</span>
                  </span>
                </td>
                <td className="muted">{info?.label ?? c.type}</td>
                <td className="muted">{c.note || '-'}</td>
                <td>
                  <label className="switch" title={c.enabled ? 'Active - click to switch off' : 'Off - click to switch on'}>
                    <input type="checkbox" checked={Boolean(c.enabled)} onChange={(e) => toggle(c.id, e.target.checked)} />
                    <span className="track" />
                  </label>
                </td>
                <td>
                  <button onClick={() => remove(c.id, label)}>Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
            <div className="modal-header">
              <span>Add condition</span>
              <button onClick={() => setShowModal(false)}>Close</button>
            </div>
            <form className="stacked-form wide" onSubmit={handleSubmit}>
              <label>
                Condition type
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {CONDITION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Component
                <select value={form.subject_id} onChange={(e) => setForm({ ...form, subject_id: e.target.value })}>
                  <option value="">Select...</option>
                  {sortedSoftware.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <div className="muted" style={{ textAlign: 'center' }}>
                <span className="cond-expr"><span className="cverb">{typeInfo.verb}</span></span>
              </div>
              <label>
                Component
                <select value={form.target_id} onChange={(e) => setForm({ ...form, target_id: e.target.value })}>
                  <option value="">Select...</option>
                  {sortedSoftware.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Note (optional)
                <input
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  placeholder="Why this rule exists"
                />
              </label>
              {formError && <p className="form-error">{formError}</p>}
              <div className="button-row">
                <button type="submit" className="primary" disabled={createCondition.isPending}>
                  {createCondition.isPending ? 'Saving…' : 'Add condition'}
                </button>
                <button type="button" onClick={() => setShowModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
