import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  useServer,
  useDeleteServer,
  useTestConnection,
  useSoftwareDefinitions,
  useGroupSoftware,
  useGroupStatus,
  useSetGroupSoftware,
  useScanGroup,
  useAutoDiscover,
  useSuggestions,
  useDismissSuggestion,
  useStartAll,
  useStartOne,
  useRestartAll,
  useStopAll,
  useRestartOne,
  useStopOne,
} from '../api/hooks';
import type { ServerSummary } from '../api/hooks';
import JobProgressPanel from '../components/JobProgressPanel';
import RowMenu from '../components/RowMenu';
import '../styles/server-page.css';
import LogViewer from '../components/LogViewer';
import LoadState from '../components/LoadState';
import InfoTip from '../components/InfoTip';
import { api } from '../api/client';

// Re-render on a timer so "checked 3 min ago" keeps counting while nothing else changes.
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function timeAgo(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} h ${mins % 60} min ago`;
}

const LOCKED = 'Something is already running on this server - wait for it to finish (or answer its question) first.';

// ---- Plain-language view of each state ---------------------------------------------------------
// working = green, has a problem = red, stopped (nothing wrong, just not running) = gray
type Tone = 'ok' | 'bad' | 'stopped' | 'busy' | 'idle';
type GroupId = 'datasource_down' | 'not_ready' | 'credential_expired' | 'failed' | 'unreachable' | 'stopped' | 'busy' | 'working' | 'idle';

const STATE_VIEW: Record<string, { label: string; tone: Tone; group: GroupId }> = {
  running: { label: 'Working', tone: 'ok', group: 'working' },
  datasource_down: { label: "Can't reach its database", tone: 'bad', group: 'datasource_down' },
  not_ready: { label: "Can't receive traffic", tone: 'bad', group: 'not_ready' },
  credential_expired: { label: 'Password expired', tone: 'bad', group: 'credential_expired' },
  failed: { label: 'Stopped with an error', tone: 'bad', group: 'failed' },
  unreachable: { label: "Couldn't be checked", tone: 'bad', group: 'unreachable' },
  stopped: { label: 'Stopped', tone: 'stopped', group: 'stopped' },
  starting: { label: 'Starting', tone: 'busy', group: 'busy' },
  stopping: { label: 'Stopping', tone: 'busy', group: 'busy' },
  mixed: { label: 'Partly running', tone: 'busy', group: 'busy' },
  not_installed: { label: 'Not installed here', tone: 'idle', group: 'idle' },
  unknown: { label: 'Not checked yet', tone: 'idle', group: 'idle' },
};

// In the order they're shown: problems first, the biggest kind of trouble on top.
const GROUPS: { id: GroupId; title: string; advice: string }[] = [
  {
    id: 'datasource_down',
    title: "Can't reach the database",
    advice:
      "It's running, but its connections to the database fail, so the applications that rely on it don't work. Get the database or its password fixed, then restart it.",
  },
  {
    id: 'not_ready',
    title: "Can't receive traffic",
    advice:
      "It's running and its database connections work, but it isn't accepting requests, so people can't reach the applications on it. Restart it, or open its log to see why.",
  },
  {
    id: 'credential_expired',
    title: 'Database password expired',
    advice:
      "These stopped because the password they use to log in to the database has expired. Once it's renewed, start them again, one by one or with Start All.",
  },
  {
    id: 'failed',
    title: 'Stopped with an error',
    advice: 'These tried to run and failed. Try starting them again, or open the log to see what went wrong.',
  },
  {
    id: 'unreachable',
    title: "Couldn't be checked",
    advice: "Healthcheck couldn't connect to the server to look at these. Check that the server is on and reachable.",
  },
  { id: 'stopped', title: 'Stopped', advice: 'Not running at the moment. Start them one by one, or all at once with Start All.' },
  { id: 'busy', title: 'In progress', advice: 'Starting or stopping right now.' },
  { id: 'working', title: 'Working normally', advice: '' },
  { id: 'idle', title: 'Not checked yet', advice: 'Healthcheck will look at these on its next check.' },
];

const CONNECTION_TEXT: Record<string, string> = {
  ok: 'Connected',
  unreachable: "Can't connect right now",
  auth_failed: 'Login to the server was refused',
  unknown: 'Connection not checked yet',
};

// Shape as well as colour: with only red, white and gray, "working" and "needs attention" must not
// rely on hue alone.
function StateIcon({ tone, size = 22 }: { tone: Tone; size?: number }) {
  return (
    <span className={`sv-icon sv-icon-${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      {tone === 'ok' && (
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {tone === 'bad' && (
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round">
          <path d="M12 5.5v8" />
          <circle cx="12" cy="18.5" r="0.9" fill="currentColor" />
        </svg>
      )}
      {tone === 'stopped' && (
        <svg width={size * 0.4} height={size * 0.4} viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="3" />
        </svg>
      )}
    </span>
  );
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage blocked: the switch still works for this visit
  }
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

export default function ServerDetail() {
  const { serverId } = useParams();
  const { data: server, isError, error, refetch } = useServer(Number(serverId));
  if (isError) return <LoadState error={error} onRetry={() => refetch()} />;
  if (!server) return <p>Loading...</p>;
  // key: opening a different server starts from a clean page
  return <ServerView key={server.id} server={server} onServerChanged={() => refetch()} />;
}

function ServerView({ server, onServerChanged }: { server: ServerSummary; onServerChanged: () => void }) {
  // Everything about a server (its software list, order, jobs, status) is stored under its own private
  // group; `id` below is that group's id.
  const id = server.group_id;
  const navigate = useNavigate();
  const location = useLocation();

  const { data: allSoftware } = useSoftwareDefinitions();
  const { data: softwareList, refetch: refetchSoftware } = useGroupSoftware(id);
  const { data: suggestions, refetch: refetchSuggestions } = useSuggestions(id);
  const { data: status, refetch: refetchStatus } = useGroupStatus(id);
  const now = useNow(30000);

  const testConnection = useTestConnection();
  const deleteServer = useDeleteServer();
  const setSoftware = useSetGroupSoftware(id);
  const scan = useScanGroup(id);
  const autoDiscover = useAutoDiscover(id);
  const dismissSuggestion = useDismissSuggestion(id);
  const startAll = useStartAll(id);
  const startOne = useStartOne();
  const restartAll = useRestartAll(id);
  const stopAll = useStopAll(id);
  const restartOne = useRestartOne();
  const stopOne = useStopOne();

  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [logSoftwareId, setLogSoftwareId] = useState<number | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('hc-dismissed-db-alerts') ?? '[]');
    } catch {
      return [];
    }
  });
  const dismissAlert = (key: string) => {
    const next = [...dismissedAlerts, key];
    setDismissedAlerts(next);
    try {
      localStorage.setItem('hc-dismissed-db-alerts', JSON.stringify(next.slice(-50)));
    } catch {
      // private window / blocked storage: closing still works for this visit
    }
  };
  const [technical, setTechnical] = useState(() => readFlag('hc-technical-view'));
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>((location.state as any)?.notice ?? null);
  // a job is running (or paused, waiting for an answer): starting another one on this server is refused
  const [jobRunning, setJobRunning] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // a message or job panel that appears below the fold would go unnoticed - bring it into view
  useEffect(() => {
    if (actionError || activeJobId) feedbackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [actionError, activeJobId]);

  // Coming back to the page (or reloading it) while a run is still going - or paused waiting for an
  // answer - re-attaches to it, so it can never be left orphaned and locking the server.
  useEffect(() => {
    api
      .get<any[]>(`/jobs?groupId=${id}`)
      .then((jobs) => {
        const running = jobs.find((j) => j.status === 'running');
        if (running) setActiveJobId(running.id);
      })
      .catch(() => {});
  }, [id]);

  // Run an action that starts a job, and show that job.
  async function runJob(start: () => Promise<{ jobId: number }>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setActionError(null);
    setActionNotice(null);
    try {
      const { jobId } = await start();
      setActiveJobId(jobId);
      setJobRunning(true);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  function toggleSoftware(softwareId: number, enabled: boolean) {
    // Membership only - the server puts everything in order from the Conditions page.
    const ids = new Set((softwareList ?? []).map((c: any) => c.software_id as number));
    if (enabled) ids.add(softwareId);
    else ids.delete(softwareId);
    const items = [...ids].map((software_id, index) => ({ software_id, sequence_order: index }));
    setSoftware.mutate(items, {
      onSuccess: () => {
        refetchSoftware();
        refetchSuggestions();
      },
      onError: (err) => setActionError(errorMessage(err)),
    });
  }

  async function handleDismissSuggestion(softwareId: number) {
    try {
      await dismissSuggestion.mutateAsync(softwareId);
      refetchSuggestions();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleDiscover() {
    setActionError(null);
    setActionNotice(null);
    try {
      const { added } = await autoDiscover.mutateAsync();
      setActionNotice(added.length ? `Added: ${added.join(', ')}` : 'Nothing new found installed on this server.');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleTestConnection() {
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await testConnection.mutateAsync(server.id);
      if (result.ok) setActionNotice('Connection OK.');
      else setActionError(result.message ?? 'Connection test failed');
      onServerChanged();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRemoveServer() {
    if (
      !confirm(
        `Remove ${server.name} from Healthcheck?\n\nNothing on the server itself is changed or stopped - Healthcheck just stops managing it.`
      )
    )
      return;
    try {
      await deleteServer.mutateAsync(server.id);
      navigate('/');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const statusBySoftware = new Map((status?.items ?? []).map((i) => [i.software_id, i]));
  const ordered = [...(softwareList ?? [])].sort((a: any, b: any) => a.sequence_order - b.sequence_order);
  const logSoftware = allSoftware?.find((s: any) => s.id === logSoftwareId);

  const services = ordered.map((item: any) => {
    const st = statusBySoftware.get(item.software_id);
    const sv = st?.servers?.[0];
    const state = st?.state ?? 'unknown';
    const view = STATE_VIEW[state] ?? STATE_VIEW.unknown;
    const datasources = state === 'datasource_down' && sv?.detail ? sv.detail.split(',') : [];
    return {
      id: item.software_id as number,
      name: item.software.name as string,
      state,
      view,
      datasources,
      // a closed database warning comes back if a different set of datasources starts failing
      alertKey: `${server.id}|${item.software.name}|${[...datasources].sort().join(',')}`,
      rawDetail: sv?.detail ?? null,
      checkedAt: sv?.checked_at ?? null,
      startStep: item.sequence_order + 1,
      stopStep: (item.stop_order ?? item.sequence_order) + 1,
    };
  });
  type Service = (typeof services)[number];

  const total = services.length;
  const counts = {
    ok: services.filter((s) => s.view.tone === 'ok').length,
    bad: services.filter((s) => s.view.tone === 'bad').length,
    stopped: services.filter((s) => s.view.tone === 'stopped').length,
    busy: services.filter((s) => s.view.tone === 'busy').length,
    idle: services.filter((s) => s.view.tone === 'idle').length,
  };
  const groups = GROUPS.map((g) => ({ ...g, members: services.filter((s) => s.view.group === g.id) })).filter((g) => g.members.length > 0);
  const problemGroups = groups.filter((g) => g.members[0].view.tone === 'bad');
  const otherGroups = groups.filter((g) => g.members[0].view.tone !== 'bad');
  const alsoStopped = counts.stopped === 0 ? '' : counts.stopped === 1 ? ' One more is stopped.' : ` ${counts.stopped} more are stopped.`;

  const verdict =
    total === 0
      ? { tone: 'idle', title: 'Nothing to watch here yet', text: "Healthcheck hasn't found any of the platform's software on this server. Use Find installed software below to look again." }
      : counts.bad > 0
        ? {
            tone: 'bad',
            title: counts.bad === 1 ? `1 of ${total} services has a problem` : `${counts.bad} of ${total} services have a problem`,
            text: `The loyalty platform on ${server.name} isn't fully working. The list below says what's wrong with each one and what to do.${alsoStopped}`,
          }
        : counts.busy > 0
          ? { tone: 'busy', title: 'Changes in progress', text: `${counts.busy} of ${total} services are starting or stopping right now.` }
          : counts.stopped > 0
            ? {
                tone: 'stopped',
                title: counts.stopped === total ? `Everything on ${server.name} is stopped` : `${counts.stopped} of ${total} services are stopped`,
                text: 'Nothing is broken, they just aren\'t running. Start them one by one, or all at once with Start All.',
              }
            : counts.idle === total
              ? { tone: 'idle', title: 'Waiting for the first check', text: 'Healthcheck is about to look at every service on this server.' }
              : { tone: 'ok', title: 'Everything is working', text: `All ${counts.ok} services on ${server.name} are up and running.` };

  const busyTitle = jobRunning ? LOCKED : undefined;

  const renderRow = (s: Service) => {
    const down = (s.view.tone === 'bad' || s.view.tone === 'stopped') && s.state !== 'datasource_down' && s.state !== 'not_ready' && s.state !== 'unreachable';
    const showDsCallout = s.datasources.length > 0 && !dismissedAlerts.includes(s.alertKey);
    return (
      <li key={s.id} id={`svc-${s.id}`} className={`sv-row sv-tone-${s.view.tone}`}>
        <StateIcon tone={s.view.tone} />
        <div className="sv-main">
          <div className="sv-name">{s.name}</div>
          {s.state === 'not_ready' && s.rawDetail && <div className="sv-state">{s.rawDetail}</div>}
          {s.datasources.length > 0 && !showDsCallout && (
            <div className="sv-state">
              {s.datasources.length} database connection{s.datasources.length > 1 ? 's' : ''} failing
            </div>
          )}
          {showDsCallout && (
            <div className="sv-callout" role="note">
              <button className="sv-callout-close" aria-label="Hide this list" title="Hide this list" onClick={() => dismissAlert(s.alertKey)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
              <p>
                {s.datasources.length === 1 ? 'This database connection fails:' : `These ${s.datasources.length} database connections fail:`}
              </p>
              <div className="dm-ds-list">
                {s.datasources.map((ds) => (
                  <span key={ds} className="dm-ds-chip">{ds}</span>
                ))}
              </div>
            </div>
          )}
          {technical && (
            <div className="sv-tech">
              Starts at step {s.startStep}, stops at step {s.stopStep}. State: {s.state}
              {s.rawDetail ? ` (${s.rawDetail})` : ''}
              {s.checkedAt ? `. Checked ${new Date(s.checkedAt).toLocaleTimeString()}.` : '.'}
            </div>
          )}
        </div>
        <div className="sv-actions">
          {down && (
            <button
              className="sv-start"
              disabled={jobRunning}
              title={busyTitle}
              onClick={() => runJob(() => startOne.mutateAsync({ serverId: server.id, softwareId: s.id }))}
            >
              Start
            </button>
          )}
          {(s.state === 'datasource_down' || s.state === 'not_ready') && (
            <button
              className="sv-start"
              disabled={jobRunning}
              title={busyTitle}
              onClick={() => runJob(() => restartOne.mutateAsync({ serverId: server.id, softwareId: s.id }))}
            >
              Restart
            </button>
          )}
          <RowMenu
            label={`More actions for ${s.name}`}
            items={[
              { label: 'Start', disabled: jobRunning, title: busyTitle, onSelect: () => runJob(() => startOne.mutateAsync({ serverId: server.id, softwareId: s.id })) },
              { label: 'Restart', disabled: jobRunning, title: busyTitle, onSelect: () => runJob(() => restartOne.mutateAsync({ serverId: server.id, softwareId: s.id })) },
              { label: 'Stop', disabled: jobRunning, title: busyTitle, onSelect: () => runJob(() => stopOne.mutateAsync({ serverId: server.id, softwareId: s.id })) },
              { label: 'Show its log', onSelect: () => setLogSoftwareId(s.id) },
              { label: 'Remove from this list', danger: true, onSelect: () => toggleSoftware(s.id, false) },
            ]}
          />
        </div>
      </li>
    );
  };

  const renderGroup = (g: (typeof groups)[number]) => (
    <section key={g.id} className={`sv-group sv-group-${g.members[0].view.tone}`} aria-labelledby={`grp-${g.id}`}>
      <header className="sv-group-head">
        <h3 id={`grp-${g.id}`}>
          {g.title} <span className="sv-count">{g.members.length}</span>
        </h3>
        {g.advice && <p>{g.advice}</p>}
      </header>
      <ul className="sv-list">{g.members.map(renderRow)}</ul>
    </section>
  );

  return (
    <div className="sv-page">
      <header className="sv-head">
        <div>
          <h1 className="sv-title">{server.name}</h1>
          <p className={`sv-conn sv-conn-${server.connection_status}`}>
            <span className="sv-conn-dot" aria-hidden="true" />
            {CONNECTION_TEXT[server.connection_status] ?? server.connection_status}
            {technical && <span className="sv-tech-inline">{server.ssh_username}@{server.host}:{server.port}</span>}
          </p>
        </div>
        <span className="with-info">
          <button onClick={handleTestConnection}>Test connection</button>
          <InfoTip>Checks that Healthcheck can still log in to this server.</InfoTip>
        </span>
      </header>

      <section className={`sv-verdict sv-verdict-${verdict.tone}`} aria-labelledby="sv-verdict-title">
        <StateIcon tone={verdict.tone as Tone} size={44} />
        <div className="sv-verdict-body">
        <h2 id="sv-verdict-title" className="sv-verdict-title">{verdict.title}</h2>
        <p className="sv-verdict-text">{verdict.text}</p>

        <p className="sv-checked">
          {status?.last_checked_at ? `Checked ${timeAgo(status.last_checked_at, now)}.` : 'First check pending.'}{' '}
          {status?.interval_minutes ? `Refreshes on its own every ${status.interval_minutes} minutes.` : 'Refreshes on its own.'}{' '}
          <button className="sv-linkbtn" onClick={() => runJob(() => scan.mutateAsync())} disabled={jobRunning} title={busyTitle ?? 'Looks at every service now. Changes nothing.'}>
            Check now
          </button>
        </p>
        </div>
      </section>

      <div className="sv-bulk">
          <span className="with-info">
            <button className="primary sv-bulk-main" onClick={() => runJob(() => startAll.mutateAsync())} disabled={jobRunning} title={busyTitle}>
              Start All
            </button>
            <InfoTip>
              Starts everything that isn't running and leaves the rest alone. Services that depend on each other start in the
              right order, each one waiting until the one before it works. You can follow it live below.
            </InfoTip>
          </span>
          <span className="with-info">
            <button
              className="outline"
              onClick={() => runJob(() => restartAll.mutateAsync(), `Restart everything on ${server.name}, in order?`)}
              disabled={jobRunning}
              title={busyTitle}
            >
              Restart All
            </button>
            <InfoTip>Stops and starts every service again, even the ones that are working, in the same order as Start All.</InfoTip>
          </span>
          <span className="with-info">
            <button
              className="danger"
              onClick={() => runJob(() => stopAll.mutateAsync(), `Stop everything on ${server.name}? This will take it down.`)}
              disabled={jobRunning}
              title={busyTitle}
            >
              Stop All
            </button>
            <InfoTip>Stops every service, one at a time, in a safe order: what sits on top of another service is stopped first.</InfoTip>
          </span>
      </div>

      <div ref={feedbackRef} className="sv-feedback">
        {actionError && (
          <div className="alert alert-bad" role="alert">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)}>Dismiss</button>
          </div>
        )}
        {actionNotice && (
          <div className="alert alert-ok">
            <span>{actionNotice}</span>
            <button onClick={() => setActionNotice(null)}>Dismiss</button>
          </div>
        )}
        {activeJobId && (
          <JobProgressPanel
            key={activeJobId}
            jobId={activeJobId}
            onUpdate={(job) => {
              setJobRunning(job.status === 'running');
              refetchStatus();
            }}
            onClear={() => {
              setActiveJobId(null);
              setJobRunning(false);
            }}
          />
        )}
      </div>

      {suggestions && suggestions.length > 0 && (
        <section className="sv-found">
          <h3>Found on this server but not watched yet</h3>
          <ul>
            {suggestions.map((s) => (
              <li key={s.software_id}>
                <span>{s.name}</span>
                <button onClick={() => toggleSoftware(s.software_id, true)}>Watch it</button>
                <button className="sv-linkbtn" onClick={() => handleDismissSuggestion(s.software_id)}>
                  Ignore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {problemGroups.length > 0 && <h2 className="sv-section-title">Needs attention</h2>}
      {problemGroups.map(renderGroup)}
      {problemGroups.length > 0 && otherGroups.length > 0 && <div className="sv-gap" />}
      {otherGroups.map(renderGroup)}

      <footer className="sv-foot">
        <span className="with-info">
          <button onClick={handleDiscover}>Find installed software</button>
          <InfoTip>Looks for the platform's software installed on this server that isn't in this list yet, and adds it.</InfoTip>
        </span>
        <label className="sv-switch">
          <input
            type="checkbox"
            checked={technical}
            onChange={(e) => {
              setTechnical(e.target.checked);
              writeFlag('hc-technical-view', e.target.checked);
            }}
          />
          Show technical details
        </label>
        <span className="with-info sv-foot-end">
          <button className="sv-linkbtn sv-danger-link" onClick={handleRemoveServer}>
            Stop watching this server
          </button>
          <InfoTip>Removes this server from Healthcheck. Nothing on the server itself is changed or stopped.</InfoTip>
        </span>
      </footer>

      {logSoftwareId && (
        <LogViewer
          serverId={server.id}
          softwareId={logSoftwareId}
          title={logSoftware?.name}
          subtitle={[server.name, logSoftware?.log_path].filter(Boolean).join('  -  ')}
          onClose={() => setLogSoftwareId(null)}
        />
      )}
    </div>
  );
}
