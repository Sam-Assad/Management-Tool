import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import InfoTip from './InfoTip';

interface Step {
  id: number;
  server_id: number;
  software_id: number;
  server_name?: string | null;
  software_name?: string | null;
  action: string;
  status: string;
  log_excerpt: string | null;
  // running, and the log has not shown its success line for a while: the operator may vouch for it
  acceptable?: boolean;
}

interface Awaiting {
  component: string;
  server: string;
  verb: string;
  summary: string;
  detail: string;
  holdsBack: string[];
  // what "Roll back" would stop (start / restart runs only)
  rollback?: string[];
  // set when something else holds a port the component needs
  portFix?: { label: string; detail: string };
  // set when this was an expired password/credential: retrying can't help, so only Continue / Roll back show
  limited?: boolean;
  expires_at: string;
}

interface Job {
  id: number;
  awaiting?: Awaiting | null;
  kind: string;
  status: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  steps: Step[];
}

interface JobProgressPanelProps {
  jobId: number;
  // called whenever the job's state was re-read, so the page can refresh what depends on it
  onUpdate?: (job: { status: string }) => void;
  // shows a Clear button that dismisses the panel
  onClear?: () => void;
}

export const KIND_LABEL: Record<string, string> = {
  start_all: 'Start All',
  start_one: 'Start',
  restart_all: 'Restart All',
  restart_one: 'Restart',
  stop_all: 'Stop All',
  stop_one: 'Stop',
  scan: 'Check status',
};

const STEP_LABEL: Record<string, string> = {
  pending: 'waiting',
  running: 'running',
  healthy: 'ok',
  failed: 'failed',
  skipped: 'skipped',
  blocked: 'not started',
};

function firstLine(text: string | null): string {
  return (text ?? '').split('\n').find((l) => l.trim()) ?? '';
}

function stateLabel(step: Step, isScan: boolean): string {
  if (isScan && step.status === 'failed') return 'not running';
  if (step.status === 'healthy' && (step.action === 'stop' || step.action === 'rollback')) return 'stopped';
  if (step.status === 'healthy' && step.action === 'free_port') return 'freed';
  return STEP_LABEL[step.status] ?? step.status;
}

// a live log shows its newest lines: keep it scrolled to the bottom as it grows
function stickToBottom(el: HTMLPreElement | null) {
  if (el) el.scrollTop = el.scrollHeight;
}

function duration(job: Job): string {
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - new Date(job.started_at).getTime()) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function JobProgressPanel({ jobId, onUpdate, onClear }: JobProgressPanelProps) {
  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const previousStatus = useRef<string | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // Read the job straight from the server (instead of relying on a live event stream that can
  // connect after a quick job has already finished): every 1.5 s while it runs, once when done.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    previousStatus.current = null;
    setJob(null);
    setCollapsed(false);
    setLoadError(null);

    async function poll() {
      try {
        const next = await api.get<Job>(`/jobs/${jobId}`);
        if (cancelled) return;
        setJob(next);
        setLoadError(null);
        onUpdateRef.current?.(next);
        // A run that ended with nothing wrong folds itself down to one summary line.
        const wasRunning = previousStatus.current === 'running';
        previousStatus.current = next.status;
        if (wasRunning && next.status !== 'running' && !next.steps.some((s) => s.status === 'failed')) {
          setCollapsed(true);
        }
        if (next.status === 'running') timer = setTimeout(poll, 1500);
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err?.message ?? String(err));
        timer = setTimeout(poll, 3000);
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (!job?.awaiting) {
      setDeciding(false);
      setDecisionError(null);
    }
  }, [job?.awaiting]);

  async function decide(choice: 'retry' | 'skip' | 'halt' | 'rollback' | 'free_port') {
    setDeciding(true);
    setDecisionError(null);
    try {
      await api.post(`/jobs/${jobId}/decision`, { choice });
      // Don't rely solely on the `!job.awaiting` effect below to re-enable the buttons: several
      // components can fail before this one is even answered, so the next poll can show a brand new
      // question immediately (awaiting never goes through a falsy tick in between) - that left THAT
      // question's buttons stuck disabled forever, looking like they were simply unclickable.
      setDeciding(false);
    } catch (err: any) {
      setDecisionError(err?.message ?? String(err));
      setDeciding(false);
    }
  }

  async function markStarted(stepId: number) {
    setDecisionError(null);
    try {
      await api.post(`/jobs/${jobId}/steps/${stepId}/accept`);
    } catch (err: any) {
      setDecisionError(err?.message ?? String(err));
    }
  }

  if (!job) {
    return <div className="jp"><div className="jp-bar">{loadError ? `Couldn't load job #${jobId}: ${loadError}` : 'Loading job…'}</div></div>;
  }

  const isScan = job.kind === 'scan';
  const counts = {
    ok: job.steps.filter((s) => s.status === 'healthy').length,
    failed: job.steps.filter((s) => s.status === 'failed').length,
    skipped: job.steps.filter((s) => s.status === 'skipped').length,
    blocked: job.steps.filter((s) => s.status === 'blocked').length,
    running: job.steps.filter((s) => s.status === 'running').length,
    waiting: job.steps.filter((s) => s.status === 'pending').length,
  };
  const rolledBack = job.steps.some((s) => s.action === 'rollback');
  const problems = counts.failed + counts.blocked;
  // A status check succeeds even when components are down - it's a report, not an operation.
  const outcome =
    job.status === 'running' && job.awaiting
      ? 'waiting'
      : job.status === 'running'
        ? 'running'
        : rolledBack
          ? 'rolledback'
          : job.status === 'failed'
            ? 'failed'
            : problems > 0 && isScan
              ? 'attention'
              : 'ok';
  const headline = {
    waiting: 'Waiting for your decision',
    running: 'Running…',
    rolledback: 'Rolled back',
    failed: 'Failed',
    attention: 'Done - some components are not running',
    ok: isScan ? 'Done - all running' : 'Done',
  }[outcome];

  const rows = onlyProblems ? job.steps.filter((s) => s.status === 'failed' || s.status === 'blocked') : job.steps;

  return (
    <div className={`jp jp-${outcome}`}>
      <div className="jp-bar">
        <span className={`jp-badge jp-badge-${outcome}`}>
          {outcome === 'running' && <span className="jp-spinner" />}
          {headline}
        </span>
        <span className="jp-title">
          <b>{KIND_LABEL[job.kind] ?? job.kind}</b>
          <span className="muted"> · job #{job.id} · {duration(job)}</span>
        </span>
        <span className="jp-counts">
          {counts.ok > 0 && <span className="jp-count jp-count-ok">{counts.ok} {isScan ? 'running' : 'ok'}</span>}
          {counts.failed > 0 && <span className="jp-count jp-count-bad">{counts.failed} {isScan ? 'not running' : 'failed'}</span>}
          {counts.blocked > 0 && <span className="jp-count jp-count-warn">{counts.blocked} not started</span>}
          {counts.skipped > 0 && <span className="jp-count">{counts.skipped} skipped</span>}
          {counts.running > 0 && <span className="jp-count jp-count-live">{counts.running} running</span>}
          {counts.waiting > 0 && <span className="jp-count">{counts.waiting} waiting</span>}
        </span>
        <span className="jp-actions">
          {problems > 0 && !collapsed && (
            <label className="jp-toggle">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only problems
            </label>
          )}
          <button onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show details' : 'Hide details'}</button>
          {onClear && <button onClick={onClear} title="Dismiss this result">Clear</button>}
        </span>
      </div>

      {job.awaiting && (
        <div className="jp-decision">
          <div className="jp-decision-title">{job.awaiting.summary}</div>
          {job.awaiting.detail && <pre className="step-log">{job.awaiting.detail}</pre>}
          {job.awaiting.limited && (
            <div className="jp-decision-hint jp-decision-urgent">
              This looks like an expired password or credential, so retrying was skipped - it would only fail the same way
              again. Fix it on the server, then Continue past it or Roll back. If other components hit the same expired
              credential later in this run, choosing Continue here carries them past too, without asking again.
            </div>
          )}
          <div className="jp-decision-hint">
            The run is paused.{' '}
            {job.awaiting.holdsBack.length > 0
              ? `${job.awaiting.verb === 'stop' ? 'Leaving' : 'Skipping'} it also holds back: ${job.awaiting.holdsBack.join(', ')}.`
              : 'Nothing else depends on it, so the rest can carry on without it.'}
          </div>
          <div className="jp-decision-actions">
            {job.awaiting.portFix && (
              <span className="with-info">
                <button className="primary" disabled={deciding} onClick={() => decide('free_port')}>
                  {job.awaiting.portFix.label}
                </button>
                <InfoTip>{job.awaiting.portFix.detail}</InfoTip>
              </span>
            )}
            {!job.awaiting.limited && (
              <span className="with-info">
                <button className={job.awaiting.portFix ? '' : 'primary'} disabled={deciding} onClick={() => decide('retry')}>
                  Retry
                </button>
                <InfoTip>Tries {job.awaiting.component} again - for example after you have fixed the cause.</InfoTip>
              </span>
            )}
            <span className="with-info">
              <button className={job.awaiting.limited ? 'primary' : ''} disabled={deciding} onClick={() => decide('skip')}>
                {job.awaiting.limited
                  ? `Continue without ${job.awaiting.component}`
                  : job.awaiting.verb === 'stop'
                    ? `Leave ${job.awaiting.component} running and continue`
                    : `Skip ${job.awaiting.component} and continue`}
              </button>
              <InfoTip>
                Gives up on {job.awaiting.component} and carries on with the rest. Only components that depend on it through
                a condition are held back.
              </InfoTip>
            </span>
            {!job.awaiting.limited && (
              <span className="with-info">
                <button className="danger" disabled={deciding} onClick={() => decide('halt')}>
                  Stop the run here
                </button>
                <InfoTip>
                  Ends the run now and starts nothing further, so you can look into the problem. Whatever is already running
                  is left running. If nobody answers within 30 minutes, the run stops by itself.
                </InfoTip>
              </span>
            )}
            {job.awaiting.rollback && (
              <span className="with-info">
                <button className="danger" disabled={deciding} onClick={() => decide('rollback')}>
                  Roll back
                </button>
                <InfoTip>
                  Undoes this run: stops what it has started so far, in the stop order (like Stop All, but only these), and
                  ends the run. Components that were already running when it began are not touched.
                  {job.awaiting.rollback.length > 0 && (
                    <>
                      <br />
                      <b>Would stop:</b> {job.awaiting.rollback.join(', ')}.
                    </>
                  )}
                </InfoTip>
              </span>
            )}
          </div>
          {decisionError && <div className="jp-error">{decisionError}</div>}
        </div>
      )}

      {job.error_message && job.status === 'failed' && <div className="jp-error">{job.error_message}</div>}

      {!collapsed && (
        <div className="jp-body">
          {rows.length === 0 && <div className="jp-empty">{onlyProblems ? 'No problems.' : 'No steps yet…'}</div>}
          {rows.map((step) => {
            const failed = step.status === 'failed';
            return (
              <div key={step.id} className={`jp-row jp-row-${step.status}`}>
                <div className="jp-line">
                  <span className="jp-dot" />
                  <b className="jp-name">{step.software_name ?? `software ${step.software_id}`}</b>
                  <span className="muted jp-where">{step.server_name ?? `server ${step.server_id}`} · {step.action.replace('_', ' ')}</span>
                  {!failed && step.status !== 'blocked' && step.status !== 'running' && step.log_excerpt && (
                    <span className="jp-msg">{firstLine(step.log_excerpt)}</span>
                  )}
                  {step.acceptable && (
                    <span className="with-info">
                      <button className="jp-mark" onClick={() => markStarted(step.id)}>
                        Mark as started
                      </button>
                      <InfoTip>
                        The service is running, but its log has not printed the success line yet. If you can see it is up,
                        click this and the run carries on as if it had become healthy (anything waiting for it starts).
                      </InfoTip>
                    </span>
                  )}
                  <span className="jp-state">{stateLabel(step, isScan)}</span>
                </div>
                {failed && step.log_excerpt && !isScan && <pre className="step-log">{step.log_excerpt}</pre>}
                {step.status === 'running' && step.log_excerpt && (
                  <pre className="step-log step-log-live" ref={stickToBottom}>
                    {step.log_excerpt}
                  </pre>
                )}
                {step.status === 'blocked' && step.log_excerpt && <div className="jp-note">{step.log_excerpt}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
