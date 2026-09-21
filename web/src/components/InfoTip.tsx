import { useRef, useState, type ReactNode } from 'react';

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
}

// A small (i) next to a button. Hover it (or focus / tap it) to read what the button does.
// The popover is positioned against the window, so it is never clipped by the panel it sits in.
export default function InfoTip({ children, label = 'What does this do?' }: { children: ReactNode; label?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  function show() {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(300, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    // open below the icon, or above it when there is no room underneath
    if (r.bottom > window.innerHeight - 190) setPlace({ left, width, bottom: window.innerHeight - r.top + 8 });
    else setPlace({ left, width, top: r.bottom + 8 });
  }
  const hide = () => setPlace(null);

  return (
    <span
      ref={anchor}
      className="info"
      tabIndex={0}
      role="button"
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => {
        e.stopPropagation();
        place ? hide() : show();
      }}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5.5" />
        <path d="M12 7.6h.01" />
      </svg>
      {place && (
        <span role="tooltip" className="info-pop" style={{ left: place.left, top: place.top, bottom: place.bottom, width: place.width }}>
          {children}
        </span>
      )}
    </span>
  );
}
