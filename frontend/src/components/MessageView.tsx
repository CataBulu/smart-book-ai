import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { Check, Copy, Loader2, Search, ShieldAlert, Square, Volume2, Wrench } from 'lucide-react'
import type { ChatMessage, Source } from '../types.ts'
import { Logo } from './Logo.tsx'

const STAGES: Record<string, string> = {
  moderating: 'Checking your message…',
  rewriting: 'Understanding your follow-up…',
  searching: 'Searching the library…',
  generating: 'Writing recommendations…',
  tool: 'Consulting the library…',
}

const CATEGORY: Record<string, string> = {
  invalid: 'invalid message',
  too_long: 'message too long',
  prompt_injection: 'prompt injection',
  dangerous_instructions: 'dangerous instructions',
  self_harm: 'wellbeing',
  sexual_minors: 'sexual content involving minors',
  hate_or_violence: 'hate or violence',
}

const plain = (md: string) => md.replace(/[*_#`>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1')

function useSpeech(text: string) {
  const [speaking, setSpeaking] = useState(false)
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
  useEffect(() => () => { if (speaking) window.speechSynthesis.cancel() }, [speaking])
  const toggle = () => {
    if (!supported) return
    window.speechSynthesis.cancel()
    if (speaking) return setSpeaking(false)
    const u = new SpeechSynthesisUtterance(plain(text))
    u.lang = 'en-US'
    u.onend = u.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(u)
    setSpeaking(true)
  }
  return { speaking, toggle, supported }
}

function Actions({ text }: { text: string }) {
  const { speaking, toggle, supported } = useSpeech(text)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(plain(text))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="meta-line">
      {supported && (
        <button className="pill" onClick={toggle} aria-pressed={speaking}>
          {speaking ? <Square size={12} /> : <Volume2 size={12} />} {speaking ? 'Stop' : 'Listen'}
        </button>
      )}
      <button className="pill" onClick={copy}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Sources({ sources }: { sources: Source[] }) {
  const cited = sources.filter((s) => s.cited)
  const shown = cited.length ? cited : sources
  if (!shown.length) return null
  return (
    <div className="meta-line" data-testid="sources">
      <span className="sources-label">{cited.length ? 'From your library' : 'Library matches'}</span>
      <div className="sources">
        {shown.map((s) => (
          <span key={s.book_id} className={`source${s.cited ? ' cited' : ''}`} title={s.description}>
            <b>{s.title}</b> {s.author}
            {s.score !== null && <span className="score">{Math.round(s.score * 100)}%</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

export function MessageView({ message: m }: { message: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="msg user" data-testid="user-message">
        <div className="avatar user">You</div>
        <div className="msg-body">
          <div className="bubble">{m.content}</div>
          <Actions text={m.content} />
        </div>
      </div>
    )
  }

  const waiting = m.pending && !m.content
  return (
    <div className="msg bot" data-testid="assistant-message">
      <div className="avatar bot"><Logo size={32} /></div>
      <div className="msg-body">
        {m.rewrite && (
          <div className="meta-line">
            <span className="pill rewrite" title="Your follow-up was rewritten into a standalone library search">
              <Search size={12} /> Searched for: {m.rewrite}
            </span>
          </div>
        )}
        {m.error ? (
          <div className="bubble error" role="alert">{m.error}</div>
        ) : m.blocked ? (
          <div className="bubble blocked" data-testid="blocked-message">
            <div className="blocked-tag">
              <ShieldAlert size={14} /> Moderation {m.blockedInfo?.layer ?? ''}
              {m.blockedInfo ? ` · ${CATEGORY[m.blockedInfo.category] ?? m.blockedInfo.category}` : ''} · no model call spent
            </div>
            {m.content}
          </div>
        ) : waiting ? (
          <div className="bubble">
            <span className="stage"><Loader2 size={15} className="spin" /> {STAGES[m.stage ?? ''] ?? 'Thinking…'}</span>
          </div>
        ) : (
          <div className={`bubble${m.pending ? ' caret' : ''}`}>
            <Markdown>{m.content}</Markdown>
          </div>
        )}
        {m.tools && m.tools.length > 0 && (
          <div className="meta-line">
            {m.tools.map((t, i) => <span key={i} className="pill"><Wrench size={11} /> {t}</span>)}
          </div>
        )}
        {m.sources && !m.blocked && !m.error && <Sources sources={m.sources} />}
        {!m.pending && !m.error && m.content && (
          <div className="meta-line">
            <Actions text={m.content} />
            {m.usage && m.usage.prompt_tokens + m.usage.completion_tokens > 0 && (
              <span title="Tokens used for this answer (embeddings, rewrite, chat, tools)">
                {(m.usage.prompt_tokens + m.usage.completion_tokens).toLocaleString()} tokens · ${m.usage.cost.toFixed(5)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
