import { z } from 'zod'
import { NavigatorRunId, ObjectId, PrincipalId, ProjectId, ProposalId, RelationId } from './ids.ts'
import { RelationTypeName, TypeName } from './registry.ts'
import { KernelError } from './results.ts'

const revision = z.int().min(0).optional()

// ---------- impact traversal (ADR 0010) ----------

export const ImpactQuery = z.object({
  projectId: ProjectId,
  revision,
  seeds: z.array(ObjectId).min(1).max(50),
  maxDepth: z.int().min(1).max(8).default(4),
  maxNodes: z.int().min(1).max(1000).default(300),
})
export type ImpactQuery = z.input<typeof ImpactQuery>

/** One hop of an impact path, in traversal order: a change at `from` may affect `to`. */
export const ImpactStep = z.object({
  relationId: RelationId,
  type: RelationTypeName,
  from: ObjectId,
  to: ObjectId,
  /** "forward" follows the relation from its source to its target; "reverse" goes against it. */
  direction: z.enum(['forward', 'reverse']),
  /** "relation": the type's declared impact rule; "definition": a module defines the element. */
  rule: z.enum(['relation', 'definition']),
})
export type ImpactStep = z.infer<typeof ImpactStep>

export const ImpactedElement = z.object({
  id: ObjectId,
  type: TypeName,
  label: z.string(),
  /** 0 for a seed. */
  depth: z.int().min(0),
  seed: ObjectId,
  /** A shortest path from the seed; empty for a seed. */
  path: z.array(ImpactStep),
})
export type ImpactedElement = z.infer<typeof ImpactedElement>

export const ImpactResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  seeds: z.array(ObjectId),
  elements: z.array(ImpactedElement),
  /** True when the depth or node limit cut the traversal short. */
  truncated: z.boolean(),
})
export type ImpactResult = z.infer<typeof ImpactResult>

// ---------- provider gateway and budget ----------

export const BudgetThreshold = z.object({ fraction: z.number(), reached: z.boolean() })

/** Amounts are integer micro-dollars (1 USD = 1,000,000). */
export const BudgetStatus = z.object({
  capMicroUsd: z.int().min(0),
  capNote: z.string().nullable(),
  capSetAt: z.iso.datetime().nullable(),
  spentMicroUsd: z.int().min(0),
  /** Reserved by calls in flight or with an unknown outcome; counted as spent. */
  reservedMicroUsd: z.int().min(0),
  remainingMicroUsd: z.int(),
  calls: z.int().min(0),
  thresholds: z.array(BudgetThreshold),
})
export type BudgetStatus = z.infer<typeof BudgetStatus>

export const ProviderConsent = z.object({
  /** False for local providers such as the mock. */
  required: z.boolean(),
  granted: z.boolean(),
  grantedBy: PrincipalId.nullable(),
  grantedAt: z.iso.datetime().nullable(),
})
export type ProviderConsent = z.infer<typeof ProviderConsent>

export const NavigatorStatus = z.object({
  provider: z.object({
    id: z.string(),
    /** Sends project content outside this machine. */
    external: z.boolean(),
    /** Calls may cost money. */
    paid: z.boolean(),
  }),
  /** Model id per role, e.g. { summarize: "...", alternatives: "..." }. */
  models: z.record(z.string(), z.string()),
  budget: BudgetStatus,
  consent: ProviderConsent,
})
export type NavigatorStatus = z.infer<typeof NavigatorStatus>

export const ConsentInput = z.object({ projectId: ProjectId, granted: z.boolean() })

// ---------- Navigator runs ----------

export const ModelCallOutcome = z.enum([
  'ok',
  'schema_invalid',
  'refused',
  'failed',
  'unknown_outcome',
])
export type ModelCallOutcome = z.infer<typeof ModelCallOutcome>

export const ModelCallRecord = z.object({
  purpose: z.string(),
  provider: z.string(),
  model: z.string(),
  attempt: z.int().min(1),
  outcome: ModelCallOutcome,
  inputTokens: z.int().min(0).nullable(),
  outputTokens: z.int().min(0).nullable(),
  reservedMicroUsd: z.int().min(0),
  costMicroUsd: z.int().min(0),
  latencyMs: z.int().min(0),
  issues: z.array(z.string()),
})
export type ModelCallRecord = z.infer<typeof ModelCallRecord>

export const GroundingRejection = z.object({
  /** Which output item was rejected, e.g. "alternative 2" or "statement 1". */
  item: z.string(),
  reason: z.string(),
  ref: z.string().optional(),
})
export type GroundingRejection = z.infer<typeof GroundingRejection>

/** A citation accepted by the bounded second pass (ADR 0017), kept verbatim for audit. */
export const NormalizedCitation = z.object({
  item: z.string(),
  ref: z.string(),
  /** The model's quote, verbatim. */
  quote: z.string(),
  /** The pinned source text it was matched to, verbatim. */
  source: z.string(),
  differences: z.array(z.enum(['typographic quotes', 'layout', 'python string delimiters'])),
})
export type NormalizedCitation = z.infer<typeof NormalizedCitation>

/** What the grounding validator checked in one run (ADR 0010, ADR 0017). */
export const GroundingReport = z.object({
  citations: z.int().min(0),
  /** Citations accepted: exact plus normalised. */
  validCitations: z.int().min(0),
  /**
   * Accepted by the original comparison, the benchmark metric. Absent in runs recorded before
   * ADR 0017, where every accepted citation was exact.
   */
  exactCitations: z.int().min(0).optional(),
  /** Accepted only by the bounded second pass (ADR 0017). */
  normalizedCitations: z.int().min(0).optional(),
  /** The normalised matches, up to 100, for audit. */
  normalizedMatches: z.array(NormalizedCitation).max(100).optional(),
  itemsKept: z.int().min(0),
  itemsRejected: z.array(GroundingRejection),
})
export type GroundingReport = z.infer<typeof GroundingReport>

export const StartNavigatorRunInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summarize'), projectId: ProjectId, elementId: ObjectId }),
  z.object({
    kind: z.literal('alternatives'),
    projectId: ProjectId,
    request: z.string().trim().min(3).max(2000),
    /** Elements the person wants considered first. */
    focus: z.array(ObjectId).max(20).default([]),
    /**
     * An open decision to explore again (Tier B, Journey 1): the run sees its alternatives and the
     * answers to its questions, and adds alternatives and questions to it instead of a new decision.
     */
    decisionId: ObjectId.optional(),
  }),
])
export type StartNavigatorRunInput = z.input<typeof StartNavigatorRunInput>

export const NavigatorRunStatus = z.enum(['running', 'completed', 'failed'])
export type NavigatorRunStatus = z.infer<typeof NavigatorRunStatus>

export const NavigatorRunOutput = z.object({
  assertions: z.int().min(0),
  decisions: z.int().min(0),
  alternatives: z.int().min(0),
  questions: z.int().min(0),
  directImpacts: z.int().min(0),
})
export type NavigatorRunOutput = z.infer<typeof NavigatorRunOutput>

export const NavigatorRun = z.object({
  id: NavigatorRunId,
  projectId: ProjectId,
  input: StartNavigatorRunInput,
  status: NavigatorRunStatus,
  requestedBy: PrincipalId,
  baseRevision: z.int().min(0),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  calls: z.array(ModelCallRecord),
  costMicroUsd: z.int().min(0),
  grounding: GroundingReport.nullable(),
  output: NavigatorRunOutput.nullable(),
  /** The proposal holding everything the run produced; people review and commit it. */
  proposalId: ProposalId.nullable(),
  error: KernelError.nullable(),
})
export type NavigatorRun = z.infer<typeof NavigatorRun>

export const NavigatorRunQuery = z.object({ runId: NavigatorRunId })
export const NavigatorRunListQuery = z.object({
  projectId: ProjectId,
  limit: z.int().min(1).max(200).default(50),
})
export const NavigatorRunList = z.object({ runs: z.array(NavigatorRun) })
