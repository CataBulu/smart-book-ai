import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { AlertCircle, BookOpen, Check, ChevronDown, Copy, Download, ImageIcon, Info, Loader2, RotateCcw, Square, Volume2 } from 'lucide-react'
import { speak, stopSpeaking, useSpeechState } from '../lib/speech.ts'
import type { ChatMessage, Source } from '../types.ts'
import { BookCover } from './BookCover.tsx'
import { Logo } from './Logo.tsx'

const STAGES: Record<string, string> = {
  moderating: 'Reading your request',
  rewriting: 'Following the thread of our conversation',
  searching: 'Looking through your shelves',
  generating: 'Choosing the best matches',
  tool: 'Checking a book more closely',
}

const WHY: Record<string, string> = {
  prompt_injection: 'it tried to change my instructions',
  dangerous_instructions: 'it asked for something dangerous',
  self_harm: 'it sounded like you might be going through something hard',
  sexual_minors: 'it asked for content involving minors',
  hate_or_violence: 'it contained hate or a threat of violence',
  invalid: 'it was empty or unreadable',
  too_long: 'it was too long',
}

interface Handlers {
  voice: string
  canSpeak: boolean
  canPaint: boolean
  busy: boolean
  onAsk: (text: string) => void
  onIllustrate: (messageId: string, source: Source) => void
  onOpenBook: (bookId: string) => void
  canRead: (bookId: string) => boolean
  onRead: (bookId: string) => void
  onRetry: () => void
  onError: (message: string) => void
}

function Pick({ s, m, h }: { s: Source; m: ChatMessage; h: Handlers }) {
  return (
    <article className="pick" data-testid="pick">
      <button onClick={() => h.onOpenBook(s.book_id)} aria-label={`Open ${s.title}`}>
        <BookCover title={s.title} author={s.author} url={s.cover_url} size="sm" />
      </button>
      <div>
        <h3>{s.title}</h3>
        <div className="by">{s.author}{s.genres.length ? ` · ${s.genres.slice(0, 2).join(', ')}` : ''}</div>
        <p className="blurb">{s.description}</p>
        <div className="actions">
          {h.canRead(s.book_id) && (
            <button className="link" onClick={() => h.onRead(s.book_id)}><BookOpen size={13} /> Read</button>
          )}
          <button className="link" disabled={h.busy} onClick={() => h.onAsk(`Tell me more about "${s.title}" by ${s.author}.`)}>
            Tell me more
          </button>
          <button className="link" disabled={h.busy} onClick={() => h.onAsk(`Recommend books similar to "${s.title}" by ${s.author}.`)}>
            More like this
          </button>
          {h.canPaint && (
            <button className="link" disabled={m.illustrations?.some((i) => i.pending)} onClick={() => h.onIllustrate(m.id, s)}>
              <ImageIcon size={13} /> Illustrate
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function Details({ m }: { m: ChatMessage }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  const tokens = m.usage ? m.usage.prompt_tokens + m.usage.completion_tokens : 0
  return (
    <div className="details" data-testid="details" ref={ref}>
      {m.rewrite && <div>Searched the library for <b>“{m.rewrite}”</b> (your follow-up, made standalone)</div>}
      {m.tools?.map((t, i) => <div key={i}>Tool: {t}</div>)}
      {m.sources && m.sources.length > 0 && (
        <div>Library matches: {m.sources.map((s) => `${s.title}${s.score !== null ? ` ${Math.round(s.score * 100)}%` : ''}`).join(' · ')}</div>
      )}
      {m.blockedInfo && <div>Stopped by moderation layer <b>{m.blockedInfo.layer}</b> ({m.blockedInfo.category.replace(/_/g, ' ')}) — no model call was made.</div>}
      {tokens > 0 && <div><b>{tokens.toLocaleString()}</b> tokens · ${m.usage!.cost.toFixed(5)} cloud-equivalent</div>}
    </div>
  )
}

export function Question({ m }: { m: ChatMessage }) {
  return <div className="q" data-testid="user-message">{m.content}</div>
}

export function Answer({ m, h }: { m: ChatMessage; h: Handlers }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const speech = useSpeechState()
  const waiting = m.pending && !m.content
  const picks = (m.sources ?? []).filter((s) => s.cited)
  const speaking = speech.speakingId === m.id
  const loading = speech.loadingId === m.id

  const copy = async () => {
    await navigator.clipboard.writeText(m.content.replace(/[*_#`]/g, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="ans" data-testid="assistant-message">
      <div className="ans-label"><Logo size={18} /> Smart Book</div>

      {m.error ? (
        <div className="notice error" role="alert">
          <AlertCircle size={18} />
          <div>{m.error} <button className="link" onClick={h.onRetry}><RotateCcw size={13} /> Try again</button></div>
        </div>
      ) : m.blocked ? (
        <div className="notice" data-testid="blocked-message">
          <Info size={18} />
          <div>
            {m.content}
            {m.blockedInfo && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              I didn't send this to the model because {WHY[m.blockedInfo.category] ?? 'it broke the house rules'}.
            </div>}
          </div>
        </div>
      ) : waiting ? (
        <div className="thinking" aria-live="polite">
          <span className="dots"><i /><i /><i /></span> {STAGES[m.stage ?? ''] ?? 'Thinking'}…
        </div>
      ) : (
        <div className={`prose${m.pending ? ' typing' : ''}`}><Markdown>{m.content}</Markdown></div>
      )}

      {!m.pending && picks.length > 0 && (
        <>
          <div className="picks-label">Books in this answer</div>
          <div className="picks">{picks.map((s) => <Pick key={s.book_id} s={s} m={m} h={h} />)}</div>
        </>
      )}

      {m.illustrations?.map((ill, i) => ill.pending ? (
        <div key={i} className="painting-card"><Loader2 size={16} className="spin" /> Painting “{ill.caption}” on your PC — about 20 seconds…</div>
      ) : (
        <figure key={i} className="illustration">
          <img src={ill.url} alt={ill.caption} />
          <figcaption>
            {ill.caption}
            <a className="link" href={ill.url} download><Download size={13} /> Save image</a>
          </figcaption>
        </figure>
      ))}

      {!m.pending && !m.error && m.content && (
        <div className="tools-row">
          {h.canSpeak && (
            <button className="btn btn-quiet" aria-pressed={speaking}
                    onClick={() => (speaking || loading ? stopSpeaking() : speak(m.id, m.content, h.voice, h.onError))}>
              {loading ? <Loader2 size={15} className="spin" /> : speaking ? <Square size={13} /> : <Volume2 size={15} />}
              {speaking ? 'Stop' : loading ? 'Preparing…' : 'Listen'}
            </button>
          )}
          <button className="btn btn-quiet" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Details <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
          </button>
        </div>
      )}
      {open && <Details m={m} />}
    </div>
  )
}
