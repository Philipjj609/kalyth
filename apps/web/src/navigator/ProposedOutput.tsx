import type { ImpactedElement, ImpactResult, NavigatorRun, Proposal } from '@kalyth/contracts'
import { ArrowRight, Check, Network, TriangleAlert, Waypoints } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { MAX_IMPACT_SEEDS, useAcceptAlternative, useImpact, useProposal } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  ConfidenceBadge,
  DecisionStatusBadge,
  InquiryRoleBadge,
  MockBadge,
  ProposalStatusBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural, shortId } from '../model/format.ts'
import {
  type AlternativesProposal,
  decisionStatusOf,
  groupImpact,
  impactLabeller,
  impactPathText,
  impactSeeds,
  type ProposedAlternative,
  type ProposedAssertion,
  parseAlternativesProposal,
  parseSummaryProposal,
} from '../model/navigator.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'

/** Names and types of existing elements, from the model at the viewed revision. */
export interface ElementLookup {
  nameOf: (id: string) => string | undefined
  typeOf: (id: string) => string | undefined
}

// ---------- presentational ----------

/** An element's name; a button that inspects it when `onInspect` is given. */
export function ElementButton({
  id,
  label,
  onInspect,
  className,
}: {
  id: string
  label: string
  onInspect?: ((id: string) => void) | undefined
  className?: string
}) {
  if (!onInspect) return <span className={cn('break-words', className)}>{label}</span>
  return (
    <button
      type="button"
      onClick={() => onInspect(id)}
      title={id}
      className={cn(
        'max-w-full break-words rounded-sm text-left text-accent underline-offset-2 hover:underline',
        className,
      )}
    >
      {label}
    </button>
  )
}

const citations = (n: number) => (
  <span className={cn('text-2xs tabular-nums', n === 0 ? 'text-fg-subtle' : 'text-fg-muted')}>
    {n === 0 ? 'no citations' : plural(n, 'citation')}
  </span>
)

function AlternativeCard({
  alternative: alt,
  index,
  lookup,
  onInspect,
  status,
  impact,
  decide,
  nameOfAlternative,
}: {
  alternative: ProposedAlternative
  index: number
  lookup: ElementLookup
  /** How to name an alternative a hybrid combines. */
  nameOfAlternative?: ((id: string) => string) | undefined
  onInspect?: ((id: string) => void) | undefined
  /** The alternative's current status, once its proposal is committed. */
  status: string | undefined
  impact?: ReactNode
  decide?: ReactNode
}) {
  const titleId = useId()
  const confidence = alt.claim.confidence
  const accepted = status === 'accepted'
  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex h-full flex-col rounded-lg border bg-surface shadow-panel',
        accepted ? 'tone-success border-tone-bd ring-2 ring-tone-bd' : 'border-border',
      )}
    >
      <header className="space-y-1.5 px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-2xs text-fg-subtle">Alternative {index + 1}</span>
          {status && status !== 'proposed' && <DecisionStatusBadge status={status} size="sm" />}
          {alt.mock && <MockBadge size="sm" />}
          <BasisBadge basis={alt.claim.basis} size="sm" />
          {confidence && <ConfidenceBadge level={confidence.level} size="sm" />}
          {citations(alt.citations)}
        </div>
        <h4 id={titleId} className="break-words font-semibold text-[14px] text-fg leading-snug">
          {alt.title || 'Untitled alternative'}
        </h4>
        {alt.combines.length > 0 && (
          <p className="text-fg-muted text-xs">
            Hybrid of {alt.combines.map((id) => nameOfAlternative?.(id) ?? shortId(id)).join(' + ')}
          </p>
        )}
      </header>
      <div className="space-y-3 px-4 pb-3 text-sm">
        {alt.summary && <p className="whitespace-pre-line break-words text-fg">{alt.summary}</p>}
        {alt.tradeoffs && (
          <div>
            <p className="mb-0.5 font-medium text-fg-muted text-xs">Trade-offs</p>
            <p className="whitespace-pre-line break-words text-fg">{alt.tradeoffs}</p>
          </div>
        )}
        {confidence && (
          <p className="break-words text-fg-muted text-xs">
            <span className="font-medium text-fg">Confidence: {confidence.level}.</span>{' '}
            {confidence.rationale}
          </p>
        )}
        <div>
          <p className="mb-1 font-medium text-fg-muted text-xs">
            Direct changes <span className="text-fg-subtle">{alt.changes.length}</span>
          </p>
          {alt.changes.length === 0 ? (
            <p className="text-fg-subtle text-xs">None proposed.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {alt.changes.map((c) => {
                const type = lookup.typeOf(c.targetId)
                return (
                  <li key={c.relationId} className="space-y-0.5 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {type && <TypeLabel type={type} className="shrink-0 text-fg-muted text-xs" />}
                      <ElementButton
                        id={c.targetId}
                        label={lookup.nameOf(c.targetId) ?? shortId(c.targetId)}
                        onInspect={onInspect}
                        className="min-w-0 font-medium"
                      />
                      <span className="ml-auto shrink-0">{citations(c.citations)}</span>
                    </div>
                    <p className="whitespace-pre-line break-words text-fg-muted text-xs">
                      {c.change || 'No description of the change.'}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      {(impact || decide) && (
        <footer
          className={cn(
            'mt-auto flex flex-wrap items-start justify-between gap-2 border-t px-4 py-2.5',
            accepted ? 'border-tone-bd' : 'border-border',
          )}
        >
          <div className="min-w-0 flex-1">{impact}</div>
          {decide && <div className="shrink-0">{decide}</div>}
        </footer>
      )}
    </article>
  )
}

/**
 * The alternatives a run proposed: the decision question, one card per alternative with its
 * direct changes, and the open questions. Model text is rendered as text only.
 */
export function AlternativesView({
  output,
  lookup,
  onInspect,
  renderImpact,
  statusOf,
  renderDecide,
  notice,
}: {
  output: AlternativesProposal
  lookup: ElementLookup
  onInspect?: (id: string) => void
  renderImpact?: (alternative: ProposedAlternative) => ReactNode
  /** Current decision status of the decision or an alternative, when it exists in the model. */
  statusOf?: ((id: string) => string | undefined) | undefined
  /** The decide action (or why it is not available) for one alternative. */
  renderDecide?: (alternative: ProposedAlternative) => ReactNode
  /** Shown under the decision: the outcome of accepting an alternative. */
  notice?: ReactNode
}) {
  const { decision, alternatives, questions } = output
  if (!decision && alternatives.length === 0 && questions.length === 0) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        The proposal holds no decision, alternatives or questions.
      </p>
    )
  }
  const decisionStatus = decision ? statusOf?.(decision.id) : undefined
  const proposedNames = new Map(alternatives.map((a, i) => [a.id, `Alternative ${i + 1}`] as const))
  const nameOfAlternative = (id: string) =>
    proposedNames.get(id) ?? `“${lookup.nameOf(id) ?? shortId(id)}”`
  const existingDecision = !decision && output.decisionId ? output.decisionId : null
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
        <div className="flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
          <TypeLabel type="core.Decision" />
          <span className="text-fg-subtle">to-be</span>
          {decisionStatus && <DecisionStatusBadge status={decisionStatus} size="sm" />}
          {output.mock && <MockBadge size="sm" />}
          {decision && <BasisBadge basis={decision.claim.basis} size="sm" />}
        </div>
        <h3 className="mt-1 break-words font-semibold text-[16px] text-fg leading-snug">
          {decision?.question ||
            decision?.title ||
            (existingDecision
              ? `More for: ${lookup.nameOf(existingDecision) ?? shortId(existingDecision)}`
              : 'No decision in this proposal')}
        </h3>
        {existingDecision && (
          <p className="mt-0.5 text-fg-muted text-xs">
            This run explored an open decision again, with the answers given so far. Once the
            proposal is committed, compare all its alternatives and decide in{' '}
            <AppLink to={{ view: 'decisions', decision: existingDecision }}>Decisions</AppLink>.
          </p>
        )}
        {decision?.title && decision.question && (
          <p className="mt-0.5 break-words text-fg-muted text-sm">{decision.title}</p>
        )}
        {notice && <div className="mt-2">{notice}</div>}
      </div>

      {alternatives.length > 0 && (
        <ol aria-label="Alternatives" className="grid gap-3 lg:grid-cols-2">
          {alternatives.map((alt, i) => (
            <li key={alt.id} className="min-w-0">
              <AlternativeCard
                alternative={alt}
                index={i}
                lookup={lookup}
                onInspect={onInspect}
                status={statusOf?.(alt.id)}
                impact={renderImpact?.(alt)}
                decide={renderDecide?.(alt)}
                nameOfAlternative={nameOfAlternative}
              />
            </li>
          ))}
        </ol>
      )}

      {questions.length > 0 && (
        <Panel
          title="Open questions"
          aside={<span className="text-fg-subtle text-xs">{questions.length}</span>}
        >
          <ul className="divide-y divide-border">
            {questions.map((q) => (
              <li key={q.id} className="flex items-start gap-3 px-4 py-2.5">
                <InquiryRoleBadge role={q.inquiryRole} size="sm" className="mt-0.5" />
                <span className="min-w-0 flex-1 break-words text-sm">
                  {q.text}
                  {q.options.length > 0 && (
                    <span className="mt-0.5 block text-fg-muted text-xs">
                      Suggested answers: {q.options.join(' · ')}
                    </span>
                  )}
                </span>
                {q.mock && <MockBadge size="sm" className="mt-0.5" />}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

/** The statements a summarize run proposed about one element. */
export function SummaryView({
  assertions,
  lookup,
  onInspect,
}: {
  assertions: readonly ProposedAssertion[]
  lookup: ElementLookup
  onInspect?: (id: string) => void
}) {
  if (assertions.length === 0) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        The proposal holds no statements.
      </p>
    )
  }
  return (
    <Panel
      title="Proposed statements"
      aside={<span className="text-fg-subtle text-xs">{assertions.length}</span>}
    >
      <ul className="divide-y divide-border">
        {assertions.map((a) => (
          <li key={a.id} className="space-y-1.5 px-4 py-3">
            <p className="whitespace-pre-line break-words text-fg">{a.statement}</p>
            <p className="flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
              {a.mock && <MockBadge size="sm" />}
              <BasisBadge basis={a.claim.basis} size="sm" />
              {a.claim.confidence && <ConfidenceBadge level={a.claim.confidence.level} size="sm" />}
              {citations(a.citations)}
              {a.concerns.map((id) => (
                <span key={id} className="inline-flex items-center gap-1">
                  <span className="text-fg-subtle">about</span>
                  <ElementButton
                    id={id}
                    label={lookup.nameOf(id) ?? shortId(id)}
                    onInspect={onInspect}
                  />
                </span>
              ))}
            </p>
            {a.claim.confidence && (
              <p className="break-words text-fg-muted text-xs">{a.claim.confidence.rationale}</p>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** A typed path from a direct change to an element, in the Navigator's notation. */
export function ImpactPath({
  element,
  labelOf,
}: {
  element: Pick<ImpactedElement, 'seed' | 'path' | 'label'>
  labelOf: (id: string) => string
}) {
  return (
    <code className="block break-words font-mono text-[11px] text-fg-muted leading-snug">
      {impactPathText(element, labelOf)}
    </code>
  )
}

/**
 * Propagated impact, grouped by type, with depth and a typed path from the direct change. It is
 * computed by Kalyth's deterministic traversal, never by the model.
 */
export function ImpactList({
  result,
  nameOf,
  onInspect,
  onShowInGraph,
}: {
  result: ImpactResult
  nameOf: (id: string) => string | undefined
  onInspect?: (id: string) => void
  onShowInGraph?: (id: string) => void
}) {
  const labelOf = impactLabeller(result, nameOf)
  const groups = groupImpact(result)
  return (
    <div className="space-y-3">
      <p className="text-fg-muted text-xs">
        {plural(result.elements.length, 'element')} at r{result.revision} from{' '}
        {plural(result.seeds.length, 'direct change')}, by traversal of the model.
      </p>
      {result.truncated && (
        <p className="tone-warning flex items-center gap-1.5 rounded-md border border-tone-bd bg-tone-bg px-2.5 py-1.5 text-tone-fg text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          The depth or node limit cut the traversal short; more elements may be affected.
        </p>
      )}
      {groups.map((g) => (
        <section key={g.type} aria-label={`${g.type}, ${g.elements.length}`}>
          <h5 className="mb-1 flex items-center gap-2 font-medium text-fg-muted text-xs">
            <TypeLabel type={g.type} />
            <span className="text-fg-subtle tabular-nums">{g.elements.length}</span>
          </h5>
          <ul className="space-y-1">
            {g.elements.map((e) => (
              <li key={e.id} className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-2">
                <span
                  className={cn(
                    'pt-0.5 font-mono text-2xs tabular-nums',
                    e.depth === 0 ? 'text-accent' : 'text-fg-subtle',
                  )}
                >
                  {e.depth === 0 ? 'direct' : `depth ${e.depth}`}
                </span>
                <span className="min-w-0">
                  <ElementButton
                    id={e.id}
                    label={labelOf(e.id)}
                    onInspect={onInspect}
                    className="text-sm"
                  />
                  {e.path.length > 0 && <ImpactPath element={e} labelOf={labelOf} />}
                </span>
                {onShowInGraph && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="-my-0.5"
                    aria-label={`Show ${labelOf(e.id)} in the graph`}
                    title="Show in the graph"
                    onClick={() => onShowInGraph(e.id)}
                  >
                    <Network aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ---------- containers ----------

/** "Show impact" for one alternative: traverses from the targets of its direct changes. */
function ImpactToggle({ alternative }: { alternative: ProposedAlternative }) {
  const wb = useWorkbench()
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const seeds = useMemo(() => impactSeeds(alternative), [alternative])
  const impact = useImpact(wb.projectId, seeds, wb.revision, open)
  if (seeds.length === 0) {
    return <p className="text-fg-subtle text-xs">No direct changes, so no impact to trace.</p>
  }
  return (
    <div>
      <Button
        size="sm"
        variant={open ? 'secondary' : 'ghost'}
        className="-ml-2.5"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
      >
        <Waypoints aria-hidden />
        {open ? 'Hide impact' : 'Show impact'}
      </Button>
      {open && (
        <div id={regionId} className="mt-2 max-h-[420px] overflow-auto pr-1 scrollbar-thin">
          {seeds.length > MAX_IMPACT_SEEDS && (
            <p className="mb-2 text-fg-muted text-xs">
              Traced from the first {MAX_IMPACT_SEEDS} of {seeds.length} direct changes.
            </p>
          )}
          {impact.error ? (
            <ErrorNotice error={impact.error} title="Impact could not be computed" />
          ) : impact.isLoading || !impact.data ? (
            <span className="flex items-center gap-2 text-fg-muted text-xs">
              <Spinner label="Tracing impact" /> Tracing impact…
            </span>
          ) : (
            <ImpactList
              result={impact.data}
              nameOf={(id) => wb.model?.nameOf(id)}
              onInspect={wb.select}
              onShowInGraph={(id) => {
                wb.select(id)
                wb.setView('graph')
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Reads the run's proposal and shows what it holds, as alternatives or as statements. */
export function RunOutput({ run }: { run: NavigatorRun }) {
  const wb = useWorkbench()
  const proposal = useProposal(run.proposalId)
  const parsed = useMemo(() => {
    const ops = proposal.data?.ops
    if (!ops) return null
    return run.input.kind === 'alternatives'
      ? { kind: 'alternatives' as const, output: parseAlternativesProposal(ops) }
      : { kind: 'summary' as const, assertions: parseSummaryProposal(ops) }
  }, [proposal.data, run.input.kind])
  // Elements the run proposes are named from the proposal itself; they are not in the model yet.
  const lookup = useMemo<ElementLookup>(() => {
    const proposed = new Map(
      (parsed?.kind === 'alternatives' ? parsed.output.newElements : []).map((e) => [e.id, e]),
    )
    return {
      nameOf: (id) => {
        const p = proposed.get(id)
        return p ? `${p.label} (proposed)` : wb.model?.nameOf(id)
      },
      typeOf: (id) => proposed.get(id)?.type ?? wb.model?.objectById.get(id)?.type,
    }
  }, [wb.model, parsed])

  if (!run.proposalId) return null
  return (
    <section aria-label="What the run proposed" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-[15px] text-fg">
          {run.input.kind === 'alternatives' ? 'Alternatives' : 'Summary'}
        </h3>
        {proposal.data && <ProposalStatusBadge status={proposal.data.status} size="sm" />}
        <span className="font-mono text-2xs text-fg-subtle">{shortId(run.proposalId)}</span>
        <AppLink
          to={{ view: 'proposals', proposal: run.proposalId }}
          className="ml-auto inline-flex items-center gap-1 text-sm"
        >
          {proposal.data?.status === 'pending' ? 'Review in Proposals' : 'Open in Proposals'}
          <ArrowRight aria-hidden className="size-3.5" />
        </AppLink>
      </div>
      <p className="text-fg-muted text-xs">
        Everything here is one proposal. Nothing is in the model until a person commits it; every
        record is inferred and carries the model, its confidence and its citations.
      </p>
      {proposal.error ? (
        <ErrorNotice error={proposal.error} title="The proposal could not be loaded" />
      ) : !parsed ? (
        <Skeleton className="h-40" />
      ) : parsed.kind === 'alternatives' && proposal.data ? (
        <DecidableAlternatives output={parsed.output} proposal={proposal.data} lookup={lookup} />
      ) : parsed.kind === 'summary' ? (
        <SummaryView assertions={parsed.assertions} lookup={lookup} onInspect={wb.select} />
      ) : null}
    </section>
  )
}

/**
 * The alternatives with the person's decision. Once the run's proposal is committed the decision
 * and alternatives exist with the ids in its operations, and while the decision is open each
 * alternative can be accepted: a proposal of setDecisionStatus operations, committed at once.
 */
function DecidableAlternatives({
  output,
  proposal,
  lookup,
}: {
  output: AlternativesProposal
  proposal: Proposal
  lookup: ElementLookup
}) {
  const wb = useWorkbench()
  const notify = useToast()
  const accept = useAcceptAlternative(wb.projectId)
  const [choosing, setChoosing] = useState<ProposedAlternative | null>(null)
  const decision = output.decision
  const alternativeIds = useMemo(
    () =>
      output.alternatives
        .map((a) => a.id)
        // An alternative missing at the head (for example retired) cannot change status.
        .filter((id) => !wb.model || wb.model.objectById.has(id)),
    [output.alternatives, wb.model],
  )
  const outcome = accept.data
  const acceptedNow = outcome && 'committed' in outcome ? accept.variables?.chosenId : undefined

  // The model can lag a moment behind a commit; the outcome of this tab's own commit is known.
  const statusOf = (id: string): string | undefined => {
    if (acceptedNow && decision) {
      if (id === decision.id || id === acceptedNow) return 'accepted'
      if (alternativeIds.includes(id)) return 'rejected'
    }
    return decisionStatusOf(wb.model?.objectById.get(id))
  }
  const decisionOpen = decision !== null && statusOf(decision.id) === 'open'

  const renderDecide = (alt: ProposedAlternative): ReactNode => {
    if (!decision) return null
    if (proposal.status === 'pending') {
      return (
        <AppLink to={{ view: 'proposals', proposal: proposal.id }} className="text-xs">
          Commit the proposal to decide
        </AppLink>
      )
    }
    if (proposal.status !== 'committed' || !decisionOpen) return null
    return (
      <Button
        size="sm"
        variant="primary"
        disabled={accept.isPending || wb.isHistorical}
        title={wb.isHistorical ? 'Return to the head to decide' : undefined}
        onClick={() => {
          accept.reset()
          setChoosing(alt)
        }}
      >
        <Check aria-hidden />
        Accept this alternative
      </Button>
    )
  }

  const chosenTitle = output.alternatives.find((a) => a.id === accept.variables?.chosenId)?.title
  let notice: ReactNode = null
  if (outcome && 'committed' in outcome) {
    notice = (
      <p
        role="status"
        className="tone-success rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs"
      >
        Accepted “{chosenTitle}”. Committed as revision r{outcome.committed.revision}
        {outcome.committed.rebasedFrom !== null &&
          `, rebased from r${outcome.committed.rebasedFrom}`}
        .
      </p>
    )
  } else if (outcome && 'refused' in outcome) {
    notice = (
      <div className="space-y-1.5">
        <ErrorNotice
          error={outcome.refused}
          resolveName={(id) => wb.model?.nameOf(id)}
          onSelect={wb.select}
        />
        <p className="text-fg-muted text-xs">
          The decision proposal is still pending.{' '}
          <AppLink to={{ view: 'proposals', proposal: outcome.proposalId }}>
            Review it in Proposals
          </AppLink>
        </p>
      </div>
    )
  } else if (
    proposal.status === 'committed' &&
    decision &&
    !decisionOpen &&
    statusOf(decision.id)
  ) {
    notice = (
      <p className="text-fg-muted text-xs">
        This decision is {statusOf(decision.id)}; it changes again only through a person.
      </p>
    )
  }

  return (
    <>
      <AlternativesView
        output={output}
        lookup={lookup}
        onInspect={wb.select}
        renderImpact={(alt) => <ImpactToggle alternative={alt} />}
        statusOf={proposal.status === 'committed' ? statusOf : undefined}
        renderDecide={renderDecide}
        notice={notice}
      />
      <AcceptDialog
        alternative={choosing}
        question={decision?.question || decision?.title || ''}
        headRevision={wb.headRevision}
        pending={accept.isPending}
        error={accept.error}
        onClose={() => setChoosing(null)}
        onSubmit={(rationale) => {
          if (!decision || !choosing) return
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
    </>
  )
}

/** Asks for the person's rationale; the decision proposal carries it. */
export function AcceptDialog({
  alternative,
  question,
  headRevision,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  alternative: { title: string } | null
  question: string
  headRevision: number
  pending: boolean
  error: unknown
  onSubmit: (rationale: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [rationale, setRationale] = useState('')
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (alternative && !dialog.open) {
      setRationale('')
      dialog.showModal()
    } else if (!alternative && dialog.open) {
      dialog.close()
    }
  }, [alternative])
  const trimmed = rationale.trim()
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(540px,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-fg shadow-pop"
    >
      {alternative && (
        <form
          method="dialog"
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed && !pending) onSubmit(trimmed)
          }}
        >
          <h2 id={titleId} className="font-semibold text-[15px]">
            Accept “{alternative.title}”
          </h2>
          {question && <p className="text-fg-muted text-sm">{question}</p>}
          <p className="text-fg-muted text-xs">
            The decision and this alternative become accepted with your rationale, and the other
            alternatives are rejected. This is proposed against the head,{' '}
            <span className="font-mono">r{headRevision}</span>, and committed at once.
          </p>
          <label className="block space-y-1">
            <span className="font-medium text-xs">Rationale (required)</span>
            <textarea
              autoFocus
              required
              maxLength={2000}
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
              placeholder="Why this alternative?"
            />
          </label>
          {error ? <ErrorNotice error={error} title="The decision was not recorded" /> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={() => ref.current?.close()} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!trimmed || pending}>
              {pending ? (
                <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Accepting" />
              ) : (
                <Check aria-hidden />
              )}
              Accept alternative
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}
