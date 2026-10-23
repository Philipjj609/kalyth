import type { ObjectVersion } from '@kalyth/contracts'
import { Compass, Sparkles } from 'lucide-react'
import {
  useDemoSession,
  useNavigatorRun,
  useNavigatorRuns,
  useNavigatorStatus,
  useStartNavigatorRun,
} from '../api/queries.ts'
import { useSessionMode } from '../app/session.ts'
import { useWorkbench } from '../app/workbench.ts'
import { MockBadge, RunStatusBadge } from '../components/badges.tsx'
import { Button, SectionTitle, Spinner, Tip } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { relativeTime } from '../model/format.ts'
import { budgetWarnings, citationSummary, formatMicroUsd, isMockRun } from '../model/navigator.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'

/** Header chip: the provider and the remaining budget. Opens the Navigator view. */
export function NavigatorIndicator() {
  if (useSessionMode() === 'demo') return <DemoIndicator />
  return <LocalIndicator />
}

/** In the hosted demo: what runs cost this visitor, not the ledger behind a recording. */
function DemoIndicator() {
  const wb = useWorkbench()
  const view = useDemoSession().data
  if (!view) return null
  const text = view.live.available
    ? `${view.live.runsLeftToday} live ${view.live.runsLeftToday === 1 ? 'run' : 'runs'} left`
    : 'recorded runs'
  const summary = `Navigator: recorded runs are free; ${
    view.live.available ? `${text} today` : 'live runs are off'
  }`
  return (
    <Tip label={`${summary}. Open the Navigator (6)`}>
      <button
        type="button"
        aria-label={`${summary}. Open the Navigator`}
        onClick={() => wb.setView('navigator')}
        className="tone-neutral inline-flex h-7 items-center gap-1.5 rounded-md border border-tone-bd bg-tone-bg px-2 text-tone-fg text-xs transition-colors hover:brightness-[0.97]"
      >
        <Compass aria-hidden className="size-3.5" />
        <span>Nemotron</span>
        <span aria-hidden className="h-3 w-px bg-tone-bd" />
        <span className="tabular-nums">{text}</span>
      </button>
    </Tip>
  )
}

function LocalIndicator() {
  const wb = useWorkbench()
  const status = useNavigatorStatus(wb.projectId)
  const s = status.data
  if (!s) return null
  const warnings = budgetWarnings(s)
  const tone = warnings.some((w) => w.tone === 'danger')
    ? 'danger'
    : (warnings[0]?.tone ?? 'neutral')
  const remaining = formatMicroUsd(s.budget.remainingMicroUsd)
  // A free provider (the mock, or replaying recordings) never touches the budget, so its remainder
  // says nothing; "$0.0000 left" would read as if runs were blocked.
  const summary = s.provider.paid
    ? `Navigator provider ${s.provider.id}, ${remaining} of the budget remaining`
    : `Navigator provider ${s.provider.id}, free: its runs need no budget`
  return (
    <Tip
      label={
        <span className="block space-y-0.5">
          <span className="block">{summary}.</span>
          {warnings.map((w) => (
            <span key={w.text} className="block text-fg-muted">
              {w.text}
            </span>
          ))}
          <span className="block text-fg-subtle">Open the Navigator (6)</span>
        </span>
      }
    >
      <button
        type="button"
        aria-label={`${summary}. Open the Navigator`}
        onClick={() => wb.setView('navigator')}
        className={cn(
          `tone-${tone}`,
          'inline-flex h-7 items-center gap-1.5 rounded-md border border-tone-bd bg-tone-bg px-2 text-tone-fg text-xs transition-colors hover:brightness-[0.97]',
        )}
      >
        <Compass aria-hidden className="size-3.5" />
        <span className="font-mono">{s.provider.id}</span>
        <span aria-hidden className="h-3 w-px bg-tone-bd" />
        {s.provider.paid ? (
          <>
            <span className="font-mono tabular-nums">{remaining}</span>
            <span className="text-fg-muted">left</span>
          </>
        ) : (
          <span className="text-fg-muted">free</span>
        )}
      </button>
    </Tip>
  )
}

/**
 * "Summarise with Navigator" for a software element in the Inspector. Starts a summarize run and
 * follows the latest one for this element until it settles; the result is a pending proposal.
 */
export function SummariseAction({ object }: { object: ObjectVersion }) {
  const wb = useWorkbench()
  const status = useNavigatorStatus(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId, Boolean(status.data))
  const start = useStartNavigatorRun(wb.projectId)
  const latest = runs.data?.runs.find(
    (r) => r.input.kind === 'summarize' && r.input.elementId === object.id,
  )
  const shownId = start.data?.id ?? latest?.id
  const run = useNavigatorRun(wb.projectId, shownId).data
  if (!status.data) return null

  const needsConsent = status.data.consent.required && !status.data.consent.granted
  const running = start.isPending || run?.status === 'running'
  return (
    <section className="border-border border-b px-4 py-3">
      <SectionTitle>Navigator</SectionTitle>
      <p className="mb-2 text-fg-muted text-xs">
        A model summarises this element from its pinned evidence. The statements come back as a
        pending proposal of inferred claims for you to review.
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={running || needsConsent || wb.isHistorical}
        onClick={() => start.mutate({ kind: 'summarize', elementId: object.id })}
      >
        {running ? <Spinner label="Summarising" /> : <Sparkles aria-hidden />}
        Summarise with Navigator
      </Button>
      {wb.isHistorical && (
        <p className="mt-1.5 text-fg-muted text-xs">Runs work on the head; return to it first.</p>
      )}
      {needsConsent && !wb.isHistorical && (
        <p className="mt-1.5 text-fg-muted text-xs">
          The provider needs consent for this project.{' '}
          <AppLink to={{ view: 'navigator' }}>Open the Navigator</AppLink>
        </p>
      )}
      {start.isError && (
        <ErrorNotice error={start.error} title="The run was not started" className="mt-2" />
      )}
      {run && (
        <div
          role="status"
          className="mt-2 space-y-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-xs"
        >
          <p className="flex flex-wrap items-center gap-1.5">
            <RunStatusBadge status={run.status} size="sm" />
            {isMockRun(run) && <MockBadge size="sm" />}
            <span className="text-fg-subtle">{relativeTime(run.startedAt)}</span>
            <AppLink to={{ view: 'navigator', run: run.id }} className="ml-auto">
              Open run
            </AppLink>
          </p>
          {run.status !== 'running' && (
            <p className="text-fg-muted">
              Citations: {citationSummary(run.grounding)}
              {(run.grounding?.itemsRejected.length ?? 0) > 0 &&
                `, ${run.grounding?.itemsRejected.length} rejected`}
              {run.proposalId && (
                <>
                  {' '}
                  ·{' '}
                  <AppLink to={{ view: 'proposals', proposal: run.proposalId }}>
                    Review the proposal
                  </AppLink>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
