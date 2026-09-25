import { useEffect, useState, type MouseEvent } from 'react'
import { Library, MessageSquarePlus, Settings, X } from 'lucide-react'
import type { Prefs, ThemePref } from '../lib/prefs.ts'
import type { ConversationSummary, ModelId, UsageSummary, Voice } from '../types.ts'
import { HardwarePanel } from './HardwarePanel.tsx'
import { Logo } from './Logo.tsx'

export type View = 'chat' | 'library'

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

function groupByDate(items: ConversationSummary[]): [string, ConversationSummary[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const groups: Record<string, ConversationSummary[]> = { Today: [], 'Previous 7 days': [], Older: [] }
  for (const c of items) {
    const t = new Date(c.updated_at).getTime()
    groups[t >= startOfToday ? 'Today' : t >= startOfToday - 7 * 864e5 ? 'Previous 7 days' : 'Older'].push(c)
  }
  return Object.entries(groups).filter(([, list]) => list.length)
}

interface Props {
  open: boolean
  view: View
  conversations: ConversationSummary[]
  activeId: string | null
  bookCount: number
  usage: UsageSummary | null
  contextPct: number
  prefs: Prefs
  voices: Voice[]
  busy: boolean
  onPrefs: (patch: Partial<Prefs>) => void
  onNewChat: () => void
  onLibrary: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onError: (message: string) => void
}

export function Sidebar(p: Props) {
  const [pop, setPop] = useState<'usage' | 'settings' | null>(null)

  useEffect(() => {
    if (!pop) return
    const close = () => setPop(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [pop])

  const toggle = (which: 'usage' | 'settings') => (e: MouseEvent) => {
    e.stopPropagation()
    setPop((cur) => (cur === which ? null : which))
  }
  const s = p.usage?.session

  return (
    <aside className={`sidebar${p.open ? ' open' : ''}`} aria-label="Navigation">
      <div className="wordmark"><Logo /> <b>Smart Book</b> <span>AI</span></div>

      <nav className="nav">
        <button className="nav-item" onClick={p.onNewChat} disabled={p.busy}
                aria-current={p.view === 'chat' && !p.activeId ? 'page' : undefined}>
          <MessageSquarePlus size={17} /> New conversation
        </button>
        <button className="nav-item" onClick={p.onLibrary} aria-current={p.view === 'library' ? 'page' : undefined}>
          <Library size={17} /> Library <span className="count" data-testid="book-count">{p.bookCount}</span>
        </button>
      </nav>

      <div className="recent" aria-label="Recent conversations">
        {p.conversations.length === 0 && <><h4>Recent</h4><div className="recent-empty">Your conversations will appear here.</div></>}
        {groupByDate(p.conversations).map(([label, list]) => (
          <div key={label}>
            <h4>{label}</h4>
            {list.map((c) => (
              <div key={c.id} className="recent-row" aria-current={c.id === p.activeId && p.view === 'chat' ? 'page' : undefined}>
                <button className="recent-item" title={c.title} onClick={() => p.onSelect(c.id)} disabled={p.busy}>
                  {c.title}
                </button>
                <button className="recent-del" aria-label={`Delete “${c.title}”`} onClick={() => p.onDelete(c.id)} disabled={p.busy}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="usage-btn" onClick={toggle('usage')} aria-expanded={pop === 'usage'} data-testid="usage-button">
          <b data-testid="session-cost">${(s?.cost ?? 0).toFixed(4)}</b> this session<br />
          {tokens(p.usage?.total.tokens ?? 0)} tokens in total
        </button>
        <button className="icon-btn" aria-label="Settings" onClick={toggle('settings')} aria-expanded={pop === 'settings'}>
          <Settings size={18} />
        </button>
      </div>

      {pop === 'usage' && (
        <div className="popover" role="dialog" aria-label="Usage" onClick={(e) => e.stopPropagation()}>
          <h3>Usage</h3>
          <div className="row">This session <b>${(s?.cost ?? 0).toFixed(4)}</b></div>
          <div className="row">Session tokens <b>{(s?.tokens ?? 0).toLocaleString()}</b></div>
          <div className="row">Model calls <b>{s?.calls ?? 0}</b></div>
          <div className="row">All-time tokens <b>{(p.usage?.total.tokens ?? 0).toLocaleString()}</b></div>
          <div className="row">Conversations <b>{p.usage?.conversations ?? 0}</b></div>
          <div className="row">Blocked by moderation <b data-testid="blocked-count">{p.usage?.total.blocked ?? 0}</b></div>
          <div className="row">Context window used <b>{p.contextPct}%</b></div>
          <p className="note">Qwen runs on your PC, so nothing is billed. Costs are what the same tokens would cost on a
            cloud API. Blocked messages never reach the model.</p>
        </div>
      )}

      {pop === 'settings' && (
        <div className="popover" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
          <div className="setting">
            <span>Appearance</span>
            <div className="segmented">
              {(['light', 'dark', 'system'] as ThemePref[]).map((t) => (
                <button key={t} aria-pressed={p.prefs.theme === t} onClick={() => p.onPrefs({ theme: t })}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="setting">
            <span>Answers</span>
            <div className="segmented">
              {([['pro', 'Best'], ['lite', 'Fast']] as [ModelId, string][]).map(([id, label]) => (
                <button key={id} aria-pressed={p.prefs.model === id} onClick={() => p.onPrefs({ model: id })}>{label}</button>
              ))}
            </div>
            <small>{p.prefs.model === 'pro' ? 'Qwen 3.5 4B — richer picks, ~25 s per answer.' : 'Qwen 3.5 2B — quicker, simpler answers.'}</small>
          </div>
          <div className="setting">
            <span>Reading voice</span>
            <select className="select" value={p.prefs.voice} onChange={(e) => p.onPrefs({ voice: e.target.value })}
                    aria-label="Reading voice">
              {p.voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <HardwarePanel onError={p.onError} />
        </div>
      )}
    </aside>
  )
}
