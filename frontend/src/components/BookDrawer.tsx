import { useEffect } from 'react'
import { MessageCircle, Paintbrush, Trash2, X } from 'lucide-react'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'

interface Props {
  book: Book
  canPaint: boolean
  painting: boolean
  onClose: () => void
  onAsk: (book: Book) => void
  onCover: (book: Book) => void
  onRemove: (book: Book) => void
}

export function BookDrawer({ book, canPaint, painting, onClose, onAsk, onCover, onRemove }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={book.title}>
        <div className="drawer-head">
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="drawer-body">
          <div className="drawer-cover">
            <BookCover title={book.title} author={book.author} url={book.cover_url} size="lg" painting={painting} />
          </div>
          <h2>{book.title}</h2>
          <div className="by">{book.author}</div>
          <div className="tags">
            {[...book.genres, ...book.themes.slice(0, 5)].map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
          <p className="desc">{book.description}</p>
          <div className="drawer-actions">
            <button className="btn btn-primary" onClick={() => onAsk(book)}><MessageCircle size={16} /> Ask about this book</button>
            {canPaint && (
              <button className="btn" onClick={() => onCover(book)} disabled={painting}>
                <Paintbrush size={16} /> {painting ? 'Painting a cover…' : book.cover_url ? 'Paint a new cover' : 'Paint a cover'}
              </button>
            )}
            <button className="btn btn-quiet btn-danger" onClick={() => onRemove(book)}><Trash2 size={16} /> Remove from library</button>
          </div>
          <div className="drawer-meta">
            Indexed as {book.chunks} passage{book.chunks === 1 ? '' : 's'} · added {new Date(book.created_at).toLocaleDateString()}
          </div>
        </div>
      </aside>
    </>
  )
}
