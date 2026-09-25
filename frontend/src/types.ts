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
  series?: string | null
  series_index?: number | null
}

export interface Book extends Omit<BookIn, 'text'> {
  id: string
  chunks: number
  source: string
  cover_url: string | null
  created_at: string
  series: string | null
  series_index: number | null
  text_chars: number
  progress: ReadingProgress | null
}

export interface ReadingProgress {
  char_offset: number
  page: number
  pages: number | null
  furthest_page: number
  percent: number
  updated_at: string
}

export interface Source {
  book_id: string
  title: string
  author: string
  genres: string[]
  themes: string[]
  description: string
  cover_url?: string | null
  series?: string | null
  series_index?: number | null
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
  illustrations?: { url?: string; caption: string; pending?: boolean }[]
  query?: string
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
  max_upload_mb: number
  media: { images: boolean; tts: boolean; stt: boolean }
}

export interface JobStatus {
  label: string
  stage: 'starting' | 'reading' | 'indexing' | 'done' | 'failed'
  done: number
  total: number
  percent: number
  elapsed_s: number
  eta_s: number | null
}

export interface Voice {
  id: string
  label: string
}

export interface HardwareStatus {
  gpu: { name: string; total_mb: number; used_mb: number; util_pct: number } | null
  ram: { total_gb: number; used_gb: number }
  ollama: { name: string; size_gb: number; vram_gb: number; gpu_pct: number }[]
  images: { setting: 'gpu' | 'cpu'; running_on: 'gpu' | 'cpu'; gpu_available: boolean }
  placement: { chat: string; embeddings: string; voice: string }
}
