import { useState } from 'react';
import { createPortal } from 'react-dom';
import InfoTip from './InfoTip';

export interface Awaiting {
  component: string;
  server: string;
  verb: string;
  summary: string;
  detail: string;
  holdsBack: string[];
  rollback?: string[];
  portFix?: { label: string; detail: string };
  limited?: boolean;
  // set when WildFly started but some of its datasources failed a connection test
  datasources?: string[];
  cause?: string;
  expires_at: string;
}

export type Choice = 'retry' | 'skip' | 'halt' | 'rollback' | 'free_port';

type Tone = 'error' | 'warning';

function look(a: Awaiting): { tone: Tone; title: string } {
  if (a.datasources?.length) return { tone: 'error', title: 'Database connection problem' };
  if (a.limited) return { tone: 'warning', title: 'Password expired' };
  if (a.portFix) return { tone: 'warning', title: 'Port already in use' };
  return { tone: 'error', title: `${a.component} ${a.verb === 'stop' ? "didn't stop" : "didn't start"}` };
}

function ToneIcon({ tone }: { tone: Tone }) {
  return (
    <span className={`dm-icon dm-icon-${tone}`} aria-hidden="true">
      {tone === 'error' ? (
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      ) : (
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M12 6v8" />
          <circle cx="12" cy="18.5" r="0.6" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

// The question a paused run asks the operator, as a centered card on top of the page.
export default function DecisionModal({
  awaiting: a,
  deciding,
  error,
  onDecide,
  onMinimize,
}: {
  awaiting: Awaiting;
  deciding: boolean;
  error: string | null;
  onDecide: (choice: Choice) => void;
  onMinimize: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const { tone, title } = look(a);
  const holdsBackText =
    a.holdsBack.length > 0
      ? `${a.verb === 'stop' ? 'Leaving' : 'Skipping'} it also holds back: ${a.holdsBack.join(', ')}.`
      : 'Nothing else depends on it, so the rest can carry on without it.';

  return createPortal(
    <div className="modal-overlay">
      <div className={`dm-card dm-${tone}`} role="alertdialog" aria-labelledby="dm-title">
        <ToneIcon tone={tone} />
        <h2 id="dm-title" className="dm-title">{title}</h2>
        <p className="dm-message">{a.summary}</p>

        {a.datasources && a.datasources.length > 0 && (
          <div className="dm-ds">
            <div className="dm-ds-label">
              {a.datasources.length === 1 ? 'Failed datasource' : `${a.datasources.length} failed datasources`}
            </div>
            <div className="dm-ds-list">
              {a.datasources.map((name) => (
                <span key={name} className="dm-ds-chip">{name}</span>
              ))}
            </div>
          </div>
        )}

        <p className="dm-hint">The run is paused. {holdsBackText}</p>

        {a.detail && (
          <div className="dm-detail">
            <button className="dm-link" onClick={() => setShowDetail(!showDetail)}>
              {showDetail ? 'Hide technical details' : 'Show technical details'}
            </button>
            {showDetail && <pre className="step-log">{a.detail}</pre>}
          </div>
        )}

        <div className="dm-actions">
          {a.portFix && (
            <span className="with-info">
              <button className="dm-btn dm-btn-main" disabled={deciding} onClick={() => onDecide('free_port')}>
                {a.portFix.label}
              </button>
              <InfoTip>{a.portFix.detail}</InfoTip>
            </span>
          )}
          {!a.limited && (
            <span className="with-info">
              <button className={`dm-btn ${a.portFix ? '' : 'dm-btn-main'}`} disabled={deciding} onClick={() => onDecide('retry')}>
                Try again
              </button>
              <InfoTip>Tries {a.component} again - for example after you have fixed the cause.</InfoTip>
            </span>
          )}
          <span className="with-info">
            <button className={`dm-btn ${a.limited ? 'dm-btn-main' : ''}`} disabled={deciding} onClick={() => onDecide('skip')}>
              {a.verb === 'stop' ? `Leave ${a.component} running` : `Continue without ${a.component}`}
            </button>
            <InfoTip>
              Gives up on {a.component} and carries on with the rest. Only components that depend on it through a
              condition are held back.
            </InfoTip>
          </span>
          {a.rollback && (
            <span className="with-info">
              <button className="dm-btn dm-btn-danger" disabled={deciding} onClick={() => onDecide('rollback')}>
                Roll back
              </button>
              <InfoTip>
                Stops what this run has started so far, in the stop order, and ends the run. Components that were already
                running when it began are not touched.
                {a.rollback.length > 0 && (
                  <>
                    <br />
                    <b>Would stop:</b> {a.rollback.join(', ')}.
                  </>
                )}
              </InfoTip>
            </span>
          )}
          {!a.limited && (
            <span className="with-info">
              <button className="dm-btn dm-btn-danger" disabled={deciding} onClick={() => onDecide('halt')}>
                Stop the run
              </button>
              <InfoTip>
                Ends the run now and starts nothing further. Whatever is already running is left running. If nobody
                answers within 30 minutes, the run stops by itself.
              </InfoTip>
            </span>
          )}
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="dm-link dm-later" onClick={onMinimize}>
          Look at the run first
        </button>
      </div>
    </div>,
    document.body
  );
}
