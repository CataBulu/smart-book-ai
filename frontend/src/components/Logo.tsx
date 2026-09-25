/** Smart Book AI mark: an open blue book with a small spark. Same drawing as public/favicon.svg. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="sb-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#sb-g)" />
      <path d="M12 20c7-2.5 13-1.5 19 2.5v25c-6-4-12-5-19-2.5z" fill="#fff" />
      <path d="M52 20c-7-2.5-13-1.5-19 2.5v25c6-4 12-5 19-2.5z" fill="#dbeafe" />
      <path d="M16 26c4-1 7-.6 11 1.4M16 31c4-1 7-.6 11 1.4M16 36c4-1 7-.6 11 1.4" stroke="#93c5fd" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M46 7l1.6 4.4L52 13l-4.4 1.6L46 19l-1.6-4.4L40 13l4.4-1.6z" fill="#fde68a" />
    </svg>
  )
}
