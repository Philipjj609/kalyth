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
