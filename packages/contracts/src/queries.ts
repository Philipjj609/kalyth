import { z } from 'zod'
import { InstructionOrigin } from './auth.ts'
import { EvidenceView } from './evidence.ts'
import {
  ChangeSetId,
  EvidenceId,
  ObjectId,
  PrincipalId,
  ProjectId,
  ProposalId,
  RelationId,
} from './ids.ts'
import { ObjectVersion, RelationVersion } from './ops.ts'
import { ProposalStatus } from './proposals.ts'
import { RelationTypeName, TypeName } from './registry.ts'

const revision = z.int().min(0).optional()
const limit = z.int().min(1).max(1000).default(500)

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
})

export const ProjectSummary = z.object({
  id: ProjectId,
  name: z.string(),
  description: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: PrincipalId,
  headRevision: z.int().min(0),
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

export const ProjectRef = z.object({ projectId: ProjectId, revision })

export const ProjectOverview = z.object({
  project: ProjectSummary,
  revision: z.int().min(0),
  objectCounts: z.record(z.string(), z.int()),
  relationCounts: z.record(z.string(), z.int()),
  evidenceCount: z.int(),
  pendingProposals: z.int(),
})
export type ProjectOverview = z.infer<typeof ProjectOverview>

export const ObjectQuery = z.object({
  projectId: ProjectId,
  revision,
  types: z.array(TypeName).min(1).max(50).optional(),
  ids: z.array(ObjectId).min(1).max(1000).optional(),
  includeRetired: z.boolean().default(false),
  limit,
  /** Results come in id order; the next page starts after the last id of the previous one. */
  after: ObjectId.optional(),
})
export type ObjectQuery = z.input<typeof ObjectQuery>

export const ObjectQueryResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  objects: z.array(ObjectVersion),
})
export type ObjectQueryResult = z.infer<typeof ObjectQueryResult>

export const RelationQuery = z.object({
  projectId: ProjectId,
  revision,
  types: z.array(RelationTypeName).min(1).max(50).optional(),
  ids: z.array(RelationId).min(1).max(1000).optional(),
  from: ObjectId.optional(),
  to: ObjectId.optional(),
  includeRetired: z.boolean().default(false),
  limit,
  /** Results come in id order; the next page starts after the last id of the previous one. */
  after: RelationId.optional(),
})
export type RelationQuery = z.input<typeof RelationQuery>

export const RelationQueryResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  relations: z.array(RelationVersion),
})
export type RelationQueryResult = z.infer<typeof RelationQueryResult>

export const EvidenceQuery = z.object({
  projectId: ProjectId,
  ids: z.array(EvidenceId).min(1).max(200),
})
export const EvidenceQueryResult = z.object({ evidence: z.array(EvidenceView) })
export type EvidenceQueryResult = z.infer<typeof EvidenceQueryResult>

export const ProposalListQuery = z.object({
  projectId: ProjectId,
  status: ProposalStatus.optional(),
  limit,
})

export const ChangeSetSummary = z.object({
  id: ChangeSetId,
  revision: z.int().min(1),
  proposalId: ProposalId,
  proposedBy: PrincipalId,
  committedBy: PrincipalId,
  origin: InstructionOrigin,
  rebasedFrom: z.int().min(0).nullable(),
  committedAt: z.iso.datetime(),
  writeCount: z.int().min(0),
})
export type ChangeSetSummary = z.infer<typeof ChangeSetSummary>

export const HistoryQuery = z.object({ projectId: ProjectId, limit })
export const HistoryResult = z.object({
  projectId: ProjectId,
  headRevision: z.int().min(0),
  changeSets: z.array(ChangeSetSummary),
})
export type HistoryResult = z.infer<typeof HistoryResult>

/**
 * Freshness of every claim at a revision (ADR 0009). Source-span evidence is fresh while the
 * project's current source snapshot for that repository still has the same git blob at the same
 * path. Claim status follows the support groups (R2):
 * - current: every support group is fresh
 * - weakened: some groups went stale but at least one is entirely fresh (still supported)
 * - stale: no group is entirely fresh (needs review)
 * - derived-stale: its own support is fine or absent, but a claim it derives from is stale
 * - unknown: its evidence points at a repository with no recorded snapshot
 * - not-applicable: no evidence and no derivation (for example stated intentions)
 */
export const FreshnessStatus = z.enum([
  'current',
  'weakened',
  'stale',
  'derived-stale',
  'unknown',
  'not-applicable',
])
export type FreshnessStatus = z.infer<typeof FreshnessStatus>

export const ClaimFreshness = z.object({
  id: z.union([ObjectId, RelationId]),
  kind: z.enum(['object', 'relation']),
  type: z.string(),
  basis: z.string(),
  status: FreshnessStatus,
  staleEvidence: z.array(EvidenceId),
  reason: z.string(),
})
export type ClaimFreshness = z.infer<typeof ClaimFreshness>

export const SnapshotSummary = z.object({
  objectId: ObjectId,
  repo: z.string(),
  commit: z.string(),
  ref: z.string().optional(),
})

export const FreshnessQuery = z.object({ projectId: ProjectId, revision })
export const FreshnessResult = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  snapshots: z.array(SnapshotSummary),
  claims: z.array(ClaimFreshness),
  summary: z.record(z.string(), z.int()),
})
export type FreshnessResult = z.infer<typeof FreshnessResult>

/**
 * What needs a person's attention at a revision, computed deterministically (ADR 0010): open
 * decisions with their alternatives, open questions, pending proposals and stale claims. The
 * Navigator and agents read it; models summarise it but never invent it.
 */
export const SituationQuery = z.object({ projectId: ProjectId, revision })
export const Situation = z.object({
  projectId: ProjectId,
  revision: z.int().min(0),
  openDecisions: z.array(
    z.object({
      id: ObjectId,
      title: z.string(),
      alternatives: z.array(z.object({ id: ObjectId, title: z.string(), status: z.string() })),
    }),
  ),
  openQuestions: z.array(
    z.object({
      id: ObjectId,
      text: z.string(),
      inquiryRole: z.string(),
      concerns: z.array(ObjectId),
    }),
  ),
  pendingProposals: z.array(
    z.object({
      id: ProposalId,
      proposedBy: PrincipalId,
      origin: InstructionOrigin,
      createdAt: z.iso.datetime(),
      operations: z.int().min(0),
      rationale: z.string(),
    }),
  ),
  freshness: z.record(z.string(), z.int()),
  /** The first 100 claims that are stale or derived-stale. */
  staleClaims: z.array(ClaimFreshness),
})
export type Situation = z.infer<typeof Situation>
