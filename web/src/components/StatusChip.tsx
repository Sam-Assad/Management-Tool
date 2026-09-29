// How a component's state reads in the UI. `state` comes from the heartbeat/scan
// (running, stopped, failed, credential_expired, starting, stopping, not_installed, unreachable) or is
// 'mixed' (servers in the group disagree) / 'unknown' (not checked yet).
const STATE_INFO: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' | 'pending' }> = {
  running: { label: 'Running', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  credential_expired: { label: 'Failed (due to expired password)', tone: 'bad' },
  unreachable: { label: 'Unreachable', tone: 'bad' },
  starting: { label: 'Starting', tone: 'warn' },
  stopping: { label: 'Stopping', tone: 'warn' },
  mixed: { label: 'Mixed', tone: 'warn' },
  not_installed: { label: 'Not installed', tone: 'pending' },
  unknown: { label: 'Not checked yet', tone: 'pending' },
};

export default function StatusChip({ state, title }: { state: string; title?: string }) {
  const info = STATE_INFO[state] ?? STATE_INFO.unknown;
  return (
    <span className={`chip chip-${info.tone}`} title={title}>
      {info.label}
    </span>
  );
}
