import type { DecisionSummary, NavigatorRun, TaskView } from '@kalyth/contracts'
import { ArrowRight, Check, Columns3, Network, PackagePlus } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import {
  useAcceptAlternative,
  useCommitProposal,
  useCompileContext,
  useContextPackages,
  useDecisions,
  useNavigatorRuns,
  useProposal,
  useProposals,
  useRejectProposal,
  useTasks,
} from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { ConfidenceBadge, DecisionStatusBadge, TaskStatusBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, Spinner } from '../components/ui.tsx'
import { ExploreAgain, QuestionList } from '../decisions/DecisionsView.tsx'
import { cn } from '../lib/cn.ts'
import { type ComparedAlternative, compareAlternatives } from '../model/compare.ts'
import { citationSummary } from '../model/navigator.ts'
import { EMPTY_TASK_DRAFT } from '../model/tasks.ts'
import { AcceptDialog, RunOutput } from '../navigator/ProposedOutput.tsx'
import { useFileReport, useReconcileTask } from '../tasks/api.ts'
import { CreateTaskForm } from '../tasks/CreateTaskForm.tsx'
import { canReconcile, ReconcileAction, ReportAction, verifiedReport } from '../tasks/FollowUp.tsx'
import { AgentPrompt } from '../tasks/TaskDetail.tsx'
import { AppLink, ButtonLink, ErrorNotice, RecordLink, withoutHandles } from '../views/shared.tsx'
import {
  acceptedAlternative,
  changeItems,
  lead,
  type NextStep,
  nextStep,
  openQuestions,
  runOfDecision,
  STAGES,
  type Stage,
  tradeoffLevels,
} from './model.ts'

const STAGE_LABEL: Record<Stage, string> = {
  ask: 'Ask',
  alternatives: 'Alternatives',
  questions: 'Questions',
  decide: 'Decide',
  handoff: 'Hand off',
  work: 'Agent work',
  reconcile: 'Reconcile',
}

const DECISIVE = new Set(['blocking', 'decision-sensitive'])

/**
 * One change request followed from the question to reconciliation (ADR 0020): a decision once a
 * person committed the Navigator's proposal, or a run whose proposal still awaits review.
 */
export function ChangeView() {
  const [loc] = useAppLocation()
  if (loc.decision) return <DecisionThread key={loc.decision} decisionId={loc.decision} />
  if (loc.run) return <RunThread key={loc.run} runId={loc.run} />
  return <ChangeIndex />
}

// ---------- every change ----------

function ChangeIndex() {
  const wb = useWorkbench()
  const decisions = useDecisions(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId)
  const proposals = useProposals(wb.projectId)
  const items = useMemo(
    () =>
      changeItems(
        decisions.data?.decisions ?? [],
        runs.data?.runs ?? [],
        proposals.data?.proposals ?? [],
        (id) => openQuestions(wb.model, id).length,
      ),
    [decisions.data, runs.data, proposals.data, wb],
  )
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="k-eyebrow">Changes</p>
          <h1 className="font-semibold text-2xl tracking-tight">What is changing in this system</h1>
        </div>
        <ButtonLink to={{ view: 'navigator' }}>New change</ButtonLink>
      </div>
      {decisions.isLoading ? (
        <Spinner label="Loading changes" />
      ) : items.length === 0 ? (
        <p className="text-fg-muted">
          No changes yet. Describe one to the Navigator, or start from the canvas.
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border bg-surface">
          {items.map((c) => (
            <li key={`${c.ref.kind}:${c.ref.id}`}>
              <AppLink
                to={
                  c.ref.kind === 'decision'
                    ? { view: 'change', decision: c.ref.id, run: undefined }
                    : { view: 'change', run: c.ref.id, decision: undefined }
                }
                className="flex flex-col gap-0.5 px-4 py-3 text-fg no-underline hover:bg-surface-2"
              >
                <span className="font-medium">{c.title}</span>
                <span className="text-fg-muted text-xs">{c.status}</span>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------- a run awaiting review ----------

function RunThread({ runId }: { runId: string }) {
  const wb = useWorkbench()
  const [, navigate] = useAppLocation()
  const runs = useNavigatorRuns(wb.projectId)
  const run = runs.data?.runs.find((r) => r.id === runId)
  const proposal = useProposal(run?.proposalId)
  const commit = useCommitProposal(wb.projectId)
  const reject = useRejectProposal(wb.projectId)
  const notify = useToast()
  if (!run) {
    return runs.isLoading ? (
      <div className="p-8">
        <Spinner label="Loading the change" />
      </div>
    ) : (
      <p className="p-8 text-fg-muted">This Navigator run is not in the project’s recent runs.</p>
    )
  }
  const request = run.input.kind === 'alternatives' ? run.input.request : 'Summary'
  const pending = proposal.data?.status === 'pending'
  const decisionId = proposal.data?.ops.find(
    (op) => op.op === 'createObject' && op.type === 'core.Decision',
  )?.id
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-8">
      <header className="space-y-2">
        <p className="k-eyebrow">Change · proposed by the Navigator · awaiting your review</p>
        <h1 className="font-semibold text-2xl leading-tight tracking-tight">{request}</h1>
        <Stated by="you" what="the request">
          {request}
        </Stated>
      </header>
      <NextStepCallout
        step={
          pending
            ? {
                text: 'Review the proposed alternatives, then commit them to start comparing',
                detail:
                  'Nothing is in the model until you commit. Rejecting keeps the run record and adds nothing.',
                stage: 'alternatives',
                tone: 'action',
              }
            : {
                text: proposal.data?.status === 'committed' ? 'Committed' : 'Not committed',
                stage: 'alternatives',
                tone: 'done',
              }
        }
        action={
          pending && run.proposalId ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={commit.isPending}
                onClick={() =>
                  commit.mutate(run.proposalId as string, {
                    onSuccess: () => {
                      notify({ tone: 'success', title: 'Committed: the change is in the model' })
                      if (decisionId)
                        navigate({ view: 'change', decision: decisionId, run: undefined })
                    },
                  })
                }
              >
                <Check aria-hidden />
                Commit the alternatives
              </Button>
              <Button
                disabled={reject.isPending}
                onClick={() =>
                  reject.mutate({
                    proposalId: run.proposalId as string,
                    reason: 'Rejected in the change thread',
                  })
                }
              >
                Reject
              </Button>
            </div>
          ) : decisionId ? (
            <AppLink to={{ view: 'change', decision: decisionId, run: undefined }}>
              Open the decision
            </AppLink>
          ) : null
        }
      />
      {commit.error ? <ErrorNotice error={commit.error} title="Not committed" /> : null}
      <RunLine run={run} />
      <RunOutput run={run} />
    </div>
  )
}

// ---------- a decision ----------

function DecisionThread({ decisionId }: { decisionId: string }) {
  const wb = useWorkbench()
  const decisions = useDecisions(wb.projectId)
  const runs = useNavigatorRuns(wb.projectId)
  const proposals = useProposals(wb.projectId)
  const packages = useContextPackages(wb.projectId)
  const tasks = useTasks(wb.projectId)
  const decision = decisions.data?.decisions.find((d) => d.id === decisionId)

  if (!decision) {
    return decisions.isLoading ? (
      <div className="p-8">
        <Spinner label="Loading the change" />
      </div>
    ) : (
      <p className="p-8 text-fg-muted">No decision with this id at the viewed revision.</p>
    )
  }
  const run = runOfDecision(decision.id, runs.data?.runs ?? [], proposals.data?.proposals ?? [])
  const comparison = compareAlternatives(decision, {
    objectById: wb.model?.objectById ?? new Map(),
    relations: wb.model?.relations ?? [],
  })
  const questions = [
    ...comparison.questions,
    ...comparison.alternatives.flatMap((a) => a.questions),
  ].filter((q, i, all) => all.findIndex((x) => x.id === q.id) === i)
  const open = questions.filter((q) => q.status === 'open')
  const decisive = open.filter((q) => DECISIVE.has(q.inquiryRole))
  const ownPackages = (packages.data?.packages ?? []).filter((p) => p.focus.includes(decision.id))
  const step = nextStep({
    decision,
    decisiveOpen: decisive.length,
    questionsOpen: open.length,
    hasPackage: ownPackages.length > 0,
  })
  const implementing = (tasks.data?.tasks ?? []).filter((t) =>
    t.implements.some(
      (i) => i.id === decision.id || decision.alternatives.some((a) => a.id === i.id),
    ),
  )

  return (
    <div className="flex min-h-full flex-wrap items-stretch">
      <div className="min-w-0 flex-[999_1_560px] space-y-6 px-8 pt-6 pb-16">
        <ThreadHeader decision={decision} run={run} />
        <NextStepCallout step={step} action={<StepAction step={step} decision={decision} />} />
        <StageRail current={step.stage} decision={decision} />

        <Section stage="ask" title="Ask" aside={run ? <RunLine run={run} compact /> : null}>
          {run ? (
            <p className="text-fg-muted text-sm">
              Proposed by the Navigator from your request. Everything below marked inferred is its
              interpretation; the source excerpts it cites are observed.
            </p>
          ) : (
            <p className="text-fg-muted text-sm">
              This decision was stated directly, without a Navigator run.
            </p>
          )}
        </Section>

        <Section
          stage="alternatives"
          title={`Alternatives · ${comparison.alternatives.length}`}
          aside={
            <AppLink to={{ view: 'compare', decision: decision.id }}>
              <Columns3 aria-hidden className="mr-1 inline size-4" />
              Compare side by side
            </AppLink>
          }
        >
          <ol className="space-y-3">
            {comparison.alternatives.map((alt, i) => (
              <li key={alt.id}>
                <AlternativeCard
                  alternative={alt}
                  index={i}
                  summary={decision.alternatives.find((a) => a.id === alt.id)}
                  nameOf={(id) => {
                    const j = comparison.alternatives.findIndex((a) => a.id === id)
                    return j >= 0 ? `A${j + 1}` : (wb.model?.nameOf(id) ?? 'an alternative')
                  }}
                />
              </li>
            ))}
          </ol>
          {decision.status === 'open' && !wb.isHistorical && (
            <ExploreAgain
              decision={decision}
              answered={questions.filter((q) => q.status === 'answered').length}
            />
          )}
        </Section>

        <Section stage="questions" title={`Questions · ${open.length} open`}>
          {questions.length === 0 ? (
            <p className="text-fg-muted text-sm">The Navigator raised no questions.</p>
          ) : (
            <>
              <p className="text-fg-muted text-sm">
                Pick a suggested answer or write your own. Answers are kept as what you said, so a
                later run can use them; they never count as observations of the code.
              </p>
              <div className="border border-border bg-surface">
                <QuestionList
                  questions={questions}
                  answerable={decision.status === 'open' && !wb.isHistorical}
                />
              </div>
            </>
          )}
        </Section>

        <Section stage="decide" title="Decide">
          <DecideStage
            decision={decision}
            alternatives={comparison.alternatives}
            decisiveOpen={decisive.map((q) => q.text)}
          />
        </Section>

        <Section stage="handoff" title="Hand off">
          <HandoffStage
            decision={decision}
            packages={ownPackages}
            tasks={tasks.data?.tasks ?? []}
          />
        </Section>

        <Section stage="work" title="Agent work">
          <WorkStage decision={decision} tasks={implementing} />
        </Section>

        <Section stage="reconcile" title="Reconcile">
          <ReconcileStage decision={decision} tasks={implementing} />
        </Section>
      </div>
      <aside
        aria-label="Where this change stands"
        className="w-full flex-[1_1_280px] border-border border-l bg-surface min-[1100px]:max-w-[320px]"
      >
        <div className="sticky top-0 space-y-5 px-5 py-6">
          <Facets decision={decision} />
          <div className="space-y-2">
            <AppLink
              to={{
                view: 'graph',
                lens: 'impact',
                alternative: (acceptedAlternative(decision) ?? decision.alternatives.at(-1))?.id,
              }}
            >
              <Network aria-hidden className="mr-1 inline size-4" />
              Open on the canvas
            </AppLink>
          </div>
        </div>
      </aside>
    </div>
  )
}

function ThreadHeader({
  decision,
  run,
}: {
  decision: DecisionSummary
  run: NavigatorRun | undefined
}) {
  const request = run?.input.kind === 'alternatives' ? run.input.request : null
  return (
    <header className="space-y-2">
      <p className="k-eyebrow">
        Change · {decision.status}
        {run ? ` · started ${new Date(run.startedAt).toLocaleDateString()}` : ''}
      </p>
      <h1 className="max-w-4xl font-semibold text-2xl leading-tight tracking-tight">
        {decision.title || decision.question}
      </h1>
      {decision.question && decision.title && (
        <p className="max-w-3xl text-fg-muted">{withoutHandles(decision.question)}</p>
      )}
      {request && (
        <Stated by="you" what="the request">
          {request}
        </Stated>
      )}
    </header>
  )
}

/** What a person said, kept apart from inference and observation (ADR 0022). */
export function Stated({ by, what, children }: { by: string; what: string; children: ReactNode }) {
  return (
    <blockquote className="k-stated max-w-3xl">
      <p>“{children}”</p>
      <footer className="k-eyebrow mt-1">
        Stated by {by} · {what}
      </footer>
    </blockquote>
  )
}

function NextStepCallout({ step, action }: { step: NextStep; action?: ReactNode }) {
  return (
    <section
      aria-label="Next step"
      className={cn(
        'flex flex-wrap items-center gap-4 border px-5 py-4',
        step.tone === 'attention'
          ? 'border-revision bg-revision-soft'
          : step.tone === 'action'
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface',
      )}
    >
      <div className="min-w-0 flex-[1_1_360px]">
        <p className="k-eyebrow">Next step</p>
        <p className="font-semibold text-[17px] leading-snug">{step.text}</p>
        {step.detail && <p className="mt-0.5 text-fg-muted text-sm">{step.detail}</p>}
      </div>
      {action}
    </section>
  )
}

function StepAction({ step, decision }: { step: NextStep; decision: DecisionSummary }) {
  if (step.tone === 'done') return null
  if (step.stage === 'decide' && decision.status === 'open') {
    return (
      <ButtonLink to={{ view: 'compare', decision: decision.id }} primary>
        Compare and decide
        <ArrowRight aria-hidden className="ml-1.5 inline size-4" />
      </ButtonLink>
    )
  }
  return (
    <a
      href={`#stage-${step.stage}`}
      className="k-button-link primary"
      onClick={scrollToStage(step.stage)}
    >
      Go to {STAGE_LABEL[step.stage].toLowerCase()}
      <ArrowRight aria-hidden className="ml-1.5 inline size-4" />
    </a>
  )
}

const scrollToStage = (stage: Stage) => (e: React.MouseEvent) => {
  const el = document.getElementById(`stage-${stage}`)
  if (!el) return
  e.preventDefault()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

/** Where the thread stands; every stage can be reached directly, in any order. */
function StageRail({ current, decision }: { current: Stage; decision: DecisionSummary }) {
  const accepted = decision.status === 'accepted'
  const impl = decision.facets.implementation.state
  const doneThrough: Record<Stage, boolean> = {
    ask: true,
    alternatives: decision.alternatives.length > 0,
    questions: decision.status !== 'open',
    decide: accepted,
    handoff: accepted && impl !== 'none',
    work: impl === 'complete',
    reconcile: false,
  }
  return (
    <nav
      aria-label="Stages of this change"
      className="k-stages sticky top-0 z-10 bg-bg/95 py-2 backdrop-blur-sm"
    >
      <ol className="flex flex-wrap border-fg border-t">
        {STAGES.map((stage) => (
          <li key={stage} className="flex-[1_1_96px]">
            <a
              href={`#stage-${stage}`}
              onClick={scrollToStage(stage)}
              aria-current={stage === current ? 'step' : undefined}
              data-state={stage === current ? 'current' : doneThrough[stage] ? 'done' : 'upcoming'}
              className="k-stage"
            >
              {STAGE_LABEL[stage]}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function Section({
  stage,
  title,
  aside,
  children,
}: {
  stage: Stage
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      id={`stage-${stage}`}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="scroll-mt-16 space-y-3 outline-none"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-border border-b pb-1.5">
        <h2 id={headingId} className="font-semibold text-[15px]">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function RunLine({ run, compact = false }: { run: NavigatorRun; compact?: boolean }) {
  const call = run.calls.at(-1)
  const recorded = run.calls.some((c) => c.recorded)
  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-muted text-xs',
        !compact && 'border border-border bg-surface px-3 py-2',
      )}
    >
      <span className="k-eyebrow">Run</span>
      <span className="font-mono text-fg">{call?.model ?? 'no model call'}</span>
      {recorded && <span>recorded, replayed free</span>}
      {run.grounding && <span>{citationSummary(run.grounding)}</span>}
      <AppLink to={{ view: 'navigator', run: run.id }}>Run record</AppLink>
    </p>
  )
}

function AlternativeCard({
  alternative: alt,
  index,
  summary,
  nameOf,
}: {
  alternative: ComparedAlternative
  index: number
  summary: DecisionSummary['alternatives'][number] | undefined
  nameOf: (id: string) => string
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const changes = summary?.directChanges ?? []
  const levels = tradeoffLevels(alt.tradeoffs)
  return (
    <article
      className={cn(
        'border bg-surface',
        open ? 'border-fg' : 'border-border',
        alt.status === 'accepted' && 'border-accent',
      )}
    >
      <div className="flex flex-wrap items-start gap-3 px-4 pt-3.5 pb-2.5">
        <span className="k-key">A{index + 1}</span>
        <div className="min-w-0 flex-[1_1_360px]">
          <h3 className="font-semibold text-[15px] leading-snug">{alt.title}</h3>
          <p className="mt-0.5 text-fg-muted text-sm">{withoutHandles(lead(alt.summary))}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {alt.confidence && <ConfidenceBadge level={alt.confidence.level} size="sm" />}
          {alt.status !== 'proposed' && <DecisionStatusBadge status={alt.status} size="sm" />}
          {alt.combines.length > 0 && (
            <span className="text-fg-muted text-xs">
              combines {alt.combines.map(nameOf).join(' + ')}
            </span>
          )}
        </div>
      </div>
      {levels.some((l) => l.level) && (
        <dl className="grid grid-cols-5 border-border border-t max-[720px]:grid-cols-3">
          {levels.map((l) => (
            <div key={l.label} className="border-border border-r px-3 py-1.5 last:border-r-0">
              <dt className="k-eyebrow">{l.label}</dt>
              <dd className="flex items-center gap-2 text-sm">
                {l.level ?? '—'}
                <LevelBars level={l.level} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-3 border-border border-t px-4 py-2 text-sm">
        <span>
          {changes.length} direct change{changes.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex gap-2">
          <AppLink to={{ view: 'graph', lens: 'impact', alternative: alt.id }}>
            Show on canvas
          </AppLink>
          <Button
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide details' : 'Details'}
          </Button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="space-y-3 border-border border-t px-4 py-3">
          <Inferred label="Summary">{withoutHandles(alt.summary)}</Inferred>
          {alt.confidence && (
            <Inferred label="Why this confidence">
              {withoutHandles(alt.confidence.rationale)}
            </Inferred>
          )}
          {alt.tradeoffs && <Inferred label="Trade-offs">{withoutHandles(alt.tradeoffs)}</Inferred>}
          <div>
            <p className="k-eyebrow mb-1">
              Direct changes · inferred; the excerpts they cite are observed
            </p>
            <ol className="divide-y divide-border">
              {changes.map((c, j) => (
                <li key={c.relationId} className="flex gap-3 py-2">
                  <span className="k-balloon">{j + 1}</span>
                  <div className="min-w-0">
                    <RecordLink id={c.target} className="font-mono text-[13px]">
                      {c.label}
                    </RecordLink>
                    <p className="k-inferred mt-1 text-sm">{withoutHandles(c.change)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </article>
  )
}

export function LevelBars({ level }: { level: 'low' | 'medium' | 'high' | null }) {
  const n = level === 'high' ? 3 : level === 'medium' ? 2 : level === 'low' ? 1 : 0
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {[1, 2, 3].map((i) => (
        <i
          key={i}
          className={cn('block h-1.5 w-3.5 border border-fg-muted', i <= n && 'bg-fg-muted')}
        />
      ))}
    </span>
  )
}

/** The model's interpretation: marked as inferred, apart from what was observed or stated. */
export function Inferred({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="k-inferred">
      <p className="k-eyebrow">Inferred · {label}</p>
      <p className="text-sm">{children}</p>
    </div>
  )
}

function DecideStage({
  decision,
  alternatives,
  decisiveOpen,
}: {
  decision: DecisionSummary
  alternatives: ComparedAlternative[]
  decisiveOpen: string[]
}) {
  const wb = useWorkbench()
  const accept = useAcceptAlternative(wb.projectId)
  const notify = useToast()
  const [choosing, setChoosing] = useState<{ id: string; title: string } | null>(null)
  const chosen = acceptedAlternative(decision)
  if (decision.status !== 'open') {
    return (
      <div className="space-y-1 text-sm">
        <p>
          <DecisionStatusBadge status={decision.status} size="sm" />{' '}
          {chosen ? (
            <>
              Accepted <strong>{chosen.title}</strong>
            </>
          ) : null}
        </p>
        {decision.statusRationale && (
          <Stated by="you" what="the reason">
            {decision.statusRationale}
          </Stated>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {decisiveOpen.length > 0 && (
        <div role="note" className="border border-revision border-l-4 bg-surface px-4 py-3 text-sm">
          <p className="font-semibold">
            {decisiveOpen.length} question{decisiveOpen.length === 1 ? '' : 's'} that decide between
            these alternatives {decisiveOpen.length === 1 ? 'is' : 'are'} still open
          </p>
          <ul className="mt-1 list-disc pl-5">
            {decisiveOpen.map((q) => (
              <li key={q}>{q.split('\nOptions:')[0]}</li>
            ))}
          </ul>
          <p className="mt-1 text-fg-muted">
            You can still accept now: they stay open on the decision and go into the context package
            as mandatory items.
          </p>
        </div>
      )}
      <ul className="flex flex-wrap gap-2">
        {alternatives.map((alt, i) => (
          <li key={alt.id}>
            <Button
              disabled={accept.isPending || wb.isHistorical}
              onClick={() => {
                accept.reset()
                setChoosing({ id: alt.id, title: alt.title })
              }}
            >
              <Check aria-hidden />
              Accept A{i + 1}
            </Button>
          </li>
        ))}
      </ul>
      <AcceptDialog
        alternative={choosing}
        question={decision.question || decision.title}
        headRevision={wb.headRevision}
        pending={accept.isPending}
        error={accept.error}
        onClose={() => setChoosing(null)}
        onSubmit={(rationale) => {
          if (!choosing) return
          const picked = choosing
          accept.mutate(
            {
              decisionId: decision.id,
              chosenId: picked.id,
              alternativeIds: decision.alternatives.map((a) => a.id),
              rationale,
              baseRevision: wb.headRevision,
            },
            {
              onSuccess: (result) => {
                setChoosing(null)
                if ('committed' in result) {
                  notify({ tone: 'success', title: `Accepted: ${picked.title}`, body: rationale })
                } else {
                  notify({
                    tone: result.refused.body.code === 'stale' ? 'caution' : 'danger',
                    title: `Not committed: ${result.refused.body.code}`,
                    body: result.refused.body.message,
                  })
                }
              },
            },
          )
        }}
      />
    </div>
  )
}

function HandoffStage({
  decision,
  packages,
  tasks,
}: {
  decision: DecisionSummary
  packages: {
    id: string
    revision: number
    items: number
    chars: number
    taskTitle: string | null
  }[]
  tasks: readonly TaskView[]
}) {
  const wb = useWorkbench()
  const compile = useCompileContext(wb.projectId)
  const [creating, setCreating] = useState(false)
  const chosen = acceptedAlternative(decision)
  if (decision.status !== 'accepted') {
    return (
      <p className="text-fg-muted text-sm">
        Once an alternative is accepted, hand it off here: a context package and a task for a coding
        agent.
      </p>
    )
  }
  const latest = packages[0]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-surface px-4 py-3 text-sm">
        <div className="min-w-0 flex-[1_1_320px]">
          <p className="font-medium">Context package</p>
          {latest ? (
            <p className="text-fg-muted">
              {latest.items} items, {latest.chars.toLocaleString()} characters, compiled at r
              {latest.revision}.{' '}
              <AppLink to={{ view: 'handoff', package: latest.id }}>Open the package</AppLink>
            </p>
          ) : (
            <p className="text-fg-muted">
              The accepted alternative, its changes with their source excerpts, and the questions
              still open.
            </p>
          )}
        </div>
        <Button
          disabled={compile.isPending || wb.isHistorical}
          onClick={() => compile.mutate({ focus: [decision.id] })}
        >
          <PackagePlus aria-hidden />
          {latest ? 'Compile again at the head' : 'Compile a context package'}
        </Button>
      </div>
      {compile.error ? (
        <ErrorNotice error={compile.error} title="The package was not compiled" />
      ) : null}
      {creating ? (
        <CreateTaskForm
          initialDraft={{
            ...EMPTY_TASK_DRAFT,
            decisionId: decision.id,
            implementsId: chosen?.id ?? decision.id,
            title: chosen?.title ?? decision.title,
            prefilledTitle: chosen?.title ?? decision.title,
            contextPackageId: latest?.id ?? '',
          }}
          tasks={tasks}
          baseRevision={wb.headRevision}
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <Button variant="primary" disabled={wb.isHistorical} onClick={() => setCreating(true)}>
          Create a task for this decision
        </Button>
      )}
    </div>
  )
}

/** Statuses before an agent has claimed the task, when the prompt is what a person needs. */
const UNCLAIMED = new Set(['proposed', 'ready'])

function WorkStage({ decision, tasks }: { decision: DecisionSummary; tasks: TaskView[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-fg-muted text-sm">
        {decision.status === 'accepted'
          ? 'No task implements this decision yet.'
          : 'Work starts after a decision is accepted.'}
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {tasks.map((t) => {
        const report = t.reports.at(-1)
        return (
          <li key={t.id} className="space-y-3 border border-border bg-surface px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <TaskStatusBadge status={t.status} size="sm" />
              <span className="font-medium">{t.title}</span>
              <AppLink to={{ view: 'tasks', task: t.id }} className="ml-auto">
                Open the task
              </AppLink>
            </div>
            {report && (
              <p className="text-fg-muted">
                Latest report: {report.outcome} (
                {report.filedBy ? 'stated by a person' : 'stated by the agent'})
                {report.verification
                  ? `; git verification ${report.verification.outcome} (observed in the repository)`
                  : '; not verified'}
                .
              </p>
            )}
            {t.agentPrompt && UNCLAIMED.has(t.status) && (
              <details className="group">
                <summary className="cursor-pointer font-medium text-accent text-sm">
                  Prompt for a coding agent
                </summary>
                <div className="mt-2">
                  <AgentPrompt prompt={t.agentPrompt} />
                </div>
              </details>
            )}
            <ThreadReport task={t} />
          </li>
        )
      })}
    </ul>
  )
}

function ThreadReport({ task }: { task: TaskView }) {
  const wb = useWorkbench()
  const file = useFileReport(wb.projectId)
  return <ReportAction task={task} file={file} />
}

function ThreadReconcile({ task }: { task: TaskView }) {
  const wb = useWorkbench()
  const reconcile = useReconcileTask(wb.projectId)
  return <ReconcileAction task={task} reconcile={reconcile} />
}

function ReconcileStage({ decision, tasks }: { decision: DecisionSummary; tasks: TaskView[] }) {
  const { freshness, implementation } = decision.facets
  const ready = tasks.filter((t) => canReconcile(t) && verifiedReport(t)?.commit)
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-muted">
        After the work is verified, re-analyse the repository at the task commit, so the model shows
        the change as observed and the decision’s evidence is current again. Links to proposed
        elements come back as proposals for you to commit.
      </p>
      {implementation.touched !== undefined && (implementation.changes ?? 0) > 0 && (
        <p>
          <span className="font-medium">
            Verified work touched {implementation.touched} of {implementation.changes} direct
            changes.
          </span>{' '}
          <span className="text-fg-muted">
            Observed in git: a file the change’s evidence cites is among the files the commit
            changed.
          </span>
        </p>
      )}
      {ready.length === 0 && tasks.length > 0 && (
        <p className="text-fg-muted">
          Nothing to reconcile until a report passes git verification.
        </p>
      )}
      {ready.map((t) => (
        <div key={t.id} className="space-y-2 border border-border bg-surface px-4 py-3">
          <p className="font-medium">{t.title}</p>
          <ThreadReconcile task={t} />
        </div>
      ))}
      {freshness.stale.length > 0 && (
        <ul className="space-y-1">
          {freshness.stale.map((s) => (
            <li key={s.relationId}>
              <RecordLink id={s.target}>{s.label}</RecordLink>: {s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const IMPLEMENTATION: Record<string, string> = {
  none: 'Not started',
  planned: 'Planned',
  'in-progress': 'In progress',
  reported: 'Reported, awaiting review',
  partial: 'Partly done',
  complete: 'Complete',
}
const VERIFICATION: Record<string, string> = {
  none: 'Nothing verified yet',
  failed: 'Failed',
  partial: 'Partly verified',
  passed: 'Passed',
}

/** The four facets, each on its own row (ADR 0023). */
function Facets({ decision }: { decision: DecisionSummary }) {
  const { implementation, verification, freshness } = decision.facets
  const rows: [string, string, string | null][] = [
    [
      'Decision',
      decision.status[0]?.toUpperCase() + decision.status.slice(1),
      acceptedAlternative(decision)?.title ?? `${decision.alternatives.length} alternatives`,
    ],
    [
      'Implementation',
      IMPLEMENTATION[implementation.state] ?? implementation.state,
      implementation.tasks.length > 0
        ? `${implementation.tasks.filter((t) => t.status === 'completed').length} of ${implementation.tasks.length} tasks completed${
            implementation.touched !== undefined && implementation.changes
              ? `; verified work touched ${implementation.touched} of ${implementation.changes} changes`
              : ''
          }`
        : 'No task yet',
    ],
    ['Verification', VERIFICATION[verification.state] ?? verification.state, verification.coverage],
    [
      'Evidence',
      freshness.status === 'stale'
        ? 'Needs review'
        : freshness.status === 'current'
          ? 'Current'
          : 'Unchecked',
      freshness.status === 'unchecked'
        ? 'The changes cite no source that could go stale'
        : `${freshness.stale.length} of ${freshness.changes} changes moved`,
    ],
  ]
  return (
    <div>
      <p className="k-eyebrow mb-1">Status · each tracked on its own</p>
      <dl>
        {rows.map(([k, v, d]) => (
          <div key={k} className="grid grid-cols-[104px_1fr] gap-x-3 border-border border-b py-2.5">
            <dt className="k-eyebrow pt-0.5">{k}</dt>
            <dd>
              <span
                className={cn(
                  'font-medium',
                  k === 'Evidence' && freshness.status === 'stale' && 'text-revision',
                )}
              >
                {v}
              </span>
              {d && (
                <span className="line-clamp-3 text-fg-muted text-xs" title={d}>
                  {d}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
