import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useRecentJobs, useServerList, type RecentJob } from '../api/hooks';
import Badge from '../components/Badge';
import LoadState from '../components/LoadState';
import AddServerModal from '../components/AddServerModal';
import DonutChart from '../components/DonutChart';
import InfoTip from '../components/InfoTip';
import JobProgressPanel, { KIND_LABEL } from '../components/JobProgressPanel';
import { useCan } from '../auth/AuthContext';
import { NO_PERMISSION } from '../auth/permissions';
import { IconPlus, IconServer } from '../components/Icons';
import ConnectionProblem, { type ConnectionProblemInfo } from '../components/ConnectionProblem';
import { ToneIcon } from '../components/DecisionModal';

type BulkAction = 'start' | 'restart' | 'stop';
const ACTION_LABEL: Record<BulkAction, string> = { start: 'Start All', restart: 'Restart All', stop: 'Stop All' };

type ServerItem = NonNullable<ReturnType<typeof useServerList>['data']>[number];

// one selected server: can it be reached, and if not, why
interface Reach {
  id: number;
  name: string;
  ok: boolean;
  problem: ConnectionProblemInfo | null;
}

// one run started from this page, for one server
interface Run {
  jobId: number;
  serverId: number;
  serverName: string;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

function listNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

const GUIDE_STEPS = [
  {
    title: 'Add a server',
    body: "Give it the service account's password once. Healthcheck generates its own SSH key, installs it, and uses that key from then on.",
  },
  {
    title: 'Software is discovered automatically',
    body: "Healthcheck checks which of the catalog's components are installed on the server and lists just those.",
  },
  {
    title: 'Control it',
    body: 'Start All / Restart All / Stop All run in the order set by your Conditions, gated on each step becoming healthy. Or start, restart, stop and read the logs of one component.',
  },
  {
    title: 'Watch it',
    body: "Every component's status refreshes on its own every few minutes, so you can see at a glance what's running.",
  },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

// Some of the selected servers can't be reached: nothing is done on those. Says which and why, and asks whether
// the others go ahead.
function UnreachableDialog({
  action,
  reachable,
  down,
  onCancel,
  onContinue,
}: {
  action: BulkAction;
  reachable: ServerItem[];
  down: Reach[];
  onCancel: () => void;
  onContinue: () => void;
}) {
  const label = ACTION_LABEL[action];
  const title =
    reachable.length === 0
      ? down.length === 1
        ? `${down[0].name} can't be reached`
        : `None of the ${down.length} servers can be reached`
      : down.length === 1
        ? `${down[0].name} can't be reached`
        : `${down.length} of the selected servers can't be reached`;
  return createPortal(
    <div className="modal-overlay">
      <div className="dm-card dm-error ur-card" role="alertdialog" aria-labelledby="ur-title">
        <ToneIcon tone="error" />
        <h2 id="ur-title" className="dm-title">{title}</h2>
        <p className="dm-message">
          Healthcheck can't connect to {down.length === 1 ? 'it' : 'them'}, so {label} won't be done there. Nothing was
          started or stopped.
        </p>
        <ul className="ur-list">
          {down.map((d) => (
            <li key={d.id}>
              <b className="ur-name">{d.name}</b>
              {d.problem ? <ConnectionProblem problem={d.problem} compact /> : <p className="cp-why">The connection failed.</p>}
            </li>
          ))}
        </ul>
        <div className="dm-actions">
          {reachable.length > 0 && (
            <button className="dm-btn dm-btn-main" onClick={onContinue}>
              {label} on {reachable.length === 1 ? reachable[0].name : `the other ${reachable.length}`}
            </button>
          )}
          <button className="dm-btn" onClick={onCancel}>
            {reachable.length > 0 ? 'Cancel' : 'OK'}
          </button>
        </div>
        {reachable.length > 0 && (
          <p className="dm-hint">
            {reachable.length === 1 ? `${reachable[0].name} can be reached.` : `${listNames(reachable.map((s) => s.name))} can be reached.`}{' '}
            Fix the connection first if {down.length === 1 ? 'that server' : 'those servers'} should be included.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default function ServersDashboard() {
  const { data: servers, isLoading, isError, error, refetch } = useServerList();
  const { data: jobs } = useRecentJobs(7);
  const [params, setParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = useCan();

  // ---- several servers at once: tick them, then Start All / Restart All / Stop All on every one of them.
  // Each server gets its own run - exactly the one its own page's button starts (its catalog services, in
  // its order, gated the same way) - and they run side by side.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [runs, setRuns] = useState<Run[]>([]);
  const [runState, setRunState] = useState<Record<number, { running: boolean; asking: boolean }>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  // checking the selected servers can be reached, and the ones that can't (waiting for "go ahead without them?")
  const [checking, setChecking] = useState(false);
  const [unreachable, setUnreachable] = useState<{ action: BulkAction; reachable: ServerItem[]; down: Reach[] } | null>(null);
  const runsRef = useRef<HTMLDivElement>(null);
  const reattached = useRef(false);

  // the sidebar's "+ Add server" button lands here as /?add=1
  useEffect(() => {
    if (params.get('add') === '1') {
      setShowAdd(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const list = servers ?? [];
  const components = list.flatMap((s) => s.software);
  const running = components.filter((c) => c.state === 'running').length;
  const stopped = components.filter((c) => c.state === 'stopped').length;
  const problems = components.filter((c) => ['failed', 'unreachable', 'unknown', 'credential_expired', 'datasource_down', 'not_ready'].includes(c.state)).length;
  const percent = components.length > 0 ? Math.round((running / components.length) * 100) : null;
  const serverOfGroup = new Map(list.map((s) => [s.group_id, s]));

  // Coming back to this page while runs are still going (or waiting for an answer) shows them again, so a
  // question is never left unanswered out of sight.
  useEffect(() => {
    if (reattached.current || !servers) return;
    reattached.current = true;
    api
      .get<RecentJob[]>('/jobs?limit=100')
      .then((jobs) => {
        const live = jobs
          .filter((j) => j.status === 'running' && j.group_id !== null && serverOfGroup.has(j.group_id))
          .map((j) => {
            const s = serverOfGroup.get(j.group_id!)!;
            return { jobId: j.id, serverId: s.id, serverName: s.name };
          });
        if (live.length) setRuns((prev) => [...live.filter((r) => !prev.some((p) => p.serverId === r.serverId)), ...prev]);
      })
      .catch(() => {});
  }, [servers]); // eslint-disable-line react-hooks/exhaustive-deps

  // a server that's gone from the list can't stay selected
  useEffect(() => {
    if (!servers) return;
    setSelected((prev) => new Set([...prev].filter((id) => servers.some((s) => s.id === id))));
  }, [servers]);

  const busyServers = new Set(runs.filter((r) => runState[r.jobId]?.running !== false).map((r) => r.serverId));
  const selectedServers = list.filter((s) => selected.has(s.id));
  const allSelected = list.length > 0 && selectedServers.length === list.length;
  // only one run's popup (question or Artemis report) on screen at a time: the earliest one that has one
  const askingJobId = runs.find((r) => runState[r.jobId]?.asking)?.jobId ?? null;

  function toggle(serverId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  }

  // First: can each selected server be reached right now? A run on one that can't would only fail at its first
  // step, so it isn't started: the ones that can't are listed with why, and the others go ahead only if you say so.
  async function runOnSelected(action: BulkAction) {
    const targets = selectedServers;
    if (targets.length === 0) return;
    setBulkBusy(true);
    setChecking(true);
    setBulkErrors([]);
    let reach: Reach[];
    try {
      reach = (await api.post<{ servers: Reach[] }>('/servers/reachability', { ids: targets.map((s) => s.id), action })).servers;
    } catch (err) {
      setBulkErrors([`Couldn't check whether the servers can be reached: ${errorMessage(err)}`]);
      setBulkBusy(false);
      setChecking(false);
      return;
    }
    setChecking(false);
    queryClient.invalidateQueries({ queryKey: ['servers'] }); // their connection badges
    const down = reach.filter((r) => !r.ok);
    const reachable = targets.filter((s) => reach.some((r) => r.id === s.id && r.ok));
    if (down.length > 0) {
      setUnreachable({ action, reachable, down });
      setBulkBusy(false);
      return;
    }
    await startRuns(action, reachable);
  }

  async function startRuns(action: BulkAction, targets: ServerItem[]) {
    const names = listNames(targets.map((s) => s.name));
    const what = targets.length === 1 ? names : `${targets.length} servers (${names})`;
    const go =
      targets.length > 0 &&
      (action === 'start' ||
        (action === 'restart' && confirm(`Restart everything on ${what}, in order?`)) ||
        (action === 'stop' && confirm(`Stop everything on ${what}? This will take ${targets.length === 1 ? 'it' : 'them'} down.`)));
    if (!go) {
      setBulkBusy(false);
      return;
    }

    setBulkBusy(true);
    setBulkErrors([]);
    const results = await Promise.allSettled(targets.map((s) => api.post<{ jobId: number }>(`/groups/${s.group_id}/${action}-all`)));
    const started: Run[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      const s = targets[i];
      if (r.status === 'fulfilled') started.push({ jobId: r.value.jobId, serverId: s.id, serverName: s.name });
      else errors.push(`${s.name}: ${errorMessage(r.reason)}`);
    });
    // a server's newest run replaces its previous panel
    setRuns((prev) => [...started, ...prev.filter((p) => !started.some((n) => n.serverId === p.serverId))]);
    setBulkErrors(errors);
    setBulkBusy(false);
    requestAnimationFrame(() => runsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  return (
    <div>
      <p className="page-eyebrow">{greeting()}</p>
      <h1 className="page-title">Fleet overview</h1>

      <div className="dash-grid">
        <div className="dash-card dash-dark">
          <div className="dash-icon">
            <IconServer />
          </div>
          <h2>Welcome back</h2>
          <p>
            {list.length === 0
              ? 'Add your first server (Add server, below) to start, restart and stop the Loyalty platform in the right order.'
              : `${list.length} server${list.length === 1 ? '' : 's'} and ${components.length} components under control. Start, restart and stop them in the right order.`}
          </p>
        </div>

        <div className="dash-card">
          <h3>Fleet health</h3>
          <div className="donut-wrap">
            <DonutChart percent={percent} />
          </div>
          <div className="metric-row">
            <div className="metric">
              <span className="lbl">Running</span>
              <b>{running}</b>
            </div>
            <div className="metric">
              <span className="lbl">Stopped</span>
              <b>{stopped}</b>
            </div>
            <div className={problems > 0 ? 'metric metric-alert' : 'metric'}>
              <span className="lbl">Problems</span>
              <b>{problems}</b>
            </div>
          </div>
        </div>

        <div className="dash-card">
          <h3>Recent activity</h3>
          {(jobs ?? []).length === 0 && <p className="muted">Nothing has been run yet.</p>}
          <ul className="timeline">
            {(jobs ?? []).map((job) => {
              const server = job.group_id !== null ? serverOfGroup.get(job.group_id) : undefined;
              const waiting = job.status === 'running' && job.awaiting;
              const tone = waiting ? 'warn' : job.status === 'running' ? 'run' : job.status === 'failed' ? 'bad' : 'ok';
              const word = waiting ? 'waiting for your decision' : job.status === 'succeeded' ? 'succeeded' : job.status;
              const row = (
                <>
                  <span className={`tl-dot tl-${tone}`} />
                  <span className="tl-body">
                    <b>
                      {KIND_LABEL[job.kind] ?? job.kind}
                      {server ? ` · ${server.name}` : ''}
                    </b>
                    <span className="muted">
                      {word} · {ago(job.finished_at ?? job.started_at)}
                      {job.started_by ? ` · by ${job.started_by}` : ''}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={job.id}>
                  {server ? (
                    <Link to={`/servers/${server.id}`} className="tl-row">
                      {row}
                    </Link>
                  ) : (
                    <div className="tl-row">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="section-head">
        <h2>Servers</h2>
        <button className="primary" onClick={() => setShowAdd(true)} disabled={!can('manage_servers')} title={can('manage_servers') ? undefined : NO_PERMISSION}>
          <IconPlus size={14} /> Add server
        </button>
      </div>

      {isLoading && <p>Loading...</p>}
      {isError && <LoadState error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && list.length === 0 && (
        <p className="muted">No servers yet — add your first one to get started.</p>
      )}

      {list.length > 0 && (
        <div className="fleet-bar" role="toolbar" aria-label="Act on the selected servers">
          <label className="fleet-pick-all">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedServers.length > 0 && !allSelected;
              }}
              onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((s) => s.id)))}
            />
            Select all
          </label>
          <span className="fleet-count">
            {checking
              ? `Checking that ${selectedServers.length === 1 ? 'the server' : `the ${selectedServers.length} servers`} can be reached…`
              : selectedServers.length === 0
                ? 'Tick servers to start, restart or stop everything on them at once.'
                : `${selectedServers.length} of ${list.length} server${list.length === 1 ? '' : 's'} selected`}
          </span>
          <span className="fleet-actions">
            <span className="with-info">
              <button className="primary" disabled={selectedServers.length === 0 || bulkBusy || !can('start_all')} title={can('start_all') ? undefined : NO_PERMISSION} onClick={() => runOnSelected('start')}>
                Start All
              </button>
              <InfoTip>
                On every selected server, starts each catalog service that isn't running, in the right order, each one
                waiting until the one before it works. The servers run side by side.
              </InfoTip>
            </span>
            <span className="with-info">
              <button className="outline" disabled={selectedServers.length === 0 || bulkBusy || !can('restart_all')} title={can('restart_all') ? undefined : NO_PERMISSION} onClick={() => runOnSelected('restart')}>
                Restart All
              </button>
              <InfoTip>On every selected server, stops and starts each catalog service again, even the ones that are working.</InfoTip>
            </span>
            <span className="with-info">
              <button className="danger" disabled={selectedServers.length === 0 || bulkBusy || !can('stop_all')} title={can('stop_all') ? undefined : NO_PERMISSION} onClick={() => runOnSelected('stop')}>
                Stop All
              </button>
              <InfoTip>On every selected server, stops each catalog service, one at a time, in a safe order.</InfoTip>
            </span>
          </span>
        </div>
      )}

      <div ref={runsRef} className="fleet-runs">
        {bulkErrors.length > 0 && (
          <div className="alert alert-bad" role="alert">
            <div>
              {bulkErrors.length === 1 ? "One server's run didn't start:" : `${bulkErrors.length} servers' runs didn't start:`}
              <ul className="fleet-errors">
                {bulkErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
            <button onClick={() => setBulkErrors([])}>Dismiss</button>
          </div>
        )}
        {runs.map((run) => (
          <JobProgressPanel
            key={run.jobId}
            jobId={run.jobId}
            serverName={run.serverName}
            allowPopup={askingJobId === null || askingJobId === run.jobId}
            onUpdate={(job) => {
              const next = { running: job.status === 'running', asking: Boolean(job.wantsPopup ?? job.awaiting) };
              const prev = runState[run.jobId];
              if (prev?.running === next.running && prev?.asking === next.asking) return;
              setRunState((all) => ({ ...all, [run.jobId]: next }));
              // a run finishing (or pausing) changes what's running: refresh the cards and the totals
              queryClient.invalidateQueries({ queryKey: ['servers'] });
            }}
            onClear={() => setRuns((prev) => prev.filter((r) => r.jobId !== run.jobId))}
          />
        ))}
      </div>

      <div className="group-grid">
        {list.map((server) => {
          const pct = server.summary.total > 0 ? Math.round((server.summary.running / server.summary.total) * 100) : 0;
          const isSelected = selected.has(server.id);
          return (
            <div
              key={server.id}
              className={`card group-card${isSelected ? ' group-card-selected' : ''}`}
              onClick={() => navigate(`/servers/${server.id}`)}
            >
              <div className="server-card-head">
                <label className="card-pick" onClick={(e) => e.stopPropagation()} title={`Select ${server.name}`}>
                  <input type="checkbox" checked={isSelected} onChange={() => toggle(server.id)} aria-label={`Select ${server.name}`} />
                </label>
                <h3>
                  <Link to={`/servers/${server.id}`} onClick={(e) => e.stopPropagation()}>
                    {server.name}
                  </Link>
                </h3>
                {busyServers.has(server.id) ? <span className="card-busy">Running…</span> : <Badge status={server.connection_status} />}
              </div>
              <p className="muted mono" style={{ margin: '2px 0 0' }}>
                {server.ssh_username}@{server.host}:{server.port}
              </p>
              <p className="muted" style={{ margin: '8px 0 0' }}>
                {server.summary.total === 0
                  ? 'Nothing from the catalog is installed'
                  : `${server.summary.running} of ${server.summary.total} running`}
              </p>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="chip-row">
                {server.software.map((s) => (
                  <Badge key={s.software_id} status={s.state === 'stopped' ? 'stopped' : s.status}>{s.name}</Badge>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <details className="guide-card" open={list.length === 0 && !isLoading}>
        <summary>How Healthcheck works</summary>
        <ol className="guide-steps">
          {GUIDE_STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="step-num">{i + 1}</span>
              <span className="step-body">
                <b>{step.title}</b>
                <span>{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </details>

      {unreachable && (
        <UnreachableDialog
          {...unreachable}
          onCancel={() => setUnreachable(null)}
          onContinue={() => {
            const { action, reachable } = unreachable;
            setUnreachable(null);
            void startRuns(action, reachable);
          }}
        />
      )}

      {showAdd && (
        <AddServerModal
          onClose={() => setShowAdd(false)}
          onAdded={(server) => {
            setShowAdd(false);
            const found = server.discovered.length
              ? `Connected. Found ${server.discovered.length} installed: ${server.discovered.join(', ')}.`
              : 'Connected. None of the catalog components were found installed on it yet.';
            navigate(`/servers/${server.id}`, { state: { notice: found } });
          }}
        />
      )}
    </div>
  );
}
