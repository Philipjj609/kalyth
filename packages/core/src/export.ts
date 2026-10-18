import {
  CONTRACTS_VERSION,
  canonicalJson,
  type ExportedContent,
  fail,
  type ImportSummary,
  type Issue,
  type KalythEvent,
  ok,
  ProjectExport,
  type Result,
} from '@kalyth/contracts'
import { replayEvents } from './replay.ts'
import { SCHEMA_VERSION } from './store/schema.ts'
import type { SqliteStore } from './store/sqlite-store.ts'
import { hashCanonical, sha256Hex } from './util.ts'

/** Columns that hold JSON text; their key order is an accident of how a write was built. */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  objects: ['attributes', 'claim'],
  relations: ['properties', 'claim'],
  evidence: ['source', 'collected_by'],
}

/**
 * The hash of a project's revisioned state: what a replay of its events must reproduce (R3). JSON
 * columns are compared by content, so a bundle whose JSON was reformatted or key-sorted on the way
 * still imports.
 */
export function stateSha256(store: SqliteStore, projectId: string): string {
  const dump = store.dumpRevisionedState(projectId) as Record<string, unknown>
  for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
    dump[table] = (dump[table] as Record<string, unknown>[]).map((row) => {
      const parsed = { ...row }
      for (const column of columns) {
        const value = parsed[column]
        if (typeof value === 'string') parsed[column] = JSON.parse(value)
      }
      return parsed
    })
  }
  return hashCanonical(dump)
}

/**
 * Collects a project into one bundle (ADR 0014): its events, the content its evidence refers to,
 * the principals its history names, and the hash of the state the events rebuild. Proposals,
 * grants, agent tokens, context packages and operational settings are not part of it.
 */
export function buildProjectExport(
  store: SqliteStore,
  projectId: string,
  exportedBy: string,
  exportedAt: string,
): ProjectExport | undefined {
  const project = store.getProject(projectId)
  if (!project) return undefined
  const events = store.listEvents(projectId)
  const named = new Set<string>([project.createdBy])
  for (const event of events) {
    named.add(event.actor)
    if (event.type === 'changeSet.committed') named.add(event.payload.proposedBy)
  }
  return {
    format: 'kalyth.project-export',
    formatVersion: 1,
    exportedAt,
    exportedBy,
    source: { contractsVersion: CONTRACTS_VERSION, schemaVersion: SCHEMA_VERSION },
    project,
    principals: [...named].sort().flatMap((id) => store.getPrincipal(id) ?? []),
    events,
    content: store.listContent(projectId),
    stateSha256: stateSha256(store, projectId),
  }
}

class StateMismatch extends Error {}

/**
 * Rebuilds an exported project in this store by replaying its events, then copies its events,
 * content and missing principals (without grants). Everything happens in one transaction, and the
 * import is refused unless the replayed state hashes to the bundle's `stateSha256`.
 *
 * Replay writes history directly, without the checks proposals get, so a bundle is trusted input:
 * the checks here catch damage and inconsistency, not a forged history.
 */
export function importProjectExport(store: SqliteStore, input: unknown): Result<ImportSummary> {
  const parsed = ProjectExport.safeParse(input)
  if (!parsed.success) {
    return fail('invalid', 'not a Kalyth project export (format 1)', {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        code: `schema.${i.code}`,
        message: i.message,
        path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
      })),
    })
  }
  const bundle = parsed.data
  const projectId = bundle.project.id
  if (store.getProject(projectId)) {
    return fail('conflicting', `project ${projectId} already exists in this store`)
  }
  // The bundle's own events are replayed and kept, so the copy matches the store byte for byte.
  // They must say exactly what the contract reads from them: no field outside it gets stored.
  const raw = (input as { events: KalythEvent[] }).events
  const issues: Issue[] = []
  raw.forEach((event, i) => {
    if (canonicalJson(event) !== canonicalJson(bundle.events[i])) {
      issues.push({
        code: 'export.unexpected_fields',
        message: `event ${bundle.events[i]?.id} carries fields outside the contract`,
      })
    }
  })
  const events = [...raw].sort((a, b) => a.seq - b.seq)
  issues.push(...checkBundle(bundle.project.headRevision, projectId, events, bundle.content))
  if (issues.length > 0) {
    return fail('invalid', 'the export is inconsistent', { issues: issues.slice(0, 20) })
  }

  let principalsAdded = 0
  try {
    store.writeTransaction(() => {
      for (const principal of bundle.principals) {
        if (store.getPrincipal(principal.id)) continue
        store.insertPrincipal(principal)
        principalsAdded += 1
      }
      replayEvents(store, events)
      for (const { seq: _seq, ...event } of events) store.insertEvent(event)
      for (const content of bundle.content) store.importContent(projectId, content)
      const rebuilt = stateSha256(store, projectId)
      if (rebuilt !== bundle.stateSha256) throw new StateMismatch(rebuilt)
    })
  } catch (error) {
    if (error instanceof StateMismatch) {
      return fail('invalid', 'replaying the events does not rebuild the exported state', {
        issues: [{ code: 'export.state_mismatch', message: `rebuilt ${error.message}` }],
      })
    }
    throw error
  }
  return ok({
    projectId,
    name: bundle.project.name,
    headRevision: bundle.project.headRevision,
    events: events.length,
    content: bundle.content.length,
    principalsAdded,
    stateSha256: bundle.stateSha256,
  })
}

function checkBundle(
  headRevision: number,
  projectId: string,
  events: readonly KalythEvent[],
  content: readonly ExportedContent[],
): Issue[] {
  const issues: Issue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })
  if (events[0]?.type !== 'project.created')
    add('export.no_creation', 'the first event must create the project')
  let revision = 0
  for (const event of events) {
    if (event.projectId !== projectId)
      add('export.foreign_event', `${event.id} belongs to ${event.projectId}`)
    if (event.type === 'changeSet.committed') {
      revision += 1
      if (event.revision !== revision)
        add(
          'export.revision_gap',
          `${event.id} is revision ${event.revision}, expected ${revision}`,
        )
    }
  }
  if (revision !== headRevision)
    add(
      'export.head_mismatch',
      `the events reach revision ${revision}, the project says ${headRevision}`,
    )

  const bodies = new Map(content.map((c) => [c.id, c]))
  for (const c of content) {
    if (c.id !== `cnt_${c.sha256.slice(0, 32)}`)
      add('export.content_id', `${c.id} does not match its hash`)
    if (c.body !== null && sha256Hex(c.body) !== c.sha256)
      add('export.content_hash', `${c.id} does not match its body`)
  }
  for (const event of events) {
    if (event.type !== 'changeSet.committed') continue
    for (const write of event.payload.writes) {
      const excerpt = write.kind === 'evidence' ? write.record.excerpt : null
      if (excerpt && bodies.get(excerpt.contentId)?.sha256 !== excerpt.sha256) {
        add(
          'export.content_missing',
          `${write.kind === 'evidence' ? write.record.id : ''} refers to ${excerpt.contentId}, which the export lacks`,
        )
      }
    }
  }
  return issues
}
