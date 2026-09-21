interface DonutProps {
  // 0-100, or null when there is nothing to measure yet
  percent: number | null;
  size?: number;
  stroke?: number;
}

// Share of components that are running: the red arc is the running part, the dark rest is everything else.
export default function DonutChart({ percent, size = 150, stroke = 20 }: DonutProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="donut" style={{ width: size, height: size }} role="img" aria-label={percent === null ? 'No data' : `${shown}% running`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--sidebar)" strokeWidth={stroke} />
        {shown > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--accent-deep)"
            strokeWidth={stroke}
            strokeDasharray={`${(c * shown) / 100} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="donut-text">{percent === null ? '—' : `${shown}%`}</span>
    </div>
  );
}
