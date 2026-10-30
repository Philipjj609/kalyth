import { z } from 'zod'
import { Claim, ClaimInput, Lifecycle, Stance } from './claims.ts'
import { Collector, ContentRef, EvidenceInput, EvidenceRecord, EvidenceSource } from './evidence.ts'
import {
  ClaimId,
  ClaimTarget,
  EvidenceId,
  EvidenceTarget,
  LocalRef,
  ObjectId,
  ObjectTarget,
  PrincipalId,
  RelationId,
} from './ids.ts'
import { JsonRecord } from './json.ts'
import {
  Licence,
  Maturity,
  ReviewVerdict,
  SourceVerification,
  SupportGroupKey,
  SupportReview,
  VerificationMethod,
  VerificationStatus,
} from './knowledge.ts'
import { RelationTypeName, TypeName } from './registry.ts'

export const DecisionStatus = z.enum(['open', 'accepted', 'rejected', 'deferred', 'superseded'])
export const AlternativeStatus = z.enum(['proposed', 'accepted', 'rejected', 'withdrawn'])
export const AnyDecisionStatus = z.enum([
  'open',
  'accepted',
  'rejected',
  'deferred',
  'superseded',
  'proposed',
  'withdrawn',
])

const reason = z.string().min(1).max(2000)

/** Task lifecycle (ADR 0013). `running` always carries a lease. */
export const TaskStatus = z.enum([
  'proposed',
  'ready',
  'running',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'unknown_outcome',
])
export type TaskStatus = z.infer<typeof TaskStatus>

/** Transitions the kernel allows; `completed` and `cancelled` are final. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed: ['ready', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: ['running', 'review', 'failed', 'unknown_outcome', 'ready', 'blocked'],
  unknown_outcome: ['review', 'ready', 'failed', 'cancelled'],
  review: ['completed', 'ready', 'failed'],
  blocked: ['ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  completed: [],
  cancelled: [],
}

export const TaskLease = z.object({
  id: z.string().regex(/^lease_[0-9a-f]{32}$/),
  holder: PrincipalId,
  expiresAt: z.iso.datetime(),
})
export type TaskLease = z.infer<typeof TaskLease>

/**
 * What a claim found in the task repository when the last holder's outcome was unknown: commits
 * whose message carries the task trailer, newest first (ADR 0013, amendment of 2026-10-20). Kept
 * while the task is `unknown_outcome`, cleared when it leaves that state, and recorded only by the
 * task coordinator.
 */
export const TaskFinding = z.object({
  commits: z
    .array(z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex commit sha'))
    .min(1)
    .max(5),
})
export type TaskFinding = z.infer<typeof TaskFinding>

// ---------- Operations as submitted (may use local refs) ----------

export const CreateObjectOp = z.object({
  op: z.literal('createObject'),
  ref: LocalRef.optional(),
  type: TypeName,
  stance: Stance,
  attributes: JsonRecord,
  claim: ClaimInput,
})

/** Shallow merge: listed keys replace, a null value removes the key. */
export const UpdateObjectOp = z.object({
  op: z.literal('updateObject'),
  id: ObjectId,
  set: JsonRecord,
  claim: ClaimInput.optional(),
})

export const RetireObjectOp = z.object({ op: z.literal('retireObject'), id: ObjectId, reason })

export const CreateRelationOp = z.object({
  op: z.literal('createRelation'),
  ref: LocalRef.optional(),
  type: RelationTypeName,
  from: ObjectTarget,
  to: ObjectTarget,
  stance: Stance,
  properties: JsonRecord.default({}),
  claim: ClaimInput,
})

/** Shallow merge of properties and/or a replacement claim, for example to refresh evidence. */
export const UpdateRelationOp = z.object({
  op: z.literal('updateRelation'),
  id: RelationId,
  set: JsonRecord.default({}),
  claim: ClaimInput.optional(),
})

export const RetireRelationOp = z.object({
  op: z.literal('retireRelation'),
  id: RelationId,
  reason,
})

export const RecordEvidenceOp = z.object({
  op: z.literal('recordEvidence'),
  ref: LocalRef.optional(),
  evidence: EvidenceInput,
})

/** The only way to change a Decision's or Alternative's status. Human authority required (D4). */
export const SetDecisionStatusOp = z.object({
  op: z.literal('setDecisionStatus'),
  id: ObjectId,
  status: AnyDecisionStatus,
  rationale: reason,
})

/**
 * The only way to change a Task's status and lease (ADR 0013). `lease` is required for `running`;
 * the kernel keeps the current lease on `unknown_outcome` and clears it otherwise. `finding`
 * records what git showed, only with `unknown_outcome`; the kernel keeps it there and clears it
 * when the task leaves that state.
 */
export const SetTaskStatusOp = z.object({
  op: z.literal('setTaskStatus'),
  id: ObjectId,
  status: TaskStatus,
  rationale: reason,
  lease: TaskLease.nullable().default(null),
  finding: TaskFinding.optional(),
})

// ---------- Curation of knowledge libraries (ADR 0030 §3, amendment A1 to A4) ----------

/** The only way to change a knowledge item's maturity. A curator acting directly (A2). */
export const SetMaturityOp = z.object({
  op: z.literal('setMaturity'),
  id: ObjectTarget,
  maturity: Maturity,
  reason,
})

/** A group named by its key, or by its evidence, which the kernel turns into the key (A1). */
export const SupportGroupRef = z.union([
  SupportGroupKey,
  z.object({ allOf: z.array(EvidenceTarget).min(1).max(64) }),
])

/** A curator's review of one support group. `partly` needs a `scopeLimit`. */
export const ReviewSupportOp = z.object({
  op: z.literal('reviewSupport'),
  target: ClaimTarget,
  group: SupportGroupRef,
  verdict: ReviewVerdict,
  note: reason,
  scopeLimit: z.string().min(1).max(500).optional(),
})

/**
 * Records a source verification in every group citing the evidence, in the listed claims or, with
 * no `targets`, in every claim of the library citing it (A3).
 */
export const VerifySourceOp = z.object({
  op: z.literal('verifySource'),
  evidence: EvidenceTarget,
  status: VerificationStatus,
  method: VerificationMethod,
  retrievedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  licence: Licence.optional(),
  note: reason,
  targets: z.array(ClaimTarget).min(1).max(1000).optional(),
})

export const OperationInput = z.discriminatedUnion('op', [
  CreateObjectOp,
  UpdateObjectOp,
  RetireObjectOp,
  CreateRelationOp,
  UpdateRelationOp,
  RetireRelationOp,
  RecordEvidenceOp,
  SetDecisionStatusOp,
  SetTaskStatusOp,
  SetMaturityOp,
  ReviewSupportOp,
  VerifySourceOp,
])
export type OperationInput = z.input<typeof OperationInput>
export type OperationParsed = z.output<typeof OperationInput>

// ---------- Resolved operations (ids assigned, refs resolved, content stored) ----------

/** The local ref a created record was submitted with, kept beside the id it resolved to. */
const createdRef = LocalRef.optional()

export const ResolvedOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createObject'),
    id: ObjectId,
    ref: createdRef,
    type: TypeName,
    stance: Stance,
    attributes: JsonRecord,
    claim: Claim,
  }),
  z.object({
    op: z.literal('updateObject'),
    id: ObjectId,
    set: JsonRecord,
    claim: Claim.optional(),
  }),
  z.object({ op: z.literal('retireObject'), id: ObjectId, reason }),
  z.object({
    op: z.literal('createRelation'),
    id: RelationId,
    ref: createdRef,
    type: RelationTypeName,
    from: ObjectId,
    to: ObjectId,
    stance: Stance,
    properties: JsonRecord,
    claim: Claim,
  }),
  z.object({
    op: z.literal('updateRelation'),
    id: RelationId,
    set: JsonRecord,
    claim: Claim.optional(),
  }),
  z.object({ op: z.literal('retireRelation'), id: RelationId, reason }),
  z.object({
    op: z.literal('recordEvidence'),
    id: EvidenceId,
    ref: createdRef,
    source: EvidenceSource,
    excerpt: ContentRef.nullable(),
    collectedBy: Collector,
    collectedAt: z.iso.datetime(),
  }),
  z.object({
    op: z.literal('setDecisionStatus'),
    id: ObjectId,
    status: AnyDecisionStatus,
    rationale: reason,
  }),
  z.object({
    op: z.literal('setTaskStatus'),
    id: ObjectId,
    status: TaskStatus,
    rationale: reason,
    lease: TaskLease.nullable(),
    // Absent, not null, when nothing was found, so operations stored earlier are unchanged.
    finding: TaskFinding.optional(),
  }),
  z.object({ op: z.literal('setMaturity'), id: ObjectId, maturity: Maturity, reason }),
  /** The review as it will be written: reviewer and time come from the proposal (A4). */
  z.object({
    op: z.literal('reviewSupport'),
    target: ClaimId,
    group: SupportGroupKey,
    review: SupportReview,
  }),
  /**
   * `targets` are the claims written. With `allCiting`, they were found at proposal time, and the
   * citing set at the head must still be the same when committed (A1).
   */
  z.object({
    op: z.literal('verifySource'),
    evidence: EvidenceId,
    verification: SourceVerification,
    targets: z.array(ClaimId).max(1000),
    allCiting: z.boolean(),
  }),
])
export type ResolvedOperation = z.infer<typeof ResolvedOperation>

// ---------- Resolved writes: complete post-state carried by events (R3) ----------

export const ObjectVersion = z.object({
  id: ObjectId,
  type: TypeName,
  typeVersion: z.int().min(1),
  stance: Stance,
  lifecycle: Lifecycle,
  attributes: JsonRecord,
  claim: Claim,
  /** Revision at which this version became current. */
  revision: z.int().min(0),
  retiredReason: z.string().nullable(),
})
export type ObjectVersion = z.infer<typeof ObjectVersion>

export const RelationVersion = z.object({
  id: RelationId,
  type: RelationTypeName,
  typeVersion: z.int().min(1),
  from: ObjectId,
  to: ObjectId,
  stance: Stance,
  lifecycle: Lifecycle,
  properties: JsonRecord,
  claim: Claim,
  revision: z.int().min(0),
  retiredReason: z.string().nullable(),
})
export type RelationVersion = z.infer<typeof RelationVersion>

export const ResolvedWrite = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), version: ObjectVersion }),
  z.object({ kind: z.literal('relation'), version: RelationVersion }),
  z.object({ kind: z.literal('evidence'), record: EvidenceRecord, revision: z.int().min(0) }),
])
export type ResolvedWrite = z.infer<typeof ResolvedWrite>
