import { useState, type DragEvent } from 'react'

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** Native HTML5 drag-and-drop reordering. Spread `dragProps(i)` on each item; `onMove(from, to)` fires on drop. */
export function useDragReorder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const reset = () => { setDragging(null); setOver(null) }

  return (i: number) => ({
    draggable: true,
    'data-dragging': dragging === i ? true : undefined,
    'data-over': over === i && dragging !== null && dragging !== i ? (dragging < i ? 'below' : 'above') : undefined,
    onDragStart: (e: DragEvent) => {
      setDragging(i)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(i)) // Firefox needs data to start a drag
    },
    onDragOver: (e: DragEvent) => {
      if (dragging === null) return // e.g. files dragged in from the desktop: not ours
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (over !== i) setOver(i)
    },
    onDrop: (e: DragEvent) => {
      if (dragging === null) return
      e.preventDefault()
      e.stopPropagation()
      if (dragging !== i) onMove(dragging, i)
      reset()
    },
    onDragEnd: reset,
  })
}
