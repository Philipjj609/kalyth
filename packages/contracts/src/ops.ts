import { z } from 'zod'
import { Claim, ClaimInput, Lifecycle, Stance } from './claims.ts'
import { Collector, ContentRef, EvidenceInput, EvidenceRecord, EvidenceSource } from './evidence.ts'
import { EvidenceId, LocalRef, ObjectId, ObjectTarget, RelationId } from './ids.ts'
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

export const OperationInput = z.discriminatedUnion('op', [
  CreateObjectOp,
  UpdateObjectOp,
  RetireObjectOp,
  CreateRelationOp,
  RetireRelationOp,
  RecordEvidenceOp,
  SetDecisionStatusOp,
])
export type OperationInput = z.input<typeof OperationInput>
export type OperationParsed = z.output<typeof OperationInput>

// ---------- Resolved operations (ids assigned, refs resolved, content stored) ----------

export const ResolvedOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createObject'),
    id: ObjectId,
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
    type: RelationTypeName,
    from: ObjectId,
    to: ObjectId,
    stance: Stance,
    properties: JsonRecord,
    claim: Claim,
  }),
  z.object({ op: z.literal('retireRelation'), id: RelationId, reason }),
  z.object({
    op: z.literal('recordEvidence'),
    id: EvidenceId,
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
