import type { NavigatorRun, NavigatorStatus } from '@kalyth/contracts'
import { Compass, OctagonAlert, Sparkles, TriangleAlert } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { ApiError, toApiErrorBody } from '../api/client.ts'
import { liveRunState } from '../api/demo.ts'
import {
  useDemoSession,
  useNavigatorRun,
  useNavigatorRuns,
  useNavigatorStatus,
  useSetNavigatorConsent,
  useStartNavigatorRun,
} from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useSessionMode } from '../app/session.ts'
import { useWorkbench } from '../app/workbench.ts'
import { MockBadge, RunStatusBadge, StatusBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, EmptyState, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import {
  budgetUsed,
  budgetWarnings,
  citationSummary,
  isMockRun,
  providerFacts,
  RUN_KIND_LABEL,
  RUN_STATUS_META,
  runSubject,
} from '../model/navigator.ts'
import { AppLink, ErrorNotice, RecordLink, ViewHeader } from '../views/shared.tsx'
import { DemoPresets } from './DemoPresets.tsx'
import { ElementPicker } from './ElementPicker.tsx'
import { RunOutput } from './ProposedOutput.tsx'
import { GroundingReportPanel, ModelCallsPanel, OutputCountsPanel, Usd } from './RunReport.tsx'
import { SituationPanel } from './SituationPanel.tsx'

const MAX_FOCUS = 20
const REQUEST_MIN = 3
const REQUEST_MAX = 2000

export function NavigatorView() {
  const demo = useSessionMode() === 'demo'
  const wb = useWorkbench()
  const [loc] = useAppLocation()
  const status = useNavigatorStatus(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId, Boolean(status.data))
  const runList = runs.data?.runs
  const selectedRunId = loc.run ?? runList?.[0]?.id

  return (
    <div className="@container mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <ViewHeader
        title="Navigator"
        description="Describe what you want. The Navigator, a language model, proposes two to four ways to do it, what each one changes, and the questions that decide between them. Nothing is added to the model until you accept it."
      />
      {status.error ? (
        <ErrorNotice error={status.error} title="The Navigator status could not be loaded" />
      ) : status.isLoading ? (
        <Skeleton className="h-28" />
      ) : !status.data ? (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState icon={<Compass />} title="This server has no Navigator">
            The server answered that the Navigator routes do not exist. Update and restart the
            Kalyth server to use it.
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Side by side only when the view itself is wide: an open Inspector narrows it. */}
          <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="space-y-4">
              {demo && <DemoPresets runs={runList} />}
              <ChangeRequestForm status={status.data} runs={runList} />
            </div>
            <RecentRuns
              runs={runList}
              loading={runs.isLoading}
              error={runs.error}
              selectedId={selectedRunId}
            />
          </div>
          {selectedRunId && <RunDetail key={selectedRunId} runId={selectedRunId} />}
          <StatusStrip status={status.data} />
        </>
      )}
      <SituationPanel />
    </div>
  )
}

// ---------- status strip ----------

function Cell({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0 px-4 py-3', className)}>
      <h3 className="mb-1.5 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
        {label}
      </h3>
      {children}
    </div>
  )
}

function StatusStrip({ status }: { status: NavigatorStatus }) {
  const demo = useSessionMode() === 'demo'
  const { provider, budget, consent, models } = status
  const warnings = budgetWarnings(status)
  const used = budgetUsed(budget)
  const modelEntries = Object.entries(models)
  const meterTone = warnings.some((w) => w.tone === 'danger')
    ? 'danger'
    : (warnings[0]?.tone ?? 'accent')
  return (
    <section
      aria-label="Provider, budget and consent"
      className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] divide-x divide-border">
        <Cell label="Provider">
          {demo ? (
            <DemoProviderCell />
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono font-semibold text-sm">{provider.id}</span>
                <StatusBadge
                  size="sm"
                  tone={provider.external ? 'caution' : 'neutral'}
                  label={provider.external ? 'External' : 'Local'}
                  description={providerFacts(provider)[0]}
                  prefix="Location:"
                />
                <StatusBadge
                  size="sm"
                  tone={provider.paid ? 'warning' : 'success'}
                  label={provider.paid ? 'Paid' : 'Free'}
                  description={providerFacts(provider)[1]}
                  prefix="Cost:"
                />
                {provider.id === 'mock' && <MockBadge size="sm" />}
              </p>
              <p className="mt-1 text-fg-muted text-xs">{providerFacts(provider).join('. ')}.</p>
            </>
          )}
        </Cell>
        <Cell label="Models">
          {modelEntries.length === 0 ? (
            <p className="text-fg-subtle text-xs">None configured.</p>
          ) : (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              {modelEntries.map(([role, model]) => (
                <div key={role} className="contents">
                  <dt className="text-fg-muted">{role}</dt>
                  <dd className="truncate font-mono" title={model}>
                    {model}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Cell>
        <Cell label={demo ? 'Today’s allowance' : 'Budget'}>
          {demo ? (
            <DemoAllowanceCell />
          ) : (
            <>
              <dl className="grid grid-cols-4 gap-x-3 text-xs">
                {(
                  [
                    ['Cap', budget.capMicroUsd],
                    ['Spent', budget.spentMicroUsd],
                    ['Reserved', budget.reservedMicroUsd],
                    ['Remaining', budget.remainingMicroUsd],
                  ] as const
                ).map(([label, micro]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-fg-muted">{label}</dt>
                    <dd className={cn('text-sm', label === 'Remaining' && 'font-semibold')}>
                      <Usd micro={micro} />
                    </dd>
                  </div>
                ))}
              </dl>
              {used !== null && (
                <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <span
                    className={cn(`tone-${meterTone}`, 'block h-full rounded-full bg-tone-fg')}
                    style={{ width: `${used * 100}%` }}
                  />
                </div>
              )}
              <p className="mt-1.5 text-fg-subtle text-xs">
                {used !== null && <>{Math.round(used * 100)}% of the cap used · </>}
                {plural(budget.calls, 'call')} recorded
                {budget.capSetAt && (
                  <>
                    {' '}
                    · cap set{' '}
                    <time dateTime={budget.capSetAt} title={absoluteTime(budget.capSetAt)}>
                      {relativeTime(budget.capSetAt)}
                    </time>
                  </>
                )}
                {budget.capNote && <> · {budget.capNote}</>}. Reserved amounts count as spent.
              </p>
            </>
          )}
        </Cell>
      </div>
      {consent.required && (demo ? <DemoConsentRow /> : <ConsentRow status={status} />)}
      {warnings.length > 0 && (
        <ul aria-label="Budget warnings">
          {warnings.map((w) => (
            <li
              key={w.text}
              className={cn(
                `tone-${w.tone}`,
                'flex items-center gap-2 border-tone-bd border-t bg-tone-bg px-4 py-2 text-tone-fg text-xs',
              )}
            >
              {w.tone === 'danger' ? (
                <OctagonAlert aria-hidden className="size-4 shrink-0" />
              ) : (
                <TriangleAlert aria-hidden className="size-4 shrink-0" />
              )}
              <span>
                <span className="sr-only">Warning: </span>
                {w.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Shown only for providers that need consent (external ones). */
function ConsentRow({ status }: { status: NavigatorStatus }) {
  const wb = useWorkbench()
  const set = useSetNavigatorConsent(wb.projectId)
  const { consent, provider } = status
  return (
    <div
      className={cn(
        'border-t px-4 py-3',
        consent.granted ? 'border-border' : 'tone-warning border-tone-bd bg-tone-bg',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
          Consent
        </h3>
        <p className={cn('min-w-0 flex-1 text-sm', !consent.granted && 'text-tone-fg')}>
          {consent.granted ? (
            <>
              Granted
              {consent.grantedBy && (
                <>
                  {' '}
                  by <span className="font-mono text-xs">{shortId(consent.grantedBy)}</span>
                </>
              )}
              {consent.grantedAt && (
                <>
                  {' '}
                  <time dateTime={consent.grantedAt} title={absoluteTime(consent.grantedAt)}>
                    {relativeTime(consent.grantedAt)}
                  </time>
                </>
              )}
              . Excerpts of this project’s source are sent to{' '}
              <span className="font-mono">{provider.id}</span>.
            </>
          ) : (
            <>
              Not granted. <span className="font-mono">{provider.id}</span> receives excerpts of
              this project’s source, so a person must allow it for this project first.
            </>
          )}
        </p>
        <Button
          size="sm"
          variant={consent.granted ? 'secondary' : 'primary'}
          disabled={set.isPending}
          onClick={() => set.mutate(!consent.granted)}
        >
          {set.isPending && <Spinner label="Saving consent" />}
          {consent.granted ? 'Revoke consent' : 'Grant consent'}
        </Button>
      </div>
      {PROVIDER_NOTES[provider.id] && (
        <p className="mt-1.5 text-fg-muted text-xs">{PROVIDER_NOTES[provider.id]}</p>
      )}
      {set.isError && <ErrorNotice error={set.error} className="mt-2" />}
    </div>
  )
}

/** In the hosted demo, the operator consented once for this public project (ADR 0019). */
function DemoConsentRow() {
  return (
    <div className="border-border border-t px-4 py-3 text-sm">
      <h3 className="mb-1 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
        Consent
      </h3>
      <p>
        Granted by the demo’s operator for this project, which is built from a public repository.
        Live runs send excerpts of its source to Nebius Token Factory; please do not type personal
        data into a request.
      </p>
    </div>
  )
}

/**
 * In the hosted demo the provider is Nebius Token Factory, but most runs replay recordings: the
 * gateway's own flags (local, free) describe the replay, not where live runs go.
 */
function DemoProviderCell() {
  const demo = useDemoSession()
  const live = demo.data?.live.available ?? false
  return (
    <>
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-sm">Nebius Token Factory</span>
        <StatusBadge
          size="sm"
          tone="success"
          label="Recorded runs free"
          description="Recorded runs replay real Nemotron answers and cost nothing"
          prefix="Cost:"
        />
      </p>
      <p className="mt-1 text-fg-muted text-xs">
        Recorded runs replay here at no cost.{' '}
        {live
          ? 'Live runs go to Nebius Token Factory, within today’s allowance.'
          : 'Live runs are off in this demo.'}
      </p>
    </>
  )
}

/** The visitor's live runs and the pool's allowance today, instead of the ledger's cap. */
function DemoAllowanceCell() {
  const demo = useDemoSession()
  const view = demo.data
  if (!view) return <Skeleton className="h-10" />
  const state = liveRunState(view)
  return (
    <div className="space-y-1 text-xs">
      <p>
        {view.live.available
          ? `${view.live.runsLeftToday} of ${view.live.runsPerDay} live runs left for your copy.`
          : 'Live runs are off; recorded runs work.'}
      </p>
      <p>
        {view.live.pool === 'judges' ? 'Judges’' : 'Public'} allowance left today:{' '}
        <Usd micro={view.live.poolRemainingTodayMicroUsd} />. It resets at 00:00 UTC.
      </p>
      {!state.ok && <p className="text-fg-muted">{state.reason}</p>}
    </div>
  )
}

/** What a person should know before consenting to a provider (ADR 0016). */
const PROVIDER_NOTES: Record<string, string> = {
  openrouter:
    'OpenRouter’s free endpoints may log prompts or use them for training. Consent only for projects built from public repositories or synthetic data. Nebius remains the provider for competition work.',
}

// ---------- change request ----------

function ChangeRequestForm({
  status,
  runs,
}: {
  status: NavigatorStatus
  runs: readonly NavigatorRun[] | undefined
}) {
  const wb = useWorkbench()
  const [, navigate] = useAppLocation()
  const notify = useToast()
  const start = useStartNavigatorRun(wb.projectId)
  // A project with no software elements yet starts from an idea: the run proposes a first model,
  // starting from the idea the person wrote when creating the project (ADR 0022).
  const idea = !Object.entries(wb.overview.objectCounts).some(
    ([type, n]) => type.startsWith('software.') && n > 0,
  )
  const [request, setRequest] = useState(() =>
    idea ? wb.overview.project.description.slice(0, REQUEST_MAX) : '',
  )
  const [focus, setFocus] = useState<string[]>([])
  const requestId = useId()
  const hintId = useId()
  const focusHintId = useId()
  const inFlight = runs?.find((r) => r.status === 'running')
  const busy = start.isPending || inFlight !== undefined
  const needsConsent = status.consent.required && !status.consent.granted
  const trimmed = request.trim()
  const valid = trimmed.length >= REQUEST_MIN && trimmed.length <= REQUEST_MAX

  return (
    <Panel
      title="Change request"
      aside={<span className="text-fg-subtle text-xs">alternatives with typed impact</span>}
    >
      <form
        className="space-y-3 p-4"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || busy || needsConsent) return
          start.mutate(
            { kind: 'alternatives', request: trimmed, focus },
            {
              onSuccess: (run) => {
                setRequest('')
                setFocus([])
                // The change thread follows the run and offers its review when it is done. A run
                // that failed at once (paused, over budget) stays here, beside the reason.
                navigate(
                  run.input.kind === 'alternatives' && run.status !== 'failed'
                    ? { view: 'change', run: run.id, decision: undefined }
                    : { run: run.id },
                )
                notify({
                  tone: run.status === 'failed' ? 'danger' : 'neutral',
                  title: run.status === 'running' ? 'Navigator run started' : `Run ${run.status}`,
                  body: trimmed,
                })
              },
            },
          )
        }}
      >
        <div className="space-y-1">
          <label htmlFor={requestId} className="block font-medium text-xs">
            {idea ? 'What should it be?' : 'What should change?'}
          </label>
          <textarea
            id={requestId}
            aria-describedby={hintId}
            rows={4}
            minLength={REQUEST_MIN}
            maxLength={REQUEST_MAX}
            value={request}
            disabled={busy}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={
              idea
                ? 'For example: a tutoring platform where students book sessions with tutors'
                : 'For example: add multi-tenancy to the API'
            }
            className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm placeholder:text-fg-subtle disabled:bg-surface-2"
          />
          <p id={hintId} className="text-fg-muted text-xs">
            {idea
              ? 'The project has no elements yet. The model proposes two to four first designs, the new elements each one needs, and open questions. Your words are kept as what you said, never as an observation.'
              : 'The model proposes two to four alternatives, possibly with a hybrid of two of them, the elements each one changes or adds directly, and open questions. Kalyth computes the propagated impact itself.'}
          </p>
        </div>
        <fieldset className={cn('space-y-1.5', idea && 'hidden')}>
          <legend className="font-medium text-xs">
            Focus <span className="font-normal text-fg-muted">(optional)</span>
          </legend>
          <p id={focusHintId} className="text-fg-muted text-xs">
            Elements the model should consider first, up to {MAX_FOCUS}.
          </p>
          <ElementPicker
            value={focus}
            onChange={setFocus}
            max={MAX_FOCUS}
            disabled={busy}
            describedBy={focusHintId}
          />
        </fieldset>
        {needsConsent && (
          <p className="tone-warning rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
            Grant consent above before running: this provider receives project content.
          </p>
        )}
        {start.isError && <ErrorNotice error={start.error} title="The run was not started" />}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {inFlight && (
            <p role="status" className="mr-auto flex items-center gap-2 text-fg-muted text-xs">
              <Spinner label="Run in progress" />
              <span>
                A run is in progress. <AppLink to={{ run: inFlight.id }}>Show it</AppLink>
              </span>
            </p>
          )}
          <Button type="submit" variant="primary" disabled={!valid || busy || needsConsent}>
            {start.isPending ? (
              <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Starting" />
            ) : (
              <Sparkles aria-hidden />
            )}
            Propose alternatives
          </Button>
        </div>
      </form>
    </Panel>
  )
}

// ---------- runs ----------

function RecentRuns({
  runs,
  loading,
  error,
  selectedId,
}: {
  runs: readonly NavigatorRun[] | undefined
  loading: boolean
  error: unknown
  selectedId: string | undefined
}) {
  const wb = useWorkbench()
  const head = 'border-border border-b px-3 py-2 font-medium'
  const cell = 'border-border border-b px-3 py-2 align-top'
  return (
    <Panel
      title="Recent runs"
      aside={runs && <span className="text-fg-subtle text-xs">{runs.length}</span>}
    >
      {error ? (
        <div className="p-4">
          <ErrorNotice error={error} title="Runs could not be loaded" />
        </div>
      ) : loading || !runs ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState icon={<Compass />} title="No runs yet" className="py-10">
          Describe a change request, or summarise a software element from the Inspector.
        </EmptyState>
      ) : (
        <div className="max-h-[380px] overflow-auto scrollbar-thin">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Navigator runs, newest first</caption>
            <thead className="sticky top-0 z-10 bg-surface-2 text-left text-fg-muted text-xs">
              <tr>
                <th scope="col" className={head}>
                  Run
                </th>
                <th scope="col" className={head}>
                  Status
                </th>
                <th scope="col" className={cn(head, 'text-right')}>
                  Cost
                </th>
                <th scope="col" className={head}>
                  Citations
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const selected = run.id === selectedId
                const rejected = run.grounding?.itemsRejected.length ?? 0
                return (
                  <tr key={run.id} className={cn(selected && 'bg-accent-soft')}>
                    <td className={cn(cell, 'max-w-[280px]')}>
                      <AppLink
                        to={{ run: run.id }}
                        aria-current={selected ? 'true' : undefined}
                        className="block truncate py-0.5 font-medium"
                      >
                        {RUN_KIND_LABEL[run.input.kind] ?? run.input.kind}:{' '}
                        {runSubject(run, (id) => wb.model?.nameOf(id))}
                      </AppLink>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
                        <time dateTime={run.startedAt} title={absoluteTime(run.startedAt)}>
                          {relativeTime(run.startedAt)}
                        </time>
                        <span className="font-mono">{shortId(run.id)}</span>
                        {run.proposalId && (
                          <AppLink
                            to={{ view: 'proposals', proposal: run.proposalId }}
                            className="inline-flex min-h-6 items-center gap-1"
                          >
                            proposal <span className="font-mono">{shortId(run.proposalId)}</span>
                          </AppLink>
                        )}
                        {isMockRun(run) && <MockBadge size="sm" />}
                      </span>
                    </td>
                    <td className={cell}>
                      <RunStatusBadge status={run.status} size="sm" />
                    </td>
                    <td className={cn(cell, 'whitespace-nowrap text-right text-xs')}>
                      <Usd micro={run.costMicroUsd} />
                    </td>
                    <td className={cn(cell, 'whitespace-nowrap text-xs')}>
                      <span className="block">{citationSummary(run.grounding)}</span>
                      {rejected > 0 && (
                        <span className="tone-danger block font-medium text-tone-fg">
                          {rejected} rejected
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/** The run's error envelope as an ApiError, so ErrorNotice renders it like any API error. */
function runError(run: NavigatorRun): ApiError | null {
  if (!run.error) return null
  return new ApiError(0, toApiErrorBody(0, { error: run.error }))
}

function RunDetail({ runId }: { runId: string }) {
  const demo = useSessionMode() === 'demo'
  const wb = useWorkbench()
  const query = useNavigatorRun(wb.projectId, runId)
  const titleId = useId()
  const run = query.data
  if (query.error) {
    return <ErrorNotice error={query.error} title="This run could not be loaded" />
  }
  if (!run) return <Skeleton className="h-48" />
  if (run.projectId !== wb.projectId) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        Run <span className="font-mono">{shortId(run.id)}</span> belongs to another project.
      </p>
    )
  }
  const error = runError(run)
  const input = run.input
  const recorded = run.calls.length > 0 && run.calls.every((c) => c.recorded === true)
  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <header className="rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={run.status} />
          <span className="font-medium text-fg-muted text-xs">
            {RUN_KIND_LABEL[input.kind] ?? input.kind} run
          </span>
          {isMockRun(run) && <MockBadge />}
          {recorded && (
            <StatusBadge
              tone="success"
              label="Recorded Nemotron run"
              description="Replayed from a recording made earlier on this same project; nothing was sent or charged"
              prefix="Source:"
            />
          )}
          <span className="font-mono text-2xs text-fg-subtle">{shortId(run.id)}</span>
          <span role="status" className="sr-only">
            Run status: {RUN_STATUS_META[run.status]?.label ?? run.status}
          </span>
        </div>
        <h2
          id={titleId}
          className="mt-1.5 whitespace-pre-line break-words font-semibold text-[15px] text-fg leading-snug"
        >
          {input.kind === 'summarize' ? (
            <>
              Summary of <RecordLink id={input.elementId} />
            </>
          ) : (
            input.request
          )}
        </h2>
        {input.kind === 'alternatives' && (input.focus?.length ?? 0) > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-fg-muted">Focus:</span>
            {input.focus?.map((id) => (
              <span key={id} className="rounded border border-border px-1.5 py-0.5">
                <RecordLink id={id} />
              </span>
            ))}
          </p>
        )}
        <p className="mt-1.5 text-fg-muted text-xs">
          Requested by <span className="font-mono">{shortId(run.requestedBy)}</span> ·{' '}
          <time dateTime={run.startedAt} title={absoluteTime(run.startedAt)}>
            {relativeTime(run.startedAt)}
          </time>{' '}
          · base <span className="font-mono">r{run.baseRevision}</span> · cost{' '}
          <Usd micro={run.costMicroUsd} />
          {run.finishedAt && (
            <>
              {' '}
              · finished{' '}
              <time dateTime={run.finishedAt} title={absoluteTime(run.finishedAt)}>
                {relativeTime(run.finishedAt)}
              </time>
            </>
          )}
        </p>
        {run.status === 'running' && (
          <p className="mt-2 flex items-center gap-2 text-fg-muted text-xs">
            <Spinner label="Running" /> Running. This page checks the run about once a second.
          </p>
        )}
        {isMockRun(run) && (
          <p className="tone-caution mt-2 rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
            This run used the local mock provider. Its text is deterministic test output, not model
            output, and says nothing about this project.
          </p>
        )}
      </header>
      {error &&
        (demo && error.body.code === 'budget_exceeded' ? (
          <ErrorNotice
            error={
              new ApiError(0, {
                code: 'budget_exceeded',
                message:
                  'This request has no recording, and no live run is available for it now: your live runs for today, or today’s allowance, are used up. The recorded presets still run, and everything else in your copy works.',
                issues: [],
              })
            }
            title="Live runs are paused"
          />
        ) : (
          <ErrorNotice error={error} title="The run failed" />
        ))}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <GroundingReportPanel grounding={run.grounding} status={run.status} />
        <OutputCountsPanel output={run.output} />
      </div>
      {run.proposalId && <RunOutput run={run} />}
      <ModelCallsPanel calls={run.calls} totalMicroUsd={run.costMicroUsd} />
    </section>
  )
}
