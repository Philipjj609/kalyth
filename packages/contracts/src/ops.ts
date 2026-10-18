import { z } from 'zod'
import { Claim, ClaimInput, Lifecycle, Stance } from './claims.ts'
import { Collector, ContentRef, EvidenceInput, EvidenceRecord, EvidenceSource } from './evidence.ts'
import { EvidenceId, LocalRef, ObjectId, ObjectTarget, PrincipalId, RelationId } from './ids.ts'
import { JsonRecord } from './json.ts'
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
 * the kernel keeps the current lease on `unknown_outcome` and clears it otherwise.
 */
export const SetTaskStatusOp = z.object({
  op: z.literal('setTaskStatus'),
  id: ObjectId,
  status: TaskStatus,
  rationale: reason,
  lease: TaskLease.nullable().default(null),
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
