import { useCallback, useSyncExternalStore } from 'react'

/**
 * Navigation state lives in the query string (?project=&view=&rev=&sel=), so views are linkable
 * and survive reloads. The fragment is reserved for the session token handoff.
 */
export const VIEWS = ['overview', 'graph', 'records', 'proposals', 'history'] as const
export type View = (typeof VIEWS)[number]

export interface AppLocation {
  project: string | undefined
  view: View
  /** A past revision being viewed; undefined follows the head. */
  revision: number | undefined
  /** Selected object or relation id. */
  selection: string | undefined
}

export function parseLocation(search: string): AppLocation {
  const q = new URLSearchParams(search)
  const view = q.get('view')
  const rev = q.get('rev')
  const revision = rev !== null && /^\d{1,9}$/.test(rev) ? Number(rev) : undefined
  return {
    project: q.get('project') ?? undefined,
    view: (VIEWS as readonly string[]).includes(view ?? '') ? (view as View) : 'overview',
    revision,
    selection: q.get('sel') ?? undefined,
  }
}

export function formatLocation(loc: AppLocation): string {
  const q = new URLSearchParams()
  if (loc.project) q.set('project', loc.project)
  if (loc.view !== 'overview') q.set('view', loc.view)
  if (loc.revision !== undefined) q.set('rev', String(loc.revision))
  if (loc.selection) q.set('sel', loc.selection)
  const s = q.toString()
  return s ? `?${s}` : ''
}

const listeners = new Set<() => void>()
let cachedSearch: string | undefined
let cached: AppLocation | undefined

function snapshot(): AppLocation {
  const search = window.location.search
  if (search !== cachedSearch || cached === undefined) {
    cachedSearch = search
    cached = parseLocation(search)
  }
  return cached
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function useAppLocation(): [
  AppLocation,
  (patch: Partial<AppLocation>, mode?: 'push' | 'replace') => void,
] {
  const loc = useSyncExternalStore(subscribe, snapshot, snapshot)
  const navigate = useCallback((patch: Partial<AppLocation>, mode: 'push' | 'replace' = 'push') => {
    const next = { ...snapshot(), ...patch }
    const url = `${window.location.pathname}${formatLocation(next)}`
    if (url === `${window.location.pathname}${window.location.search}`) return
    if (mode === 'push') window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
    for (const l of listeners) l()
  }, [])
  return [loc, navigate]
}
