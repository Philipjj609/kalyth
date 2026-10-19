import type { ProjectSummary } from '@kalyth/contracts'
import * as Popover from '@radix-ui/react-popover'
import * as Tabs from '@radix-ui/react-tabs'
import {
  ChevronDown,
  Compass,
  FolderGit2,
  GitPullRequest,
  Handshake,
  ClockArrowLeft as HistoryIcon,
  Keyboard,
  LayoutDashboard,
  Monitor,
  Moon,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Scale,
  SquareKanban,
  Sun,
  Table2,
} from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  useFreshness,
  useHistory,
  useOverview,
  useProjects,
  useProposals,
  useRevisionModel,
} from '../api/queries.ts'
import { FreshnessBadge } from '../components/badges.tsx'
import { Button, Kbd, Spinner, Tip } from '../components/ui.tsx'
import { DecisionsView } from '../decisions/DecisionsView.tsx'
import { HandoffView } from '../handoff/HandoffView.tsx'
import { Inspector } from '../inspector/Inspector.tsx'
import { cn } from '../lib/cn.ts'
import { relativeTime } from '../model/format.ts'
import { NavigatorIndicator } from '../navigator/NavigatorActions.tsx'
import { NavigatorView } from '../navigator/NavigatorView.tsx'
import { TasksView } from '../tasks/TasksView.tsx'
import { HistoryView } from '../views/HistoryView.tsx'
import { OverviewView } from '../views/OverviewView.tsx'
import { ProjectsLanding } from '../views/ProjectsLanding.tsx'
import { ProposalsView } from '../views/ProposalsView.tsx'
import { RecordsView } from '../views/RecordsView.tsx'
import { ErrorNotice } from '../views/shared.tsx'
import { DemoBanner } from './DemoBanner.tsx'
import { useAppLocation, VIEWS, type View } from './location.ts'
import { type ThemePreference, theme, useTheme } from './theme.ts'
import {
  type RelationGroupSelection,
  useWorkbench as useContextWorkbench,
  type Workbench,
  WorkbenchContext,
} from './workbench.ts'

const GraphView = lazy(() => import('../graph/GraphView.tsx'))

const VIEW_META: Record<View, { label: string; icon: typeof Network }> = {
  overview: { label: 'Overview', icon: LayoutDashboard },
  graph: { label: 'Graph', icon: Network },
  records: { label: 'Records', icon: Table2 },
  proposals: { label: 'Proposals', icon: GitPullRequest },
  history: { label: 'History', icon: HistoryIcon },
  navigator: { label: 'Navigator', icon: Compass },
  handoff: { label: 'Handoff', icon: Handshake },
  tasks: { label: 'Tasks', icon: SquareKanban },
  decisions: { label: 'Decisions', icon: Scale },
}

const INSPECTOR_KEY = 'kalyth.inspector'

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

  // With exactly one project and none chosen, open it.
  useEffect(() => {
    if (loc.project === undefined && projectList?.length === 1 && projectList[0]) {
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
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    try {
      return window.localStorage.getItem(INSPECTOR_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const toggleInspector = useCallback((open?: boolean) => {
    setInspectorOpen((prev) => {
      const next = open ?? !prev
      try {
        window.localStorage.setItem(INSPECTOR_KEY, next ? 'open' : 'closed')
      } catch {
        // Not persisted.
      }
      return next
    })
  }, [])

  const select = useCallback(
    (id: string | undefined) => {
      setGroup(null)
      navigate({ selection: id }, 'replace')
      if (id) toggleInspector(true)
    },
    [navigate, toggleInspector],
  )
  const selectGroup = useCallback(
    (g: RelationGroupSelection) => {
      setGroup(g)
      navigate({ selection: undefined }, 'replace')
      toggleInspector(true)
    },
    [navigate, toggleInspector],
  )
  const setView = useCallback((view: View) => navigate({ view }), [navigate])
  const setRevision = useCallback(
    (rev: number | undefined) => navigate({ revision: rev }),
    [navigate],
  )

  // Keyboard shortcuts: 1-9 switch views, "/" focuses the view's search, "i" toggles the
  // Inspector, Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return
      const index = Number(e.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < VIEWS.length) {
        setView(VIEWS[index] as View)
        e.preventDefault()
      } else if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-view-search]')
        if (search) {
          search.focus()
          e.preventDefault()
        }
      } else if (e.key === 'i') {
        toggleInspector()
      } else if (e.key === 'Escape' && (loc.selection || group)) {
        select(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView, toggleInspector, select, loc.selection, group])

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

  return (
    <WorkbenchContext.Provider value={workbench}>
      <Frame
        projects={projects}
        currentId={projectId}
        revisionControl={<RevisionSelect />}
        actions={
          <>
            <NavigatorIndicator />
            <Tip label={inspectorOpen ? 'Hide Inspector (i)' : 'Show Inspector (i)'}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={inspectorOpen ? 'Hide Inspector' : 'Show Inspector'}
                aria-pressed={inspectorOpen}
                onClick={() => toggleInspector()}
              >
                {inspectorOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
              </Button>
            </Tip>
          </>
        }
      >
        <DemoBanner />
        <Tabs.Root
          value={loc.view}
          onValueChange={(v) => setView(v as View)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex h-10 shrink-0 items-center gap-3 border-border border-b bg-surface px-3">
            <Tabs.List aria-label="Workbench views" className="flex h-full items-stretch gap-1">
              {VIEWS.map((view, i) => {
                const { label, icon: Icon } = VIEW_META[view]
                return (
                  <Tabs.Trigger
                    key={view}
                    value={view}
                    className="group relative inline-flex items-center gap-1.5 px-2.5 font-medium text-fg-muted text-sm transition-colors hover:text-fg focus-visible:bg-surface-2 focus-visible:-outline-offset-2 data-[state=active]:text-fg"
                    title={`${label} (${i + 1})`}
                  >
                    <Icon aria-hidden className="size-4" />
                    {label}
                    {view === 'proposals' && pending !== undefined && pending > 0 && (
                      <span className="tone-warning rounded-full border border-tone-bd bg-tone-bg px-1.5 font-semibold text-2xs text-tone-fg tabular-nums">
                        <span className="sr-only">, pending: </span>
                        {pending}
                      </span>
                    )}
                    <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent opacity-0 transition-opacity group-data-[state=active]:opacity-100" />
                  </Tabs.Trigger>
                )
              })}
            </Tabs.List>
            <div className="ml-auto flex min-w-0 items-center gap-2 text-fg-muted text-xs">
              <FreshnessSummary />
              {model?.truncated && (
                <span className="tone-warning rounded border border-tone-bd bg-tone-bg px-1.5 text-tone-fg">
                  Showing the first 1,000 records
                </span>
              )}
            </div>
          </div>
          {workbench.isHistorical && <HistoricalBanner />}
          <div className="relative flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <Tabs.Content
                value="overview"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <OverviewView />
              </Tabs.Content>
              <Tabs.Content
                value="graph"
                className="min-h-0 flex-1 focus-visible:-outline-offset-2"
              >
                <Suspense fallback={<ViewLoading label="Loading the graph" />}>
                  <GraphView />
                </Suspense>
              </Tabs.Content>
              <Tabs.Content
                value="records"
                className="flex min-h-0 flex-1 flex-col focus-visible:-outline-offset-2"
              >
                <RecordsView />
              </Tabs.Content>
              <Tabs.Content
                value="proposals"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <ProposalsView />
              </Tabs.Content>
              <Tabs.Content
                value="history"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <HistoryView />
              </Tabs.Content>
              <Tabs.Content
                value="navigator"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <NavigatorView />
              </Tabs.Content>
              <Tabs.Content
                value="handoff"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <HandoffView />
              </Tabs.Content>
              <Tabs.Content
                value="tasks"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <TasksView />
              </Tabs.Content>
              <Tabs.Content
                value="decisions"
                className="relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
              >
                <DecisionsView />
              </Tabs.Content>
            </main>
            {inspectorOpen && (
              <aside
                aria-label="Inspector"
                className="flex w-[384px] shrink-0 flex-col border-border border-l bg-surface max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-30 max-[1180px]:shadow-pop"
              >
                <Inspector onClose={() => toggleInspector(false)} />
              </aside>
            )}
          </div>
        </Tabs.Root>
      </Frame>
    </WorkbenchContext.Provider>
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
  actions,
  children,
}: {
  projects: ProjectSummary[] | undefined
  currentId: string | undefined
  revisionControl?: ReactNode
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

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <rect width="32" height="32" rx="7" style={{ fill: 'var(--k-fg)' }} />
      <path
        d="M10 8v16M10 16l9-8M13.5 13l6.5 11"
        fill="none"
        style={{ stroke: 'var(--k-surface)' }}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22.5" cy="9.5" r="2.2" style={{ fill: 'var(--k-tone-observed-fg)' }} />
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
    [
      <>
        <Kbd>1</Kbd>–<Kbd>{VIEWS.length}</Kbd>
      </>,
      'Switch view',
    ],
    [<Kbd key="slash">/</Kbd>, 'Search in Graph or Records'],
    [<Kbd key="i">i</Kbd>, 'Show or hide the Inspector'],
    [<Kbd key="esc">Esc</Kbd>, 'Clear the selection'],
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
