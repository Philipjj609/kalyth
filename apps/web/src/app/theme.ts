import { useSyncExternalStore } from 'react'

/** Theme preference: follow the system, or force light or dark. Stored per browser. */
export type ThemePreference = 'system' | 'light' | 'dark'

const KEY = 'kalyth.theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')
let preference: ThemePreference = 'system'
const listeners = new Set<() => void>()

function read(): ThemePreference {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply() {
  const dark = preference === 'dark' || (preference === 'system' && media().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export const theme = {
  init() {
    preference = read()
    apply()
    media().addEventListener('change', () => {
      if (preference === 'system') {
        apply()
        for (const l of listeners) l()
      }
    })
  },
  get: () => preference,
  resolved: (): 'light' | 'dark' =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  set(next: ThemePreference) {
    preference = next
    try {
      if (next === 'system') window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, next)
    } catch {
      // Preference only lasts for this page load.
    }
    apply()
    for (const l of listeners) l()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function useTheme(): { preference: ThemePreference; resolved: 'light' | 'dark' } {
  const preferenceNow = useSyncExternalStore(theme.subscribe, theme.get, theme.get)
  const resolved = useSyncExternalStore(theme.subscribe, theme.resolved, theme.resolved)
  return { preference: preferenceNow, resolved }
}
