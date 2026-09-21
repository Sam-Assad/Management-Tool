import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';

interface LogViewerProps {
  serverId: number;
  softwareId: number;
  title?: string;
  subtitle?: string;
  onClose: () => void;
}

function levelOf(line: string): '' | 'lvl-error' | 'lvl-warn' {
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(line)) return 'lvl-error';
  if (/\b(WARN|WARNING)\b/.test(line)) return 'lvl-warn';
  return '';
}

function highlight(line: string, needle: string) {
  if (!needle) return line;
  const idx = line.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return line;
  return (
    <>
      {line.slice(0, idx)}
      <mark>{line.slice(idx, idx + needle.length)}</mark>
      {line.slice(idx + needle.length)}
    </>
  );
}

export default function LogViewer({ serverId, softwareId, title, subtitle, onClose }: LogViewerProps) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [lines, setLines] = useState(500);
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState(false);
  const viewRef = useRef<HTMLPreElement>(null);

  async function load(showSpinner = true) {
    if (showSpinner) setStatus('loading');
    try {
      const res = await api.get<string>(`/servers/${serverId}/software/${softwareId}/logs?lines=${lines}`);
      setText(res);
      setStatus('ready');
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setStatus('error');
    }
  }

  useEffect(() => {
    load();
  }, [lines]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => load(false), 4000);
    return () => clearInterval(timer);
  }, [autoRefresh, lines]);

  const allLines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n') : []), [text]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const numbered = allLines.map((line, i) => ({ line, no: i + 1 }));
    return needle ? numbered.filter((l) => l.line.toLowerCase().includes(needle)) : numbered;
  }, [allLines, filter]);

  // Logs are read from the bottom: jump to the newest lines after each load.
  useEffect(() => {
    if (follow && viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [shown, follow]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(shown.map((l) => l.line).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard can be unavailable on plain http - the text is still selectable
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span>{title ? `Logs - ${title}` : 'Logs'}</span>
            {subtitle && <span className="modal-sub">{subtitle}</span>}
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="log-toolbar">
          <label>
            Last
            <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              {[100, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>{n} lines</option>
              ))}
            </select>
          </label>
          <label>
            <input type="text" placeholder="Filter lines..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <label><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap</label>
          <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Jump to latest</label>
          <label><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto-refresh</label>
          <span className="spacer" />
          <span className="log-stats">
            {status === 'ready' ? `${shown.length}${filter ? ` of ${allLines.length}` : ''} lines` : ''}
          </span>
          <button onClick={copyAll} disabled={shown.length === 0}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="primary" onClick={() => load()}>Refresh</button>
        </div>

        <pre className="log-view log-large" ref={viewRef}>
          {status === 'loading' && allLines.length === 0 && <div className="log-line">Loading…</div>}
          {status === 'error' && <div className="log-line lvl-error">{error}</div>}
          {status === 'ready' && shown.length === 0 && (
            <div className="log-line">{allLines.length === 0 ? '(log is empty)' : 'No lines match the filter.'}</div>
          )}
          {shown.map((l) => (
            <div key={l.no} className={`log-line ${levelOf(l.line)}${wrap ? ' wrap' : ''}`}>
              <span className="log-no">{l.no}</span>
              <span>{highlight(l.line, filter.trim())}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
