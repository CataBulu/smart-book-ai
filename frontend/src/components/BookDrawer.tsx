import { useEffect, useRef } from 'react'
import { BookOpen, FileUp, Library, Loader2, MessageCircle, Paintbrush, Pencil, Trash2, X } from 'lucide-react'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'

const ACCEPT = '.pdf,.docx,.epub,.md,.markdown,.txt'

interface Props {
  book: Book
  canPaint: boolean
  painting: boolean
  attaching: boolean
  onClose: () => void
  onRead: (book: Book) => void
  onAttach: (book: Book, file: File) => void
  onAsk: (book: Book) => void
  onCover: (book: Book) => void
  onRemove: (book: Book) => void
  onEdit: (book: Book) => void
  onOpenSeries: (name: string) => void
}

export function BookDrawer({ book, canPaint, painting, attaching, onClose, onRead, onAttach, onAsk, onCover, onRemove, onEdit,
  onOpenSeries }: Props) {
  const file = useRef<HTMLInputElement>(null)
  const p = book.progress

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
          {book.series && (
            <button className="link series-link" onClick={() => onOpenSeries(book.series!)}>
              <Library size={13} /> {book.series_index !== null ? `Book ${book.series_index} in ` : 'Part of '}{book.series}
            </button>
          )}
          <div className="tags">
            {[...book.genres, ...book.themes.slice(0, 5)].map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
          <p className="desc">{book.description}</p>
          <div className="drawer-actions">
            {book.text_chars > 0 ? (
              <>
                <button className="btn btn-primary" onClick={() => onRead(book)}>
                  <BookOpen size={16} /> {p ? `Continue reading · page ${p.page}${p.pages ? ` of ${p.pages}` : ''}` : 'Read this book'}
                </button>
                {p && <p className="drawer-note">You've read {p.furthest_page} page{p.furthest_page === 1 ? '' : 's'} · {Math.round(p.percent)}% through</p>}
              </>
            ) : (
              <>
                <input ref={file} type="file" accept={ACCEPT} hidden data-testid="attach-input"
                       onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(book, f); e.target.value = '' }} />
                <button className="btn btn-primary" onClick={() => file.current?.click()} disabled={attaching}>
                  {attaching ? <><Loader2 size={16} className="spin" /> Adding the text…</> : <><FileUp size={16} /> Add the book's text to read it</>}
                </button>
                <p className="drawer-note">PDF, EPUB, Word, text or Markdown — it opens in the reader and becomes searchable.</p>
              </>
            )}
            <button className="btn" onClick={() => onAsk(book)}><MessageCircle size={16} /> Ask about this book</button>
            <button className="btn" onClick={() => onEdit(book)}><Pencil size={16} /> Edit details</button>
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
