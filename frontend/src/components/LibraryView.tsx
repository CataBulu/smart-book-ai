import { useMemo, useState } from 'react'
import { Download, Plus, Search } from 'lucide-react'
import { groupSeries } from '../lib/series.ts'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'
import { SeriesCard, SeriesView } from './SeriesView.tsx'

interface Props {
  books: Book[]
  painting: Set<string>
  openSeries: string | null
  onOpenSeries: (name: string | null) => void
  onOpen: (book: Book) => void
  onAdd: (preset?: { series: string; series_index: number; author: string }) => void
  onExport: () => void
  onReorderSeries: (series: string, books: Book[]) => void
}

export function LibraryView({ books, painting, openSeries, onOpenSeries, onOpen, onAdd, onExport, onReorderSeries }: Props) {
  const [query, setQuery] = useState('')
  const [genre, setGenre] = useState<string | null>(null)
  const series = useMemo(() => groupSeries(books), [books])

  const genres = useMemo(() => {
    const counts = new Map<string, number>()
    books.forEach((b) => b.genres.forEach((g) => counts.set(g, (counts.get(g) ?? 0) + 1)))
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([g]) => g)
  }, [books])

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => books.filter((b) => (!genre || b.genres.includes(genre)) &&
    (!q || [b.title, b.author, b.series ?? '', ...b.genres, ...b.themes].some((f) => f.toLowerCase().includes(q)))),
  [books, q, genre])
  // a search shows matching series first ("witcher" → The Witcher); without a search every series gets a card
  const shownSeries = genre ? [] : series.filter((s) => !q || s.name.toLowerCase().includes(q) ||
    s.books.some((b) => b.author.toLowerCase().includes(q)))

  const current = openSeries ? series.find((s) => s.name === openSeries) : undefined
  if (current) {
    const last = current.books.reduce((n, b) => Math.max(n, b.series_index ?? 0), 0)
    return (
      <SeriesView series={current} onBack={() => onOpenSeries(null)} onOpenBook={onOpen}
                  onReorder={(ordered) => onReorderSeries(current.name, ordered)}
                  onAdd={() => onAdd({ series: current.name, series_index: Math.floor(last) + 1, author: current.books[0].author })} />
    )
  }

  return (
    <div className="lib">
      <div className="lib-column">
        <div className="lib-head">
          <div>
            <h1>Your library</h1>
            <p>{books.length} books{series.length ? ` · ${series.length} series` : ''} · Smart Book only recommends from these shelves.</p>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onExport} disabled={!books.length}><Download size={16} /> Export</button>
          <button className="btn btn-primary" onClick={() => onAdd()}><Plus size={16} /> Add books</button>
        </div>

        <div className="lib-tools">
          <label className="search">
            <Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, author, series or theme"
                   aria-label="Search library" />
          </label>
          <div className="chips" role="group" aria-label="Filter by genre">
            {genres.map((g) => (
              <button key={g} className="chip" aria-pressed={genre === g} onClick={() => setGenre(genre === g ? null : g)}>{g}</button>
            ))}
          </div>
        </div>

        {shownSeries.length > 0 && (
          <section className="series-row" aria-label="Series">
            {shownSeries.map((s) => <SeriesCard key={s.name} series={s} onOpen={() => onOpenSeries(s.name)} />)}
          </section>
        )}

        {shown.length === 0 ? (
          <div className="empty">
            {books.length ? 'No books match — try another word or clear the filter.' : 'Your shelves are empty. Add a book to get started.'}
          </div>
        ) : (
          <div className="grid">
            {shown.map((b) => (
              <button key={b.id} className="grid-book" onClick={() => onOpen(b)} data-testid="book-card">
                <BookCover title={b.title} author={b.author} url={b.cover_url} painting={painting.has(b.id)} />
                {b.progress && <span className="progress-line" title={`${Math.round(b.progress.percent)}% read`}><i style={{ width: `${b.progress.percent}%` }} /></span>}
                <p>{b.title}</p>
                <small>{b.author}</small>
                {b.series && <small className="series-tag">{b.series}{b.series_index !== null ? ` #${b.series_index}` : ''}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
