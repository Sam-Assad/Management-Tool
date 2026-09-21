interface LoadStateProps {
  error: unknown;
  onRetry: () => void;
}

export default function LoadState({ error, onRetry }: LoadStateProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <p style={{ margin: '0 0 10px', color: 'var(--bad)' }}>Couldn't load this: {message}</p>
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}
