import type {
  Book, BookIn, ConversationSummary, HardwareStatus, Health, ModelId, ModelInfo, StoredMessage, UsageSummary, Voice,
} from './types.ts'

function sessionId(): string {
  try {
    let id = sessionStorage.getItem('smartbook-session')
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem('smartbook-session', id)
    }
    return id
  } catch {
    return 'anonymous'
  }
}

const SESSION = sessionId()

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-Session-Id', SESSION)
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  const res = await fetch(`/api${path}`, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`)
  return data as T
}

export const api = {
  health: () => request<Health>('/health'),
  models: () => request<ModelInfo[]>('/models'),
  usage: () => request<UsageSummary>('/usage'),
  books: () => request<Book[]>('/books'),
  addBook: (book: BookIn) => request<Book>('/books', { method: 'POST', body: JSON.stringify(book) }),
  addBooks: (books: BookIn[]) =>
    request<{ created: Book[]; errors: string[] }>('/books/bulk', { method: 'POST', body: JSON.stringify({ books }) }),
  deleteBook: (id: string) => request<{ deleted: boolean }>(`/books/${id}`, { method: 'DELETE' }),
  exportBooks: () => request<BookIn[]>('/books/export'),
  previewImport: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ drafts: BookIn[] }>('/import/preview', { method: 'POST', body: form })
  },
  conversations: () => request<ConversationSummary[]>('/conversations'),
  conversation: (id: string) =>
    request<ConversationSummary & { messages: StoredMessage[] }>(`/conversations/${id}`),
  deleteConversation: (id: string) => request<{ deleted: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),
  generateCover: (id: string) => request<Book>(`/books/${id}/cover`, { method: 'POST' }),
  illustrate: (id: string) => request<{ url: string; caption: string }>(`/books/${id}/illustrate`, { method: 'POST' }),
  voices: () => request<Voice[]>('/voices'),
  hardware: () => request<HardwareStatus>('/hardware'),
  setImageDevice: (images: 'gpu' | 'cpu') =>
    request<HardwareStatus>('/hardware', { method: 'POST', body: JSON.stringify({ images }) }),
  transcribe: (audio: Blob) => {
    const form = new FormData()
    form.append('audio', audio, 'recording.webm')
    return request<{ text: string }>('/stt', { method: 'POST', body: form })
  },
  speak: async (text: string, voice: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION },
      body: JSON.stringify({ text, voice }), signal,
    })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Speech failed')
    return res.blob()
  },
}

export type ChatEvent = { event: string; data: Record<string, unknown> }

/** POST /api/chat and parse the text/event-stream response (EventSource is GET-only). */
export async function streamChat(
  body: { message: string; conversation_id: string | null; model: ModelId },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Chat request failed (${res.status})`)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data) onEvent({ event, data: JSON.parse(data) })
    }
  }
}
