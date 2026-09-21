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
import Badge from '../components/Badge';
import StatusChip from '../components/StatusChip';
import JobProgressPanel from '../components/JobProgressPanel';
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

const LOCKED = 'A job is running on this server - wait for it to finish (or answer its question) first.';

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

  return (
    <div>
      <div className="section-label">
        <span className="dot" />
        <span className="label-text">Server</span>
      </div>
      <div className="server-head">
        <div>
          <h1>{server.name}</h1>
          <p className="muted mono" style={{ margin: '2px 0 0' }}>
            {server.ssh_username}@{server.host}:{server.port} <Badge status={server.connection_status} />
          </p>
        </div>
        <div className="server-head-actions">
          <span className="with-info">
            <button onClick={handleTestConnection}>Test connection</button>
            <InfoTip>Checks that Healthcheck can still log in to this server with its SSH key.</InfoTip>
          </span>
          <span className="with-info">
            <button className="danger" onClick={handleRemoveServer}>Remove server</button>
            <InfoTip>
              Makes Healthcheck stop managing this server. Nothing on the machine itself is changed or stopped.
            </InfoTip>
          </span>
        </div>
      </div>

      {suggestions && suggestions.length > 0 && (
        <section>
          <div className="card" style={{ borderColor: 'rgba(230, 0, 0, 0.3)' }}>
            <p style={{ margin: '0 0 10px' }}>
              <b>Installed on this server but not in its list yet:</b>
            </p>
            <div className="chip-row">
              {suggestions.map((s) => (
                <span key={s.software_id} className="chip chip-pending" style={{ gap: 10 }}>
                  {s.name}
                  <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => toggleSoftware(s.software_id, true)}>
                    Add
                  </button>
                  <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => handleDismissSuggestion(s.software_id)}>
                    Dismiss
                  </button>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      <section>
        <h2>Software</h2>
        <div className="button-row">
          <span className="with-info">
            <button onClick={() => runJob(() => scan.mutateAsync())} disabled={jobRunning} title={jobRunning ? LOCKED : undefined}>
              Check status
            </button>
            <InfoTip>
              Read-only. Looks at every component on this server and tells you which are running and which are stopped.
              Changes nothing.
            </InfoTip>
          </span>
          <span className="with-info">
            <button onClick={handleDiscover}>Discover software</button>
            <InfoTip>
              Looks for catalog components that are installed on this server but not in its list yet, and adds them.
            </InfoTip>
          </span>
          <span className="with-info">
            <button
              className="primary"
              onClick={() => runJob(() => startAll.mutateAsync())}
              disabled={jobRunning}
              title={jobRunning ? LOCKED : undefined}
            >
              Start All
            </button>
            <InfoTip>
              Starts everything that is down and leaves what already runs alone. Components tied together by a "Start
              before" rule start one after another, each waiting until the one before it is healthy. Components with no
              rule start at the same time, with live status and logs below.
            </InfoTip>
          </span>
          <span className="with-info">
            <button
              className="outline"
              onClick={() => runJob(() => restartAll.mutateAsync(), `Restart everything on ${server.name}, in sequence?`)}
              disabled={jobRunning}
              title={jobRunning ? LOCKED : undefined}
            >
              Restart All
            </button>
            <InfoTip>
              Stops and starts every component again, even ones that are already running. Same order as Start All: rules
              first, the rest at the same time.
            </InfoTip>
          </span>
          <span className="with-info">
            <button
              className="danger"
              onClick={() => runJob(() => stopAll.mutateAsync(), `Stop everything on ${server.name}? This will take it down.`)}
              disabled={jobRunning}
              title={jobRunning ? LOCKED : undefined}
            >
              Stop All
            </button>
            <InfoTip>
              Stops everything, one at a time, in the stop order: a component that sits on top of another (for example
              WildFly on Artemis) is stopped first.
            </InfoTip>
          </span>
        </div>
        <div ref={feedbackRef}>
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
        <p className="muted status-line">
          <span className="status-pulse" />
          Status updates automatically
          {status?.interval_minutes ? ` every ${status.interval_minutes} minutes` : ' on a schedule'}
          {status?.last_checked_at
            ? ` · last checked ${new Date(status.last_checked_at).toLocaleTimeString()} (${timeAgo(status.last_checked_at, now)})`
            : ' · first check pending'}
        </p>

        <table className="table">
          <thead>
            <tr>
              <th>
                <span className="with-info">
                  Start #
                  <InfoTip>
                    The order Start All and Restart All go in. Components tied by a "Start before" rule follow this order,
                    one after another; components with no rule start at the same time. To change it, change a condition
                    on the Conditions page.
                  </InfoTip>
                </span>
              </th>
              <th>
                <span className="with-info">
                  Stop #
                  <InfoTip>
                    The order Stop All goes in: the reverse of the start order, unless a "Stop before" rule says
                    otherwise. To change it, change a condition on the Conditions page.
                  </InfoTip>
                </span>
              </th>
              <th>Name</th>
              <th>Status</th>
              <th>
                <span className="with-info">
                  Actions
                  <InfoTip>
                    <ul>
                      <li><b>Start</b> - starts it if it is down. Refused while a component it needs is not running.</li>
                      <li><b>Restart</b> - stops it and starts it again. Refused while something that must stop first is still running.</li>
                      <li><b>Stop</b> - stops it. Refused while a component that must stop before it is still running (WildFly before Artemis).</li>
                      <li><b>Logs</b> - opens its log file, live.</li>
                      <li><b>Remove</b> - takes it out of this server's list. Nothing is stopped or uninstalled.</li>
                    </ul>
                  </InfoTip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing from the catalog is installed on this server yet. If that looks wrong, click Discover software.
                </td>
              </tr>
            )}
            {ordered.map((item: any) => {
              const st = statusBySoftware.get(item.software_id);
              const sv = st?.servers?.[0];
              const title = sv
                ? `${sv.state.replace('_', ' ')}${sv.detail ? ` (${sv.detail})` : ''}${sv.checked_at ? ` - checked ${new Date(sv.checked_at).toLocaleTimeString()}` : ''}`
                : undefined;
              return (
                <tr key={item.software_id}>
                  <td>{item.sequence_order + 1}</td>
                  <td>{(item.stop_order ?? item.sequence_order) + 1}</td>
                  <td>{item.software.name}</td>
                  <td><StatusChip state={st?.state ?? 'unknown'} title={title} /></td>
                  <td>
                    <button disabled={jobRunning} title={jobRunning ? LOCKED : undefined} onClick={() => runJob(() => startOne.mutateAsync({ serverId: server.id, softwareId: item.software_id }))}>Start</button>
                    <button disabled={jobRunning} title={jobRunning ? LOCKED : undefined} onClick={() => runJob(() => restartOne.mutateAsync({ serverId: server.id, softwareId: item.software_id }))}>Restart</button>
                    <button disabled={jobRunning} title={jobRunning ? LOCKED : undefined} onClick={() => runJob(() => stopOne.mutateAsync({ serverId: server.id, softwareId: item.software_id }))}>Stop</button>
                    <button onClick={() => setLogSoftwareId(item.software_id)}>Logs</button>
                    <button onClick={() => toggleSoftware(item.software_id, false)}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

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
