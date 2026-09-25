import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api.ts'

// ---------- text-to-speech (local Kokoro via /api/tts) ----------
// One global player: reading a new answer stops the previous one. Text is spoken in sentence-sized
// chunks, fetching the next chunk while the current one plays, so audio starts within a second or two.

const plain = (md: string) =>
  md.replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[*_#`>|]/g, '').replace(/\s+/g, ' ').trim()

export function chunkText(text: string, max = 240): string[] {
  const sentences = plain(text).match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? []
  const chunks: string[] = []
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    const last = chunks.length - 1
    if (last >= 0 && chunks[last].length + s.length + 1 <= max) chunks[last] += ` ${s}`
    else chunks.push(s)
  }
  return chunks
}

let current: { id: string; stop: () => void } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const state = { speakingId: null as string | null, loadingId: null as string | null }
let snapshot = { ...state }
const set = (patch: Partial<typeof state>) => { Object.assign(state, patch); snapshot = { ...state }; emit() }

export function stopSpeaking() {
  current?.stop()
  current = null
  set({ speakingId: null, loadingId: null })
}

export async function speak(id: string, text: string, voice: string, onError: (m: string) => void) {
  stopSpeaking()
  const controller = new AbortController()
  const audio = new Audio()
  let stopped = false
  const session = { id, stop: () => { stopped = true; controller.abort(); audio.pause() } }
  current = session
  set({ loadingId: id })
  const chunks = chunkText(text)
  const fetchChunk = (i: number) => api.speak(chunks[i], voice, controller.signal)
  try {
    let next = chunks.length ? fetchChunk(0) : null
    for (let i = 0; next && !stopped; i++) {
      const blob = await next
      next = i + 1 < chunks.length ? fetchChunk(i + 1) : null
      if (stopped) break
      const url = URL.createObjectURL(blob)
      audio.src = url
      set({ speakingId: id, loadingId: null })
      await audio.play()
      await new Promise<void>((resolve) => { audio.onended = () => resolve(); audio.onpause = () => resolve() })
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    if (!stopped) onError((e as Error).message || 'Could not play audio')
  } finally {
    // Only the session that still owns the player resets it; stopSpeaking()/a newer speak() already did otherwise.
    if (current === session) {
      current = null
      set({ speakingId: null, loadingId: null })
    }
  }
}

export function useSpeechState() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => snapshot)
}

// ---------- speech-to-text (MediaRecorder → local Whisper via /api/stt) ----------

export function useRecorder(onText: (text: string) => void, onError: (m: string) => void) {
  const [status, setStatus] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

  useEffect(() => {
    if (status !== 'recording') return
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [status])

  const start = async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return onError('Microphone access was blocked. Allow it in your browser to dictate.')
    }
    const rec = new MediaRecorder(stream)
    const parts: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setStatus('transcribing')
      try {
        const { text } = await api.transcribe(new Blob(parts, { type: rec.mimeType }))
        if (text) onText(text)
        else onError("I didn't catch that — try again a little closer to the mic.")
      } catch (e) {
        onError((e as Error).message)
      } finally {
        setStatus('idle')
      }
    }
    recorder.current = rec
    rec.start()
    setSeconds(0)
    setStatus('recording')
  }

  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop()
  return { status, seconds, supported, start, stop }
}
