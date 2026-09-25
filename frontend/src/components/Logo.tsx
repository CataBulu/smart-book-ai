/** Smart Book mark: a plain open book on a blue tile. Same drawing as public/favicon.svg. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#1f4fd1" />
      <path d="M6 10.5c3.6-1.3 6.7-.8 9.3 1.2v11.6c-2.6-1.9-5.7-2.4-9.3-1.2z" fill="#fff" />
      <path d="M26 10.5c-3.6-1.3-6.7-.8-9.3 1.2v11.6c2.6-1.9 5.7-2.4 9.3-1.2z" fill="#c9d7ff" />
    </svg>
  )
}
