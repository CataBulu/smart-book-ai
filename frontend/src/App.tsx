import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Menu } from 'lucide-react'
import { api, streamChat } from './api.ts'
import { Composer } from './components/Composer.tsx'
import { LibraryModal } from './components/LibraryModal.tsx'
import { Logo } from './components/Logo.tsx'
import { MessageView } from './components/MessageView.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Welcome } from './components/Welcome.tsx'
import type {
  Book, ChatMessage, ConversationSummary, Health, ModelId, ModelInfo, Source, StoredMessage, Usage, UsageSummary,
} from './types.ts'

const stored = (key: string): string | null => {
  try { return localStorage.getItem(key) } catch { return null }
}
const store = (key: string, value: string) => {
  try { localStorage.setItem(key, value) } catch { /* private mode: preference just isn't remembered */ }
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const saved = stored('smartbook-theme')
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    store('smartbook-theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, () => setDark((d) => !d)]
}

const toChat = (m: StoredMessage): ChatMessage => ({
  id: m.id, role: m.role, content: m.content, sources: m.sources, blocked: m.blocked,
  usage: m.role === 'assistant'
    ? { prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens, cost: m.cost } : undefined,
})

function toolLabel(data: Record<string, unknown>): string {
  const args = (data.args ?? {}) as Record<string, unknown>
  if (data.name === 'get_book_details') return `Looked up “${args.title ?? ''}”`
  if (data.name === 'search_library') return `Searched library: “${args.query ?? ''}”`
  return String(data.name)
}

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<ModelId>(() => (stored('smartbook-model') === 'lite' ? 'lite' : 'pro'))
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [books, setBooks] = useState<Book[]>([])
  const [health, setHealth] = useState<Health | null | undefined>(undefined)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [context, setContext] = useState({ used: 0, max: 8192 })
  const abort = useRef<AbortController | null>(null)
  const threadEnd = useRef<HTMLDivElement>(null)
  const bookCount = useRef(0)

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
    api.models().then((ms) => {
      setModels(ms)
      if (ms[0]) setContext((c) => ({ ...c, max: ms[0].num_ctx }))
    }).catch(() => {})
  }, [refresh, refreshBooks])

  // Poll health: fast while the starter library is indexing or something is down, slow otherwise.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      let delay = 30_000
      try {
        const h = await api.health()
        setHealth(h)
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

  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const chooseModel = (m: ModelId) => { setModel(m); store('smartbook-model', m) }

  const send = async (text: string) => {
    if (busy) return
    const now = Date.now()
    const assistantId = `pending-${now}`
    setMessages((ms) => [
      ...ms,
      { id: `user-${now}`, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', pending: true, stage: 'moderating' },
    ])
    setBusy(true)
    setSidebarOpen(false)
    const controller = new AbortController()
    abort.current = controller
    const patch = (fn: (m: ChatMessage) => Partial<ChatMessage>) =>
      setMessages((ms) => ms.map((m) => (m.id === assistantId ? { ...m, ...fn(m) } : m)))

    try {
      await streamChat({ message: text, conversation_id: activeId, model }, ({ event, data }) => {
        switch (event) {
          case 'meta': {
            const id = data.conversation_id as string
            setActiveId(id)
            setConversations((cs) => cs.some((c) => c.id === id)
              ? cs : [{ id, title: data.title as string, updated_at: new Date().toISOString() }, ...cs])
            break
          }
          case 'status': patch(() => ({ stage: data.stage as string })); break
          case 'rewrite': patch(() => ({ rewrite: data.query as string })); break
          case 'sources': patch(() => ({ sources: data.books as Source[] })); break
          case 'tool': patch((m) => ({ tools: [...(m.tools ?? []), toolLabel(data)] })); break
          case 'token': patch((m) => ({ content: m.content + (data.text as string) })); break
          case 'blocked':
            patch(() => ({
              content: data.message as string, blocked: true,
              blockedInfo: { layer: data.layer as string, category: data.category as string },
            }))
            break
          case 'done': {
            const cited = new Set(data.cited as string[])
            patch((m) => ({
              pending: false, usage: data.usage as Usage,
              sources: m.sources?.map((s) => ({ ...s, cited: cited.has(s.book_id) })),
            }))
            const ctx = data.context as { used: number; max: number }
            if (ctx.used > 0) setContext(ctx) // blocked turns never reach the model, so keep the last reading
            break
          }
          case 'error': patch(() => ({ pending: false, error: data.message as string })); break
        }
      }, controller.signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') patch((m) => ({ content: m.content || '_Stopped._' }))
      else patch(() => ({ error: `Couldn't reach the Smart Book AI server: ${(e as Error).message}` }))
    } finally {
      patch(() => ({ pending: false }))
      setBusy(false)
      abort.current = null
      refresh()
    }
  }

  const newChat = () => {
    setActiveId(null)
    setMessages([])
    setContext((c) => ({ ...c, used: 0 }))
    setSidebarOpen(false)
  }

  const selectConversation = async (id: string) => {
    if (busy || id === activeId) return
    try {
      const conv = await api.conversation(id)
      setActiveId(id)
      setMessages(conv.messages.map(toChat))
      // Rough estimate until the next answer reports the real number: ~4 chars/token + prompt scaffolding.
      const chars = conv.messages.slice(-8).reduce((n, m) => n + m.content.length, 0)
      setContext((c) => ({ ...c, used: conv.messages.length ? Math.round(chars / 4) + 900 : 0 }))
      setSidebarOpen(false)
    } catch {
      refresh()
    }
  }

  const deleteChat = async () => {
    if (!activeId || !confirm('Delete this conversation?')) return
    await api.deleteConversation(activeId).catch(() => {})
    newChat()
    refresh()
  }

  const banner = health === null
    ? <>Can’t reach the Smart Book AI server. Start it with <code>cd backend && uv run smartbook</code>.</>
    : health && health.llm === 'ollama' && !health.ollama_up
      ? <>Ollama isn’t running, so the Qwen models are unavailable. Open the Ollama app or run <code>ollama serve</code>.</>
      : null

  return (
    <div className="app">
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        open={sidebarOpen} conversations={conversations} activeId={activeId} bookCount={books.length}
        usage={usage} dark={dark} busy={busy} onToggleTheme={toggleTheme} onNewChat={newChat}
        onSelect={(id) => void selectConversation(id)} onDelete={() => void deleteChat()}
        onOpenLibrary={() => { setLibraryOpen(true); setSidebarOpen(false) }}
      />
      <main className="main">
        <div className="topbar">
          <button className="btn btn-ghost btn-sm" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <Logo size={24} /> <strong>Smart Book AI</strong>
        </div>
        {banner && <div className="banner" role="alert"><AlertTriangle size={18} /> <span>{banner}</span></div>}
        {health?.seeding && (
          <div className="banner" role="status">
            <Loader2 size={18} className="spin" /> <span>Indexing the starter library with Qwen embeddings…</span>
          </div>
        )}
        <div className="thread">
          {messages.length === 0 ? (
            <Welcome onPick={(t) => void send(t)} disabled={busy} />
          ) : (
            <div className="thread-inner">
              {messages.map((m) => <MessageView key={m.id} message={m} />)}
              <div ref={threadEnd} />
            </div>
          )}
        </div>
        <Composer
          busy={busy} models={models} model={model} context={context} onModel={chooseModel}
          onSend={(t) => void send(t)} onStop={() => abort.current?.abort()}
        />
      </main>
      {libraryOpen && (
        <LibraryModal books={books} onClose={() => setLibraryOpen(false)} onChanged={() => { refreshBooks(); refresh() }} />
      )}
    </div>
  )
}
