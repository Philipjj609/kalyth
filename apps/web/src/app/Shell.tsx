import type { ProjectSummary } from '@kalyth/contracts'
import * as Popover from '@radix-ui/react-popover'
import {
  ChevronDown,
  FolderGit2,
  ClockArrowLeft as HistoryIcon,
  Keyboard,
  Monitor,
  Moon,
  Search,
  Sun,
} from 'lucide-react'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useFreshness,
  useHistory,
  useOverview,
  useProjects,
  useProposals,
  useRevisionModel,
} from '../api/queries.ts'
import { ChangeView } from '../change/ChangeThread.tsx'
import { CompareView } from '../change/CompareView.tsx'
import { FreshnessBadge } from '../components/badges.tsx'
import { Button, Kbd, Spinner, Tip } from '../components/ui.tsx'
import { Inspector } from '../inspector/Inspector.tsx'
import { cn } from '../lib/cn.ts'
import { relativeTime } from '../model/format.ts'
import { NavigatorIndicator } from '../navigator/NavigatorActions.tsx'
import { OverviewView } from '../views/OverviewView.tsx'
import { ProjectsLanding } from '../views/ProjectsLanding.tsx'
import { RecordsView } from '../views/RecordsView.tsx'
import { ErrorNotice } from '../views/shared.tsx'
import { DemoBanner } from './DemoBanner.tsx'
import { useAppLocation, type View } from './location.ts'
import { Palette } from './Palette.tsx'
import { PLACES, Rail } from './Rail.tsx'
import { type ThemePreference, theme, useTheme } from './theme.ts'
import {
  type RelationGroupSelection,
  useWorkbench as useContextWorkbench,
  type Workbench,
  WorkbenchContext,
} from './workbench.ts'

// Views loaded on first use, so the first screen stays light.
const GraphView = lazy(() => import('../graph/GraphView.tsx'))
const ProposalsView = lazy(() =>
  import('../views/ProposalsView.tsx').then((m) => ({ default: m.ProposalsView })),
)
const HistoryView = lazy(() =>
  import('../views/HistoryView.tsx').then((m) => ({ default: m.HistoryView })),
)
const NavigatorView = lazy(() =>
  import('../navigator/NavigatorView.tsx').then((m) => ({ default: m.NavigatorView })),
)
const HandoffView = lazy(() =>
  import('../handoff/HandoffView.tsx').then((m) => ({ default: m.HandoffView })),
)
const TasksView = lazy(() =>
  import('../tasks/TasksView.tsx').then((m) => ({ default: m.TasksView })),
)

const INSPECTOR_WIDTH_KEY = 'kalyth.inspector.width'
const RAIL_KEY = 'kalyth.rail'
const INSPECTOR_MIN = 300
const INSPECTOR_MAX = 680

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Not persisted.
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export function Shell() {
  const [loc, navigate] = useAppLocation()
  const projects = useProjects()
  const projectList = projects.data?.projects

  // With exactly one project and none chosen, open it once, on arrival. Asking for all projects
  // later stays on the list, where a person can start another project.
  const arrived = useRef(false)
  useEffect(() => {
    if (arrived.current || projectList === undefined) return
    arrived.current = true
    if (loc.project === undefined && projectList.length === 1 && projectList[0]) {
      navigate({ project: projectList[0].id }, 'replace')
    }
  }, [loc.project, projectList, navigate])

  if (loc.project === undefined) {
    return (
      <Frame projects={projectList} currentId={undefined}>
        <ProjectsLanding
          projects={projectList}
          loading={projects.isLoading}
          error={projects.error}
          onOpen={(id) =>
            navigate({ project: id, view: 'overview', selection: undefined, revision: undefined })
          }
        />
      </Frame>
    )
  }
  return <ProjectWorkbench key={loc.project} projectId={loc.project} projects={projectList} />
}

function ProjectWorkbench({
  projectId,
  projects,
}: {
  projectId: string
  projects: ProjectSummary[] | undefined
}) {
  const [loc, navigate] = useAppLocation()
  const overview = useOverview(projectId, loc.revision)
  const revision = overview.data?.revision
  const { model, isLoading, error } = useRevisionModel(projectId, revision)
  const freshness = useFreshness(projectId, revision)
  const proposals = useProposals(projectId)
  const [group, setGroup] = useState<RelationGroupSelection | null>(null)
  // The inspector shows what is selected and folds away when nothing is (ADR 0020).
  const inspectorOpen = loc.selection !== undefined || group !== null
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const n = Number(stored(INSPECTOR_WIDTH_KEY))
    return Number.isFinite(n) && n >= INSPECTOR_MIN && n <= INSPECTOR_MAX ? n : 384
  })
  const resizeInspector = useCallback((width: number) => {
    const w = Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, width)))
    setInspectorWidth(w)
    store(INSPECTOR_WIDTH_KEY, String(w))
  }, [])
  const [railFolded, setRailFolded] = useState(() => stored(RAIL_KEY) === 'folded')
  const toggleRail = useCallback(() => {
    setRailFolded((prev) => {
      store(RAIL_KEY, prev ? 'open' : 'folded')
      return !prev
    })
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)

  const select = useCallback(
    (id: string | undefined) => {
      setGroup(null)
      navigate({ selection: id }, 'replace')
    },
    [navigate],
  )
  const selectGroup = useCallback(
    (g: RelationGroupSelection) => {
      setGroup(g)
      navigate({ selection: undefined }, 'replace')
    },
    [navigate],
  )
  const setView = useCallback((view: View) => navigate({ view }), [navigate])
  const setRevision = useCallback(
    (rev: number | undefined) => navigate({ revision: rev }),
    [navigate],
  )

  // Keyboard: Ctrl+K or Cmd+K opens the palette; 1-9 reach the rail's places, "/" focuses the
  // view's search, Escape (or "i") clears the selection and folds the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        setPaletteOpen(true)
        e.preventDefault()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return
      const index = Number(e.key) - 1
      const place = Number.isInteger(index) && index >= 0 ? PLACES[index] : undefined
      if (place) {
        navigate(
          place.view === 'change'
            ? { view: 'change', decision: undefined, run: undefined }
            : { view: place.view },
        )
        e.preventDefault()
      } else if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-view-search]')
        if (search) {
          search.focus()
          e.preventDefault()
        }
      } else if ((e.key === 'Escape' || e.key === 'i') && (loc.selection || group)) {
        select(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, select, loc.selection, group])

  const pending = proposals.data?.proposals.filter((p) => p.status === 'pending').length

  if (overview.error && !overview.data) {
    return (
      <Frame projects={projects} currentId={projectId}>
        <div className="p-6">
          <ErrorNotice error={overview.error} title="This project could not be loaded" />
        </div>
      </Frame>
    )
  }
  if (!overview.data || revision === undefined) {
    return (
      <Frame projects={projects} currentId={projectId}>
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Loading project" />
        </div>
      </Frame>
    )
  }

  const headRevision = overview.data.project.headRevision
  const workbench: Workbench = {
    projectId,
    overview: overview.data,
    revision,
    headRevision,
    isHistorical: revision < headRevision,
    model,
    modelLoading: isLoading,
    modelError: error,
    freshness,
    selection: loc.selection,
    group,
    select,
    selectGroup,
    setView,
    setRevision,
  }

  const place = PLACES.find((p) => p.view === loc.view)
  return (
    <WorkbenchContext.Provider value={workbench}>
      <Frame
        projects={projects}
        currentId={projectId}
        revisionControl={<RevisionSelect />}
        search={<PaletteButton onOpen={() => setPaletteOpen(true)} />}
        actions={
          <>
            <FreshnessSummary />
            <NavigatorIndicator />
          </>
        }
      >
        <DemoBanner />
        {workbench.isHistorical && <HistoricalBanner />}
        {model?.truncated && (
          <p className="tone-warning border-tone-bd border-b bg-tone-bg px-4 py-1 text-tone-fg text-xs">
            Showing the first 1,000 records.
          </p>
        )}
        <div className="relative flex min-h-0 flex-1">
          <Rail collapsed={railFolded} onToggle={toggleRail} pendingProposals={pending} />
          <main
            aria-label={place?.label ?? (loc.view === 'compare' ? 'Compare' : 'Change')}
            className={cn(
              'relative flex min-h-0 min-w-0 flex-1 flex-col',
              loc.view !== 'graph' && 'overflow-auto',
            )}
          >
            <Suspense fallback={<ViewLoading label="Loading" />}>
              <CurrentView view={loc.view} />
            </Suspense>
          </main>
          {inspectorOpen && (
            <>
              <InspectorSplitter width={inspectorWidth} onResize={resizeInspector} />
              <aside
                aria-label="Inspector"
                style={{ width: inspectorWidth }}
                className="flex shrink-0 flex-col bg-surface max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-30 max-[1100px]:shadow-pop"
              >
                <Inspector onClose={() => select(undefined)} />
              </aside>
            </>
          )}
        </div>
        <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </Frame>
    </WorkbenchContext.Provider>
  )
}

function CurrentView({ view }: { view: View }) {
  switch (view) {
    case 'overview':
      return <OverviewView />
    case 'graph':
      return <GraphView />
    case 'records':
      return <RecordsView />
    case 'proposals':
      return <ProposalsView />
    case 'history':
      return <HistoryView />
    case 'navigator':
      return <NavigatorView />
    case 'handoff':
      return <HandoffView />
    case 'tasks':
      return <TasksView />
    case 'compare':
      return <CompareView />
    case 'change':
    case 'decisions':
      return <ChangeView />
  }
}

/** Drag, or use the arrow keys, to give the inspector or the view more room. */
function InspectorSplitter({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA separator pattern); an hr cannot take focus or pointer drags
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the inspector"
      aria-valuemin={INSPECTOR_MIN}
      aria-valuemax={INSPECTOR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(width + 24)
        else if (e.key === 'ArrowRight') onResize(width - 24)
        else return
        e.preventDefault()
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.width + start.current.x - e.clientX)
      }}
      onPointerUp={() => {
        start.current = null
      }}
      className="w-1.5 shrink-0 cursor-col-resize border-border border-l bg-surface hover:bg-accent-soft focus-visible:bg-accent-soft max-[1100px]:hidden"
    />
  )
}

function PaletteButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="ml-2 flex h-8 min-w-0 max-w-[420px] flex-[1_1_240px] items-center gap-2 rounded-md border border-border-strong bg-bg px-2.5 text-left text-fg-muted text-sm hover:border-fg-muted"
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="truncate">Search elements, changes or actions…</span>
      <span className="ml-auto shrink-0">
        <Kbd>Ctrl K</Kbd>
      </span>
    </button>
  )
}

function ViewLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-fg-muted">
      <Spinner label={label} />
      <span>{label}…</span>
    </div>
  )
}

// ---------- frame and top bar ----------

function Frame({
  projects,
  currentId,
  revisionControl,
  search,
  actions,
  children,
}: {
  projects: ProjectSummary[] | undefined
  currentId: string | undefined
  revisionControl?: ReactNode
  search?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const [, navigate] = useAppLocation()
  return (
    <div className="flex h-full min-w-[1024px] flex-col bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-1.5"
      >
        Skip to content
      </a>
      <header className="flex h-12 shrink-0 items-center gap-3 border-border border-b bg-surface px-3">
        <button
          type="button"
          onClick={() =>
            navigate({
              project: undefined,
              selection: undefined,
              revision: undefined,
              view: 'overview',
            })
          }
          className="flex items-center gap-2 rounded-md px-1 py-1 font-semibold text-fg tracking-tight"
          aria-label="Kalyth: all projects"
        >
          <Logo />
          <span className="text-[15px]">Kalyth</span>
        </button>
        <span aria-hidden className="h-5 w-px bg-border" />
        <ProjectSwitcher projects={projects} currentId={currentId} />
        {revisionControl}
        {search}
        <div className="ml-auto flex items-center gap-1">
          <ShortcutsHelp />
          <ThemeToggle />
          {actions}
        </div>
      </header>
      <div id="main" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  )
}

/** A drafting mark: a sheet with a K in ink and a cobalt signal point. */
function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <rect
        x="1.25"
        y="1.25"
        width="21.5"
        height="21.5"
        style={{ fill: 'none', stroke: 'var(--k-fg)' }}
        strokeWidth="1.5"
      />
      <path
        d="M8 6v12M8 12.5l7-6.5M10.8 10.4l5.2 7.6"
        fill="none"
        style={{ stroke: 'var(--k-fg)' }}
        strokeWidth="1.6"
      />
      <circle cx="17.5" cy="6.5" r="1.4" style={{ fill: 'var(--k-accent)' }} />
    </svg>
  )
}

function ProjectSwitcher({
  projects,
  currentId,
}: {
  projects: ProjectSummary[] | undefined
  currentId: string | undefined
}) {
  const [, navigate] = useAppLocation()
  const [open, setOpen] = useState(false)
  const current = projects?.find((p) => p.id === currentId)
  if (currentId === undefined) {
    return <span className="font-medium text-fg-muted">Projects</span>
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" className="max-w-[320px] px-2 text-fg" aria-label="Switch project">
          <FolderGit2 aria-hidden />
          <span className="truncate font-semibold">{current?.name ?? 'Project'}</span>
          <ChevronDown aria-hidden className="text-fg-subtle" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[360px] rounded-lg border border-border bg-surface p-1 shadow-pop"
        >
          <p className="px-2 pt-1.5 pb-1 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
            Projects
          </p>
          <ul className="relative max-h-[360px] overflow-auto scrollbar-thin">
            {(projects ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-current={p.id === currentId ? 'true' : undefined}
                  onClick={() => {
                    setOpen(false)
                    navigate({
                      project: p.id,
                      selection: undefined,
                      revision: undefined,
                      run: undefined,
                      proposal: undefined,
                      package: undefined,
                      task: undefined,
                      decision: undefined,
                    })
                  }}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2',
                    p.id === currentId && 'bg-accent-soft',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-2xs text-fg-subtle">
                      r{p.headRevision}
                    </span>
                  </span>
                  {p.description && (
                    <span className="line-clamp-1 text-fg-muted text-xs">{p.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function RevisionSelect() {
  const wb = useContextWorkbench()
  const history = useHistory(wb.projectId)
  const options = useMemo(() => {
    const byRevision = new Map((history.data?.changeSets ?? []).map((c) => [c.revision, c]))
    const list: { value: number; label: string }[] = []
    for (let r = wb.headRevision; r >= 0; r--) {
      const c = byRevision.get(r)
      list.push({
        value: r,
        label:
          r === 0
            ? 'r0 · project created'
            : c
              ? `r${r} · ${c.origin} · ${relativeTime(c.committedAt)}`
              : `r${r}`,
      })
    }
    return list
  }, [history.data, wb.headRevision])
  return (
    <label className="flex items-center gap-2 text-fg-muted text-xs">
      <span>Revision</span>
      <select
        className={cn(
          'select-control h-7 rounded-md border bg-surface pl-2 font-mono text-xs',
          wb.isHistorical
            ? 'tone-warning border-tone-bd bg-tone-bg text-tone-fg'
            : 'border-border-strong text-fg',
        )}
        value={wb.isHistorical ? String(wb.revision) : 'head'}
        onChange={(e) =>
          wb.setRevision(e.target.value === 'head' ? undefined : Number(e.target.value))
        }
      >
        <option value="head">Head (r{wb.headRevision})</option>
        {options.slice(1).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function HistoricalBanner() {
  const wb = useContextWorkbench()
  return (
    <div
      role="status"
      className="tone-warning flex h-9 shrink-0 items-center gap-3 border-tone-bd border-b bg-tone-bg px-4 text-tone-fg text-xs"
    >
      <HistoryIcon aria-hidden className="size-4" />
      <span>
        Viewing revision <strong className="font-semibold">r{wb.revision}</strong>, read-only. The
        head is r{wb.headRevision}. Proposals and actions always apply to the head.
      </span>
      <Button size="sm" className="ml-auto" onClick={() => wb.setRevision(undefined)}>
        Return to head
      </Button>
    </div>
  )
}

function FreshnessSummary() {
  const wb = useContextWorkbench()
  if (!wb.freshness.available || !wb.freshness.report) return null
  const s = wb.freshness.report.summary
  const order = ['stale', 'derived-stale', 'weakened'] as const
  const shown = order.filter((k) => (s[k] ?? 0) > 0)
  if (shown.length === 0) {
    return <FreshnessBadge status="current" size="sm" />
  }
  return (
    <span className="flex items-center gap-1">
      {shown.map((k) => (
        <span key={k} className="flex items-center gap-1">
          <FreshnessBadge status={k} size="sm" />
          <span className="tabular-nums">{s[k]}</span>
        </span>
      ))}
    </span>
  )
}

const THEME_CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

function ThemeToggle() {
  const { preference } = useTheme()
  const Icon = preference === 'system' ? Monitor : preference === 'light' ? Sun : Moon
  const label = `Theme: ${preference}. Switch to ${THEME_CYCLE[preference]}`
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={() => theme.set(THEME_CYCLE[preference])}
      >
        <Icon aria-hidden />
      </Button>
    </Tip>
  )
}

function ShortcutsHelp() {
  const rows: [ReactNode, string][] = [
    [<Kbd key="k">Ctrl K</Kbd>, 'Search elements, changes or actions'],
    [
      <>
        <Kbd>1</Kbd>–<Kbd>{PLACES.length}</Kbd>
      </>,
      'Go to a place in the rail',
    ],
    [<Kbd key="slash">/</Kbd>, 'Search in the canvas or the records'],
    [<Kbd key="esc">Esc</Kbd>, 'Clear the selection and fold the inspector'],
    [
      <>
        <Kbd>Tab</Kbd> <Kbd>Enter</Kbd>
      </>,
      'Move between and select graph nodes',
    ],
  ]
  return (
    <Popover.Root>
      <Tip label="Keyboard shortcuts">
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="Keyboard shortcuts">
            <Keyboard aria-hidden />
          </Button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-72 rounded-lg border border-border bg-surface p-3 shadow-pop"
        >
          <p className="mb-2 font-semibold text-sm">Keyboard shortcuts</p>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
            {rows.map(([keys, what]) => (
              <div key={what} className="contents">
                <dt className="flex items-center gap-1">{keys}</dt>
                <dd className="text-fg-muted">{what}</dd>
              </div>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
