import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Menu } from 'lucide-react'
import { api, setUploadLimit, streamChat } from './api.ts'
import { AddBookDialog, type AddPreset } from './components/AddBookDialog.tsx'
import { EditBookDialog } from './components/EditBookDialog.tsx'
import { ProgressWindow, type TrackedJob } from './components/ProgressWindow.tsx'
import { BookDrawer } from './components/BookDrawer.tsx'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog.tsx'
import { Composer } from './components/Composer.tsx'
import { Home } from './components/Home.tsx'
import { LibraryView } from './components/LibraryView.tsx'
import { Reader } from './components/Reader.tsx'
import { Logo } from './components/Logo.tsx'
import { Answer, Question } from './components/Message.tsx'
import { Sidebar, type View } from './components/Sidebar.tsx'
import { stopSpeaking } from './lib/speech.ts'
import { usePrefs } from './lib/prefs.ts'
import type {
  Book, ChatMessage, ConversationSummary, Health, ReadingProgress, Source, StoredMessage, Usage, UsageSummary, Voice,
} from './types.ts'

const toChat = (m: StoredMessage): ChatMessage => ({
  id: m.id, role: m.role, content: m.content, sources: m.sources, blocked: m.blocked,
  usage: m.role === 'assistant' ? { prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens, cost: m.cost } : undefined,
})

function toolLabel(data: Record<string, unknown>): string {
  const args = (data.args ?? {}) as Record<string, unknown>
  if (data.name === 'get_book_details') return `looked up “${args.title ?? ''}”`
  if (data.name === 'search_library') return `searched the library for “${args.query ?? ''}”`
  return String(data.name)
}

type Toast = { id: number; text: string; kind: 'ok' | 'error' }

export default function App() {
  const [prefs, setPrefs] = usePrefs()
  const [view, setView] = useState<View>('chat')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [books, setBooks] = useState<Book[]>([])
  const [voices, setVoices] = useState<Voice[]>([])
  const [health, setHealth] = useState<Health | null | undefined>(undefined)
  const [drawer, setDrawer] = useState<Book | null>(null)
  const [adding, setAdding] = useState(false)
  const [painting, setPainting] = useState<Set<string>>(new Set())
  const [attaching, setAttaching] = useState<string | null>(null)
  const [reading, setReading] = useState<Book | null>(null)
  const [jobs, setJobs] = useState<TrackedJob[]>([])
  const [editing, setEditing] = useState<Book | null>(null)
  const [seriesOpen, setSeriesOpen] = useState<string | null>(null)
  const [addPreset, setAddPreset] = useState<AddPreset | undefined>(undefined)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [context, setContext] = useState({ used: 0, max: 8192 })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const activeRef = useRef<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const bookCount = useRef(0)

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  const fail = useCallback((m: string) => toast(m, 'error'), [toast])

  const ask = (title: string, message: string, confirmLabel: string) =>
    new Promise<boolean>((resolve) => setConfirmReq({ title, message, confirmLabel, resolve }))
  const closeConfirm = useCallback(() => setConfirmReq(null), [])

  const refresh = useCallback(() => {
    api.conversations().then(setConversations).catch(() => {})
    api.usage().then(setUsage).catch(() => {})
  }, [])
  const refreshBooks = useCallback(() => {
    api.books().then((b) => { bookCount.current = b.length; setBooks(b) }).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    refreshBooks()
    api.voices().then(setVoices).catch(() => {})
    api.models().then((ms) => ms[0] && setContext((c) => ({ ...c, max: ms[0].num_ctx }))).catch(() => {})
  }, [refresh, refreshBooks])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      let delay = 30_000
      try {
        const h = await api.health()
        setHealth(h)
        setUploadLimit(h.max_upload_mb)
        if (h.books !== bookCount.current) refreshBooks()
        if (h.seeding || !h.ollama_up) delay = 4000
      } catch {
        setHealth(null)
        delay = 5000
      }
      timer = setTimeout(tick, delay)
    }
    void tick()
    return () => clearTimeout(timer)
  }, [refreshBooks])

  // Follow the answer as it streams, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])
  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }

  const selectConversation = (id: string | null) => { activeRef.current = id; setActiveId(id) }

  const send = async (text: string) => {
    if (busy) return
    const assistantId = `pending-${crypto.randomUUID()}`
    setView('chat')
    setSidebarOpen(false)
    pinned.current = true
    setMessages((ms) => [...ms, { id: `user-${crypto.randomUUID()}`, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', pending: true, stage: 'moderating', query: text }])
    setBusy(true)
    const controller = new AbortController()
    abort.current = controller
    const patch = (fn: (m: ChatMessage) => Partial<ChatMessage>) =>
      setMessages((ms) => ms.map((m) => (m.id === assistantId ? { ...m, ...fn(m) } : m)))

    try {
      await streamChat({ message: text, conversation_id: activeRef.current, model: prefs.model }, ({ event, data }) => {
        switch (event) {
          case 'meta': {
            const id = data.conversation_id as string
            selectConversation(id)
            setConversations((cs) => cs.some((c) => c.id === id) ? cs
              : [{ id, title: data.title as string, updated_at: new Date().toISOString() }, ...cs])
            break
          }
          case 'status': patch(() => ({ stage: data.stage as string })); break
          case 'rewrite': patch(() => ({ rewrite: data.query as string })); break
          case 'sources': patch(() => ({ sources: data.books as Source[] })); break
          case 'tool': patch((m) => ({ tools: [...(m.tools ?? []), toolLabel(data)] })); break
          case 'token': patch((m) => ({ content: m.content + (data.text as string) })); break
          case 'blocked':
            patch(() => ({ content: data.message as string, blocked: true,
                           blockedInfo: { layer: data.layer as string, category: data.category as string } }))
            break
          case 'done': {
            const cited = new Set(data.cited as string[])
            patch((m) => ({ pending: false, usage: data.usage as Usage,
                            sources: m.sources?.map((s) => ({ ...s, cited: cited.has(s.book_id) })) }))
            const ctx = data.context as { used: number; max: number }
            if (ctx.used > 0) setContext(ctx)
            break
          }
          case 'error': patch(() => ({ pending: false, error: data.message as string })); break
        }
      }, controller.signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') patch((m) => ({ content: m.content || '_Stopped._' }))
      else patch(() => ({ error: `I couldn't reach the Smart Book server (${(e as Error).message}).` }))
    } finally {
      patch(() => ({ pending: false }))
      setBusy(false)
      abort.current = null
      refresh()
    }
  }

  const retry = () => {
    const lastQ = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastQ) return
    setMessages((ms) => ms.slice(0, -2))
    void send(lastQ.content)
  }

  const newChat = () => {
    stopSpeaking()
    selectConversation(null)
    setMessages([])
    setContext((c) => ({ ...c, used: 0 }))
    setView('chat')
    setSidebarOpen(false)
  }

  const openConversation = async (id: string) => {
    if (busy) return
    setView('chat')
    setSidebarOpen(false)
    if (id === activeRef.current) return
    try {
      const conv = await api.conversation(id)
      stopSpeaking()
      selectConversation(id)
      pinned.current = true
      setMessages(conv.messages.map(toChat))
      const chars = conv.messages.slice(-8).reduce((n, m) => n + m.content.length, 0)
      setContext((c) => ({ ...c, used: conv.messages.length ? Math.round(chars / 4) + 900 : 0 }))
    } catch {
      refresh()
    }
  }

  const deleteConversation = async (id: string) => {
    const title = conversations.find((c) => c.id === id)?.title ?? 'this conversation'
    const ok = await ask('Delete conversation?',
      `Are you sure you want to delete “${title}”? Its messages will be gone for good.`, 'Delete')
    if (!ok) return
    try {
      await api.deleteConversation(id)
      if (id === activeRef.current) newChat()
      toast('Conversation deleted')
    } catch (e) {
      fail((e as Error).message)
    }
    refresh()
  }

  const illustrate = async (messageId: string, s: Source) => {
    const caption = `A scene inspired by ${s.title}`
    const patchIll = (fn: (list: NonNullable<ChatMessage['illustrations']>) => ChatMessage['illustrations']) =>
      setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, illustrations: fn(m.illustrations ?? []) } : m)))
    patchIll((list) => [...list, { caption, pending: true }])
    try {
      const res = await api.illustrate(s.book_id)
      patchIll((list) => list.map((i) => (i.pending && i.caption === caption ? { url: res.url, caption: res.caption } : i)))
    } catch (e) {
      patchIll((list) => list.filter((i) => !(i.pending && i.caption === caption)))
      fail(`Couldn't paint that: ${(e as Error).message}`)
    }
  }

  const paintCover = async (book: Book) => {
    setPainting((p) => new Set(p).add(book.id))
    try {
      const updated = await api.generateCover(book.id)
      setBooks((bs) => bs.map((b) => (b.id === updated.id ? updated : b)))
      setDrawer((d) => (d?.id === updated.id ? updated : d))
      setMessages((ms) => ms.map((m) => m.sources?.some((s) => s.book_id === updated.id)
        ? { ...m, sources: m.sources.map((s) => (s.book_id === updated.id ? { ...s, cover_url: updated.cover_url } : s)) } : m))
      toast(`New cover painted for “${updated.title}”`)
    } catch (e) {
      fail(`Couldn't paint a cover: ${(e as Error).message}`)
    } finally {
      setPainting((p) => { const n = new Set(p); n.delete(book.id); return n })
    }
  }

  const removeBook = async (book: Book) => {
    const ok = await ask('Remove book?',
      `Are you sure you want to remove “${book.title}” from your library? Smart Book will stop recommending it.`, 'Remove')
    if (!ok) return
    try {
      await api.deleteBook(book.id)
      setDrawer(null)
      refreshBooks()
      toast(`Removed “${book.title}”`)
    } catch (e) {
      fail((e as Error).message)
    }
  }

  const exportLibrary = async () => {
    try {
      const data = await api.exportBooks()
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      Object.assign(document.createElement('a'), { href: url, download: 'smart-book-library.json' }).click()
      URL.revokeObjectURL(url)
      toast(`Exported ${data.length} books`)
    } catch (e) {
      fail((e as Error).message)
    }
  }

  const openBook = (id: string) => { const b = books.find((x) => x.id === id); if (b) setDrawer(b) }
  /** Runs a long request with a job id and shows its progress in the corner window until it settles. */
  const track = useCallback(async <T,>(label: string, run: (jobId: string) => Promise<T>): Promise<T> => {
    const id = crypto.randomUUID()
    setJobs((js) => [...js, { id, label, state: 'running', startedAt: Date.now() }])
    const settle = (state: TrackedJob['state']) => {
      setJobs((js) => js.map((j) => (j.id === id ? { ...j, state } : j)))
      setTimeout(() => setJobs((js) => js.filter((j) => j.id !== id)), state === 'done' ? 2500 : 6000)
    }
    try {
      const result = await run(id)
      settle('done')
      return result
    } catch (e) {
      settle('failed')
      throw e
    }
  }, [])

  const seriesNames = [...new Set(books.map((b) => b.series).filter((s): s is string => !!s))].sort()
  const replaceBook = (updated: Book) => {
    setBooks((bs) => bs.map((b) => (b.id === updated.id ? updated : b)))
    setDrawer((d) => (d?.id === updated.id ? updated : d))
  }
  const openSeries = (name: string | null) => { setDrawer(null); setView('library'); setSeriesOpen(name) }

  const readBook = (book: Book) => { stopSpeaking(); setDrawer(null); setReading(book) }

  const onProgress = useCallback((bookId: string, progress: ReadingProgress) => {
    setBooks((bs) => bs.map((b) => (b.id === bookId ? { ...b, progress } : b)))
  }, [])

  const attachText = async (book: Book, file: File) => {
    setAttaching(book.id)
    try {
      const updated = await track(`Adding the text of “${book.title}”`, (id) => api.attachText(book.id, file, id))
      setBooks((bs) => bs.map((b) => (b.id === updated.id ? updated : b)))
      setDrawer((d) => (d?.id === updated.id ? updated : d))
      toast(`“${updated.title}” is ready to read`)
    } catch (e) {
      fail(`Couldn't add that text: ${(e as Error).message}`)
    } finally {
      setAttaching(null)
    }
  }
  const media = health?.media ?? { images: false, tts: false, stt: false }
  const composerProps = { busy, voiceInput: media.stt, onSend: (t: string) => void send(t),
                          onStop: () => abort.current?.abort(), onError: fail }

  const banner = health === null
    ? <>Can’t reach the Smart Book server. Start it with <code>cd backend && uv run smartbook</code>.</>
    : health && health.llm === 'ollama' && !health.ollama_up
      ? <>Ollama isn’t running, so I can’t answer yet. Open the Ollama app (or run <code>ollama serve</code>).</> : null

  return (
    <div className="app">
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        open={sidebarOpen} view={view} conversations={conversations} activeId={activeId} bookCount={books.length}
        usage={usage} contextPct={Math.min(100, Math.round((context.used / context.max) * 100))} prefs={prefs}
        voices={voices} busy={busy} onPrefs={setPrefs} onNewChat={newChat}
        onLibrary={() => { setView('library'); setSeriesOpen(null); setSidebarOpen(false) }}
        onSelect={(id) => void openConversation(id)} onDelete={(id) => void deleteConversation(id)} onError={fail}
      />
      <main className="main">
        <div className="topbar">
          <button className="icon-btn" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <Logo size={22} /> <b>Smart Book</b>
        </div>
        {banner && <div className="banner warn" role="alert"><AlertTriangle size={18} /> <span>{banner}</span></div>}
        {health?.seeding && (
          <div className="banner" role="status"><Loader2 size={18} className="spin" /> <span>Setting up your starter library…</span></div>
        )}

        {view === 'library' ? (
          <div className="scroll">
            <LibraryView books={books} painting={painting} onOpen={setDrawer} onExport={exportLibrary}
                         openSeries={seriesOpen} onOpenSeries={setSeriesOpen}
                         onAdd={(preset) => { setAddPreset(preset); setAdding(true) }} />
          </div>
        ) : (
          <>
            <div className="scroll" ref={scroller} onScroll={onScroll}>
              <div className="column">
                {messages.length === 0 ? (
                  <Home books={books} disabled={busy} onAsk={(t) => void send(t)} onOpenBook={setDrawer} onRead={readBook}
                        onBrowse={() => setView('library')} composer={<Composer variant="hero" {...composerProps} />} />
                ) : (
                  <div className="thread">
                    {messages.map((m) => (m.role === 'user' ? <Question key={m.id} m={m} /> : (
                      <Answer key={m.id} m={m} h={{
                        voice: prefs.voice, canSpeak: media.tts, canPaint: media.images, busy,
                        onAsk: (t) => void send(t), onIllustrate: (id, s) => void illustrate(id, s),
                        onOpenBook: openBook, onRetry: retry, onError: fail,
                        canRead: (id) => (books.find((b) => b.id === id)?.text_chars ?? 0) > 0,
                        onRead: (id) => { const b = books.find((x) => x.id === id); if (b) readBook(b) },
                      }} />
                    )))}
                  </div>
                )}
              </div>
            </div>
            {messages.length > 0 && (
              <div className="composer-dock">
                <div className="column">
                  <Composer variant="dock" {...composerProps} />
                  <div className="hint">Smart Book only recommends from your library, and can make mistakes.</div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {drawer && (
        <BookDrawer
          book={drawer} canPaint={media.images} painting={painting.has(drawer.id)} onClose={() => setDrawer(null)}
          onCover={(b) => void paintCover(b)} onRemove={(b) => void removeBook(b)}
          attaching={attaching === drawer.id} onRead={readBook} onAttach={(b, f) => void attachText(b, f)}
          onEdit={setEditing} onOpenSeries={openSeries}
          onAsk={(b) => { setDrawer(null); newChat(); void send(`Tell me about "${b.title}" by ${b.author}. Who would enjoy it?`) }}
        />
      )}
      {editing && (
        <EditBookDialog
          book={editing} seriesNames={seriesNames} track={track} onClose={() => setEditing(null)}
          onSaved={(updated, note) => { replaceBook(updated); setEditing(null); toast(note) }}
        />
      )}
      {reading && <Reader book={reading} onClose={() => setReading(null)} onProgress={onProgress} />}
      {adding && (
        <AddBookDialog
          track={track} preset={addPreset} seriesNames={seriesNames}
          onClose={() => setAdding(false)}
          onAdded={(added, note) => {
            setAdding(false)
            refreshBooks()
            refresh()
            toast(added.length === 1 ? `Added “${added[0].title}” to your library` : `Added ${added.length} books${note ? ` · ${note}` : ''}`)
          }}
        />
      )}
      <ProgressWindow jobs={jobs} />
      {confirmReq && <ConfirmDialog req={confirmReq} onDone={closeConfirm} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} role="status">{t.text}</div>)}
      </div>
    </div>
  )
}
