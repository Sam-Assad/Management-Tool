import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServerList } from '../api/hooks';
import Badge from '../components/Badge';
import LoadState from '../components/LoadState';
import AddServerModal from '../components/AddServerModal';

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

export default function ServersDashboard() {
  const { data: servers, isLoading, isError, error, refetch } = useServerList();
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

  return (
    <div>
      <div className="section-label">
        <span className="dot" />
        <span className="label-text">Fleet overview</span>
      </div>
      <h1>Your <span className="gradient-text">servers</span></h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Each server is checked and controlled on its own — open one to start, restart or stop what runs on it.
      </p>

      <div className="guide-card">
        <h3 style={{ margin: 0 }}>How Healthcheck works</h3>
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
      </div>

      <div className="button-row" style={{ marginTop: 0 }}>
        <button className="primary" onClick={() => setShowAdd(true)}>+ Add server</button>
      </div>

      {isLoading && <p>Loading...</p>}
      {isError && <LoadState error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && servers?.length === 0 && (
        <p className="muted">No servers yet — add your first one above to get started.</p>
      )}

      <div className="group-grid">
        {servers?.map((server) => (
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
            <div className="chip-row">
              {server.software.map((s) => (
                <Badge key={s.software_id} status={s.status}>{s.name}</Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>

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
