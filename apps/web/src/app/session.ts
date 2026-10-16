import { useSyncExternalStore } from 'react'
import { bootstrapToken, forgetToken, TOKEN_STORAGE_KEY } from '../api/token.ts'

/**
 * Session state for this tab. "missing": no token was given; "rejected": the server refused the
 * token (it changes on every server launch). Both lead to the session screen.
 */
export type SessionState = 'ok' | 'missing' | 'rejected'

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let token: string | null = null
let state: SessionState = 'missing'
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export const session = {
  /** Reads the token from the URL fragment or this tab's storage. Call once, before rendering. */
  init() {
    const read = () =>
      bootstrapToken({
        location: window.location,
        storage: storage(),
        replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
      })
    token = read()
    state = token ? 'ok' : 'missing'
    // Opening the server link in a tab that already shows the UI only changes the fragment, which
    // does not reload the page; pick the new token up here.
    window.addEventListener('hashchange', () => {
      if (!window.location.hash.includes('token=')) return
      const next = read()
      if (next && (next !== token || state !== 'ok')) {
        token = next
        state = 'ok'
        emit()
      }
    })
  },
  token: () => token,
  state: () => state,
  /** Uses a token pasted by the user. */
  use(next: string) {
    token = next.trim()
    try {
      storage()?.setItem(TOKEN_STORAGE_KEY, token)
    } catch {
      // Storage may be unavailable; the token still works for this page load.
    }
    state = token ? 'ok' : 'missing'
    emit()
  },
  /** Called when the server answers 401. */
  reject() {
    if (state === 'rejected') return
    token = null
    forgetToken(storage())
    state = 'rejected'
    emit()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function useSessionState(): SessionState {
  return useSyncExternalStore(session.subscribe, session.state, session.state)
}
