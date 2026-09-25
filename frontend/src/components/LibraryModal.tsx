import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Download, Loader2, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { api } from '../api.ts'
import type { Book, BookIn } from '../types.ts'

const ACCENTS = ['#2563eb', '#0ea5e9', '#6366f1', '#0891b2', '#1d4ed8', '#0284c7']
const ACCEPT = '.pdf,.docx,.epub,.md,.markdown,.txt,.json'
const EMPTY: BookIn = { title: '', author: '', description: '', genres: [], themes: [], text: '' }

function ChipInput({ label, values, placeholder, onChange }: {
  label: string; values: string[]; placeholder: string; onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const items = draft.split(',').map((s) => s.trim()).filter((s) => s && !values.includes(s))
    if (items.length) onChange([...values, ...items])
    setDraft('')
  }
  const id = `chip-${label.toLowerCase()}`
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="chip-input">
        <input
          id={id} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <button type="button" className="btn" onClick={add}>Add</button>
      </div>
      {values.length > 0 && (
        <div className="chips">
          {values.map((v) => (
            <span key={v} className="chip">
              {v}
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  books: Book[]
  onClose: () => void
  onChanged: () => void
}

export function LibraryModal({ books, onClose, onChanged }: Props) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<BookIn>(EMPTY)
  const [bulk, setBulk] = useState<BookIn[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return books
    return books.filter((b) =>
      [b.title, b.author, ...b.genres, ...b.themes].some((field) => field.toLowerCase().includes(q)))
  }, [books, filter])

  const set = (patch: Partial<BookIn>) => setForm((f) => ({ ...f, ...patch }))
  const reset = () => { setForm(EMPTY); setBulk(null); setAdding(false) }

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label)
    setNotice(null)
    try {
      setNotice({ kind: 'ok', text: await action() })
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.author.trim()) {
      return setNotice({ kind: 'error', text: 'Title and author are required.' })
    }
    if (!form.description.trim() && !form.text?.trim()) {
      return setNotice({ kind: 'error', text: 'Add a short description or the full text so the book can be found.' })
    }
    void run('Embedding with Qwen…', async () => {
      const book = await api.addBook(form)
      reset()
      onChanged()
      return `Added "${book.title}" (${book.chunks} chunk${book.chunks === 1 ? '' : 's'} indexed).`
    })
  }

  const importFile = (file: File) =>
    run(`Reading ${file.name}…`, async () => {
      const { drafts } = await api.previewImport(file)
      setAdding(true)
      if (drafts.length === 1) {
        setForm({ ...EMPTY, ...drafts[0] })
        setBulk(null)
        return `Imported "${drafts[0].title}" from ${file.name} — review the details and add it.`
      }
      setBulk(drafts)
      return `${drafts.length} books found in ${file.name}.`
    })

  const importBulk = () =>
    run(`Embedding ${bulk?.length} books with Qwen…`, async () => {
      const res = await api.addBooks(bulk ?? [])
      reset()
      onChanged()
      return `Added ${res.created.length} book(s).${res.errors.length ? ` Skipped: ${res.errors.join('; ')}` : ''}`
    })

  const exportLibrary = () =>
    run('Exporting…', async () => {
      const data = await api.exportBooks()
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: 'smart-book-library.json' })
      a.click()
      URL.revokeObjectURL(url)
      return `Exported ${data.length} books.`
    })

  const remove = (book: Book) => {
    if (!confirm(`Remove "${book.title}" from the library?`)) return
    void run('Removing…', async () => {
      await api.deleteBook(book.id)
      onChanged()
      return `Removed "${book.title}".`
    })
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <div className="modal-head">
          <div style={{ flex: 1 }}>
            <h2 id="library-title">My Library</h2>
            <small>{books.length} books</small>
          </div>
          <button className="btn" onClick={exportLibrary} disabled={!!busy || !books.length}>
            <Download size={16} /> Export
          </button>
          <button className="btn btn-primary" onClick={() => { setAdding((v) => !v); setNotice(null) }} disabled={!!busy}>
            <Plus size={16} /> Add book
          </button>
          <button className="btn btn-ghost" aria-label="Close library" onClick={onClose} disabled={!!busy}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}
          {busy && <div className="notice"><Loader2 size={14} className="spin" /> {busy}</div>}

          {adding && bulk && (
            <div className="form">
              <strong>Import {bulk.length} books</strong>
              <ul className="bulk-list">
                {bulk.map((b, i) => <li key={i}>{b.title} — {b.author}</li>)}
              </ul>
              <div className="form-actions">
                <span className="spacer" />
                <button className="btn btn-primary" onClick={importBulk} disabled={!!busy}>Import all</button>
                <button className="btn" onClick={reset} disabled={!!busy}>Cancel</button>
              </div>
            </div>
          )}

          {adding && !bulk && (
            <form className="form" onSubmit={submit}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="book-title">Title</label>
                  <input id="book-title" value={form.title} placeholder="e.g. The Name of the Wind"
                         onChange={(e) => set({ title: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="book-author">Author</label>
                  <input id="book-author" value={form.author} placeholder="e.g. Patrick Rothfuss"
                         onChange={(e) => set({ author: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="book-description">Short description</label>
                <textarea id="book-description" value={form.description} rows={3}
                          placeholder="A brief summary of what the book is about..."
                          onChange={(e) => set({ description: e.target.value })} />
              </div>
              <div className="grid-2">
                <ChipInput label="Genres" values={form.genres} placeholder="e.g. Fantasy, Mystery..."
                           onChange={(genres) => set({ genres })} />
                <ChipInput label="Themes" values={form.themes} placeholder="e.g. Redemption, Identity..."
                           onChange={(themes) => set({ themes })} />
              </div>
              <div className="field">
                <label htmlFor="book-text">Full book</label>
                <span className="hint">Paste the complete text, notes, or quotes below. It is chunked and indexed for search.</span>
                <textarea id="book-text" value={form.text} rows={5} placeholder="Paste full book text, reading notes, quotes..."
                          onChange={(e) => set({ text: e.target.value })} />
              </div>
              <div className="form-actions">
                <input
                  ref={fileInput} type="file" accept={ACCEPT} hidden data-testid="import-input"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }}
                />
                <button type="button" className="btn upload-btn" onClick={() => fileInput.current?.click()}
                        disabled={!!busy} title="PDF, DOCX, EPUB, Markdown, TXT or JSON">
                  <Upload size={16} /> Add from your computer
                </button>
                <span className="spacer" />
                <button type="submit" className="btn btn-primary" disabled={!!busy}>Add to Library</button>
                <button type="button" className="btn" onClick={reset} disabled={!!busy}>Cancel</button>
              </div>
            </form>
          )}

          <div className="filter">
            <Search size={16} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter books"
                   placeholder="Filter by title, author, genre or theme" />
          </div>

          {shown.length === 0 ? (
            <div className="empty">{books.length ? 'No books match that filter.' : 'Your library is empty — add a book to get started.'}</div>
          ) : (
            <div className="book-grid">
              {shown.map((b, i) => (
                <article
                  key={b.id} className="book-card" style={{ ['--accent' as string]: ACCENTS[i % ACCENTS.length] }}
                  data-testid="book-card"
                >
                  <button
                    className="card-main" aria-expanded={expanded === b.id}
                    onClick={() => setExpanded((x) => (x === b.id ? null : b.id))}
                  >
                    <h4>{b.title}</h4>
                    <div className="author">{b.author}</div>
                    <div className="genres">{b.genres.join(' · ') || 'Unclassified'}</div>
                    {expanded === b.id && (
                      <>
                        <div className="desc">{b.description}</div>
                        {b.themes.length > 0 && <div className="themes">Themes: {b.themes.join(', ')}</div>}
                      </>
                    )}
                  </button>
                  <button className="delete" aria-label={`Remove ${b.title}`} onClick={() => remove(b)} disabled={!!busy}>
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
