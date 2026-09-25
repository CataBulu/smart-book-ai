import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Loader2, Mic, Square } from 'lucide-react'
import { useRecorder } from '../lib/speech.ts'

interface Props {
  variant: 'hero' | 'dock'
  busy: boolean
  voiceInput: boolean
  onSend: (text: string) => void
  onStop: () => void
  onError: (message: string) => void
}

export function Composer({ variant, busy, voiceInput, onSend, onStop, onError }: Props) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const rec = useRecorder(
    (said) => { setText((t) => (t ? `${t} ${said}` : said)); area.current?.focus() },
    onError,
  )

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  useEffect(() => { if (variant === 'hero') area.current?.focus() }, [variant])

  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    onSend(value)
    setText('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const recording = rec.status === 'recording'
  const transcribing = rec.status === 'transcribing'
  const placeholder = transcribing ? 'Transcribing…'
    : variant === 'hero' ? 'e.g. a slow, hopeful novel about starting over' : 'Ask a follow-up, or describe something new…'

  return (
    <div className={`composer ${variant === 'hero' ? 'hero' : ''}`}>
      <textarea
        ref={area} rows={1} value={text} placeholder={placeholder} aria-label="Message" maxLength={2000}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={transcribing}
      />
      {recording && <span className="rec-time" aria-live="polite">● {Math.floor(rec.seconds / 60)}:{String(rec.seconds % 60).padStart(2, '0')}</span>}
      {voiceInput && rec.supported && (
        <button
          className={`icon-btn mic${recording ? ' recording' : ''}`} onClick={recording ? rec.stop : rec.start}
          disabled={transcribing || busy} aria-label={recording ? 'Stop recording' : 'Speak your request'}
          title={recording ? 'Stop and transcribe' : 'Speak your request (transcribed on your PC)'}
        >
          {transcribing ? <Loader2 size={18} className="spin" /> : recording ? <Square size={15} /> : <Mic size={18} />}
        </button>
      )}
      {busy ? (
        <button className="send" onClick={onStop} aria-label="Stop"><Square size={14} /></button>
      ) : (
        <button className="send" onClick={submit} disabled={!text.trim()} aria-label="Send"><ArrowUp size={18} /></button>
      )}
    </div>
  )
}
