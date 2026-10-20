import { useCallback, useSyncExternalStore } from 'react'

/**
 * Navigation state lives in the query string
 * (?project=&view=&rev=&sel=&run=&proposal=&package=&task=&layout=&decision=),
 * so views are linkable and survive reloads. The fragment is reserved for the session token
 * handoff. Secrets never go here: agent tokens are held in component state only.
 */
export const VIEWS = [
  'overview',
  'graph',
  'records',
  'proposals',
  'history',
  'navigator',
  'handoff',
  'tasks',
  'decisions',
] as const
export type View = (typeof VIEWS)[number]

export interface AppLocation {
  project: string | undefined
  view: View
  /** A past revision being viewed; undefined follows the head. */
  revision: number | undefined
  /** Selected object or relation id. */
  selection: string | undefined
  /** The Navigator run shown in detail (Navigator view only). */
  run?: string | undefined
  /** A proposal to bring into view (Proposals view only). */
  proposal?: string | undefined
  /** The context package shown (Handoff view only). */
  package?: string | undefined
  /** The task shown in detail (Tasks view only). */
  task?: string | undefined
  /** How the Tasks view draws tasks: the board (default) or the graph of their dependencies. */
  taskLayout?: 'board' | 'graph' | undefined
  /** The decision whose alternatives are compared (Decisions view only). */
  decision?: string | undefined
  /** The canvas lens (Graph view only; ADR 0020). */
  lens?: Lens | undefined
  /** The alternative whose impact the canvas shows (Graph view, impact lens). */
  alternative?: string | undefined
}

export const LENSES = ['basis', 'freshness', 'impact', 'decisions'] as const
export type Lens = (typeof LENSES)[number]

/** Context package ids are content addresses: `ctx_` and 32 hex digits (ADR 0011). */
const PACKAGE_ID = /^ctx_[0-9a-f]{32}$/
/** Tasks are kernel objects (ADR 0013). */
const OBJECT_ID = /^obj_[0-9a-f]{32}$/

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
    run: q.get('run') ?? undefined,
    proposal: q.get('proposal') ?? undefined,
    package: PACKAGE_ID.test(q.get('package') ?? '') ? (q.get('package') as string) : undefined,
    task: OBJECT_ID.test(q.get('task') ?? '') ? (q.get('task') as string) : undefined,
    taskLayout: q.get('layout') === 'graph' ? 'graph' : undefined,
    decision: OBJECT_ID.test(q.get('decision') ?? '') ? (q.get('decision') as string) : undefined,
    lens: (LENSES as readonly string[]).includes(q.get('lens') ?? '')
      ? (q.get('lens') as Lens)
      : undefined,
    alternative: OBJECT_ID.test(q.get('alt') ?? '') ? (q.get('alt') as string) : undefined,
  }
}

/** The query string for a location. View-specific parameters are kept only for their view. */
export function formatLocation(loc: AppLocation): string {
  const q = new URLSearchParams()
  if (loc.project) q.set('project', loc.project)
  if (loc.view !== 'overview') q.set('view', loc.view)
  if (loc.revision !== undefined) q.set('rev', String(loc.revision))
  if (loc.selection) q.set('sel', loc.selection)
  if (loc.run && loc.view === 'navigator') q.set('run', loc.run)
  if (loc.proposal && loc.view === 'proposals') q.set('proposal', loc.proposal)
  if (loc.package && loc.view === 'handoff') q.set('package', loc.package)
  if (loc.task && loc.view === 'tasks') q.set('task', loc.task)
  if (loc.taskLayout === 'graph' && loc.view === 'tasks') q.set('layout', 'graph')
  if (loc.decision && loc.view === 'decisions') q.set('decision', loc.decision)
  if (loc.lens && loc.view === 'graph') q.set('lens', loc.lens)
  if (loc.alternative && loc.view === 'graph') q.set('alt', loc.alternative)
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
