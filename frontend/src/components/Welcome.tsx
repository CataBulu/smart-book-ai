import { Logo } from './Logo.tsx'

const SUGGESTIONS = [
  { emoji: '🌙', text: 'Books to read when you need quiet and calm' },
  { emoji: '🧠', text: 'Non-fiction that changed how scientists think' },
  { emoji: '🌍', text: 'Novels set in places I have never been' },
  { emoji: '📖', text: 'A short book I can finish in one afternoon' },
]

export function Welcome({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="welcome">
      <Logo size={84} />
      <h1>Smart Book AI</h1>
      <p>Ask for an English book by theme, mood, or question.</p>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.text} className="suggestion" onClick={() => onPick(s.text)} disabled={disabled}>
            <span className="emoji" aria-hidden="true">{s.emoji}</span>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
