import { useMemo, useState } from 'react'
import { Download, Plus, Search } from 'lucide-react'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'

interface Props {
  books: Book[]
  painting: Set<string>
  onOpen: (book: Book) => void
  onAdd: () => void
  onExport: () => void
}

export function LibraryView({ books, painting, onOpen, onAdd, onExport }: Props) {
  const [query, setQuery] = useState('')
  const [genre, setGenre] = useState<string | null>(null)

  const genres = useMemo(() => {
    const counts = new Map<string, number>()
    books.forEach((b) => b.genres.forEach((g) => counts.set(g, (counts.get(g) ?? 0) + 1)))
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([g]) => g)
  }, [books])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return books.filter((b) => (!genre || b.genres.includes(genre)) &&
      (!q || [b.title, b.author, ...b.genres, ...b.themes].some((f) => f.toLowerCase().includes(q))))
  }, [books, query, genre])

  return (
    <div className="lib">
      <div className="lib-column">
        <div className="lib-head">
          <div>
            <h1>Your library</h1>
            <p>{books.length} books · Smart Book only recommends from these shelves.</p>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onExport} disabled={!books.length}><Download size={16} /> Export</button>
          <button className="btn btn-primary" onClick={onAdd}><Plus size={16} /> Add a book</button>
        </div>

        <div className="lib-tools">
          <label className="search">
            <Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, author or theme"
                   aria-label="Search library" />
          </label>
          <div className="chips" role="group" aria-label="Filter by genre">
            {genres.map((g) => (
              <button key={g} className="chip" aria-pressed={genre === g} onClick={() => setGenre(genre === g ? null : g)}>{g}</button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="empty">
            {books.length ? 'No books match — try another word or clear the filter.' : 'Your shelves are empty. Add a book to get started.'}
          </div>
        ) : (
          <div className="grid">
            {shown.map((b) => (
              <button key={b.id} className="grid-book" onClick={() => onOpen(b)} data-testid="book-card">
                <BookCover title={b.title} author={b.author} url={b.cover_url} painting={painting.has(b.id)} />
                <p>{b.title}</p>
                <small>{b.author}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
