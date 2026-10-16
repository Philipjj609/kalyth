import { z } from 'zod'
import { InstructionOrigin } from './auth.ts'
import { ClaimId, EvidenceId, ObjectId, PrincipalId, ProjectId, ProposalId } from './ids.ts'
import { JsonRecord } from './json.ts'
import { OperationInput, ResolvedOperation } from './ops.ts'
import { RelationTypeName, TypeName } from './registry.ts'
import { CommitSuccess, Issue } from './results.ts'

/**
 * A query whose result a proposal depends on (R1). Its result fingerprint is taken at the base
 * revision; if the head moved, the query is re-run at head and any difference makes the
 * proposal stale. Example: "no Endpoint with path /items exists yet".
 */
export const PredicateQuery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('objects'),
    types: z.array(TypeName).min(1).max(20).optional(),
    attributeEquals: JsonRecord.optional(),
  }),
  z.object({
    kind: z.literal('relations'),
    types: z.array(RelationTypeName).min(1).max(20).optional(),
    from: ObjectId.optional(),
    to: ObjectId.optional(),
  }),
])
export type PredicateQuery = z.infer<typeof PredicateQuery>

export const ReadPredicate = z.object({
  id: z.string().regex(/^[a-z][\w-]{0,63}$/),
  query: PredicateQuery,
})

export const ProposeChangeInput = z.object({
  projectId: ProjectId,
  baseRevision: z.int().min(0),
  ops: z.array(OperationInput).min(1).max(5000),
  rationale: z.string().min(1).max(4000),
  /** Extra ids whose state the proposal relies on, beyond those derived from its operations. */
  readSet: z
    .array(z.union([ClaimId, EvidenceId]))
    .max(1000)
    .default([]),
  predicates: z.array(ReadPredicate).max(20).default([]),
  idempotencyKey: z.string().min(8).max(200).optional(),
})
export type ProposeChangeInput = z.input<typeof ProposeChangeInput>

export const ProposalStatus = z.enum([
  'pending',
  'committed',
  'rejected',
  'invalid',
  'stale',
  'conflicting',
])
export type ProposalStatus = z.infer<typeof ProposalStatus>

export const Proposal = z.object({
  id: ProposalId,
  projectId: ProjectId,
  baseRevision: z.int().min(0),
  proposedBy: PrincipalId,
  origin: InstructionOrigin,
  ops: z.array(ResolvedOperation),
  rationale: z.string(),
  readSet: z.array(z.string()),
  writeSet: z.array(z.string()),
  predicates: z.array(ReadPredicate.extend({ resultHash: z.string() })),
  idempotencyKey: z.string().nullable(),
  status: ProposalStatus,
  issues: z.array(Issue),
  result: CommitSuccess.nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: PrincipalId.nullable(),
  decisionNote: z.string().nullable(),
})
export type Proposal = z.infer<typeof Proposal>

export const CommitProposalInput = z.object({ proposalId: ProposalId })
export const RejectProposalInput = z.object({
  proposalId: ProposalId,
  reason: z.string().min(1).max(2000),
})

export const ProposeChangeOutput = z.object({
  proposalId: ProposalId,
  status: ProposalStatus,
  issues: z.array(Issue),
})
export type ProposeChangeOutput = z.infer<typeof ProposeChangeOutput>
