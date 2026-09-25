import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, Mic, SendHorizontal, Sparkles, Square, Zap } from 'lucide-react'
import type { ModelId, ModelInfo } from '../types.ts'

const MODEL_NOTES: Record<ModelId, string> = {
  pro: 'Best recommendations · slower on this GPU',
  lite: 'Fastest replies · fully on GPU',
}

// Minimal typing for the Web Speech API (not in lib.dom for all browsers).
interface Recognition {
  lang: string
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type RecognitionCtor = new () => Recognition
const SpeechRecognitionImpl: RecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition

function ContextRing({ used, max }: { used: number; max: number }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0
  const r = 16
  const c = 2 * Math.PI * r
  return (
    <div className="ring" title={`Context window: ${used.toLocaleString()} / ${max.toLocaleString()} tokens`}
         data-testid="context-ring">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 20 20)" />
      </svg>
      <span>{pct}%</span>
    </div>
  )
}

interface Props {
  busy: boolean
  models: ModelInfo[]
  model: ModelId
  context: { used: number; max: number }
  onModel: (m: ModelId) => void
  onSend: (text: string) => void
  onStop: () => void
}

export function Composer({ busy, models, model, context, onModel, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState(false)
  const [listening, setListening] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const recognition = useRef<Recognition | null>(null)
  const current = models.find((m) => m.id === model)

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

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

  const toggleMic = () => {
    if (!SpeechRecognitionImpl) return
    if (listening) return recognition.current?.stop()
    const rec = new SpeechRecognitionImpl()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.onresult = (e) => {
      const said = Array.from(e.results).map((r) => r[0].transcript).join(' ')
      setText((t) => (t ? `${t} ${said}` : said))
    }
    rec.onend = () => setListening(false)
    recognition.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <div className="composer-wrap">
      <div className="composer-row">
        <div className="composer">
          <textarea
            ref={area} rows={1} value={text} placeholder="Ask Smart Book AI" aria-label="Message"
            onChange={(e) => setText(e.target.value)} onKeyDown={onKey} maxLength={2000}
          />
          <div className="model-picker">
            <button
              className="model-btn" aria-haspopup="menu" aria-expanded={menu}
              onClick={(e) => { e.stopPropagation(); setMenu((v) => !v) }}
            >
              {model === 'pro' ? <Sparkles size={14} /> : <Zap size={14} />}
              <span className="label">{current?.label ?? 'Smart Book Pro'}</span>
              <ChevronDown size={14} />
            </button>
            {menu && (
              <div className="menu" role="menu">
                {models.map((m) => (
                  <button
                    key={m.id} className="menu-item" role="menuitemradio" aria-checked={m.id === model}
                    onClick={() => { onModel(m.id); setMenu(false) }}
                  >
                    {m.id === 'pro' ? <Sparkles size={16} /> : <Zap size={16} />}
                    <span>
                      {m.label}
                      <small>{m.model} — {MODEL_NOTES[m.id]}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`icon-btn${listening ? ' listening' : ' primary'}`} onClick={toggleMic}
            disabled={!SpeechRecognitionImpl}
            aria-label={listening ? 'Stop dictation' : 'Dictate'}
            title={SpeechRecognitionImpl ? 'Speak your request' : 'Speech input is not supported in this browser'}
          >
            <Mic size={16} />
          </button>
          {busy ? (
            <button className="icon-btn" onClick={onStop} aria-label="Stop generating"><Square size={14} /></button>
          ) : (
            <button className={`icon-btn${text.trim() ? ' primary' : ''}`} onClick={submit} disabled={!text.trim()}
                    aria-label="Send">
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
        <ContextRing used={context.used} max={context.max} />
      </div>
      <div className="disclaimer">Smart Book AI may make mistakes. Verify important information.</div>
    </div>
  )
}
