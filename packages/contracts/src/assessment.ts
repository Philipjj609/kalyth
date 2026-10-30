import { z } from 'zod'
import { EvidenceId, ObjectId, ProjectId, RelationId } from './ids.ts'
import { ConditionTest, Decimal } from './units.ts'

/**
 * A parameter's value (ADR 0028 §3). An interval is a range or an uncertainty band; `unknown`
 * means someone looked and could not say, which is different from a missing parameter.
 */
export const ParameterValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), value: Decimal, unit: z.string().min(1) }),
  z.object({
    kind: z.literal('interval'),
    min: Decimal.optional(),
    max: Decimal.optional(),
    unit: z.string().min(1),
    minInclusive: z.boolean(),
    maxInclusive: z.boolean(),
  }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('category'), value: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1).max(2000) }),
])
export type ParameterValue = z.infer<typeof ParameterValue>

/** Which facts about a property a parameter states (ADR 0028 §3, amendment A1). */
export const ParameterNature = z.enum(['current', 'expected', 'target', 'limit'])
export type ParameterNature = z.infer<typeof ParameterNature>

/** What applicability may say (ADR 0028 §5). Declared conditions only, never a recommendation. */
export const Verdict = z.enum([
  'conditionsMet',
  'conditionsNotMet',
  'unknown',
  'excepted',
  'conflicting',
  'notAssessed',
])
export type Verdict = z.infer<typeof Verdict>

export const ConditionResult = z.enum(['true', 'false', 'unknown'])

/** Why a condition is unknown (ADR 0028 §4). */
export const UnknownReason = z.enum([
  'missing',
  'declared-unknown',
  'straddles',
  'contradictory',
  'no-correspondence',
  'incompatible',
  'notAssessed',
])

/** A version of library knowledge the evaluator read, pinned by its hash (ADR 0027 §2). */
export const KnowledgeRead = z.object({
  library: ProjectId,
  target: z.enum(['object', 'relation']),
  id: z.string(),
  revision: z.int().min(0),
  versionSha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type KnowledgeRead = z.infer<typeof KnowledgeRead>

/** A project record the evaluator read, at the version it read. */
export const RecordRead = z.object({ id: ObjectId, revision: z.int().min(0) })

/**
 * Everything an assessment depends on, and nothing more (ADR 0029 §2): the evaluator records each
 * read as it makes it.
 */
export const DependencySet = z.object({
  knowledge: z.array(KnowledgeRead),
  parameters: z.array(RecordRead),
  scenarios: z.array(RecordRead),
  elements: z.array(RecordRead),
  libraryUses: z.array(RecordRead),
  evaluatorVersion: z.string(),
})
export type DependencySet = z.infer<typeof DependencySet>

/** One condition's row in an explanation: why the verdict is what it is (ADR 0028 §6). */
export const ExplanationStep = z.object({
  condition: z.string(),
  text: z.string(),
  relation: z.enum(['appliesWhen', 'unsuitableWhen', 'exceptWhen', 'requires']),
  concept: z.string().optional(),
  test: ConditionTest.optional(),
  parameters: z.array(
    z.object({
      id: ObjectId,
      revision: z.int().min(0),
      value: ParameterValue,
      /** `element`, `ancestor:<id>`, `system`, each prefixed `base:<scenario>/` when inherited. */
      resolvedFrom: z.string(),
    }),
  ),
  /** Values of other natures at the same scope, shown as context and never used (A1). */
  context: z
    .array(
      z.object({
        id: ObjectId,
        nature: ParameterNature,
        value: ParameterValue,
        resolvedFrom: z.string(),
      }),
    )
    .optional(),
  result: ConditionResult,
  reason: UnknownReason.optional(),
  /** For `requires`: the required pattern's verdict. */
  requiredVerdict: Verdict.optional(),
})
export type ExplanationStep = z.infer<typeof ExplanationStep>

/** What a missing value needs, so a person can state it (ADR 0028 §3a). */
export const MissingValue = z.object({
  concept: z.string(),
  conceptName: z.string(),
  scenario: ObjectId,
  element: ObjectId.optional(),
  nature: ParameterNature,
  dimension: z.string().optional(),
})
export type MissingValue = z.infer<typeof MissingValue>

export const Explanation = z.object({
  item: z.object({ library: ProjectId, id: z.string(), revision: z.int(), name: z.string() }),
  verdict: Verdict,
  evaluatorVersion: z.string(),
  /** The nature of the values assessed: the verdict holds for these, not for others (A1). */
  nature: ParameterNature,
  steps: z.array(ExplanationStep),
  missing: z.array(MissingValue),
  /** What the verdict says about the knowledge itself, so a reader never mistakes it for advice. */
  knowledge: z.object({
    maturity: z.string(),
    disputed: z.boolean(),
  }),
  scenario: z.object({ id: ObjectId, status: z.string(), rationale: z.string() }),
  /** Always present: what the verdict means, and does not mean (ADR 0028 I8). */
  meaning: z.string(),
})
export type Explanation = z.infer<typeof Explanation>

/** Asks the evaluator for a verdict on one item, scenario and element (ADR 0029 §1). */
export const AssessInput = z.object({
  projectId: ProjectId,
  /** The project's pin of the pattern or principle. */
  item: EvidenceId,
  scenario: ObjectId,
  /** Omitted for the whole system. */
  element: ObjectId.optional(),
  /** Which values to assess; other natures are context only (ADR 0028 amendment A1). */
  nature: ParameterNature.default('expected'),
})
export type AssessInput = z.input<typeof AssessInput>

export const AssessmentResult = z.object({
  verdict: Verdict,
  explanation: Explanation,
  inputs: DependencySet,
})
export type AssessmentResult = z.infer<typeof AssessmentResult>

/** An assessment's freshness, computed on read (ADR 0029 §3). */
export const AssessmentFreshness = z.object({
  id: ObjectId,
  verdict: Verdict,
  status: z.enum(['current', 'stale']),
  reasons: z.array(z.string()),
  /** The verdict a reassessment would give now, when it can be computed. */
  verdictNow: Verdict.optional(),
})
export type AssessmentFreshness = z.infer<typeof AssessmentFreshness>

export const AssessmentStatusResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  assessments: z.array(AssessmentFreshness),
})
export type AssessmentStatusResult = z.infer<typeof AssessmentStatusResult>

export const ConditionRef = z.union([ObjectId, RelationId])
