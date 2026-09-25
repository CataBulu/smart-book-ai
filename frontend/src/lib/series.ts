import type { Book } from '../types.ts'

export interface Series {
  name: string
  books: Book[]
}

/** Books grouped by series name, each series in reading order (unnumbered books last, by title). */
export function groupSeries(books: Book[]): Series[] {
  const map = new Map<string, Book[]>()
  for (const b of books) if (b.series) map.set(b.series, [...(map.get(b.series) ?? []), b])
  return [...map.entries()].map(([name, list]) => ({
    name,
    books: list.sort((a, b) => (a.series_index ?? Infinity) - (b.series_index ?? Infinity) || a.title.localeCompare(b.title)),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

export const percentRead = (b: Book) => (b.progress ? b.progress.percent : 0)

/** Average % read across the series (books without text count as unread). */
export const seriesPercent = (s: Series) => s.books.reduce((n, b) => n + percentRead(b), 0) / s.books.length

export function readLabel(b: Book): string {
  if (!b.text_chars) return 'No text yet'
  if (!b.progress) return 'Not started · 0%'
  const p = b.progress
  return `${Math.round(p.percent)}% read · page ${p.page}${p.pages ? ` of ${p.pages}` : ''}`
}
