import type { ReactNode } from 'react';

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconServer = () => (
  <Icon>
    <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
    <path d="M7 7.25h.01M7 16.75h.01" />
    <path d="M11 7.25h6M11 16.75h6" />
  </Icon>
);

export const IconGroups = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
  </Icon>
);

export const IconCatalog = () => (
  <Icon>
    <path d="M21 8.2 12 3.5 3 8.2v7.6l9 4.7 9-4.7V8.2Z" />
    <path d="M3.3 8.4 12 13l8.7-4.6" />
    <path d="M12 13v7.4" />
  </Icon>
);

export const IconConditions = () => (
  <Icon>
    <circle cx="6" cy="5.5" r="2.3" />
    <circle cx="6" cy="18.5" r="2.3" />
    <circle cx="18" cy="12" r="2.3" />
    <path d="M6 7.8v8.4" />
    <path d="M6 12h6.5c1 0 1.7.3 2.3.9l.9.9" />
  </Icon>
);

export const IconChevronLeft = () => (
  <Icon size={16}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
);

export const IconChevronRight = () => (
  <Icon size={16}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const IconSearch = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const IconPlus = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
