import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, FileUp, GripVertical, Library, Loader2, X } from 'lucide-react'
import { api, uploadLimit } from '../api.ts'
import { arrayMove, useDragReorder } from '../lib/dragReorder.ts'
import type { Book, BookIn } from '../types.ts'

const ACCEPT = '.pdf,.docx,.epub,.md,.markdown,.txt,.json'
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

export type Track = <T>(label: string, run: (jobId: string) => Promise<T>) => Promise<T>

export interface AddPreset {
  series?: string
  series_index?: number
  author?: string
}

interface Props {
  track: Track
  preset?: AddPreset
  seriesNames: string[]
  nextNumber: (series: string) => number
  onClose: () => void
  onAdded: (books: Book[], note?: string) => void
}

interface Bulk {
  drafts: BookIn[]
  series: string
  numbered: boolean
  start: string
  skipped: string[]
}

export function AddBookDialog({ track, preset, seriesNames, nextNumber, onClose, onAdded }: Props) {
  // A series page opens this for one more book of that series; otherwise the reader picks what to add.
  const [mode, setMode] = useState<'choose' | 'one' | 'series'>(preset ? 'one' : 'choose')
  const [sForm, setSForm] = useState({ series: '', author: '', start: '1', titles: '' })
  const seriesInput = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'upload' | 'details'>('upload')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bulk, setBulk] = useState<Bulk | null>(null)
  const [form, setForm] = useState({
    title: '', author: preset?.author ?? '', description: '', genres: '', themes: '', text: '',
    series: preset?.series ?? '', number: preset?.series_index?.toString() ?? '',
  })
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

  /** One file → review it in the form. Several files (or a JSON list) → review them as a list and add them all. */
  const readFiles = (picked: File[], asSeries = false) => {
    const files = [...picked].sort(byName)
    return run(files.length > 1 ? `Reading ${files.length} files…` : `Reading ${files[0].name}…`, async () => {
      const drafts: BookIn[] = []
      const skipped: string[] = []
      for (const [i, file] of files.entries()) {
        const label = files.length > 1 ? `Reading ${file.name} (${i + 1} of ${files.length})` : `Reading ${file.name}`
        try {
          drafts.push(...(await track(label, (id) => api.previewImport(file, id))).drafts)
        } catch (e) {
          if (files.length === 1) throw e
          skipped.push(`${file.name}: ${(e as Error).message}`)
        }
      }
      if (!drafts.length) throw new Error(skipped.join('\n') || 'No books found in those files.')
      if (!asSeries && drafts.length === 1 && files.length === 1) {
        const d = drafts[0]
        setForm((f) => ({ ...f, title: d.title, author: f.author || d.author, description: d.description,
                          genres: d.genres.join(', '), themes: d.themes.join(', '), text: d.text ?? '' }))
        return setTab('details')
      }
      if (asSeries) {
        const author = sForm.author.trim()
        return setBulk({ drafts: author ? drafts.map((d) => ({ ...d, author })) : drafts, series: sForm.series.trim(),
                         numbered: true, start: sForm.start, skipped })
      }
      setBulk({ drafts, series: preset?.series ?? '', numbered: !!preset?.series, start: String(preset?.series_index ?? 1), skipped })
    })
  }

  const onDrop = (e: DragEvent, asSeries = false) => {
    e.preventDefault()
    setOver(false)
    if (asSeries && !seriesReady()) return
    if (e.dataTransfer.files.length) void readFiles([...e.dataTransfer.files], asSeries)
  }

  const seriesReady = () => {
    if (sForm.series.trim()) return true
    setError('Name the series first, e.g. The Witcher.')
    return false
  }
  const pickSeries = (name: string) =>
    setSForm((f) => ({ ...f, series: name, start: seriesNames.includes(name.trim()) ? String(nextNumber(name.trim())) : f.start }))

  /** No files yet: one entry per typed title, to fill in later with "Add the book's text". */
  const fromTitles = () => {
    if (!seriesReady()) return
    const titles = sForm.titles.split('\n').map((t) => t.trim()).filter(Boolean)
    if (!titles.length) return setError('Type at least one title, one per line.')
    const first = Number(sForm.start) || 1
    setError(null)
    setBulk({
      drafts: titles.map((title, i) => ({ title, author: sForm.author.trim() || 'Unknown', genres: [], themes: [],
        description: `Book ${first + i} of the ${sForm.series.trim()} series.` })),
      series: sForm.series.trim(), numbered: true, start: sForm.start, skipped: [],
    })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.author.trim()) return setError('Please add a title and an author.')
    if (!form.description.trim() && !form.text.trim()) return setError('Add a short description (or the book text) so it can be found.')
    if (form.number && Number.isNaN(Number(form.number))) return setError('The number in the series must be a number, like 1 or 2.5.')
    void run('Adding to your library…', async () => {
      const book = await track(`Adding “${form.title}”`, (id) => api.addBook({
        title: form.title, author: form.author, description: form.description, genres: list(form.genres),
        themes: list(form.themes), text: form.text, series: form.series.trim() || null,
        series_index: form.number ? Number(form.number) : null,
      }, id))
      onAdded([book])
    })
  }

  const patchDraft = (i: number, patch: Partial<BookIn>) =>
    setBulk((b) => b && { ...b, drafts: b.drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  const dragBulk = useDragReorder((from, to) => setBulk((b) => b && { ...b, drafts: arrayMove(b.drafts, from, to) }))
  const move = (i: number, dir: -1 | 1) => setBulk((b) => {
    if (!b || i + dir < 0 || i + dir >= b.drafts.length) return b
    const drafts = [...b.drafts]
    ;[drafts[i], drafts[i + dir]] = [drafts[i + dir], drafts[i]]
    return { ...b, drafts }
  })

  const importAll = () => run(`Adding ${bulk!.drafts.length} books…`, async () => {
    const { drafts, series, numbered, start } = bulk!
    const first = Number(start) || 1
    const books = drafts.map((d, i) => ({ ...d, series: series.trim() || d.series || null,
      series_index: series.trim() && numbered ? first + i : d.series_index ?? null }))
    const res = await track(`Adding ${books.length} books`, (id) => api.addBooks(books, id))
    onAdded(res.created, res.errors.length ? `${res.errors.length} skipped (already in your library)` : undefined)
  })

  return (
    <>
      <div className="overlay" onClick={() => !busy && onClose()} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="dialog-head">
          <h2 id="add-title">{preset?.series ? `Add to ${preset.series}` : mode === 'series' ? 'Add a whole series'
            : mode === 'one' ? 'Add a book' : 'Add to your library'}</h2>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close"><X size={18} /></button>
        </div>

        {bulk ? (
          <>
            <p className="muted">Check the titles and authors, drag them into reading order, then add them all.</p>
            <div className="two series-fields">
              <div className="field"><label htmlFor="b-series">Series <span className="muted">(optional)</span></label>
                <input id="b-series" list="series-names" value={bulk.series} placeholder="e.g. The Witcher"
                       onChange={(e) => setBulk({ ...bulk, series: e.target.value, numbered: bulk.numbered || !bulk.series })} />
                <datalist id="series-names">{seriesNames.map((s) => <option key={s} value={s} />)}</datalist></div>
              <div className="field"><label htmlFor="b-start">Number them from</label>
                <div className="inline-check">
                  <input id="b-number" type="checkbox" checked={bulk.numbered} disabled={!bulk.series.trim()}
                         onChange={(e) => setBulk({ ...bulk, numbered: e.target.checked })} aria-label="Number them in this order" />
                  <input id="b-start" inputMode="numeric" value={bulk.start} disabled={!bulk.numbered || !bulk.series.trim()}
                         onChange={(e) => setBulk({ ...bulk, start: e.target.value })} />
                </div></div>
            </div>
            <ol className="bulk-edit" data-testid="bulk-list">
              {bulk.drafts.map((d, i) => (
                <li key={i} {...dragBulk(i)} title="Drag to reorder">
                  <GripVertical size={15} className="grip" aria-hidden="true" />
                  <span className="bulk-no">{bulk.series.trim() && bulk.numbered ? `#${(Number(bulk.start) || 1) + i}` : i + 1}</span>
                  <input aria-label={`Title ${i + 1}`} value={d.title} onChange={(e) => patchDraft(i, { title: e.target.value })} />
                  <input aria-label={`Author ${i + 1}`} value={d.author} onChange={(e) => patchDraft(i, { author: e.target.value })} />
                  <span className="bulk-size">{d.text ? `${Math.round(d.text.length / 1000)}k chars` : 'no text'}</span>
                  <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${d.title} up`}><ArrowUp size={14} /></button>
                  <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === bulk.drafts.length - 1} aria-label={`Move ${d.title} down`}><ArrowDown size={14} /></button>
                  <button className="icon-btn" onClick={() => setBulk({ ...bulk, drafts: bulk.drafts.filter((_, j) => j !== i) })}
                          aria-label={`Remove ${d.title}`}><X size={14} /></button>
                </li>
              ))}
            </ol>
            {bulk.skipped.length > 0 && <p className="notice error">Couldn't read: {bulk.skipped.join('; ')}</p>}
            {error && <p className="notice error">{error}</p>}
            <div className="form-foot">
              <button className="btn" onClick={() => setBulk(null)} disabled={!!busy}>Back</button>
              <button className="btn btn-primary" onClick={importAll} disabled={!!busy || !bulk.drafts.length}>
                {busy ? <><Loader2 size={15} className="spin" /> {busy}</> : `Add all ${bulk.drafts.length}`}
              </button>
            </div>
          </>
        ) : mode === 'choose' ? (
          <div className="add-choice">
            <button className="choice-card" onClick={() => setMode('one')}>
              <BookOpen size={26} />
              <b>One book</b>
              <span>Upload a file (PDF, EPUB, Word, text) or type in the details.</span>
            </button>
            <button className="choice-card" onClick={() => setMode('series')}>
              <Library size={26} />
              <b>A whole series</b>
              <span>Name the series, then drop in all of its books at once — they're numbered in order.</span>
            </button>
          </div>
        ) : mode === 'series' ? (
          <div className="form">
            <button className="link back-link" onClick={() => { setMode('choose'); setError(null) }}><ArrowLeft size={14} /> Back</button>
            <div className="two">
              <div className="field"><label htmlFor="s-series">Series name</label>
                <input id="s-series" list="series-names" value={sForm.series} placeholder="e.g. The Witcher"
                       onChange={(e) => pickSeries(e.target.value)} />
                <datalist id="series-names">{seriesNames.map((n) => <option key={n} value={n} />)}</datalist></div>
              <div className="field"><label htmlFor="s-author">Author</label>
                <input id="s-author" value={sForm.author} placeholder="e.g. Andrzej Sapkowski"
                       onChange={(e) => setSForm({ ...sForm, author: e.target.value })} />
                <small>Leave empty to use the author inside each file.</small></div>
            </div>
            <div className="field narrow"><label htmlFor="s-start">Start numbering at</label>
              <input id="s-start" inputMode="numeric" value={sForm.start} onChange={(e) => setSForm({ ...sForm, start: e.target.value })} />
              {seriesNames.includes(sForm.series.trim()) && <small>Already in your library — continuing its numbering.</small>}</div>
            <button
              className={`dropzone${over ? ' over' : ''}`} disabled={!!busy}
              onClick={() => seriesReady() && seriesInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(e) => onDrop(e, true)}
            >
              {busy ? <Loader2 size={28} className="spin" /> : <FileUp size={28} />}
              <p><b>{busy ?? 'Drop all the books of the series here, or click to choose'}</b></p>
              <small>Sorted by file name (Book 1, Book 2 …) — you can reorder them next · up to {uploadLimit()} MB each</small>
            </button>
            <input ref={seriesInput} type="file" accept={ACCEPT} multiple hidden data-testid="series-input"
                   onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) void readFiles(fs, true); e.target.value = '' }} />
            <details className="titles-only">
              <summary>No files yet? Type the titles instead</summary>
              <div className="field">
                <textarea aria-label="Titles, one per line" rows={5} value={sForm.titles}
                          placeholder={'The Last Wish\nSword of Destiny\nBlood of Elves'}
                          onChange={(e) => setSForm({ ...sForm, titles: e.target.value })} />
                <small>Each title becomes an entry you can open later to add its text.</small>
              </div>
              <button className="btn" onClick={fromTitles} disabled={!!busy}>Continue with these titles</button>
            </details>
            {error && <p className="notice error" style={{ whiteSpace: 'pre-line' }}>{error}</p>}
          </div>
        ) : (
          <>
            {!preset && (
              <button className="link back-link" onClick={() => { setMode('choose'); setError(null) }}><ArrowLeft size={14} /> Back</button>
            )}
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
                <input ref={input} type="file" accept={ACCEPT} multiple hidden data-testid="import-input"
                       onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) void readFiles(fs); e.target.value = '' }} />
                {error && <p className="notice error" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>{error}</p>}
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
                <div className="two series-fields">
                  <div className="field"><label htmlFor="f-series">Series <span className="muted">(optional)</span></label>
                    <input id="f-series" list="series-names" value={form.series} onChange={set('series')} placeholder="e.g. The Witcher" />
                    <datalist id="series-names">{seriesNames.map((s) => <option key={s} value={s} />)}</datalist></div>
                  <div className="field"><label htmlFor="f-number">Number in series</label>
                    <input id="f-number" inputMode="decimal" value={form.number} onChange={set('number')} placeholder="1" /></div>
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
