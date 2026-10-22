import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { durationText, intervalText, useBeatAlerts, useStopCrashing, type BeatAlert } from '../api/hooks';
import { useCan } from '../auth/AuthContext';
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

// "10:42" today, "Thu 9 Oct, 10:42" before
function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? time(iso)
    : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time(iso)}`;
}

const gb = (kb: number) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

// who started it before it began crashing
function startedHow(c: NonNullable<BeatAlert['crash']>): string {
  if (c.started_source === 'boot') return ' when the server started up';
  if (c.started_source === 'terminal') return ` by ${c.started_actor} from a terminal`;
  if (c.started_source === 'outside') return ' outside Healthcheck';
  return '';
}

// A service that keeps crashing: how often, why, and how the server looks. Nothing is stopped unless someone
// presses Stop.
function Crash({ alert }: { alert: BeatAlert }) {
  const c = alert.crash!;
  const facts = c.facts;
  const lowMemory = facts?.memory ? facts.memory.availableKb / facts.memory.totalKb < 0.1 : false;
  return (
    <>
      {alert.state === 'gave_up' ? (
        <>
          <b>It's down:</b> it crashed {c.count} times since {when(c.first_crash_at)}, and systemd gave up restarting it.
        </>
      ) : (
        <>
          <b>It keeps crashing:</b> {c.count} times since {when(c.first_crash_at)}, the last at {when(c.last_crash_at)}. systemd
          restarts it each time.
        </>
      )}
      {c.after_start && c.ran_for_s !== null ? (
        <> It never got going: it was started{startedHow(c)}, and first crashed {durationText(c.ran_for_s)} later.</>
      ) : (
        c.ran_for_s !== null && c.ran_for_s > 0 && <> It had been running fine for {durationText(c.ran_for_s)} before.</>
      )}
      <span className="ba-reason">
        <b>Why:</b> {c.reason ?? (alert.detail ? `It ends with ${alert.detail}.` : 'Being looked at…')}
      </span>
      {facts && (
        <span className="ba-facts ba-crash-facts">
          {facts.disks.map((d) => (
            <span key={d.mount} className={d.usedPct >= 90 ? 'ba-warn' : undefined}>
              Disk {d.mount}: {d.usedPct}% full ({gb(d.availKb)} free)
            </span>
          ))}
          {facts.memory && (
            <span className={lowMemory ? 'ba-warn' : undefined}>
              Memory: {gb(facts.memory.availableKb)} free of {gb(facts.memory.totalKb)}
            </span>
          )}
          {facts.oom.length > 0 && <span className="ba-warn">The server killed processes for lack of memory: {facts.oom[facts.oom.length - 1]}</span>}
        </span>
      )}
      {c.excerpt && (
        <details className="ba-error">
          <summary>Show the error from its log</summary>
          <pre>{c.excerpt}</pre>
        </details>
      )}
    </>
  );
}

// Stop a service that keeps crashing, after asking. It stays stopped until someone starts it (a server restart
// starts it again). Without the permission, says who can.
function StopCrashing({ alert, main, onStarted }: { alert: BeatAlert; main?: boolean; onStarted: (jobId: number) => void }) {
  const can = useCan();
  const stop = useStopCrashing();
  const [error, setError] = useState<string | null>(null);
  if (alert.kind !== 'crash' || alert.state !== 'crashing') return null;
  if (!can('stop_one')) return <span className="ba-stop-note muted">Someone allowed to stop services can stop it from here.</span>;
  async function go() {
    if (
      !confirm(
        `Stop ${alert.software_name} on ${alert.server_name}?\n\nIt stays stopped until someone starts it again (a restart of the server starts it too). Look at why it crashes before starting it.`,
      )
    )
      return;
    setError(null);
    try {
      const { jobId } = await stop.mutateAsync({ serverId: alert.server_id, softwareId: alert.software_id });
      onStarted(jobId);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <button className={main ? 'dm-btn dm-btn-main' : 'dm-btn ba-stop'} onClick={go} disabled={stop.isPending}>
        {stop.isPending ? 'Stopping…' : `Stop ${alert.software_name}`}
      </button>
      {error && <span className="ba-stop-error">{error}</span>}
    </>
  );
}

function Problem({ alert }: { alert: BeatAlert }) {
  if (alert.kind === 'crash' && alert.crash) return <Crash alert={alert} />;
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
  if (alert.state === 'unhealthy') {
    return (
      <>
        <b>It's running, but not working:</b> {alert.detail}
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
  const can = useCan();

  const open = (data?.alerts ?? []).filter((a) => !dismissed.includes(keyOf(a)));
  if (open.length === 0) return null;

  function dismiss(alerts: BeatAlert[]) {
    const next = [...dismissed, ...alerts.map(keyOf)];
    setDismissed(next);
    saveDismissed(next);
  }

  // the stop runs as a job: show it on the server's page
  const stopped = (a: BeatAlert) => (jobId: number) => {
    dismiss([a]);
    navigate(`/servers/${a.server_id}`, { state: { jobId } });
  };

  const software = [...new Set(open.map((a) => a.software_name))];
  const servers = [...new Set(open.map((a) => a.server_name))];
  const names = software.length === 1 ? software[0] : `${software.slice(0, -1).join(', ')} and ${software[software.length - 1]}`;
  const allCrashing = open.every((a) => a.kind === 'crash');
  const title = allCrashing
    ? `${names} ${software.length === 1 ? 'keeps' : 'keep'} crashing`
    : `${names} ${software.length === 1 ? 'has' : 'have'} issues, please check`;
  const every = data?.interval_minutes;
  const kinds = new Set(open.map((a) => a.kind));
  // when the next check comes depends on which check found it: WildFly's heartbeat, Artemis's own beat, the crash check
  const schedule = [
    kinds.has('wildfly') && every ? `WildFly is checked every ${intervalText(every)}` : null,
    kinds.has('health') && every ? `Services are checked every ${intervalText(every)}` : null,
    kinds.has('artemis') && data?.artemis_schedule ? `Artemis's queues and memory are checked ${data.artemis_schedule}` : null,
    kinds.has('crash') && data?.crash_check_minutes ? `Crashes are looked for every ${intervalText(data.crash_check_minutes)}` : null,
  ].filter(Boolean);

  return createPortal(
    <div className="modal-overlay">
      <div className="dm-card dm-error" role="alertdialog" aria-labelledby="ba-title" aria-describedby="ba-list">
        <ToneIcon tone="error" />
        <h2 id="ba-title" className="dm-title">{title}</h2>
        <p className="dm-message">
          The background check found {open.length === 1 ? 'a problem' : `${open.length} problems`}
          {servers.length === 1 ? ` on ${servers[0]}` : ` on ${servers.length} servers`}. Nothing was stopped or restarted.
        </p>

        <ul id="ba-list" className="ba-list">
          {open.map((a) => (
            <li key={keyOf(a)} className="ba-item">
              <div className="ba-where">
                <b>
                  {a.software_name} on {a.server_name}
                </b>
                <span className="muted">checked at {time(a.checked_at)}</span>
              </div>
              <div className="ba-problem">
                <Problem alert={a} />
              </div>
              {open.length > 1 && (
                <div className="ba-item-actions">
                  <StopCrashing alert={a} onStarted={stopped(a)} />
                  <button
                    className="dm-link"
                    onClick={() => {
                      dismiss([a]);
                      navigate(`/servers/${a.server_id}`);
                    }}
                  >
                    Open {a.server_name}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="dm-actions">
          {open.length === 1 && <StopCrashing alert={open[0]} main onStarted={stopped(open[0])} />}
          {open.length === 1 && (
            <button
              // the Stop button, when there is one, is the main action
              className={open[0].kind === 'crash' && open[0].state === 'crashing' && can('stop_one') ? 'dm-btn' : 'dm-btn dm-btn-main'}
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
