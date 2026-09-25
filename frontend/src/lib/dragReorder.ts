import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const GLIDE = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }

/**
 * Sortable list/grid on native HTML5 drag and drop, with FLIP animations:
 * while dragging, the other items slide out of the way live; dropping keeps the preview; a drag that ends outside
 * the list glides everything back. Buttons and Alt+arrow keys (`move`) animate the same way.
 *
 * Spread `containerProps` on the list and `itemProps(key)` on each item; render `ordered`.
 */
export function useSortable<T>(items: T[], keyOf: (item: T) => string, onCommit: (ordered: T[]) => void, enabled = true) {
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const before = useRef<Map<string, DOMRect> | null>(null)
  const dropped = useRef(false)

  const capture = () => {
    before.current = new Map([...nodes.current].map(([k, el]) => [k, el.getBoundingClientRect()]))
  }

  // FLIP: after any re-order, animate each item from where it was to where it is now
  useLayoutEffect(() => {
    const prev = before.current
    if (!prev) return
    before.current = null
    if (reducedMotion()) return
    nodes.current.forEach((el, k) => {
      const was = prev.get(k)
      if (!was) return
      const now = el.getBoundingClientRect()
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], GLIDE)
      }
    })
  })

  const byKey = new Map(items.map((item) => [keyOf(item), item]))
  const ordered = preview ? preview.map((k) => byKey.get(k)).filter((x): x is T => x !== undefined) : items
  const changed = () => !!preview && preview.some((k, i) => k !== keyOf(items[i]))

  const end = () => { setDragKey(null); setPreview(null) }
  const finish = () => {
    dropped.current = true
    if (changed()) onCommit(ordered) // already on screen in its new place, so nothing jumps
    end()
  }

  const move = (key: string, delta: number) => {
    const i = items.findIndex((item) => keyOf(item) === key)
    const j = i + delta
    if (i < 0 || j < 0 || j >= items.length) return
    capture()
    onCommit(arrayMove(items, i, j))
  }

  const containerProps = {
    onDragOver: (e: DragEvent) => { if (dragKey !== null) e.preventDefault() },
    onDrop: (e: DragEvent) => { if (dragKey !== null) { e.preventDefault(); finish() } },
  }

  const itemProps = (key: string) => ({
    ref: (el: HTMLElement | null) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key) },
    draggable: enabled,
    'data-dragging': dragKey === key ? true : undefined,
    onDragStart: (e: DragEvent) => {
      if (!enabled) return
      dropped.current = false
      setDragKey(key)
      setPreview(items.map(keyOf))
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', key) // Firefox needs data to start a drag
    },
    onDragOver: (e: DragEvent) => {
      if (dragKey === null || !preview) return // e.g. files dragged in from the desktop: not ours
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      // an item that is still gliding away would otherwise bounce straight back under the pointer
      if (key === dragKey || (e.currentTarget as HTMLElement).getAnimations().length) return
      const from = preview.indexOf(dragKey)
      const to = preview.indexOf(key)
      if (from < 0 || to < 0 || from === to) return
      capture()
      setPreview(arrayMove(preview, from, to))
    },
    onDrop: (e: DragEvent) => {
      if (dragKey === null) return
      e.preventDefault()
      e.stopPropagation()
      finish()
    },
    onDragEnd: () => {
      if (!dropped.current && changed()) capture() // cancelled: glide back
      end()
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (!e.altKey || !enabled) return
      const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
      if (delta) { e.preventDefault(); move(key, delta) }
    },
  })

  return { ordered, itemProps, containerProps, move, dragging: dragKey !== null }
}
