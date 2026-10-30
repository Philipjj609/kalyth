import { z } from 'zod'
import { KnowledgeRead, ParameterNature, Verdict } from './assessment.ts'
import { InstructionOrigin } from './auth.ts'
import { EvidenceId, MethodRunId, ObjectId, PrincipalId, ProjectId, ProposalId } from './ids.ts'

/**
 * The check catalogue, version 1 (ADR 0029 §5, ADR 0033 §8). Each check is a pure function of a
 * proposal's operations and the project state, reading an alternative's structured `basis`.
 */
export const CHECK_CATALOGUE_VERSION = 1
export const CheckName = z.enum([
  'alternatives-cite-assessments',
  'no-reliance-on-ruled-out',
  'disputed-flagged',
  'hypotheses-labelled',
  'worsens-disclosed',
  'unknowns-asked',
])
export type CheckName = z.infer<typeof CheckName>

export const MANDATORY_CHECKS: readonly CheckName[] = [
  'alternatives-cite-assessments',
  'no-reliance-on-ruled-out',
  'disputed-flagged',
  'hypotheses-labelled',
]

/** One check on one alternative. A mandatory failure blocks commit and acceptance (ADR 0033 §8). */
export const CheckResult = z.object({
  check: CheckName,
  version: z.int().min(1),
  severity: z.enum(['mandatory', 'advisory']),
  target: ObjectId,
  passed: z.boolean(),
  detail: z.string(),
  /** A CheckException that lets a mandatory failure through, given by a person. */
  exceptedBy: ObjectId.optional(),
})
export type CheckResult = z.infer<typeof CheckResult>

/** A person's exception to a failed mandatory check, given with the commit (ADR 0033 §8). */
export const CheckExceptionInput = z.object({
  check: CheckName,
  target: ObjectId,
  reason: z.string().min(1).max(2000),
})
export type CheckExceptionInput = z.infer<typeof CheckExceptionInput>

export const MethodRunLimits = z.object({
  maxCandidates: z.int().min(1).max(50).default(12),
  maxHops: z.int().min(0).max(3).default(2),
  maxAssessments: z.int().min(1).max(200).default(60),
})

/** Starting a deterministic method run (ADR 0033 §2). Scenarios and natures are explicit. */
export const MethodRunInput = z.object({
  projectId: ProjectId,
  /** The project's pin of a knowledge.Method. */
  method: EvidenceId,
  scenarios: z.array(ObjectId).min(1).max(10),
  natures: z.array(ParameterNature).min(1).max(4),
  /** Default: the whole system only. */
  elements: z.array(ObjectId).max(20).optional(),
  /** An open Decision to add alternatives to; otherwise the run proposes one. */
  decision: ObjectId.optional(),
  question: z.string().min(1).max(2000).optional(),
  /** Terms for the lexical source. */
  request: z.string().min(1).max(2000).optional(),
  /** Pins a person adds (the `person` source). */
  add: z.array(EvidenceId).max(20).optional(),
  limits: MethodRunLimits.default({ maxCandidates: 12, maxHops: 2, maxAssessments: 60 }),
  /** The run this one re-runs, if any. */
  previous: MethodRunId.optional(),
})
export type MethodRunInput = z.input<typeof MethodRunInput>
export type MethodRunInputParsed = z.output<typeof MethodRunInput>

export const SelectionSource = z.enum([
  'explicit',
  'person',
  'parameter',
  'elementType',
  'graph',
  'lexical',
])
export type SelectionSource = z.infer<typeof SelectionSource>

/** One way a candidate was found, with what led to it. */
export const SourceHit = z.object({
  source: SelectionSource,
  /** For graph: the relations followed, from a selected item; for others, what named it. */
  path: z.array(z.string()).optional(),
  hops: z.int().min(0).optional(),
  score: z.number().optional(),
})
export type SourceHit = z.infer<typeof SourceHit>

export const SelectedItem = z.object({
  library: ProjectId,
  id: z.string(),
  type: z.string(),
  name: z.string(),
  /** The project's pin, when it already had one. */
  pin: EvidenceId.optional(),
  sources: z.array(SourceHit),
  reason: z.string().optional(),
})
export type SelectedItem = z.infer<typeof SelectedItem>

/** An exact assessment context: one item, scenario, element (or the whole system) and nature. */
export const ContextVerdict = z.object({
  scenario: ObjectId,
  element: ObjectId.optional(),
  nature: ParameterNature,
  verdict: Verdict,
  specification: z.enum(['sufficient', 'underspecified']),
  /** The assessment in the proposal: an id once filed. */
  assessment: z.string(),
})
export type ContextVerdict = z.infer<typeof ContextVerdict>

export const ComparisonEntry = z.object({
  library: ProjectId,
  id: z.string(),
  name: z.string(),
  /** Its alternative in the proposal; absent when it is ruled out in every context. */
  alternative: z.string().optional(),
  contexts: z.array(ContextVerdict),
  tradeoffs: z.array(
    z.object({
      effect: z.enum(['improves', 'worsens', 'mixed']),
      quality: z.string(),
      note: z.string(),
    }),
  ),
  constraints: z.array(z.object({ id: z.string(), statement: z.string() })),
  /** Candidate patterns that refine this one, shown under it rather than as alternatives. */
  refinedBy: z.array(
    z.object({ id: z.string(), name: z.string(), contexts: z.array(ContextVerdict) }),
  ),
  underspecified: z.boolean(),
  ruledOutEverywhere: z.boolean(),
})
export type ComparisonEntry = z.infer<typeof ComparisonEntry>

export const Uncertainty = z.object({
  kind: z.enum([
    'missing',
    'straddles',
    'declared-unknown',
    'contradictory',
    'no-correspondence',
    'incompatible',
    'underspecified',
    'scenario-assumed',
    'scenario-planned',
  ]),
  item: z.string().optional(),
  concept: z.string().optional(),
  scenario: ObjectId,
  element: ObjectId.optional(),
  nature: ParameterNature,
  detail: z.string(),
})
export type Uncertainty = z.infer<typeof Uncertainty>

export const MethodRunStatus = z.enum(['running', 'proposed', 'failed'])

/** A run: operational data outside the event log (ADR 0033 §9). It never commits. */
export const MethodRun = z.object({
  id: MethodRunId,
  projectId: ProjectId,
  startedBy: PrincipalId,
  origin: InstructionOrigin,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  input: z.json(),
  pinned: z.object({
    method: KnowledgeRead.nullable(),
    libraryUses: z.array(z.object({ id: ObjectId, library: ProjectId, revision: z.int() })),
    projectRevision: z.int().min(0),
    engineVersion: z.string(),
    checkCatalogueVersion: z.int(),
  }),
  status: MethodRunStatus,
  selection: z.object({
    candidates: z.array(SelectedItem),
    cut: z.array(SelectedItem),
    ideas: z.array(SelectedItem),
    excluded: z.array(SelectedItem),
    missingLibraries: z.array(ProjectId),
  }),
  uncertainties: z.array(Uncertainty),
  comparison: z.array(ComparisonEntry),
  checks: z.array(CheckResult),
  proposal: ProposalId.nullable(),
  /** The proposal's status now, read from it: a run never changes. */
  proposalStatus: z.string().nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Hash of the outputs with ids and times masked: equal for equal inputs and revisions. */
  outputSha256: z.string().nullable(),
  cost: z.object({ modelCalls: z.literal(0), microUsd: z.literal(0) }),
})
export type MethodRun = z.infer<typeof MethodRun>

export const GetMethodRunInput = z.object({ projectId: ProjectId, id: MethodRunId })
export const ListMethodRunsInput = z.object({
  projectId: ProjectId,
  limit: z.int().min(1).max(200).default(50),
})
export const MethodRunList = z.object({
  projectId: ProjectId,
  runs: z.array(
    MethodRun.pick({
      id: true,
      startedBy: true,
      origin: true,
      startedAt: true,
      status: true,
      proposal: true,
      proposalStatus: true,
      failure: true,
    }),
  ),
})
export type MethodRunList = z.infer<typeof MethodRunList>
