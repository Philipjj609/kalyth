import type { DecisionSummary } from '@kalyth/contracts'
import { Check, Compass, GitCompareArrows, MessageSquareReply, Scale } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  useAcceptAlternative,
  useAnswerQuestion,
  useDecisions,
  useImpacts,
  useStartNavigatorRun,
} from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  ConfidenceBadge,
  DecisionStatusBadge,
  InquiryRoleBadge,
} from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, EmptyState, Panel, Skeleton } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import {
  type ComparedAlternative,
  type ComparedQuestion,
  type Comparison,
  compareAlternatives,
  compareReach,
  type Reach,
} from '../model/compare.ts'
import { plural } from '../model/format.ts'
import { AcceptDialog } from '../navigator/ProposedOutput.tsx'
import { AppLink, ErrorNotice, RecordLink, ViewHeader } from '../views/shared.tsx'

const STATUS_ORDER = ['open', 'accepted', 'deferred', 'rejected', 'superseded']

/**
 * Decisions (Tier B): every decision of the project, and for the chosen one its alternatives side
 * by side: what each changes (shared changes first), what each reaches through impact that the
 * others do not, the questions about each, and the person's choice. Shown at the head.
 */
export function DecisionsView() {
  const [loc] = useAppLocation()
  const wb = useWorkbench()
  const list = useDecisions(wb.projectId)
  const decisions = useMemo(
    () =>
      [...(list.data?.decisions ?? [])].sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          a.title.localeCompare(b.title),
      ),
    [list.data],
  )
  const chosen =
    decisions.find((d) => d.id === loc.decision) ??
    (loc.decision ? undefined : (decisions.find((d) => d.status === 'open') ?? decisions[0]))

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-6">
      <ViewHeader
        title="Decisions"
        description="Every decision in the project, with its alternatives side by side: what each changes, what each reaches that the others do not, and the questions still open. A person accepts one; the others are rejected. Always shown at the head."
      />
      {list.error ? (
        <ErrorNotice error={list.error} title="Decisions could not be loaded" />
      ) : list.isLoading ? (
        <Skeleton className="h-64" />
      ) : decisions.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState icon={<Scale />} title="No decisions yet">
            A Navigator run proposes a decision with alternatives. Start one in the{' '}
            <AppLink to={{ view: 'navigator' }}>Navigator</AppLink>.
          </EmptyState>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <DecisionList decisions={decisions} selectedId={chosen?.id} />
          {chosen ? (
            <DecisionComparison key={chosen.id} decision={chosen} />
          ) : (
            <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
              That decision is not in this project at the head.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function DecisionList({
  decisions,
  selectedId,
}: {
  decisions: readonly DecisionSummary[]
  selectedId: string | undefined
}) {
  return (
    <nav aria-label="Decisions">
      <ul className="space-y-1">
        {decisions.map((d) => (
          <li key={d.id}>
            <AppLink
              to={{ view: 'decisions', decision: d.id }}
              aria-current={d.id === selectedId ? 'page' : undefined}
              className={cn(
                'block rounded-md border px-3 py-2 no-underline hover:border-accent',
                d.id === selectedId ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
              )}
            >
              <span className="flex items-center gap-1.5">
                <DecisionStatusBadge status={d.status} size="sm" />
                <span className="text-fg-subtle text-xs">
                  {plural(d.alternatives.length, 'alternative')}
                </span>
              </span>
              <span className="mt-1 block break-words font-medium text-fg text-sm">{d.title}</span>
            </AppLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function DecisionComparison({ decision }: { decision: DecisionSummary }) {
  const wb = useWorkbench()
  const notify = useToast()
  const accept = useAcceptAlternative(wb.projectId)
  const [choosing, setChoosing] = useState<{ id: string; title: string } | null>(null)
  const atHead = !wb.isHistorical
  const comparison: Comparison = useMemo(
    () =>
      compareAlternatives(decision, {
        objectById: atHead && wb.model ? wb.model.objectById : new Map(),
        relations: atHead && wb.model ? wb.model.relations : [],
      }),
    [decision, wb.model, atHead],
  )
  const impacts = useImpacts(
    wb.projectId,
    comparison.alternatives.map((a) => a.targets),
    wb.headRevision,
  )
  const reach = compareReach(impacts.map((q) => q.data))
  const open = decision.status === 'open'
  const alternativeIds = decision.alternatives.map((a) => a.id)
  const nameOf = (id: string) => {
    const i = comparison.alternatives.findIndex((a) => a.id === id)
    return i === -1 ? (wb.model?.nameOf(id) ?? 'an alternative') : `Alternative ${i + 1}`
  }
  const answered = [
    ...comparison.questions,
    ...comparison.alternatives.flatMap((a) => a.questions),
  ].filter((q) => q.status === 'answered').length
  const columns = `repeat(${Math.max(comparison.alternatives.length, 1)}, minmax(240px, 1fr))`

  return (
    <section aria-labelledby="decision-question" className="min-w-0 space-y-4">
      <header className="rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <DecisionStatusBadge status={decision.status} size="sm" />
          <BasisBadge basis={decision.basis} size="sm" />
          <RecordLink id={decision.id}>Inspect</RecordLink>
        </div>
        <h2 id="decision-question" className="mt-1 break-words font-semibold text-[16px]">
          {decision.question || decision.title}
        </h2>
        {decision.question && <p className="text-fg-muted text-sm">{decision.title}</p>}
        {decision.statusRationale && (
          <p className="mt-1 text-fg-muted text-xs">
            <span className="font-medium text-fg">Rationale:</span> {decision.statusRationale}
          </p>
        )}
        {open && atHead && <ExploreAgain decision={decision} answered={answered} />}
        {!atHead && (
          <p className="tone-warning mt-2 rounded border border-tone-bd bg-tone-bg px-2 py-1 text-tone-fg text-xs">
            You are viewing an older revision. Decisions are compared at the head; return to the
            head to see trade-offs, questions and claims.
          </p>
        )}
      </header>

      {comparison.alternatives.length === 0 ? (
        <p className="text-fg-muted text-sm">This decision has no alternatives yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto pb-1">
            <ol
              aria-label="Alternatives"
              className="grid gap-3"
              style={{ gridTemplateColumns: columns }}
            >
              {comparison.alternatives.map((alt, i) => (
                <li key={alt.id} className="min-w-0">
                  <AlternativeColumn
                    alternative={alt}
                    index={i}
                    reach={reach[i]}
                    reachError={impacts[i]?.error ?? null}
                    hybridOf={alt.combines.map(nameOf)}
                    answerable={open && atHead}
                    decide={
                      open ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={accept.isPending || !atHead}
                          title={atHead ? undefined : 'Return to the head to decide'}
                          onClick={() => {
                            accept.reset()
                            setChoosing({ id: alt.id, title: alt.title })
                          }}
                        >
                          <Check aria-hidden />
                          Accept this alternative
                        </Button>
                      ) : null
                    }
                  />
                </li>
              ))}
            </ol>
          </div>
          <ChangeMatrix comparison={comparison} />
        </>
      )}

      {comparison.questions.length > 0 && (
        <Panel title="Questions about the decision" aside={comparison.questions.length}>
          <QuestionList questions={comparison.questions} answerable={open && atHead} />
        </Panel>
      )}

      <AcceptDialog
        alternative={choosing}
        question={decision.question || decision.title}
        headRevision={wb.headRevision}
        pending={accept.isPending}
        error={accept.error}
        onClose={() => setChoosing(null)}
        onSubmit={(rationale) => {
          if (!choosing) return
          const chosen = choosing
          accept.mutate(
            {
              decisionId: decision.id,
              chosenId: chosen.id,
              alternativeIds,
              rationale,
              baseRevision: wb.headRevision,
            },
            {
              onSuccess: (result) => {
                setChoosing(null)
                if ('committed' in result) {
                  notify({
                    tone: 'success',
                    title: `Accepted: ${chosen.title}`,
                    body: `Committed as r${result.committed.revision}. ${rationale}`,
                  })
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
    </section>
  )
}

function AlternativeColumn({
  alternative: alt,
  index,
  reach,
  reachError,
  decide,
  hybridOf,
  answerable,
}: {
  alternative: ComparedAlternative
  index: number
  reach: Reach | undefined
  reachError: unknown
  decide: ReactNode
  /** Names of the alternatives this hybrid combines; empty for others. */
  hybridOf: string[]
  answerable: boolean
}) {
  const accepted = alt.status === 'accepted'
  return (
    <article
      aria-label={`Alternative ${index + 1}: ${alt.title}`}
      className={cn(
        'flex h-full flex-col rounded-lg border bg-surface shadow-panel',
        accepted ? 'tone-success border-tone-bd ring-2 ring-tone-bd' : 'border-border',
      )}
    >
      <header className="space-y-1.5 px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-2xs text-fg-subtle">Alternative {index + 1}</span>
          <DecisionStatusBadge status={alt.status} size="sm" />
          {alt.basis && <BasisBadge basis={alt.basis} size="sm" />}
          {alt.confidence && <ConfidenceBadge level={alt.confidence.level} size="sm" />}
        </div>
        <h3 className="break-words font-semibold text-[14px] leading-snug">
          <RecordLink id={alt.id}>{alt.title || 'Untitled alternative'}</RecordLink>
        </h3>
        {hybridOf.length > 0 && (
          <p className="text-fg-muted text-xs">Hybrid of {hybridOf.join(' + ')}</p>
        )}
      </header>
      <dl className="space-y-3 px-4 pb-3 text-sm">
        <Row label="Summary">
          <p className="whitespace-pre-line break-words">{alt.summary || '—'}</p>
        </Row>
        <Row label="Trade-offs">
          <p className="whitespace-pre-line break-words">{alt.tradeoffs ?? '—'}</p>
        </Row>
        {alt.confidence && (
          <Row label="Confidence">
            <p className="break-words text-fg-muted text-xs">
              <span className="font-medium text-fg">{alt.confidence.level}.</span>{' '}
              {alt.confidence.rationale}
            </p>
          </Row>
        )}
        <Row label="Reach">
          <ReachSummary reach={reach} error={reachError} directCount={alt.targets.length} />
        </Row>
        <Row label={`Questions (${alt.questions.length})`}>
          {alt.questions.length === 0 ? (
            <p className="text-fg-subtle text-xs">None recorded.</p>
          ) : (
            <QuestionList questions={alt.questions} compact answerable={answerable} />
          )}
        </Row>
      </dl>
      {decide && <footer className="mt-auto border-border border-t px-4 py-2.5">{decide}</footer>}
    </article>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 font-medium text-fg-muted text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function ReachSummary({
  reach,
  error,
  directCount,
}: {
  reach: Reach | undefined
  error: unknown
  directCount: number
}) {
  if (directCount === 0) return <p className="text-fg-subtle text-xs">It changes no element.</p>
  if (error) return <ErrorNotice error={error} title="Impact could not be traced" />
  if (!reach) return <Skeleton className="h-4 w-32" />
  const shown = reach.only.slice(0, 6)
  return (
    <div className="space-y-1 text-xs">
      <p>
        <span className="font-medium">{plural(reach.total, 'element')}</span> reached from{' '}
        {plural(directCount, 'direct change')}
        {reach.truncated && <span className="text-fg-subtle"> (traversal cut at its limit)</span>}
      </p>
      {reach.only.length > 0 && (
        <div>
          <p className="text-fg-muted">Only this alternative reaches:</p>
          <ul className="mt-0.5 space-y-0.5">
            {shown.map((e) => (
              <li key={e.id} className="truncate">
                <RecordLink id={e.id}>{e.label}</RecordLink>
              </li>
            ))}
          </ul>
          {reach.only.length > shown.length && (
            <p className="text-fg-subtle">and {reach.only.length - shown.length} more</p>
          )}
        </div>
      )}
    </div>
  )
}

function QuestionList({
  questions,
  compact,
  answerable = false,
}: {
  questions: readonly ComparedQuestion[]
  compact?: boolean
  /** A person may answer the open ones (the decision is open and shown at the head). */
  answerable?: boolean
}) {
  return (
    <ul className={compact ? 'space-y-1.5' : 'divide-y divide-border'}>
      {questions.map((q) => (
        <li key={q.id} className={cn('space-y-1', !compact && 'px-4 py-2.5')}>
          <div className="flex items-start gap-2">
            <InquiryRoleBadge role={q.inquiryRole} size="sm" className="mt-0.5" />
            <span className="min-w-0 flex-1 whitespace-pre-line break-words text-sm">
              {q.text}
              {q.status !== 'open' && <span className="text-fg-subtle text-xs"> ({q.status})</span>}
            </span>
          </div>
          {q.answer && (
            <p className="ml-1 border-border border-l-2 pl-2 text-fg-muted text-xs">
              <span className="font-medium text-fg">Answer:</span> {q.answer}
            </p>
          )}
          {answerable && q.status === 'open' && <AnswerForm questionId={q.id} />}
        </li>
      ))}
    </ul>
  )
}

/** A person's answer to an open question, proposed and committed at once. */
function AnswerForm({ questionId }: { questionId: string }) {
  const wb = useWorkbench()
  const answer = useAnswerQuestion(wb.projectId)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const trimmed = text.trim()
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <MessageSquareReply aria-hidden />
        Answer
      </Button>
    )
  }
  const refused = answer.data && 'refused' in answer.data ? answer.data.refused : null
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!trimmed || answer.isPending) return
        answer.mutate(
          { questionId, answer: trimmed, baseRevision: wb.headRevision },
          {
            onSuccess: (result) => {
              if ('committed' in result) {
                setOpen(false)
                setText('')
              }
            },
          },
        )
      }}
    >
      <label className="block space-y-1">
        <span className="sr-only">Your answer</span>
        <textarea
          rows={2}
          maxLength={2000}
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your answer; the Navigator uses it when you explore again"
          className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
        />
      </label>
      {answer.error ? <ErrorNotice error={answer.error} title="The answer was not saved" /> : null}
      {refused ? <ErrorNotice error={refused} title="The answer was not committed" /> : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" variant="primary" disabled={!trimmed || answer.isPending}>
          Save answer
        </Button>
        <Button size="sm" onClick={() => setOpen(false)} disabled={answer.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * Journey 1: a Navigator run that sees this decision's alternatives and the answers given so far,
 * and proposes more alternatives and hybrids for it. People start runs; the output is a proposal
 * to review like any other.
 */
function ExploreAgain({ decision, answered }: { decision: DecisionSummary; answered: number }) {
  const wb = useWorkbench()
  const start = useStartNavigatorRun(wb.projectId)
  const run = start.data
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={start.isPending}
        onClick={() =>
          start.mutate({
            kind: 'alternatives',
            request: (decision.question || decision.title).slice(0, 2000),
            focus: [],
            decisionId: decision.id,
          })
        }
      >
        <Compass aria-hidden />
        Explore again with the answers
      </Button>
      <span className="text-fg-muted text-xs">
        {answered === 0
          ? 'No questions answered yet; answering them first gives the Navigator more to go on.'
          : `The Navigator sees the alternatives above and ${answered} answer${answered === 1 ? '' : 's'}.`}
      </span>
      {run && (
        <p role="status" className="w-full text-xs">
          Run started.{' '}
          <AppLink to={{ view: 'navigator', run: run.id }}>Follow it in the Navigator</AppLink>; its
          proposal adds alternatives here once a person commits it.
        </p>
      )}
      {start.error ? (
        <ErrorNotice error={start.error} title="The run did not start" className="w-full" />
      ) : null}
    </div>
  )
}

/** Rows are elements, columns alternatives; shared changes come first. */
function ChangeMatrix({ comparison }: { comparison: Comparison }) {
  if (comparison.changes.length === 0) return null
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <GitCompareArrows aria-hidden className="size-4" />
          What each alternative changes
        </span>
      }
      aside={plural(comparison.changes.length, 'element')}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Elements the alternatives change directly; each cell is the change one alternative makes
            to the element.
          </caption>
          <thead>
            <tr className="border-border border-b text-left text-fg-muted text-xs">
              <th scope="col" className="w-56 px-4 py-2 font-medium">
                Element
              </th>
              {comparison.alternatives.map((a, i) => (
                <th key={a.id} scope="col" className="px-3 py-2 font-medium">
                  {i + 1}. {a.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.changes.map((row) => (
              <tr key={row.target} className="border-border border-b align-top last:border-b-0">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  <RecordLink id={row.target}>{row.label}</RecordLink>
                  {row.shared && (
                    <span className="mt-0.5 block text-2xs text-fg-subtle">
                      changed by every alternative
                    </span>
                  )}
                </th>
                {row.cells.map((cell, i) => (
                  <td
                    key={comparison.alternatives[i]?.id ?? i}
                    className={cn(
                      'whitespace-pre-line break-words px-3 py-2',
                      cell === null && 'text-fg-subtle',
                    )}
                  >
                    {cell ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
