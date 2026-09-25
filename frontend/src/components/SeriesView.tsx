import { ArrowLeft, ArrowRight, GripVertical, Plus } from 'lucide-react'
import { useSortable } from '../lib/dragReorder.ts'
import { percentRead, readLabel, seriesPercent, type Series } from '../lib/series.ts'
import type { Book } from '../types.ts'
import { BookCover } from './BookCover.tsx'

export function SeriesCard({ series, onOpen }: { series: Series; onOpen: () => void }) {
  const started = series.books.filter((b) => b.progress).length
  const pct = seriesPercent(series)
  return (
    <button className="series-card" onClick={onOpen} data-testid="series-card">
      <span className="series-stack" aria-hidden="true">
        {series.books.slice(0, 3).map((b) => (
          <span key={b.id} className="series-stack-item">
            <BookCover title={b.title} author={b.author} url={b.cover_url} size="sm" />
          </span>
        ))}
      </span>
      <span className="series-card-text">
        <small>Series</small>
        <b>{series.name}</b>
        <span className="muted">{series.books.length} book{series.books.length === 1 ? '' : 's'} · {started} started · {Math.round(pct)}% read</span>
        <span className="progress-line"><i style={{ width: `${pct}%` }} /></span>
      </span>
    </button>
  )
}

interface Props {
  series: Series
  onBack: () => void
  onOpenBook: (book: Book) => void
  onAdd: () => void
  onReorder: (books: Book[]) => void
}

export function SeriesView({ series, onBack, onOpenBook, onAdd, onReorder }: Props) {
  const sortable = useSortable(series.books, (b) => b.id, onReorder)
  const start = Math.max(1, Math.floor(Math.min(...series.books.map((b) => b.series_index ?? Infinity))) || 1)
  const authors = [...new Set(series.books.map((b) => b.author))].join(', ')
  const withText = series.books.filter((b) => b.text_chars > 0).length
  const pct = seriesPercent(series)
  return (
    <div className="lib">
      <div className="lib-column">
        <button className="link" onClick={onBack}><ArrowLeft size={14} /> Library</button>
        <div className="lib-head" style={{ marginTop: 10 }}>
          <div>
            <h1>{series.name}</h1>
            <p>{authors} · {series.books.length} books · {withText} readable · {Math.round(pct)}% of the series read</p>
          </div>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onAdd}><Plus size={16} /> Add a book to this series</button>
        </div>
        <div className="progress-line series-total" title={`${Math.round(pct)}% of the series read`}><i style={{ width: `${pct}%` }} /></div>
        <ol className="series-list" data-testid="series-list" {...sortable.containerProps}>
          {sortable.ordered.map((b, i) => (
            <li key={b.id} className="series-item" {...sortable.itemProps(b.id)} style={{ ['--i' as string]: i }} title="Drag to change the reading order (or Alt + arrow keys)">
              <GripVertical size={16} className="grip" aria-hidden="true" />
              <button className="series-book" onClick={() => onOpenBook(b)} data-testid="series-book">
                <span className="series-no">{sortable.dragging ? `#${start + i}` : b.series_index !== null ? `#${b.series_index}` : '–'}</span>
                <BookCover title={b.title} author={b.author} url={b.cover_url} size="sm" />
                <span className="series-book-text">
                  <b>{b.title}</b>
                  <span className="muted">{b.author}</span>
                  <span className="progress-line"><i style={{ width: `${percentRead(b)}%` }} /></span>
                  <small className={b.text_chars ? '' : 'muted'} data-testid="series-read">{readLabel(b)}</small>
                </span>
              </button>
              <span className="series-move">
                <button className="icon-btn" onClick={() => sortable.move(b.id, -1)} disabled={i === 0}
                        aria-label={`Move ${b.title} earlier`} title="Earlier"><ArrowLeft size={14} /></button>
                <button className="icon-btn" onClick={() => sortable.move(b.id, 1)} disabled={i === series.books.length - 1}
                        aria-label={`Move ${b.title} later`} title="Later"><ArrowRight size={14} /></button>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
