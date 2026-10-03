interface DonutProps {
  // 0-100, or null when there is nothing to measure yet
  percent: number | null;
  size?: number;
  stroke?: number;
}

// Share of components that are running: the gradient arc is the running part, the soft pink track the rest.
export default function DonutChart({ percent, size = 150, stroke = 20 }: DonutProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const gradientId = 'donutGradient';
  return (
    <div className="donut" style={{ width: size, height: size }} role="img" aria-label={percent === null ? 'No data' : `${shown}% running`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f2414a" />
            <stop offset="55%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-deep)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--donut-track)" strokeWidth={stroke} />
        {shown > 0 && (
          <circle
            className="donut-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(c * shown) / 100} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="donut-text">{percent === null ? '—' : `${shown}%`}</span>
    </div>
  );
}
