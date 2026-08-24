/** Shared inline SVG icons for the editor UI. */
export const Icon = {
  grip: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="8" cy="6" r="1.4" />
      <circle cx="16" cy="6" r="1.4" />
      <circle cx="8" cy="12" r="1.4" />
      <circle cx="16" cy="12" r="1.4" />
      <circle cx="8" cy="18" r="1.4" />
      <circle cx="16" cy="18" r="1.4" />
    </svg>
  ),
  cube: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2z" />
      <path d="M4 6.5 12 11l8-4.5M12 11v11" />
    </svg>
  ),
  label: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 13.5 12.5 21a2 2 0 0 1-2.8 0L3 14.3V4a1 1 0 0 1 1-1h10.3l6.7 6.7a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  group: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
    </svg>
  ),
  eye: (size = 14, on = true) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" opacity={on ? 1 : 0.4}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
      {!on && <path d="m4 4 16 16" />}
    </svg>
  ),
  plus: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  trash: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" />
    </svg>
  ),
  duplicate: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  ),
  dup: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  ),
  lock: (size = 14, on = true) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" opacity={on ? 1 : 0.52}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      {on ? <path d="M8 11V8a4 4 0 0 1 8 0v3" /> : <path d="M16 11V8a4 4 0 0 0-7.6-1.7" />}
    </svg>
  ),
  text: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 5h14M12 5v14M8.5 19h7" />
    </svg>
  ),
  image: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m4 17 5-5 3.5 3 2.5-2 5 4" />
    </svg>
  ),
  shape: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="4" width="10" height="10" rx="1.5" />
      <circle cx="16" cy="16" r="5" />
    </svg>
  ),
  more: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  ),
  up: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m6 14 6-6 6 6" />
    </svg>
  ),
  down: (size = 14) => (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m6 10 6 6 6-6" />
    </svg>
  ),
}
