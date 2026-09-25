import { Loader2 } from 'lucide-react'

// Blue-family palettes: deep navy, cobalt, indigo, teal, slate, midnight, steel, ocean.
const PALETTES: [string, string][] = [
  ['#1b2a4e', '#0f172f'], ['#1f4fd1', '#15318a'], ['#3b3f9e', '#23255e'], ['#0f6e7a', '#0a4750'],
  ['#44546f', '#27324a'], ['#14213d', '#0a1224'], ['#2d6a9f', '#1a4368'], ['#1d5c8c', '#0f3858'],
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
