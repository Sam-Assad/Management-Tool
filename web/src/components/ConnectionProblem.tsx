import { useState } from 'react';

// Why connecting to a server failed, as the server explains it (server/src/ssh/explain.ts): what happened, why it
// usually happens, what to check, and the technical message for whoever digs further.
export interface ConnectionProblemInfo {
  kind: string;
  title: string;
  why: string;
  fix: string;
  technical: string;
}

// The `problem` a failed request carries, if any (Add server answers with one).
export function problemOf(err: unknown): ConnectionProblemInfo | null {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const p = JSON.parse(raw).problem;
    return p && typeof p.title === 'string' ? p : null;
  } catch {
    return null;
  }
}

export default function ConnectionProblem({ problem, compact = false }: { problem: ConnectionProblemInfo; compact?: boolean }) {
  const [showTech, setShowTech] = useState(false);
  return (
    <div className={`cp-box${compact ? ' cp-compact' : ''}`} role="alert">
      <b className="cp-title">{problem.title}</b>
      <p className="cp-why">{problem.why}</p>
      <p className="cp-fix">
        <span className="cp-label">What to check:</span> {problem.fix}
      </p>
      {problem.technical && (
        <>
          <button type="button" className="dm-link cp-tech-toggle" onClick={() => setShowTech(!showTech)}>
            {showTech ? 'Hide the technical detail' : 'Show the technical detail'}
          </button>
          {showTech && <code className="cp-tech">{problem.technical}</code>}
        </>
      )}
    </div>
  );
}
