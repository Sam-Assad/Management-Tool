import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useRecentJobs, useServerList } from '../api/hooks';
import Badge from '../components/Badge';
import LoadState from '../components/LoadState';
import AddServerModal from '../components/AddServerModal';
import DonutChart from '../components/DonutChart';
import { KIND_LABEL } from '../components/JobProgressPanel';
import { IconPlus, IconServer } from '../components/Icons';

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

function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

export default function ServersDashboard() {
  const { data: servers, isLoading, isError, error, refetch } = useServerList();
  const { data: jobs } = useRecentJobs(7);
  const [params, setParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

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
  const problems = components.filter((c) => ['failed', 'unreachable', 'unknown'].includes(c.state)).length;
  const percent = components.length > 0 ? Math.round((running / components.length) * 100) : null;
  const serverOfGroup = new Map(list.map((s) => [s.group_id, s]));

  return (
    <div>
      <h1 className="page-title">Fleet overview</h1>

      <div className="dash-grid">
        <div className="dash-card dash-dark">
          <div className="dash-icon">
            <IconServer />
          </div>
          <h2>Welcome back</h2>
          <p>
            {list.length === 0
              ? 'Add your first server to start, restart and stop the Loyalty platform in the right order.'
              : `${list.length} server${list.length === 1 ? '' : 's'} and ${components.length} components under control. Start, restart and stop them in the right order.`}
          </p>
          <button className="primary" onClick={() => setShowAdd(true)}>
            <IconPlus size={14} /> Add server
          </button>
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
            <div className="metric">
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
        <button className="primary" onClick={() => setShowAdd(true)}>
          <IconPlus size={14} /> Add server
        </button>
      </div>

      {isLoading && <p>Loading...</p>}
      {isError && <LoadState error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && list.length === 0 && (
        <p className="muted">No servers yet — add your first one to get started.</p>
      )}

      <div className="group-grid">
        {list.map((server) => {
          const pct = server.summary.total > 0 ? Math.round((server.summary.running / server.summary.total) * 100) : 0;
          return (
            <Link to={`/servers/${server.id}`} key={server.id} className="card group-card">
              <div className="server-card-head">
                <h3>{server.name}</h3>
                <Badge status={server.connection_status} />
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
                  <Badge key={s.software_id} status={s.status}>{s.name}</Badge>
                ))}
              </div>
            </Link>
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
