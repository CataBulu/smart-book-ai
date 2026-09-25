import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  resolve: (ok: boolean) => void
}

/** In-app replacement for window.confirm(): Cancel is focused by default, Esc or a click outside cancels. */
export function ConfirmDialog({ req, onDone }: { req: ConfirmRequest; onDone: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const close = (ok: boolean) => { req.resolve(ok); onDone() }

  useEffect(() => { cancel.current?.focus() }, [])

  useEffect(() => {
    // Capture phase so Esc closes only this dialog, not the drawer underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      req.resolve(false)
      onDone()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, onDone])

  return (
    <>
      <div className="overlay confirm-overlay" onClick={() => close(false)} />
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <div className="confirm-icon"><Trash2 size={20} /></div>
        <h2 id="confirm-title">{req.title}</h2>
        <p id="confirm-msg">{req.message}</p>
        <div className="confirm-actions">
          <button ref={cancel} className="btn" onClick={() => close(false)}>Cancel</button>
          <button className="btn btn-destructive" onClick={() => close(true)}>{req.confirmLabel}</button>
        </div>
      </div>
    </>
  )
}
