import { useCallback, useEffect, useMemo, useRef, useState, type AnimationEvent, type PointerEvent } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, X } from 'lucide-react'
import { api } from '../api.ts'
import { normalizeText, pageAt, paginate, paragraphsOf, renderInto, type Page } from '../lib/paginate.ts'
import type { Book, ReadingProgress } from '../types.ts'

const FONT_SIZES = [15, 16, 17, 18, 20, 22]
const FONT_KEY = 'smartbook-reader-font'
const FLIP_MS = 720
const HEAD = 46 // running head area (px) above the text block
const FOOT = 44 // folio area below it

interface Geometry { spread: boolean; pageW: number; pageH: number; padX: number; bodyW: number; bodyH: number }

function measureGeometry(): Geometry {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const spread = vw >= 900
  const avail = Math.max(420, vh - 56 - 84 - 24)
  let pageH = Math.min(avail, 860)
  let pageW = Math.round(pageH * 0.68)
  if (spread && pageW * 2 + 120 > vw) {
    pageW = Math.floor((vw - 120) / 2)
    pageH = Math.min(pageH, Math.round(pageW / 0.68))
  }
  if (!spread) {
    pageW = Math.min(vw - 24, 540)
    pageH = Math.min(avail, Math.round(pageW / 0.62))
  }
  const padX = Math.max(22, Math.round(pageW * 0.1))
  return { spread, pageW, pageH, padX, bodyW: pageW - 2 * padX, bodyH: pageH - HEAD - FOOT }
}

function loadFont(): number {
  try { return FONT_SIZES.includes(Number(localStorage.getItem(FONT_KEY))) ? Number(localStorage.getItem(FONT_KEY)) : 17 } catch { return 17 }
}

type Side = 'left' | 'right' | 'single'
interface Flip { dir: 'next' | 'prev'; from: number; to: number }

function PageView({ text, pages, index, side, title, author }:
  { text: string; pages: Page[]; index: number; side: Side; title: string; author: string }) {
  const page = index >= 0 ? pages[index] : undefined
  return (
    <div className={`paper ${side}`} data-page={page ? index + 1 : undefined}>
      {page && (
        <>
          <div className="running-head">{side === 'left' ? author : title}</div>
          <div className="page-body">
            {paragraphsOf(text, page.start, page.end).map((p, i) => <p key={i} className={p.cls || undefined}>{p.text}</p>)}
          </div>
          <div className="folio">{index + 1}</div>
        </>
      )}
    </div>
  )
}

interface Props {
  book: Book
  onClose: () => void
  onProgress: (bookId: string, progress: ReadingProgress) => void
}

export function Reader({ book, onClose, onProgress }: Props) {
  const [content, setContent] = useState<{ text: string; progress: ReadingProgress | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [geo, setGeo] = useState(measureGeometry)
  const [font, setFont] = useState(loadFont)
  const [pages, setPages] = useState<Page[]>([])
  const [laidOut, setLaidOut] = useState(0) // characters paginated so far (for the loading bar)
  const [done, setDone] = useState(false)
  const [pos, setPos] = useState<number | null>(null)
  const [flip, setFlip] = useState<Flip | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [furthest, setFurthest] = useState(0)
  const [resumeAt, setResumeAt] = useState(0) // saved offset, for the loading bar
  const target = useRef(0) // character offset to keep in view across re-pagination
  const welcomed = useRef(false)
  const measurer = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<Page[]>([])
  const pointer = useRef<number | null>(null)
  const reduceMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const text = useMemo(() => (content ? normalizeText(content.text) : ''), [content])

  // Load the book and where the reader left off.
  useEffect(() => {
    let alive = true
    api.bookContent(book.id).then((c) => {
      if (!alive) return
      target.current = c.progress?.char_offset ?? 0
      setResumeAt(target.current)
      setFurthest(c.progress?.furthest_page ?? 0)
      setContent(c)
    }).catch((e) => alive && setError((e as Error).message))
    return () => { alive = false }
  }, [book.id])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4500)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const onResize = () => { clearTimeout(t); t = setTimeout(() => setGeo(measureGeometry()), 200) }
    window.addEventListener('resize', onResize)
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize) }
  }, [])

  // Paginate in ~14 ms slices so the UI stays responsive; open on the saved page as soon as it exists.
  useEffect(() => {
    const el = measurer.current
    if (!text || !el) return
    let cancelled = false
    let located = false
    let lastPush = 0
    const acc: Page[] = []
    const fits = (s: number, e: number) => { renderInto(el, paragraphsOf(text, s, e)); return el.scrollHeight <= el.clientHeight + 1 }
    const gen = paginate(text, fits)
    setPages([]); setDone(false); setPos(null); setFlip(null); setLaidOut(0)

    const slice = () => {
      if (cancelled) return
      const t0 = performance.now()
      let finished = false
      while (performance.now() - t0 < 14) {
        const next = gen.next()
        if (next.done) { finished = true; break }
        acc.push(next.value)
      }
      const justLocated = !located && (finished || (acc.length > 0 && acc[acc.length - 1].end > target.current))
      if (justLocated || finished || performance.now() - lastPush > 250) {
        pagesRef.current = acc.slice()
        setPages(pagesRef.current)
        setLaidOut(acc.length ? acc[acc.length - 1].end : 0)
        lastPush = performance.now()
      }
      if (justLocated) {
        located = true
        const p = pageAt(acc, target.current)
        setPos(geo.spread ? p - (p % 2) : p)
        if (target.current > 0 && !welcomed.current) {
          welcomed.current = true
          setNotice(`Welcome back — picking up on page ${p + 1}, right where you left off.`)
        }
      }
      if (finished) setDone(true)
      else setTimeout(slice, 0)
    }
    void document.fonts.ready.then(() => { if (!cancelled) slice() })
    return () => { cancelled = true }
  }, [text, geo, font])

  // Remember the position: debounced after each page turn, and immediately on close.
  const save = useCallback((keepalive = false) => {
    const all = pagesRef.current
    if (pos === null || !all[pos]) return
    const body = { offset: all[pos].start, page: pos + 1, pages: done ? all.length : null }
    api.saveProgress(book.id, body, keepalive).then((p) => { setFurthest(p.furthest_page); onProgress(book.id, p) }).catch(() => {})
  }, [book.id, done, onProgress, pos])

  useEffect(() => {
    if (pos === null || !pagesRef.current[pos]) return
    target.current = pagesRef.current[pos].start
    const t = setTimeout(() => save(), 600)
    return () => clearTimeout(t)
  }, [pos, save])

  const close = useCallback(() => { save(true); onClose() }, [save, onClose])

  const step = geo.spread ? 2 : 1
  const total = pages.length
  const approx = done || !total ? total : Math.max(total, Math.round(text.length / (pages[total - 1].end / total)))
  const ofTotal = done ? `${total}` : `~${approx}`
  const canPrev = pos !== null && pos > 0
  const ready = pos !== null && pos + step < total // next spread already laid out
  const canNext = pos !== null && (ready || !done) // or still being laid out: the turn waits for it
  const queued = useRef(false) // a 'next' pressed before that page was laid out

  const go = useCallback((dir: 'next' | 'prev') => {
    if (flip || pos === null || (dir === 'next' ? !canNext : !canPrev)) return
    if (dir === 'next' && !ready) { queued.current = true; return } // turn as soon as the page exists
    const to = dir === 'next' ? pos + step : Math.max(0, pos - step)
    if (reduceMotion) setPos(to)
    else setFlip({ dir, from: pos, to })
  }, [canNext, canPrev, flip, pos, ready, reduceMotion, step])

  useEffect(() => {
    if (!queued.current || !ready) return
    queued.current = false
    go('next')
  }, [ready, go])

  const finishFlip = useCallback(() => {
    if (!flip) return
    setPos(flip.to)
    setFlip(null)
  }, [flip])
  // shading overlays animate too and their animationend bubbles; only the sheet's own turn counts
  const onSheetEnd = (e: AnimationEvent) => { if (e.target === e.currentTarget) finishFlip() }

  // animationend can be skipped (background tab); never leave a page stuck mid-turn
  useEffect(() => {
    if (!flip) return
    const t = setTimeout(finishFlip, FLIP_MS + 150)
    return () => clearTimeout(t)
  }, [flip, finishFlip])

  const changeFont = (delta: number) => {
    const i = Math.min(FONT_SIZES.length - 1, Math.max(0, FONT_SIZES.indexOf(font) + delta))
    try { localStorage.setItem(FONT_KEY, String(FONT_SIZES[i])) } catch { /* private mode */ }
    setFont(FONT_SIZES[i])
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go('next') }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go('prev') }
      else if (e.key === 'Home' && total) setPos(0)
      else if (e.key === 'End' && total) setPos(geo.spread ? (total - 1) - ((total - 1) % 2) : total - 1)
      else if (e.key === '+' || e.key === '=') changeFont(1)
      else if (e.key === '-') changeFont(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onPointerDown = (e: PointerEvent) => { pointer.current = e.clientX }
  const onPointerUp = (e: PointerEvent) => {
    if (pointer.current === null) return
    const dx = e.clientX - pointer.current
    pointer.current = null
    if (Math.abs(dx) > 40) go(dx < 0 ? 'next' : 'prev')
  }

  const vars = {
    ['--page-w' as string]: `${geo.pageW}px`, ['--page-h' as string]: `${geo.pageH}px`, ['--pad-x' as string]: `${geo.padX}px`,
    ['--body-w' as string]: `${geo.bodyW}px`, ['--body-h' as string]: `${geo.bodyH}px`, ['--reader-font' as string]: `${font}px`,
    ['--flip' as string]: `${FLIP_MS}ms`,
  }
  const pv = (index: number, side: Side) => (
    <PageView text={text} pages={pages} index={index} side={side} title={book.title} author={book.author} />
  )
  const shown = flip ? flip.to : pos ?? 0
  const pct = text.length && pages[shown] ? Math.round((100 * pages[shown].start) / text.length) : 0
  const leftEdge = total ? Math.max(2, Math.round((shown / total) * 12)) : 2
  const rightEdge = total ? Math.max(2, Math.round(((total - shown) / total) * 12)) : 2
  const label = pos === null ? '' : geo.spread
    ? `Pages ${pos + 1}${pos + 2 <= approx ? `–${pos + 2}` : ''} of ${ofTotal}`
    : `Page ${pos + 1} of ${ofTotal}`

  let stage
  if (error) stage = <div className="reader-msg">Couldn't open this book: {error}</div>
  else if (content && !text) stage = <div className="reader-msg">This book has no text yet. Add the book file from its page in the library.</div>
  else if (pos === null) {
    stage = (
      <div className="reader-msg" aria-live="polite">
        <Loader2 size={22} className="spin" />
        <span>{content ? `Laying out pages… ${text.length ? Math.min(100, Math.round((100 * laidOut) / Math.max(1, resumeAt || text.length))) : 0}%` : 'Opening the book…'}</span>
      </div>
    )
  } else if (geo.spread) {
    const left = flip ? (flip.dir === 'next' ? flip.from : flip.to) : pos
    const right = flip ? (flip.dir === 'next' ? flip.to + 1 : flip.from + 1) : pos + 1
    stage = (
      <div className="book spread" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <i className="edges left" style={{ width: leftEdge }} />
        <i className="edges right" style={{ width: rightEdge }} />
        <div className="half left" onClick={() => go('prev')}>{pv(left, 'left')}</div>
        <div className="half right" onClick={() => go('next')}>{pv(right, 'right')}</div>
        {flip && (
          <div className={`sheet ${flip.dir}`} onAnimationEnd={onSheetEnd}>
            <div className="face front">{pv(flip.dir === 'next' ? flip.from + 1 : flip.from, flip.dir === 'next' ? 'right' : 'left')}</div>
            <div className="face back">{pv(flip.dir === 'next' ? flip.to : flip.to + 1, flip.dir === 'next' ? 'left' : 'right')}</div>
          </div>
        )}
      </div>
    )
  } else {
    const under = flip ? (flip.dir === 'next' ? flip.to : flip.from) : pos
    stage = (
      <div className="book single" onPointerDown={onPointerDown} onPointerUp={onPointerUp}
           onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); go(e.clientX - r.left > r.width * 0.4 ? 'next' : 'prev') }}>
        <i className="edges right" style={{ width: rightEdge }} />
        {pv(under, 'single')}
        {flip && (
          <div className={`sheet single-${flip.dir}`} onAnimationEnd={onSheetEnd}>
            <div className="face front">{pv(flip.dir === 'next' ? flip.from : flip.to, 'single')}</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={`Reading ${book.title}`} lang="en" style={vars}>
      <header className="reader-top">
        <button className="btn btn-quiet" onClick={close}><X size={17} /> Close</button>
        <div className="reader-title"><b>{book.title}</b><span>{book.author}</span></div>
        <div className="reader-font" role="group" aria-label="Text size">
          <button className="icon-btn" onClick={() => changeFont(-1)} disabled={font === FONT_SIZES[0]} aria-label="Smaller text"><Minus size={16} /></button>
          <span aria-hidden="true">Aa</span>
          <button className="icon-btn" onClick={() => changeFont(1)} disabled={font === FONT_SIZES.at(-1)} aria-label="Larger text"><Plus size={16} /></button>
        </div>
      </header>

      <div className="reader-stage">
        <button className="turn prev" onClick={() => go('prev')} disabled={!canPrev || !!flip} aria-label="Previous page"><ChevronLeft size={26} /></button>
        {stage}
        <button className="turn next" onClick={() => go('next')} disabled={!canNext || !!flip} aria-label="Next page"><ChevronRight size={26} /></button>
        {notice && <div className="reader-notice" role="status">{notice}</div>}
      </div>

      <footer className="reader-bottom">
        {pos !== null && total > 0 && (
          <>
            <input type="range" min={1} max={approx} step={1} value={pos + 1} aria-label="Go to page"
                   onChange={(e) => {
                     const p = Math.min(Number(e.target.value), total) - 1 // pages not laid out yet can't be opened
                     setFlip(null)
                     setPos(geo.spread ? p - (p % 2) : p)
                   }} />
            <div className="reader-meta">
              <span data-testid="reader-page">{label}</span>
              <span>{pct}% · {furthest > 0 ? `you've read ${furthest} page${furthest === 1 ? '' : 's'}` : 'just started'}</span>
            </div>
          </>
        )}
      </footer>
      <div ref={measurer} className="page-body measure" aria-hidden="true" />
    </div>
  )
}
