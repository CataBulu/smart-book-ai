export type ModelId = 'pro' | 'lite'

export interface ModelInfo {
  id: ModelId
  label: string
  model: string
  num_ctx: number
}

export interface BookIn {
  title: string
  author: string
  description: string
  genres: string[]
  themes: string[]
  text?: string
}

export interface Book extends Omit<BookIn, 'text'> {
  id: string
  chunks: number
  source: string
  created_at: string
}

export interface Source {
  book_id: string
  title: string
  author: string
  genres: string[]
  themes: string[]
  description: string
  score: number | null
  kind: 'summary' | 'text'
  cited?: boolean
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  cost: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  blocked?: boolean
  blockedInfo?: { layer: string; category: string }
  pending?: boolean
  stage?: string
  rewrite?: string
  tools?: string[]
  error?: string
  usage?: Usage
}

export interface ConversationSummary {
  id: string
  title: string
  updated_at: string
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: Source[]
  blocked: boolean
  prompt_tokens: number
  completion_tokens: number
  cost: number
}

export interface UsageBucket {
  cost: number
  tokens: number
  calls: number
  blocked: number
}

export interface UsageSummary {
  session: UsageBucket
  total: UsageBucket
  conversations: number
}

export interface Health {
  ok: boolean
  llm: 'ollama' | 'fake'
  ollama_up: boolean
  models: Record<string, string>
  books: number
  seeding: boolean
}
