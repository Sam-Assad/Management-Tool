import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useBeatAlerts, type BeatAlert } from '../api/hooks';
import { ToneIcon } from './DecisionModal';
import { size } from './ArtemisNoticeModal';

// Warnings already closed, one per heartbeat reading. A later beat that still finds the problem is a new
// reading, so the warning comes back every interval until it's fixed.
const STORAGE_KEY = 'hc-dismissed-beat-alerts';

const keyOf = (a: BeatAlert) => `${a.server_id}:${a.software_id}:${a.checked_at}`;

function loadDismissed(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDismissed(keys: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys.slice(-100)));
  } catch {
    // per-viewer convenience only: without storage the warning simply shows again after a reload
  }
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Problem({ alert }: { alert: BeatAlert }) {
  if (alert.kind === 'artemis' && alert.artemis) {
    const r = alert.artemis;
    return (
      <>
        <b>It's using too much memory:</b>{' '}
        {r.heapUsedBytes !== null && r.heapMaxBytes !== null ? `${size(r.heapUsedBytes)} of ${size(r.heapMaxBytes)} (${r.heapPercent}%)` : 'over the limit'}
        , so messages may pile up or slow down.
        <span className="ba-facts">
          DLQ {r.dlq ?? '—'} · ExpiryQueue {r.expiry ?? '—'}
        </span>
      </>
    );
  }
  if (alert.state === 'not_ready') {
    // the reason may end with "N database connections are failing: A, B, C." - those names read better as chips
    const m = (alert.detail ?? '').match(/^(.*?)\s*(\d+ database connections? (?:is|are) failing): (.+)\.$/s);
    const dbNames = m ? m[3].split(', ') : [];
    return (
      <>
        <b>It can't receive traffic,</b> so users can't reach the applications on it. {m ? m[1] : alert.detail}
        {m && (
          <>
            {' '}
            {m[2]}:
            <span className="dm-ds-list ba-chips">
              {dbNames.map((n) => (
                <span key={n} className="dm-ds-chip">{n}</span>
              ))}
            </span>
          </>
        )}
      </>
    );
  }
  const names = (alert.detail ?? '').split(',').filter(Boolean);
  return (
    <>
      <b>
        {names.length === 1 ? '1 database connection is' : `${names.length} database connections are`} failing,
      </b>{' '}
      so the applications that rely on {names.length === 1 ? 'it' : 'them'} don't work.
      {names.length > 0 && (
        <span className="dm-ds-list ba-chips">
          {names.map((n) => (
            <span key={n} className="dm-ds-chip">{n}</span>
          ))}
        </span>
      )}
    </>
  );
}

// The red warning the background check raises when it finds WildFly unhealthy, on top of any page.
export default function BeatAlertModal() {
  const { data } = useBeatAlerts();
  const [dismissed, setDismissed] = useState(loadDismissed);
  const navigate = useNavigate();

  const open = (data?.alerts ?? []).filter((a) => !dismissed.includes(keyOf(a)));
  if (open.length === 0) return null;

  function dismiss(alerts: BeatAlert[]) {
    const next = [...dismissed, ...alerts.map(keyOf)];
    setDismissed(next);
    saveDismissed(next);
  }

  const software = [...new Set(open.map((a) => a.software_name))];
  const title = software.length === 1 ? `${software[0]} has issues, please check` : `${software.join(' and ')} have issues, please check`;
  const every = data?.interval_minutes;
  const kinds = new Set(open.map((a) => a.kind));
  // when the next check comes depends on which check found it: WildFly's heartbeat or Artemis's own beat
  const schedule = [
    kinds.has('wildfly') && every ? `WildFly is checked every ${every} minutes` : null,
    kinds.has('artemis') && data?.artemis_schedule ? `Artemis's queues and memory are checked ${data.artemis_schedule}` : null,
  ].filter(Boolean);

  return createPortal(
    <div className="modal-overlay">
      <div className="dm-card dm-error" role="alertdialog" aria-labelledby="ba-title" aria-describedby="ba-list">
        <ToneIcon tone="error" />
        <h2 id="ba-title" className="dm-title">{title}</h2>
        <p className="dm-message">
          The background check found {open.length === 1 ? 'a problem' : `problems on ${open.length} servers`}. Nothing
          was stopped or restarted.
        </p>

        <ul id="ba-list" className="ba-list">
          {open.map((a) => (
            <li key={keyOf(a)} className="ba-item">
              <div className="ba-where">
                <b>{a.server_name}</b>
                <span className="muted">checked at {time(a.checked_at)}</span>
              </div>
              <p className="ba-problem">
                <Problem alert={a} />
              </p>
              {open.length > 1 && (
                <button
                  className="dm-link"
                  onClick={() => {
                    dismiss([a]);
                    navigate(`/servers/${a.server_id}`);
                  }}
                >
                  Open {a.server_name}
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="dm-actions">
          {open.length === 1 && (
            <button
              className="dm-btn dm-btn-main"
              onClick={() => {
                dismiss(open);
                navigate(`/servers/${open[0].server_id}`);
              }}
            >
              Open {open[0].server_name}
            </button>
          )}
          <button className="dm-btn" onClick={() => dismiss(open)}>
            Dismiss
          </button>
        </div>
        <p className="dm-hint">
          {schedule.length ? `${schedule.join('; ')}. ` : ''}This warning comes back if the next check still finds the
          problem.
        </p>
      </div>
    </div>,
    document.body
  );
}
