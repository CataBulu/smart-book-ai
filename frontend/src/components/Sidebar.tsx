import { BookOpen, Moon, Plus, Sun, Trash2 } from 'lucide-react'
import type { ConversationSummary, UsageSummary } from '../types.ts'
import { Logo } from './Logo.tsx'

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

interface Props {
  open: boolean
  conversations: ConversationSummary[]
  activeId: string | null
  bookCount: number
  usage: UsageSummary | null
  dark: boolean
  busy: boolean
  onToggleTheme: () => void
  onNewChat: () => void
  onSelect: (id: string) => void
  onDelete: () => void
  onOpenLibrary: () => void
}

export function Sidebar(p: Props) {
  return (
    <aside className={`sidebar${p.open ? ' open' : ''}`} aria-label="Sidebar">
      <div className="brand">
        <Logo size={30} />
        <span className="brand-name">Smart Book AI</span>
        <button
          className="theme-toggle" role="switch" aria-checked={p.dark} aria-label="Dark mode"
          onClick={p.onToggleTheme}
        >
          <span className="theme-knob">{p.dark ? <Moon size={12} /> : <Sun size={12} />}</span>
        </button>
      </div>

      <button className="btn btn-new" onClick={p.onNewChat} disabled={p.busy}>
        <Plus size={16} /> New chat
      </button>

      <div className="section-label">CONVERSATIONS</div>
      <nav className="conv-list" aria-label="Conversations">
        {p.conversations.length === 0 && <div className="conv-empty">No conversations yet</div>}
        {p.conversations.map((c) => (
          <button
            key={c.id} className={`conv-item${c.id === p.activeId ? ' active' : ''}`} title={c.title}
            aria-current={c.id === p.activeId ? 'page' : undefined}
            onClick={() => p.onSelect(c.id)} disabled={p.busy}
          >
            {c.title}
          </button>
        ))}
      </nav>

      <button className="btn library-btn" onClick={p.onOpenLibrary}>
        <span><BookOpen size={16} /> My Library</span>
        <span className="badge" data-testid="book-count">{p.bookCount}</span>
      </button>
      <button className="btn btn-danger" onClick={p.onDelete} disabled={!p.activeId || p.busy}>
        <Trash2 size={16} /> Delete active chat
      </button>

      <section className="cost-card" aria-label="Cost">
        <h3>COST</h3>
        <div className="cost-row" title="Cloud-equivalent estimate — local Qwen inference is free">
          This session <b data-testid="session-cost">${(p.usage?.session.cost ?? 0).toFixed(4)}</b>
        </div>
        <div className="cost-row">Conversations <b>{p.usage?.conversations ?? 0}</b></div>
        <div className="cost-row" title="All-time tokens: embeddings, rewrites, chat and tool rounds">
          Total tokens <b data-testid="total-tokens">{formatTokens(p.usage?.total.tokens ?? 0)}</b>
        </div>
        <div className="cost-row" title="Messages stopped by moderation before any chat-model call">
          Blocked by moderation <b data-testid="blocked-count">{p.usage?.total.blocked ?? 0}</b>
        </div>
      </section>
    </aside>
  )
}
