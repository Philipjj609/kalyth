import { EVENT_SCHEMA_VERSIONS, type KalythEvent } from '@kalyth/contracts'

/** An event at the current schema version of its type. */
export type CurrentEvent = Extract<KalythEvent, { schemaVersion: 2 }>

import type { SqliteStore } from './store/sqlite-store.ts'

/**
 * Rebuilds revisioned state from the event log (R3). Older schema versions are upcast before
 * applying; unknown versions are refused rather than guessed. Proposals, principals, grants and
 * content bodies are not part of revisioned state and are not replayed.
 */
export function replayEvents(target: SqliteStore, events: readonly KalythEvent[]): void {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  target.writeTransaction(() => {
    for (const raw of ordered) {
      const event = upcast(raw)
      switch (event.type) {
        case 'project.created':
          target.insertProject({
            id: event.projectId,
            name: event.payload.name,
            description: event.payload.description,
            createdAt: event.occurredAt,
            createdBy: event.actor,
            kind: event.payload.kind,
          })
          break
        case 'changeSet.committed': {
          const p = event.payload
          target.applyWrites(event.projectId, event.revision, p.writes)
          target.insertChangeSet({
            id: p.changeSetId,
            projectId: event.projectId,
            revision: event.revision,
            proposalId: p.proposalId,
            proposedBy: p.proposedBy,
            committedBy: event.actor,
            origin: event.origin,
            proposalBaseRevision: p.proposalBaseRevision,
            appliedOnRevision: p.appliedOnRevision,
            committedAt: event.occurredAt,
            writeCount: p.writes.length,
          })
          target.setHead(event.projectId, event.revision - 1, event.revision)
          break
        }
      }
    }
  })
}

/**
 * Brings an event to the current schema version of its type, as a pure function (ADR 0030 §5):
 * a version 1 project was an ordinary project, and a version 1 change set has the same fields.
 */
export function upcast(event: KalythEvent): CurrentEvent {
  const known = EVENT_SCHEMA_VERSIONS[event.type]
  if (known === undefined || event.schemaVersion > known) {
    throw new Error(`cannot replay ${event.type} schema version ${event.schemaVersion}`)
  }
  if (event.schemaVersion === 2) return event
  if (event.type === 'project.created')
    return { ...event, schemaVersion: 2, payload: { ...event.payload, kind: 'project' } }
  return { ...event, schemaVersion: 2 }
}
