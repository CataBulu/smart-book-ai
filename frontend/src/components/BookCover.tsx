import { Loader2 } from 'lucide-react'

// Cyanotype palettes: sun-print, Prussian, indigo, teal, slate, midnight, steel, ocean.
const PALETTES: [string, string][] = [
  ['#1d4f8f', '#12325e'], ['#13345f', '#0a1f3d'], ['#24457e', '#15294f'], ['#175a74', '#0d384b'],
  ['#3a5577', '#223550'], ['#0f2a4d', '#081729'], ['#2c6aa0', '#18426b'], ['#1f5f8b', '#113d5c'],
]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

interface Props {
  title: string
  author: string
  url?: string | null
  size?: 'sm' | 'md' | 'lg'
  painting?: boolean
}

/** A generated painting when the book has one, otherwise a deterministic typeset cover. */
export function BookCover({ title, author, url, size = 'md', painting }: Props) {
  const [c1, c2] = PALETTES[hash(title) % PALETTES.length]
  const base = { sm: 11, md: 15, lg: 22 }[size]
  const fs = title.length > 34 ? base * 0.78 : title.length > 18 ? base * 0.9 : base
  const overlay = painting && (
    <div className="painting"><Loader2 size={18} className="spin" /> Painting a cover…<br />about 20 s</div>
  )
  if (url) {
    return (
      <div className="cover">
        <img src={url} alt={`Cover of ${title}`} loading="lazy" />
        {overlay}
      </div>
    )
  }
  return (
    <div className="cover typeset" role="img" aria-label={`Cover of ${title} by ${author}`}
         style={{ ['--c1' as string]: c1, ['--c2' as string]: c2, ['--fs' as string]: `${fs}px`,
                  ['--fa' as string]: `${Math.max(7, base * 0.58)}px` }}>
      <div className="frame" />
      <div className="t">{title}</div>
      <div className="rule" />
      <div className="au">{author}</div>
      {overlay}
    </div>
  )
}
