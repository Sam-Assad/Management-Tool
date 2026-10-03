import { createPortal } from 'react-dom';
import { ToneIcon } from './DecisionModal';

export interface ArtemisReport {
  checked: boolean;
  dlq: number | null;
  expiry: number | null;
  heapUsedBytes: number | null;
  heapMaxBytes: number | null;
  heapPercent: number | null;
  logWarnings: number;
  logErrors: number;
  lastLogProblem?: string;
  tone: 'info' | 'warning' | 'danger';
  notes: string[];
}

export interface JobNotice {
  id: string;
  kind: 'artemis';
  tone: 'info' | 'warning' | 'danger';
  server: string;
  component: string;
  at: string;
  artemis: ArtemisReport;
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function InfoIcon() {
  return (
    <span className="dm-icon an-icon-info" aria-hidden="true">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <circle cx="12" cy="6.5" r="0.6" fill="currentColor" />
        <path d="M12 11v7" />
      </svg>
    </span>
  );
}

// What Artemis looks like right after a start/restart: DLQ, ExpiryQueue and memory. A report, not a question -
// the run carries on behind it. Red when it uses half or more of its memory.
export default function ArtemisNoticeModal({ notice, onClose }: { notice: JobNotice; onClose: () => void }) {
  const r = notice.artemis;
  const danger = notice.tone === 'danger';
  const title = danger
    ? `${notice.component} is using too much memory`
    : notice.tone === 'warning'
      ? `${notice.component} started - take a look`
      : `${notice.component} started`;
  const mem =
    r.heapPercent !== null && r.heapUsedBytes !== null && r.heapMaxBytes !== null
      ? { used: size(r.heapUsedBytes), max: size(r.heapMaxBytes), pct: r.heapPercent }
      : null;

  return createPortal(
    <div className="modal-overlay">
      <div className={`dm-card ${danger ? 'dm-error' : notice.tone === 'warning' ? 'dm-warning' : 'an-info'}`} role="alertdialog" aria-labelledby="an-title">
        {danger ? <ToneIcon tone="error" /> : notice.tone === 'warning' ? <ToneIcon tone="warning" /> : <InfoIcon />}
        <h2 id="an-title" className="dm-title">{title}</h2>
        <p className="dm-message">
          On <b>{notice.server}</b>, right after it started:
        </p>

        <div className="an-stats">
          <div className={`an-stat${r.dlq ? ' an-stat-flag' : ''}`}>
            <span className="an-label">DLQ</span>
            <b>{r.dlq ?? '—'}</b>
            <span className="an-sub">{r.dlq === null ? "couldn't read" : r.dlq === 1 ? 'message' : 'messages'}</span>
          </div>
          <div className={`an-stat${r.expiry ? ' an-stat-flag' : ''}`}>
            <span className="an-label">ExpiryQueue</span>
            <b>{r.expiry ?? '—'}</b>
            <span className="an-sub">{r.expiry === null ? "couldn't read" : r.expiry === 1 ? 'message' : 'messages'}</span>
          </div>
          <div className={`an-stat an-stat-mem${danger ? ' an-stat-danger' : ''}`}>
            <span className="an-label">Memory</span>
            {mem ? (
              <>
                <b>
                  {mem.used} <span className="an-of">of {mem.max}</span>
                </b>
                <span className="an-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, mem.pct)}%` }} />
                </span>
                <span className="an-sub">{mem.pct}% used</span>
              </>
            ) : (
              <>
                <b>—</b>
                <span className="an-sub">couldn't read</span>
              </>
            )}
          </div>
        </div>

        {danger && (
          <p className="an-alert">
            Artemis is already using {mem?.pct}% of the memory it's given. Messages may pile up or slow down; check
            what's filling it before it runs out.
          </p>
        )}
        {(r.logErrors > 0 || r.logWarnings > 0) && (
          <p className="dm-hint">
            Its log shows {r.logErrors} error{r.logErrors === 1 ? '' : 's'} and {r.logWarnings} warning
            {r.logWarnings === 1 ? '' : 's'} since this start.
            {r.lastLogProblem && <span className="an-logline">{r.lastLogProblem}</span>}
          </p>
        )}
        {r.notes.map((n) => (
          <p key={n} className="dm-hint">
            {n}
          </p>
        ))}

        <div className="dm-actions">
          <button className="dm-btn dm-btn-main" onClick={onClose} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
