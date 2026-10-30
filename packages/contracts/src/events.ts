import { z } from 'zod'
import { InstructionOrigin } from './auth.ts'
import { ChangeSetId, EventId, PrincipalId, ProjectId, ProposalId } from './ids.ts'
import { ProjectKind } from './knowledge.ts'
import { ResolvedWrite } from './ops.ts'

/**
 * Events are immutable and self-sufficient for deterministic replay (R3): each change-set event
 * carries the complete post-state of every version row it writes, with ids, type versions and
 * content references (never raw excerpts). Replay applies writes in order; a version write closes
 * the previous current version of the same id.
 *
 * Schema evolution: every event has a schemaVersion. Readers upcast older versions before
 * applying them and refuse versions they do not know. History is never rewritten.
 */
export const EVENT_SCHEMA_VERSIONS = {
  'project.created': 2,
  'changeSet.committed': 2,
} as const
export type EventType = keyof typeof EVENT_SCHEMA_VERSIONS

export const ProjectCreatedV1 = z.object({
  name: z.string(),
  description: z.string(),
})

/** Version 2 adds the project's kind (ADR 0030 C3). Version 1 upcasts to `kind: "project"`. */
export const ProjectCreatedV2 = ProjectCreatedV1.extend({ kind: ProjectKind })
export type ProjectCreatedV2 = z.infer<typeof ProjectCreatedV2>

export const ChangeSetCommittedV1 = z.object({
  changeSetId: ChangeSetId,
  proposalId: ProposalId,
  proposedBy: PrincipalId,
  proposalOrigin: InstructionOrigin,
  proposalBaseRevision: z.int().min(0),
  appliedOnRevision: z.int().min(0),
  writes: z.array(ResolvedWrite),
})
export type ChangeSetCommittedV1 = z.infer<typeof ChangeSetCommittedV1>

/**
 * Version 2 has the same fields. Its claims and evidence may carry what ADR 0030 adds (reviews,
 * verifications, SourceMeta), which a version 1 reader would drop, so the version tells an older
 * build to refuse the event instead (C5). Version 1 upcasts unchanged.
 */
export const ChangeSetCommittedV2 = ChangeSetCommittedV1
export type ChangeSetCommittedV2 = ChangeSetCommittedV1

const envelope = {
  id: EventId,
  seq: z.int().min(1),
  projectId: ProjectId,
  revision: z.int().min(0),
  actor: PrincipalId,
  origin: InstructionOrigin,
  occurredAt: z.iso.datetime(),
}

export const KalythEvent = z.union([
  z.object({
    ...envelope,
    type: z.literal('project.created'),
    schemaVersion: z.literal(1),
    payload: ProjectCreatedV1,
  }),
  z.object({
    ...envelope,
    type: z.literal('project.created'),
    schemaVersion: z.literal(2),
    payload: ProjectCreatedV2,
  }),
  z.object({
    ...envelope,
    type: z.literal('changeSet.committed'),
    schemaVersion: z.literal(1),
    payload: ChangeSetCommittedV1,
  }),
  z.object({
    ...envelope,
    type: z.literal('changeSet.committed'),
    schemaVersion: z.literal(2),
    payload: ChangeSetCommittedV2,
  }),
])
export type KalythEvent = z.infer<typeof KalythEvent>
