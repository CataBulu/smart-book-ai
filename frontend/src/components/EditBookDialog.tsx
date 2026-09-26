import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { api } from '../api.ts'
import type { Book } from '../types.ts'
import type { Track } from './AddBookDialog.tsx'

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

interface Props {
  book: Book
  seriesNames: string[]
  track: Track
  onClose: () => void
  onSaved: (book: Book, note: string) => void
}

/** Edit a book's details; saving re-embeds its summary so recommendations use the new description. */
export function EditBookDialog({ book, seriesNames, track, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    title: book.title, author: book.author, description: book.description, genres: book.genres.join(', '),
    themes: book.themes.join(', '), series: book.series ?? '', number: book.series_index?.toString() ?? '',
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // capture phase + stop: Esc closes this dialog only, not the book drawer underneath
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); if (!busy) onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const run = async (label: string, job: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try { await job() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.author.trim() || !form.description.trim()) {
      return setError('Title, author and description are needed.')
    }
    if (form.number && Number.isNaN(Number(form.number))) return setError('The number in the series must be a number, like 1 or 2.5.')
    void run('Saving…', async () => {
      const saved = await api.updateBook(book.id, {
        title: form.title, author: form.author, description: form.description, genres: list(form.genres),
        themes: list(form.themes), series: form.series.trim() || null, series_index: form.number ? Number(form.number) : null,
      })
      onSaved(saved, `Saved “${saved.title}”`)
    })
  }

  const reindex = () => run('Rebuilding the search index…', async () => {
    const updated = await track(`Re-indexing “${book.title}”`, (id) => api.reindexBook(book.id, id))
    onSaved(updated, `“${updated.title}” is searchable in full (${updated.chunks.toLocaleString()} passages)`)
  })

  return (
    <>
      <div className="overlay" style={{ zIndex: 56 }} onClick={() => !busy && onClose()} />
      <div className="dialog" style={{ zIndex: 57 }} role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <div className="dialog-head">
          <h2 id="edit-title">Edit details</h2>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="form" onSubmit={save}>
          <div className="two">
            <div className="field"><label htmlFor="e-title">Title</label>
              <input id="e-title" value={form.title} onChange={set('title')} /></div>
            <div className="field"><label htmlFor="e-author">Author</label>
              <input id="e-author" value={form.author} onChange={set('author')} /></div>
          </div>
          <div className="field"><label htmlFor="e-desc">What is it about?</label>
            <textarea id="e-desc" rows={4} value={form.description} onChange={set('description')} />
            <small>This is what recommendations match against, so describe the story, mood and themes.</small></div>
          <div className="two">
            <div className="field"><label htmlFor="e-genres">Genres</label>
              <input id="e-genres" value={form.genres} onChange={set('genres')} placeholder="Fantasy, Short Stories" /></div>
            <div className="field"><label htmlFor="e-themes">Themes</label>
              <input id="e-themes" value={form.themes} onChange={set('themes')} placeholder="monster hunting, destiny" /></div>
          </div>
          <div className="two series-fields">
            <div className="field"><label htmlFor="e-series">Series</label>
              <input id="e-series" list="series-names" value={form.series} onChange={set('series')} placeholder="e.g. Sherlock Holmes" />
              <datalist id="series-names">{seriesNames.map((s) => <option key={s} value={s} />)}</datalist></div>
            <div className="field"><label htmlFor="e-number">Number in series</label>
              <input id="e-number" inputMode="decimal" value={form.number} onChange={set('number')} placeholder="1" /></div>
          </div>
          {error && <p className="notice error">{error}</p>}
          <div className="form-foot">
            {book.text_chars > 0 && (
              <button type="button" className="btn btn-quiet" onClick={reindex} disabled={!!busy} style={{ marginRight: 'auto' }}
                      title={`Indexed as ${book.chunks} passages`}>
                <RefreshCw size={15} /> Rebuild search index
              </button>
            )}
            <button type="button" className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!!busy}>
              {busy ? <><Loader2 size={15} className="spin" /> {busy}</> : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
