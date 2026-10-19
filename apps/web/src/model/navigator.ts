import type {
  Claim,
  GroundingReport,
  ImpactedElement,
  ImpactResult,
  ImpactStep,
  ModelCallRecord,
  NavigatorRun,
  NavigatorStatus,
  OperationInput,
  ResolvedOperation,
} from '@kalyth/contracts'
import { shortId } from './format.ts'
import { compareTypes, type Tone } from './semantics.ts'

/**
 * Pure display logic for the Navigator (ADR 0010): money, budget warnings, run summaries, impact
 * paths and the records a run proposes. Everything a model wrote is data; these functions only
 * read and reshape it, and the UI renders the results as text.
 */

// ---------- money ----------

const MICRO_PER_TEN_THOUSANDTH = 100

/**
 * Integer micro-dollars as USD with four decimals, e.g. 1_234_567 -> "$1.2346". Rounded half
 * away from zero in integer arithmetic, so no floating-point error reaches the display.
 */
export function formatMicroUsd(micro: number): string {
  if (!Number.isFinite(micro)) return '—'
  const units = Math.round(Math.abs(micro) / MICRO_PER_TEN_THOUSANDTH)
  const dollars = Math.floor(units / 10_000)
  const fraction = String(units % 10_000).padStart(4, '0')
  return `${micro < 0 && units > 0 ? '-' : ''}$${dollars.toLocaleString('en')}.${fraction}`
}

/** The exact amount, for a title: "$0.000037 (37 micro-USD)". */
export function exactMicroUsd(micro: number): string {
  if (!Number.isFinite(micro)) return '—'
  const abs = Math.abs(Math.trunc(micro))
  const dollars = Math.floor(abs / 1_000_000)
  const fraction = String(abs % 1_000_000).padStart(6, '0')
  return `${micro < 0 ? '-' : ''}$${dollars.toLocaleString('en')}.${fraction} (${Math.trunc(micro).toLocaleString('en')} micro-USD)`
}

// ---------- provider and budget ----------

export interface BudgetWarning {
  tone: Extract<Tone, 'warning' | 'caution' | 'danger'>
  text: string
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/**
 * Warnings for the status strip and header: no cap on a paid provider, an exhausted cap, and the
 * highest advisory threshold reached (ADR 0010: 50 and 80 percent).
 */
export function budgetWarnings(
  status: Pick<NavigatorStatus, 'provider' | 'budget'>,
): BudgetWarning[] {
  const { budget, provider } = status
  const warnings: BudgetWarning[] = []
  if (budget.capMicroUsd === 0) {
    if (provider.paid) {
      warnings.push({
        tone: 'danger',
        text: 'No budget cap is set, so every paid call is refused.',
      })
    }
    return warnings
  }
  if (budget.remainingMicroUsd <= 0) {
    warnings.push({
      tone: 'danger',
      text: 'The budget cap is used up. Paid calls are refused until it is raised.',
    })
    return warnings
  }
  const reached = budget.thresholds
    .filter((t) => t.reached)
    .sort((a, b) => b.fraction - a.fraction)[0]
  if (reached) {
    warnings.push({
      tone: reached.fraction >= 0.8 ? 'caution' : 'warning',
      text: `${percent(reached.fraction)} of the budget cap is spent or reserved.`,
    })
  }
  return warnings
}

/** The share of the cap spent or reserved, 0 to 1, or null without a cap. */
export function budgetUsed(budget: NavigatorStatus['budget']): number | null {
  if (budget.capMicroUsd <= 0) return null
  return Math.min(
    1,
    Math.max(0, (budget.spentMicroUsd + budget.reservedMicroUsd) / budget.capMicroUsd),
  )
}

/** What the provider implies for the person, as short sentences. */
export function providerFacts(provider: NavigatorStatus['provider']): string[] {
  return [
    provider.external ? 'Sends project content off this machine' : 'Runs on this machine',
    provider.paid ? 'Calls may cost money' : 'Calls are free',
  ]
}

// ---------- runs ----------

export const RUN_POLL_MS = 1000

/** Refetch interval for one run: about once a second while it runs, then never (it is final). */
export function runRefetchInterval(run: Pick<NavigatorRun, 'status'> | undefined): number | false {
  return run?.status === 'running' ? RUN_POLL_MS : false
}

export const RUN_STATUS_META: Record<
  NavigatorRun['status'],
  { label: string; tone: Tone; description: string }
> = {
  running: { label: 'Running', tone: 'accent', description: 'The model calls are in progress.' },
  completed: {
    label: 'Completed',
    tone: 'success',
    description: 'Finished; what it produced is one pending proposal.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    description: 'Stopped with an error; nothing was proposed unless a proposal is linked.',
  },
}

export const CALL_OUTCOME_META: Record<ModelCallRecord['outcome'], { label: string; tone: Tone }> =
  {
    ok: { label: 'OK', tone: 'success' },
    schema_invalid: { label: 'Schema invalid', tone: 'caution' },
    refused: { label: 'Refused', tone: 'warning' },
    failed: { label: 'Failed', tone: 'danger' },
    unknown_outcome: { label: 'Unknown outcome', tone: 'warning' },
  }

export const RUN_KIND_LABEL: Record<NavigatorRun['input']['kind'], string> = {
  summarize: 'Summary',
  alternatives: 'Alternatives',
}

/** True when any call of the run went to the mock provider: its text is not model output. */
export function isMockRun(run: Pick<NavigatorRun, 'calls'>): boolean {
  return run.calls.some((c) => c.provider === 'mock')
}

/** What the run was asked: the element summarised, or the change request. */
export function runSubject(
  run: Pick<NavigatorRun, 'input'>,
  nameOf: (id: string) => string | undefined,
): string {
  const input = run.input
  return input.kind === 'summarize'
    ? (nameOf(input.elementId) ?? shortId(input.elementId))
    : input.request
}

/**
 * Exact, normalised and rejected citations of a run (ADR 0017). Runs recorded before ADR 0017
 * have no separate counts; every accepted citation in them was exact.
 */
export function citationCounts(grounding: GroundingReport) {
  const exact = grounding.exactCitations ?? grounding.validCitations
  const normalized = grounding.normalizedCitations ?? 0
  return { exact, normalized, rejected: grounding.citations - exact - normalized }
}

/**
 * "7 of 9 exact", "7 exact and 2 normalised of 9", "no citations", or "—" before grounding.
 * Normalised matches are never counted as exact.
 */
export function citationSummary(grounding: GroundingReport | null): string {
  if (!grounding) return '—'
  if (grounding.citations === 0) return 'no citations'
  const { exact, normalized } = citationCounts(grounding)
  const total = grounding.citations.toLocaleString('en')
  return normalized > 0
    ? `${exact.toLocaleString('en')} exact and ${normalized.toLocaleString('en')} normalised of ${total}`
    : `${exact.toLocaleString('en')} of ${total} exact`
}

/** Input and output tokens of a call, e.g. "1,204 in · 388 out"; "?" where not reported. */
export function callTokens(call: Pick<ModelCallRecord, 'inputTokens' | 'outputTokens'>): string {
  const n = (v: number | null) => (v === null ? '?' : v.toLocaleString('en'))
  return `${n(call.inputTokens)} in · ${n(call.outputTokens)} out`
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** Output counts in display order, keeping zeros so a run that produced nothing says so. */
export function outputCounts(output: NavigatorRun['output']): [string, number][] {
  if (!output) return []
  return [
    ['Assertions', output.assertions],
    ['Decisions', output.decisions],
    ['Alternatives', output.alternatives],
    ['Questions', output.questions],
    ['Direct impacts', output.directImpacts],
  ]
}

// ---------- impact traversal ----------

/**
 * One hop as text. The arrow follows the relation's own direction, so a reverse step reads
 * against it: `-dependsOn->` forward, `<-dependsOn-` reverse; definitional containment is marked
 * `(defines)`.
 */
export function stepText(step: Pick<ImpactStep, 'type' | 'direction' | 'rule'>): string {
  const label = step.rule === 'definition' ? `${step.type} (defines)` : step.type
  return step.direction === 'forward' ? `-${label}->` : `<-${label}-`
}

/**
 * A readable typed path from the seed to the element, e.g.
 * `Item <-contains (defines)- app/models.py <-dependsOn- app/crud.py`.
 */
export function impactPathText(
  element: Pick<ImpactedElement, 'seed' | 'path' | 'label'>,
  labelOf: (id: string) => string,
): string {
  if (element.path.length === 0) return element.label
  const parts = [labelOf(element.seed)]
  for (const step of element.path) parts.push(stepText(step), labelOf(step.to))
  return parts.join(' ')
}

/** Labels for every id an impact result mentions: its own labels, then the model's, then ids. */
export function impactLabeller(
  result: Pick<ImpactResult, 'elements'>,
  nameOf: (id: string) => string | undefined,
): (id: string) => string {
  const labels = new Map(result.elements.map((e) => [e.id, e.label]))
  return (id) => labels.get(id) || nameOf(id) || shortId(id)
}

export interface ImpactGroup {
  type: string
  elements: ImpactedElement[]
}

/** Impacted elements grouped by type (types in model order), nearest first within a group. */
export function groupImpact(result: Pick<ImpactResult, 'elements'>): ImpactGroup[] {
  const byType = new Map<string, ImpactedElement[]>()
  for (const e of result.elements) byType.set(e.type, [...(byType.get(e.type) ?? []), e])
  return [...byType.entries()]
    .sort(([a], [b]) => compareTypes(a, b))
    .map(([type, elements]) => ({
      type,
      elements: [...elements].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label)),
    }))
}

// ---------- what a run proposed ----------

type CreateObject = Extract<ResolvedOperation, { op: 'createObject' }>
type CreateRelation = Extract<ResolvedOperation, { op: 'createRelation' }>

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Distinct evidence ids a claim cites across its support groups. */
export function citationCount(claim: Pick<Claim, 'supports'>): number {
  return new Set(claim.supports.flatMap((g) => g.allOf)).size
}

export function isMockClaim(claim: Pick<Claim, 'model'> | undefined): boolean {
  return claim?.model?.provider === 'mock'
}

/** True when any operation's claim came from the mock provider. */
export function hasMockOutput(ops: readonly ResolvedOperation[]): boolean {
  return ops.some((o) => 'claim' in o && isMockClaim(o.claim))
}

export interface ProposedRecord {
  id: string
  claim: Claim
  citations: number
  mock: boolean
}

export interface DirectChange {
  relationId: string
  targetId: string
  change: string
  citations: number
  mock: boolean
}

export interface ProposedAlternative extends ProposedRecord {
  title: string
  summary: string
  tradeoffs: string
  changes: DirectChange[]
  /** For a hybrid: the alternatives it combines, in this proposal or already in the model. */
  combines: string[]
}

export interface ProposedQuestion extends ProposedRecord {
  text: string
  inquiryRole: string
  status: string
  /** True when a `concerns` relation links it to the decision. */
  linked: boolean
}

export interface ProposedDecision extends ProposedRecord {
  title: string
  question: string
}

export interface AlternativesProposal {
  decision: ProposedDecision | null
  /**
   * The decision the alternatives answer: the one this proposal creates, or an open decision
   * already in the model when a run explores it again (Journey 1).
   */
  decisionId: string | null
  alternatives: ProposedAlternative[]
  questions: ProposedQuestion[]
  /** Any record here came from the mock provider. */
  mock: boolean
}

function record(op: CreateObject | CreateRelation): ProposedRecord {
  return {
    id: op.id,
    claim: op.claim,
    citations: citationCount(op.claim),
    mock: isMockClaim(op.claim),
  }
}

/**
 * Reads an alternatives run's proposal (ADR 0010): one core.Decision, its core.Alternatives
 * (`alternativeOf`), their direct changes (`impacts`, with properties.change) and core.Questions
 * (`concerns`). Local refs are already resolved, so relations are matched to the objects created
 * in the same proposal by id. Alternatives linked to the decision come first, in proposal order;
 * any others follow rather than being dropped.
 */
export function parseAlternativesProposal(ops: readonly ResolvedOperation[]): AlternativesProposal {
  const objects = ops.filter((o): o is CreateObject => o.op === 'createObject')
  const relations = ops.filter((o): o is CreateRelation => o.op === 'createRelation')
  const decisionOp = objects.find((o) => o.type === 'core.Decision')
  const decision: ProposedDecision | null = decisionOp
    ? {
        ...record(decisionOp),
        title: text(decisionOp.attributes.title),
        question: text(decisionOp.attributes.question),
      }
    : null

  const decisionId = decision?.id ?? relations.find((r) => r.type === 'alternativeOf')?.to ?? null
  const linkedToDecision = (type: string) =>
    new Set(
      relations
        .filter((r) => r.type === type && decisionId !== null && r.to === decisionId)
        .map((r) => r.from),
    )
  const alternativeOf = linkedToDecision('alternativeOf')
  const concerns = linkedToDecision('concerns')

  const alternatives = objects
    .filter((o) => o.type === 'core.Alternative')
    .map(
      (o): ProposedAlternative => ({
        ...record(o),
        title: text(o.attributes.title),
        summary: text(o.attributes.summary),
        tradeoffs: text(o.attributes.tradeoffs),
        changes: relations
          .filter((r) => r.type === 'impacts' && r.from === o.id)
          .map((r) => ({
            relationId: r.id,
            targetId: r.to,
            change: text(r.properties.change),
            citations: citationCount(r.claim),
            mock: isMockClaim(r.claim),
          })),
        combines: relations
          .filter((r) => r.type === 'combines' && r.from === o.id)
          .map((r) => r.to),
      }),
    )
    .sort((a, b) => Number(alternativeOf.has(b.id)) - Number(alternativeOf.has(a.id)))

  const questions = objects
    .filter((o) => o.type === 'core.Question')
    .map(
      (o): ProposedQuestion => ({
        ...record(o),
        text: text(o.attributes.text),
        inquiryRole: text(o.attributes.inquiryRole),
        status: text(o.attributes.status) || 'open',
        linked: concerns.has(o.id),
      }),
    )

  return {
    decision,
    decisionId,
    alternatives,
    questions,
    mock: hasMockOutput(ops),
  }
}

export interface ProposedAssertion extends ProposedRecord {
  statement: string
  /** Elements the assertion `concerns`. */
  concerns: string[]
}

/** Reads a summarize run's proposal: core.Assertions with `concerns` to the summarised element. */
export function parseSummaryProposal(ops: readonly ResolvedOperation[]): ProposedAssertion[] {
  const relations = ops.filter((o): o is CreateRelation => o.op === 'createRelation')
  return ops
    .filter((o): o is CreateObject => o.op === 'createObject' && o.type === 'core.Assertion')
    .map((o) => ({
      ...record(o),
      statement: text(o.attributes.statement),
      concerns: relations.filter((r) => r.type === 'concerns' && r.from === o.id).map((r) => r.to),
    }))
}

/** Seeds for an alternative's propagated impact: the targets of its direct changes. */
export function impactSeeds(alternative: Pick<ProposedAlternative, 'changes'>): string[] {
  return [...new Set(alternative.changes.map((c) => c.targetId))]
}

// ---------- deciding ----------

export const OTHER_ALTERNATIVE_REJECTED = 'Another alternative was accepted.'

type SetDecisionStatus = Extract<OperationInput, { op: 'setDecisionStatus' }>

/**
 * The operations that record a person's choice: the decision and the chosen alternative become
 * accepted with the person's rationale, every other alternative is rejected. Status changes only
 * through setDecisionStatus (ADR 0006).
 */
export function acceptAlternativeOps(input: {
  decisionId: string
  chosenId: string
  alternativeIds: readonly string[]
  rationale: string
}): SetDecisionStatus[] {
  const { decisionId, chosenId, rationale } = input
  return [
    { op: 'setDecisionStatus', id: decisionId, status: 'accepted', rationale },
    { op: 'setDecisionStatus', id: chosenId, status: 'accepted', rationale },
    ...[...new Set(input.alternativeIds)]
      .filter((id) => id !== chosenId)
      .map(
        (id): SetDecisionStatus => ({
          op: 'setDecisionStatus',
          id,
          status: 'rejected',
          rationale: OTHER_ALTERNATIVE_REJECTED,
        }),
      ),
  ]
}

/** A decision or alternative's current status, from its attributes. */
export function decisionStatusOf(
  object: { attributes: Record<string, unknown> } | undefined,
): string | undefined {
  const status = object?.attributes.status
  return typeof status === 'string' ? status : undefined
}

export const INQUIRY_ROLE_META: Record<string, { tone: Tone; description: string }> = {
  blocking: { tone: 'danger', description: 'Needs an answer before the decision can be made.' },
  'decision-sensitive': {
    tone: 'warning',
    description: 'The answer could change which alternative is best.',
  },
  'model-sensitive': {
    tone: 'accent',
    description: 'The answer could change how the system is modelled.',
  },
  exploratory: { tone: 'neutral', description: 'Worth knowing; it does not block the decision.' },
}
