import { z } from 'zod'
import { InstructionOrigin } from './auth.ts'
import { ChangeSetId, EventId, PrincipalId, ProjectId, ProposalId } from './ids.ts'
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
  'project.created': 1,
  'changeSet.committed': 1,
} as const
export type EventType = keyof typeof EVENT_SCHEMA_VERSIONS

export const ProjectCreatedV1 = z.object({
  name: z.string(),
  description: z.string(),
})

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

const envelope = {
  id: EventId,
  seq: z.int().min(1),
  projectId: ProjectId,
  revision: z.int().min(0),
  actor: PrincipalId,
  origin: InstructionOrigin,
  occurredAt: z.iso.datetime(),
}

export const KalythEvent = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('project.created'),
    schemaVersion: z.literal(1),
    payload: ProjectCreatedV1,
  }),
  z.object({
    ...envelope,
    type: z.literal('changeSet.committed'),
    schemaVersion: z.literal(1),
    payload: ChangeSetCommittedV1,
  }),
])
export type KalythEvent = z.infer<typeof KalythEvent>
