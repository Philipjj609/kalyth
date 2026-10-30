import {
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  ClockArrowLeft,
  Compass,
  GitPullRequest,
  Handshake,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Plus,
  Scale,
  SquareKanban,
  Table2,
} from 'lucide-react'
import { useMemo } from 'react'
import { useDecisions, useNavigatorRuns, useProposals } from '../api/queries.ts'
import { changeItems, openQuestions } from '../change/model.ts'
import { Tip } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { type AppLocation, formatLocation, useAppLocation, type View } from './location.ts'
import { useWorkbench } from './workbench.ts'

/** The workspace's places, in the order number keys reach them. */
export const PLACES: { view: View; label: string; icon: LucideIcon; group: 'work' | 'records' }[] =
  [
    { view: 'overview', label: 'Situation', icon: LayoutDashboard, group: 'work' },
    { view: 'graph', label: 'Canvas', icon: Network, group: 'work' },
    { view: 'change', label: 'Changes', icon: Scale, group: 'work' },
    { view: 'navigator', label: 'New change', icon: Compass, group: 'work' },
    { view: 'records', label: 'Records', icon: Table2, group: 'records' },
    { view: 'proposals', label: 'Proposals', icon: GitPullRequest, group: 'records' },
    { view: 'tasks', label: 'Tasks', icon: SquareKanban, group: 'records' },
    { view: 'handoff', label: 'Agents and packages', icon: Handshake, group: 'records' },
    { view: 'history', label: 'History', icon: ClockArrowLeft, group: 'records' },
    // Last, so the number keys 1 to 9 keep the places they had before K5; it shows with the work.
    { view: 'knowledge', label: 'Knowledge', icon: BookOpen, group: 'work' },
  ]

const MAX_CHANGES = 8

/**
 * The left rail (ADR 0020): where you are, the changes in flight, and the records that stay
 * reachable on their own. It folds to icons so the canvas can take the room.
 */
export function Rail({
  collapsed,
  onToggle,
  pendingProposals,
}: {
  collapsed: boolean
  onToggle: () => void
  pendingProposals: number | undefined
}) {
  const wb = useWorkbench()
  const [loc, navigate] = useAppLocation()
  const decisions = useDecisions(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId)
  const proposals = useProposals(wb.projectId)
  const changes = useMemo(
    () =>
      changeItems(
        decisions.data?.decisions ?? [],
        runs.data?.runs ?? [],
        proposals.data?.proposals ?? [],
        (id) => openQuestions(wb.model, id).length,
      ),
    [decisions.data, runs.data, proposals.data, wb.model],
  )
  const go = (to: Partial<AppLocation>) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  const href = (to: Partial<AppLocation>) => formatLocation({ ...loc, ...to }) || '?'
  const place = (p: (typeof PLACES)[number], i: number) => {
    const active =
      loc.view === p.view ||
      (p.view === 'change' && (loc.view === 'compare' || loc.view === 'decisions'))
    const to: Partial<AppLocation> =
      p.view === 'change'
        ? { view: 'change', decision: undefined, run: undefined }
        : { view: p.view }
    const badge = p.view === 'proposals' && pendingProposals ? pendingProposals : undefined
    const link = (
      <a
        href={href(to)}
        onClick={go(to)}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? `${p.label}${badge ? `, ${badge} pending` : ''}` : undefined}
        className={cn('k-rail-link', active && 'k-rail-active')}
        title={collapsed ? undefined : i < 9 ? `${p.label} (${i + 1})` : p.label}
      >
        <p.icon aria-hidden className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{p.label}</span>}
        {!collapsed && badge !== undefined && (
          <span className="ml-auto rounded-full border border-border px-1.5 font-mono text-2xs tabular-nums">
            <span className="sr-only">pending: </span>
            {badge}
          </span>
        )}
      </a>
    )
    return (
      <li key={p.view}>
        {collapsed ? (
          <Tip label={`${p.label} (${i + 1})`} side="right">
            {link}
          </Tip>
        ) : (
          link
        )}
      </li>
    )
  }
  const work = PLACES.filter((p) => p.group === 'work')
  const records = PLACES.filter((p) => p.group === 'records')
  return (
    <nav
      aria-label="Workspace"
      className={cn(
        'flex shrink-0 flex-col border-border border-r bg-surface',
        collapsed ? 'w-14 items-center' : 'w-[248px]',
      )}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-3 scrollbar-thin">
        <ul className="space-y-0.5">{work.map((p) => place(p, PLACES.indexOf(p)))}</ul>
        {!collapsed && (
          <section aria-labelledby="rail-changes" className="space-y-1.5">
            <div className="flex items-center justify-between px-2">
              <h2 id="rail-changes" className="k-eyebrow">
                In flight
              </h2>
              <a
                href={href({ view: 'navigator' })}
                onClick={go({ view: 'navigator' })}
                className="flex items-center gap-1 text-accent text-xs"
              >
                <Plus aria-hidden className="size-3.5" />
                New
              </a>
            </div>
            {changes.length === 0 ? (
              <p className="px-2 text-fg-muted text-xs">No changes yet.</p>
            ) : (
              <ul className="space-y-1">
                {changes.slice(0, MAX_CHANGES).map((c) => {
                  const to: Partial<AppLocation> =
                    c.ref.kind === 'decision'
                      ? { view: 'change', decision: c.ref.id, run: undefined }
                      : { view: 'change', run: c.ref.id, decision: undefined }
                  const active =
                    (loc.view === 'change' || loc.view === 'compare') &&
                    (c.ref.kind === 'decision' ? loc.decision === c.ref.id : loc.run === c.ref.id)
                  return (
                    <li key={`${c.ref.kind}:${c.ref.id}`}>
                      <a
                        href={href(to)}
                        onClick={go(to)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'block border px-2.5 py-2 text-left',
                          active ? 'border-fg bg-bg' : 'border-border hover:border-border-strong',
                        )}
                      >
                        <span className="line-clamp-2 font-medium text-[13px] leading-snug">
                          {c.title}
                        </span>
                        <span
                          className={cn(
                            'mt-0.5 block text-xs',
                            c.needsYou ? 'text-fg' : 'text-fg-muted',
                          )}
                        >
                          {c.status}
                        </span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
        <section aria-labelledby="rail-records" className="space-y-1">
          {!collapsed && (
            <h2 id="rail-records" className="k-eyebrow px-2">
              Records
            </h2>
          )}
          <ul className="space-y-0.5" aria-label={collapsed ? 'Records' : undefined}>
            {records.map((p) => place(p, PLACES.indexOf(p)))}
          </ul>
        </section>
      </div>
      <div className="border-border border-t p-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand the rail' : 'Fold the rail to icons'}
          aria-expanded={!collapsed}
          className="k-rail-link w-full"
        >
          {collapsed ? (
            <ChevronsRight aria-hidden className="size-4" />
          ) : (
            <ChevronsLeft aria-hidden className="size-4" />
          )}
          {!collapsed && <span>Fold</span>}
        </button>
      </div>
    </nav>
  )
}
