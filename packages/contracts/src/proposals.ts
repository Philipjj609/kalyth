import { z } from 'zod'
import { InstructionOrigin } from './auth.ts'
import {
  ClaimId,
  ContextPackageId,
  EvidenceId,
  ObjectId,
  PrincipalId,
  ProjectId,
  ProposalId,
} from './ids.ts'
import { JsonRecord } from './json.ts'
import { CheckExceptionInput, CheckResult } from './methods.ts'
import { CurationOperationInput, OperationInput, ResolvedOperation } from './ops.ts'
import { RelationTypeName, TypeName } from './registry.ts'
import { CommitSuccess, Issue } from './results.ts'

/**
 * The established knowledge a proposal changes, and what ADR 0026 I3 would then miss for each
 * item. Only a curator commits it, and may give the missing curation when committing (ADR 0030
 * A7).
 */
export const ProposalCuration = z.object({
  required: z.array(ObjectId),
  gaps: z.array(z.object({ id: ObjectId, gaps: z.array(z.string()) })),
})
export type ProposalCuration = z.infer<typeof ProposalCuration>

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
  /** The context package this proposal answers, recorded as provenance (ADR 0011). */
  contextPackageId: ContextPackageId.optional(),
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
  contextPackageId: ContextPackageId.nullable(),
  status: ProposalStatus,
  issues: z.array(Issue),
  result: CommitSuccess.nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: PrincipalId.nullable(),
  decisionNote: z.string().nullable(),
  /** Absent when the proposal changes no established knowledge. */
  curation: ProposalCuration.optional(),
  /**
   * The checks on its alternatives when it was proposed, for display (ADR 0033 §8). The kernel
   * computes them again at commit; these are never trusted. Absent when it has no alternative
   * with a basis.
   */
  checks: z.array(CheckResult).optional(),
})
export type Proposal = z.infer<typeof Proposal>

/**
 * A commit, with the curation a curator gives at that moment (ADR 0030 A7): setMaturity,
 * reviewSupport and verifySource, naming records by id; and the exceptions a person gives to
 * failed mandatory checks (ADR 0033 §8).
 */
export const CommitProposalInput = z.object({
  proposalId: ProposalId,
  curation: z.array(CurationOperationInput).min(1).max(1000).optional(),
  exceptions: z.array(CheckExceptionInput).min(1).max(100).optional(),
})
export const RejectProposalInput = z.object({
  proposalId: ProposalId,
  reason: z.string().min(1).max(2000),
})

export const ProposeChangeOutput = z.object({
  proposalId: ProposalId,
  status: ProposalStatus,
  issues: z.array(Issue),
  /** Present when only a curator can commit it (ADR 0030 A7). */
  curation: ProposalCuration.optional(),
  /** Present when it has alternatives with a basis (ADR 0033 §8). */
  checks: z.array(CheckResult).optional(),
})
export type ProposeChangeOutput = z.infer<typeof ProposeChangeOutput>
