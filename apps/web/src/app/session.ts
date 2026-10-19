import { useSyncExternalStore } from 'react'
import { bootstrapToken, forgetToken, TOKEN_STORAGE_KEY } from '../api/token.ts'

/**
 * Session state for this tab. "missing": no token was given; "rejected": the server refused the
 * token (it changes on every server launch). Both lead to the session screen. In the hosted demo
 * (ADR 0019) there is no token: "starting" while the page asks the server for a session, and
 * "unavailable" when it cannot get one.
 */
export type SessionState = 'ok' | 'missing' | 'rejected' | 'starting' | 'unavailable'

/** "local": the session token from the server link. "demo": an anonymous cookie session. */
export type SessionMode = 'local' | 'demo'

/** Sent with every change, so the hosted demo can tell its own UI from a cross-site form. */
export const UI_HEADER = 'x-kalyth-ui'

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let token: string | null = null
let state: SessionState = 'missing'
let mode: SessionMode = 'local'
let demoRestarted = false
let problem: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Asks the hosted demo for a session; the server sets an HttpOnly cookie. */
async function startDemo(): Promise<void> {
  try {
    const res = await fetch('/api/v1/demo/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', [UI_HEADER]: '1' },
    })
    if (res.ok) {
      state = 'ok'
      problem = null
    } else {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      state = 'unavailable'
      problem = body?.error?.message ?? `the server answered HTTP ${res.status}`
    }
  } catch {
    state = 'unavailable'
    problem = 'the server cannot be reached'
  }
  emit()
}

/** Without a token, the health check says whether this is the hosted demo. */
async function detectMode(): Promise<void> {
  try {
    const res = await fetch('/api/v1/health', { cache: 'no-store', credentials: 'same-origin' })
    const health = (await res.json()) as { mode?: string }
    if (health.mode === 'demo') {
      mode = 'demo'
      await startDemo()
      return
    }
  } catch {
    // Not the demo, or not reachable: the session screen explains the server link.
  }
  state = 'missing'
  emit()
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
    state = token ? 'ok' : 'starting'
    if (!token) void detectMode()
    // Opening the server link in a tab that already shows the UI only changes the fragment, which
    // does not reload the page; pick the new token up here.
    window.addEventListener('hashchange', () => {
      if (mode === 'demo' || !window.location.hash.includes('token=')) return
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
  mode: () => mode,
  /** Why the demo could not start a session, for the screen that says so. */
  problem: () => problem,
  /** The demo started a new copy because the server no longer knew this tab's session. */
  demoRestarted: () => demoRestarted,
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
  /** Called when the server answers 401. In the demo, a fresh session replaces the lost one. */
  reject() {
    if (mode === 'demo') {
      if (state === 'starting') return
      state = 'starting'
      demoRestarted = true
      emit()
      void startDemo()
      return
    }
    if (state === 'rejected') return
    token = null
    forgetToken(storage())
    state = 'rejected'
    emit()
  },
  /** Tries again after the demo could not start a session. */
  retry() {
    if (mode !== 'demo') return
    state = 'starting'
    emit()
    void startDemo()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function useSessionState(): SessionState {
  return useSyncExternalStore(session.subscribe, session.state, session.state)
}

export function useSessionMode(): SessionMode {
  return useSyncExternalStore(session.subscribe, session.mode, session.mode)
}
