/** Minimal inline icon set (no icon-library dependency). */
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const IconDashboard = () => (
  <svg {...base} aria-hidden="true">
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </svg>
);
export const IconInvoice = () => (
  <svg {...base} aria-hidden="true">
    <path d="M6 2h9l5 5v15H6z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
  </svg>
);
export const IconUsers = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />
  </svg>
);
export const IconBox = () => (
  <svg {...base} aria-hidden="true">
    <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5M12 13v8" />
  </svg>
);
export const IconSearch = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
export const IconMenu = () => (
  <svg {...base} aria-hidden="true">
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);
export const IconPlus = () => (
  <svg {...base} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconWallet = () => (
  <svg {...base} aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h13v4" />
    <path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z" />
    <circle cx="16" cy="14.5" r="1.2" />
  </svg>
);
export const IconChart = () => (
  <svg {...base} aria-hidden="true">
    <path d="M3 3v18h18" />
    <path d="M7 15v3M12 10v8M17 6v12" />
  </svg>
);
export const IconCreditNote = () => (
  <svg {...base} aria-hidden="true">
    <path d="M6 2h9l5 5v15H6z" />
    <path d="M14 2v6h6M9 15h6" />
  </svg>
);
