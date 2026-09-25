import { useEffect, useState } from 'react'
import type { ModelId } from '../types.ts'

export type ThemePref = 'light' | 'dark' | 'system'

export interface Prefs {
  theme: ThemePref
  model: ModelId
  voice: string
}

const KEY = 'smartbook-prefs'
const DEFAULTS: Prefs = { theme: 'system', model: 'pro', voice: 'af_heart' }

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function resolvedTheme(theme: ThemePref): 'light' | 'dark' {
  return theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
}

/** Persisted user preferences (per browser). Applies the theme to <html> as it changes. */
export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(load)
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolvedTheme(prefs.theme) }
    apply()
    try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* private mode */ }
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [prefs])
  return [prefs, (patch) => setPrefs((p) => ({ ...p, ...patch }))]
}
