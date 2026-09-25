// Client-side pagination for the reader. Pages are [start, end) character ranges into the canonical text, so a saved
// position (a character offset) survives window resizes and font-size changes: after re-paginating we reopen on the
// page that contains the offset.

export interface Page {
  start: number
  end: number
}

export interface Para {
  text: string
  cls: '' | 'cont' | 'heading' | 'lines'
}

/** Same rule as backend `importers.reading_text`: blank-line paragraphs, hard-wrapped prose joined into one line,
 *  blocks whose lines are all short (contents, verse, title pages) keep their line breaks. Idempotent. */
export function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.split(/\s+/).filter(Boolean).join(' ')).filter(Boolean)
    if (!lines.length) return ''
    return lines.length > 1 && Math.max(...lines.map((l) => l.length)) < 55 ? lines.join('\n') : lines.join(' ')
  }).filter(Boolean).join('\n\n')
}

function isHeading(t: string): boolean {
  if (t.length >= 60) return false
  return /^(chapter|book|part|letter|volume|stave|canto)\b/i.test(t) || /^[IVXLC]+\.?$/.test(t) ||
    (t.length > 2 && /[A-Z]/.test(t) && t === t.toUpperCase())
}

/** Paragraph structure of text[start, end): what both the visible page and the hidden measurer render. */
export function paragraphsOf(text: string, start: number, end: number): Para[] {
  const continued = start > 0 && text.slice(start - 2, start) !== '\n\n'
  return text.slice(start, end).split('\n\n').map((t, i) => ({
    text: t,
    cls: i === 0 && continued ? 'cont' : t.includes('\n') ? 'lines' : isHeading(t) ? 'heading' : '',
  }))
}

export function renderInto(el: HTMLElement, paras: Para[]) {
  el.replaceChildren(...paras.map((p) => {
    const node = document.createElement('p')
    node.textContent = p.text
    if (p.cls) node.className = p.cls
    return node
  }))
}

const isSpace = (c: string) => c === ' ' || c === '\n'

function skipSpace(text: string, i: number) {
  while (i < text.length && isSpace(text[i])) i++
  return i
}

/**
 * Yields pages one at a time. `fits(start, end)` must render text[start, end) into a page-sized box and report whether
 * it fits. Binary search per page (~10–14 layouts), page ends snapped back to a word boundary.
 */
export function* paginate(text: string, fits: (start: number, end: number) => boolean): Generator<Page> {
  let start = skipSpace(text, 0)
  let estimate = 1400
  while (start < text.length) {
    let lo = start + 1
    let hi = Math.min(text.length, start + Math.round(estimate * 1.25))
    while (hi < text.length && fits(start, hi)) {
      lo = hi
      hi = Math.min(text.length, hi + Math.round(estimate * 0.5))
    }
    if (hi === text.length && fits(start, hi)) {
      yield { start, end: text.length }
      return
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (fits(start, mid)) lo = mid
      else hi = mid
    }
    let end = lo
    if (end < text.length && !isSpace(text[end])) {
      let ws = end
      while (ws > start && !isSpace(text[ws])) ws--
      if (ws > start + (end - start) / 2) end = ws // avoid splitting a word, unless the "word" is half a page
    }
    yield { start, end }
    estimate = estimate * 0.6 + (end - start) * 0.4
    start = skipSpace(text, end)
  }
}

/** Index of the page containing `offset` (last page if past the end). */
export function pageAt(pages: Page[], offset: number): number {
  let lo = 0
  let hi = pages.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pages[mid].start <= offset) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}
