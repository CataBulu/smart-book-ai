import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { FileUp, Loader2, X } from 'lucide-react'
import { api, uploadLimit } from '../api.ts'
import type { Book, BookIn } from '../types.ts'

const ACCEPT = '.pdf,.docx,.epub,.md,.markdown,.txt,.json'
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

export type Track = <T>(label: string, run: (jobId: string) => Promise<T>) => Promise<T>

interface Props {
  track: Track
  onClose: () => void
  onAdded: (books: Book[], note?: string) => void
}

export function AddBookDialog({ track, onClose, onAdded }: Props) {
  const [tab, setTab] = useState<'upload' | 'details'>('upload')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bulk, setBulk] = useState<BookIn[] | null>(null)
  const [form, setForm] = useState({ title: '', author: '', description: '', genres: '', themes: '', text: '' })
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const run = async (label: string, job: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try { await job() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  const readFile = (file: File) => run(`Reading ${file.name}…`, async () => {
    const { drafts } = await track(`Reading ${file.name}`, (id) => api.previewImport(file, id))
    if (drafts.length > 1) return setBulk(drafts)
    const d = drafts[0]
    setForm({ title: d.title, author: d.author, description: d.description, genres: d.genres.join(', '),
              themes: d.themes.join(', '), text: d.text ?? '' })
    setTab('details')
  })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void readFile(file)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.author.trim()) return setError('Please add a title and an author.')
    if (!form.description.trim() && !form.text.trim()) return setError('Add a short description (or the book text) so it can be found.')
    void run('Adding to your library…', async () => {
      const book = await track(`Adding “${form.title}”`, (id) => api.addBook({
        title: form.title, author: form.author, description: form.description,
        genres: list(form.genres), themes: list(form.themes), text: form.text,
      }, id))
      onAdded([book])
    })
  }

  const importAll = () => run(`Adding ${bulk!.length} books…`, async () => {
    const res = await track(`Adding ${bulk!.length} books`, (id) => api.addBooks(bulk!, id))
    onAdded(res.created, res.errors.length ? `${res.errors.length} skipped (already in your library)` : undefined)
  })

  return (
    <>
      <div className="overlay" onClick={() => !busy && onClose()} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="dialog-head">
          <h2 id="add-title">Add to your library</h2>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close"><X size={18} /></button>
        </div>

        {bulk ? (
          <>
            <p className="muted">Found {bulk.length} books in that file:</p>
            <ul className="bulk">{bulk.map((b, i) => <li key={i}><b>{b.title}</b> — {b.author}</li>)}</ul>
            {error && <p className="notice error">{error}</p>}
            <div className="form-foot">
              <button className="btn" onClick={() => setBulk(null)} disabled={!!busy}>Back</button>
              <button className="btn btn-primary" onClick={importAll} disabled={!!busy}>
                {busy ? <><Loader2 size={15} className="spin" /> {busy}</> : `Add all ${bulk.length}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>Upload a file</button>
              <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Enter details</button>
            </div>

            {tab === 'upload' ? (
              <>
                <button
                  className={`dropzone${over ? ' over' : ''}`} onClick={() => input.current?.click()} disabled={!!busy}
                  onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}
                >
                  {busy ? <Loader2 size={28} className="spin" /> : <FileUp size={28} />}
                  <p><b>{busy ?? 'Drop a book here, or click to choose'}</b></p>
                  <small>PDF, Word, EPUB, Markdown, text, or a JSON list of books · up to {uploadLimit()} MB</small>
                </button>
                <input ref={input} type="file" accept={ACCEPT} hidden data-testid="import-input"
                       onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = '' }} />
                {error && <p className="notice error" style={{ marginTop: 12 }}>{error}</p>}
              </>
            ) : (
              <form className="form" onSubmit={submit}>
                <div className="two">
                  <div className="field"><label htmlFor="f-title">Title</label>
                    <input id="f-title" value={form.title} onChange={set('title')} placeholder="The Name of the Wind" /></div>
                  <div className="field"><label htmlFor="f-author">Author</label>
                    <input id="f-author" value={form.author} onChange={set('author')} placeholder="Patrick Rothfuss" /></div>
                </div>
                <div className="field"><label htmlFor="f-desc">What is it about?</label>
                  <textarea id="f-desc" rows={3} value={form.description} onChange={set('description')}
                            placeholder="Two or three sentences in your own words." /></div>
                <div className="two">
                  <div className="field"><label htmlFor="f-genres">Genres</label>
                    <input id="f-genres" value={form.genres} onChange={set('genres')} placeholder="Fantasy, Adventure" /></div>
                  <div className="field"><label htmlFor="f-themes">Themes</label>
                    <input id="f-themes" value={form.themes} onChange={set('themes')} placeholder="music, loss, coming of age" /></div>
                </div>
                <div className="field"><label htmlFor="f-text">Book text or notes <span className="muted">(optional)</span></label>
                  <textarea id="f-text" rows={4} value={form.text} onChange={set('text')}
                            placeholder="Paste chapters, notes or quotes — they become searchable." />
                  <small>Separate genres and themes with commas.</small></div>
                {error && <p className="notice error">{error}</p>}
                <div className="form-foot">
                  <button type="button" className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={!!busy}>
                    {busy ? <><Loader2 size={15} className="spin" /> {busy}</> : 'Add to library'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </>
  )
}
