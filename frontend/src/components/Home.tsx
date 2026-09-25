import { useMemo, type ReactNode } from 'react'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'

const MOODS: [string, string][] = [
  ['Quiet & calm', 'Books to read when I need quiet and calm'],
  ['Dark & gripping', 'A dark, gripping novel I will not be able to put down'],
  ['Funny', 'A genuinely funny book'],
  ['Short reads', 'A short book I can finish in one afternoon'],
  ['Big ideas', 'Non-fiction that changed how people think'],
  ['Far-away places', 'Novels set in places I have never been'],
  ['Love stories', 'A love story with real depth'],
  ['Other worlds', 'Science fiction or fantasy with a world to get lost in'],
]

const DAY = Math.floor(Date.now() / 864e5) // shelf order changes daily

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'
}

interface Props {
  books: Book[]
  composer: ReactNode
  disabled: boolean
  onAsk: (text: string) => void
  onOpenBook: (book: Book) => void
  onRead: (book: Book) => void
  onBrowse: () => void
}

export function Home({ books, composer, disabled, onAsk, onOpenBook, onRead, onBrowse }: Props) {
  // A different handful every day, stable within the day.
  const shelf = useMemo(() => {
    const key = (b: Book) => (b.id.charCodeAt(0) * 31 + b.id.charCodeAt(1)) * DAY % 97
    return [...books].sort((a, b) => key(a) - key(b)).slice(0, 12)
  }, [books])
  const reading = useMemo(() => books.filter((b) => b.progress && b.text_chars > 0)
    .sort((a, b) => b.progress!.updated_at.localeCompare(a.progress!.updated_at)).slice(0, 4), [books])

  return (
    <div className="home">
      <h1>{greeting()}</h1>
      <p className="lede">What would you like to read next? Describe a mood, a theme, or a book you loved.</p>
      {composer}
      <div className="moods" role="group" aria-label="Browse by mood">
        {MOODS.map(([label, query]) => (
          <button key={label} className="mood" onClick={() => onAsk(query)} disabled={disabled}>{label}</button>
        ))}
      </div>

      {reading.length > 0 && (
        <section className="continue" aria-label="Continue reading">
          <h2>Continue reading</h2>
          <div className="continue-row">
            {reading.map((b) => {
              const p = b.progress!
              return (
                <button key={b.id} className="continue-card" onClick={() => onRead(b)} data-testid="continue-card">
                  <BookCover title={b.title} author={b.author} url={b.cover_url} size="sm" />
                  <span>
                    <b>{b.title}</b>
                    <small>Page {p.page}{p.pages ? ` of ${p.pages}` : ''} · {Math.round(p.percent)}%</small>
                    <span className="progress-line"><i style={{ width: `${p.percent}%` }} /></span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {shelf.length > 0 && (
        <section className="shelf" aria-label="From your shelves">
          <div className="shelf-head">
            <h2>From your shelves</h2>
            <button className="link" onClick={onBrowse}>See all {books.length}</button>
          </div>
          <div className="shelf-row">
            {shelf.map((b) => (
              <button key={b.id} className="shelf-book" onClick={() => onOpenBook(b)} title={`${b.title} — ${b.author}`}>
                <BookCover title={b.title} author={b.author} url={b.cover_url} size="sm" />
                <p>{b.title}</p>
                <small>{b.author}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
