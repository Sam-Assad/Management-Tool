import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerList } from '../api/hooks';
import { IconSearch } from './Icons';

// The white bar across the top: jump straight to a server by typing its name, and see at a glance
// how much of the fleet is running.
export default function TopBar() {
  const { data: servers } = useServerList();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function away(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = (servers ?? [])
    .filter((s) => q && `${s.name} ${s.host}`.toLowerCase().includes(q))
    .slice(0, 6);

  const total = (servers ?? []).reduce((n, s) => n + s.summary.total, 0);
  const running = (servers ?? []).reduce((n, s) => n + s.summary.running, 0);
  const tone = total === 0 ? 'pending' : running === total ? 'ok' : running === 0 ? 'bad' : 'warn';

  function go(id: number) {
    setQuery('');
    setOpen(false);
    navigate(`/servers/${id}`);
  }

  return (
    <div className="topbar">
      <div className="search" ref={box}>
        <IconSearch size={16} />
        <input
          value={query}
          placeholder="Find a server…"
          aria-label="Find a server"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) go(matches[0].id);
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        {open && q && (
          <div className="search-pop">
            {matches.length === 0 && <div className="search-empty">No server matches “{query}”.</div>}
            {matches.map((s) => (
              <button key={s.id} onClick={() => go(s.id)}>
                <b>{s.name}</b>
                <span className="mono">{s.host}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`fleet-pill fleet-${tone}`} title="Components running across all servers">
        <span className="dot" />
        {total === 0 ? 'No servers yet' : `${running} of ${total} running`}
      </div>
    </div>
  );
}
