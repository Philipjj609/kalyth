import type { ImpactResult, NavigatorRun } from '@kalyth/contracts'
import { ArrowRight, Network, TriangleAlert, Waypoints } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { MAX_IMPACT_SEEDS, useImpact, useProposal } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  ConfidenceBadge,
  InquiryRoleBadge,
  MockBadge,
  ProposalStatusBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { Button, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural, shortId } from '../model/format.ts'
import {
  type AlternativesProposal,
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

function ElementButton({
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
  impact,
}: {
  alternative: ProposedAlternative
  index: number
  lookup: ElementLookup
  onInspect?: ((id: string) => void) | undefined
  impact?: ReactNode
}) {
  const titleId = useId()
  const confidence = alt.claim.confidence
  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full flex-col rounded-lg border border-border bg-surface shadow-panel"
    >
      <header className="space-y-1.5 px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-2xs text-fg-subtle">Alternative {index + 1}</span>
          {alt.mock && <MockBadge size="sm" />}
          <BasisBadge basis={alt.claim.basis} size="sm" />
          {confidence && <ConfidenceBadge level={confidence.level} size="sm" />}
          {citations(alt.citations)}
        </div>
        <h4 id={titleId} className="break-words font-semibold text-[14px] text-fg leading-snug">
          {alt.title || 'Untitled alternative'}
        </h4>
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
      {impact && <footer className="mt-auto border-border border-t px-4 py-2.5">{impact}</footer>}
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
}: {
  output: AlternativesProposal
  lookup: ElementLookup
  onInspect?: (id: string) => void
  renderImpact?: (alternative: ProposedAlternative) => ReactNode
}) {
  const { decision, alternatives, questions } = output
  if (!decision && alternatives.length === 0 && questions.length === 0) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        The proposal holds no decision, alternatives or questions.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
        <div className="flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
          <TypeLabel type="core.Decision" />
          <span className="text-fg-subtle">to-be</span>
          {output.mock && <MockBadge size="sm" />}
          {decision && <BasisBadge basis={decision.claim.basis} size="sm" />}
        </div>
        <h3 className="mt-1 break-words font-semibold text-[16px] text-fg leading-snug">
          {decision?.question || decision?.title || 'No decision in this proposal'}
        </h3>
        {decision?.title && decision.question && (
          <p className="mt-0.5 break-words text-fg-muted text-sm">{decision.title}</p>
        )}
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
                impact={renderImpact?.(alt)}
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
                <span className="min-w-0 flex-1 break-words text-sm">{q.text}</span>
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
                  {e.path.length > 0 && (
                    <code className="block break-words font-mono text-[11px] text-fg-muted leading-snug">
                      {impactPathText(e, labelOf)}
                    </code>
                  )}
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
  const lookup = useMemo<ElementLookup>(
    () => ({
      nameOf: (id) => wb.model?.nameOf(id),
      typeOf: (id) => wb.model?.objectById.get(id)?.type,
    }),
    [wb.model],
  )
  const parsed = useMemo(() => {
    const ops = proposal.data?.ops
    if (!ops) return null
    return run.input.kind === 'alternatives'
      ? { kind: 'alternatives' as const, output: parseAlternativesProposal(ops) }
      : { kind: 'summary' as const, assertions: parseSummaryProposal(ops) }
  }, [proposal.data, run.input.kind])

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
      ) : parsed.kind === 'alternatives' ? (
        <AlternativesView
          output={parsed.output}
          lookup={lookup}
          onInspect={wb.select}
          renderImpact={(alt) => <ImpactToggle alternative={alt} />}
        />
      ) : (
        <SummaryView assertions={parsed.assertions} lookup={lookup} onInspect={wb.select} />
      )}
    </section>
  )
}
