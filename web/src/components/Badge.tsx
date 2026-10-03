interface BadgeProps {
  status: string;
  children?: React.ReactNode;
}

const COLORS: Record<string, string> = {
  up: 'ok',
  ok: 'ok',
  down: 'bad',
  stopped: 'pending',
  unreachable: 'bad',
  auth_failed: 'bad',
  partial: 'warn',
  unknown: 'pending',
};

export default function Badge({ status, children }: BadgeProps) {
  const cls = COLORS[status] ?? 'pending';
  return <span className={`chip chip-${cls}`}>{children ?? status}</span>;
}
