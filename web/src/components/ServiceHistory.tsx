import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { intervalText, useServiceHistory, type ServiceEvent } from '../api/hooks';

// "Show its history": every start, stop, restart and crash of a service and who did it - a Healthcheck run (and
// whose), a person in a terminal (with the command), systemd, or the server restarting. Read from the server's
// journal (or, where Healthcheck can't read it, systemd's timestamps), newest first, grouped by day.

const WHAT: Record<ServiceEvent['kind'], string> = {
  started: 'Started',
  stopped: 'Stopped',
  restarted: 'Restarted',
  crashed: 'Stopped with an error',
  start_failed: 'Failed to start',
  crash_loop: 'Kept crashing',
  reloaded: 'Reloaded its settings',
  enabled: 'Set to start with the server',
  disabled: 'Set not to start with the server',
  masked: 'Blocked from starting',
  unmasked: 'Unblocked',
};
const RUN: Record<string, string> = {
  start_all: 'Start All',
  restart_all: 'Restart All',
  stop_all: 'Stop All',
  start_one: 'Start',
  restart_one: 'Restart',
  stop_one: 'Stop',
  scan: 'Check status',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
// a time, with its day when it isn't the same day as `from`
function until(iso: string, from: string): string {
  const d = new Date(iso);
  if (sameDay(d, new Date(from))) return time(iso);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const day = sameDay(d, new Date()) ? 'today' : sameDay(d, yesterday) ? 'yesterday' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time(iso)}`;
}

function who(e: ServiceEvent, sshUser: string | null): string {
  switch (e.source) {
    case 'healthcheck':
      return `In Healthcheck${e.actor ? `, by ${e.actor}` : ''}${e.job_kind && RUN[e.job_kind] ? ` (${RUN[e.job_kind]})` : ''}`;
    case 'terminal':
      if (e.actor && e.actor === sshUser && !e.terminal) return `By ${e.actor}, the account Healthcheck signs in with, but not in a Healthcheck run`;
      return `${e.probable ? 'Probably by' : 'By'} ${e.actor}${e.terminal ? ` in a terminal (${e.terminal})` : ''}`;
    case 'systemd':
      return e.kind === 'crash_loop' ? 'systemd restarted it after each crash' : 'systemd restarted it automatically';
    case 'itself':
      return 'Nobody asked systemd to stop it';
    case 'reboot':
      return 'The server restarted';
    case 'boot':
      return 'When the server started up';
    default:
      return e.origin === 'journal'
        ? "Outside Healthcheck, and not through sudo, so who did it isn't recorded"
        : 'Outside Healthcheck: from a terminal, a script, or the server itself';
  }
}

function detail(e: ServiceEvent): string | null {
  if (e.kind === 'crash_loop' && e.count) {
    return `${e.count.toLocaleString()} times, until ${until(e.until_at ?? e.at, e.at)}${e.detail ? `. Each time: ${e.detail}` : ''}`;
  }
  if (e.source === 'reboot' && e.detail === 'the server restarted') return null;
  return e.detail;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function ServiceHistory({ serverId, softwareId, name, serverName, onClose }: { serverId: number; softwareId: number; name: string; serverName: string; onClose: () => void }) {
  const { data, isLoading, error } = useServiceHistory(serverId, softwareId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const days: { label: string; events: ServiceEvent[] }[] = [];
  for (const e of data?.events ?? []) {
    const label = dayLabel(new Date(e.at));
    if (days[days.length - 1]?.label === label) days[days.length - 1].events.push(e);
    else days.push({ label, events: [e] });
  }
  const every = data?.interval_minutes ? `every ${intervalText(data.interval_minutes)}` : 'at each check';
  const last = data?.last_read_at ? `, last at ${time(data.last_read_at)}` : '';

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sh" role="dialog" aria-labelledby="sh-title">
        <div className="modal-header">
          <div>
            <h2 id="sh-title">{name}: history</h2>
            <p className="sh-sub">
              On {serverName}. Starts, stops, restarts and errors in the last {data?.days ?? 30} days, and who did them.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {isLoading && <p className="sh-empty">Loading…</p>}
        {error && <p className="sh-empty">The history couldn't be loaded. Try again in a moment.</p>}
        {data && days.length === 0 && (
          <p className="sh-empty">
            Nothing recorded yet. Healthcheck reads this from the server {every}, and after each Start, Restart or Stop
            here, so the first entries appear after the next check. Check status reads it right away.
          </p>
        )}

        {days.map((d) => (
          <section key={d.label} className="sh-day" aria-label={d.label}>
            <h3>{d.label}</h3>
            <ol className="sh-list">
              {d.events.map((e, i) => {
                const more = detail(e);
                return (
                  <li key={`${e.at}-${e.kind}-${i}`} className={`sh-item sh-${e.kind}`}>
                    <time dateTime={e.at}>{time(e.at)}</time>
                    <span className="sh-mark" aria-hidden="true" />
                    <div className="sh-text">
                      <b>{WHAT[e.kind] ?? e.kind}</b>
                      {more && <span className="sh-detail">{more}</span>}
                      <span className={`sh-who sh-who-${e.source}`}>{who(e, data?.ssh_user ?? null)}</span>
                      {e.command && <code className="sh-cmd">{e.command}</code>}
                      {e.sessions && e.sessions.length > 0 && (
                        <span className="sh-sessions">
                          Root sessions open then:{' '}
                          {e.sessions.map((s) => `${s.user} (${s.how}${s.tty ? `, ${s.tty}` : ''}, since ${until(s.since, e.at)})`).join(', ')}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}

        <p className="sh-foot">
          {data?.mode === 'snapshot' ? (
            <>
              Read from systemd {every} and after each Start, Restart or Stop in Healthcheck{last}. Healthcheck can't read
              this server's journal, so several stops and starts between two reads show as one, and who did something in a
              terminal isn't known. Adding {data.ssh_user ?? 'the account Healthcheck signs in with'} to the systemd-journal
              group fixes that.
            </>
          ) : (
            <>
              Read from the server's journal {every} and after each Start, Restart or Stop in Healthcheck{last}.
              {data?.journal_kept === false &&
                ' This server clears its journal when it restarts, so anything between the last read and a restart is lost.'}
            </>
          )}
        </p>
      </div>
    </div>,
    document.body,
  );
}
