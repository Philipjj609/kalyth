import type {
  ObjectVersion,
  Principal,
  ReconciledChange,
  ReconciledDecision,
  ReconciledElement,
  RelationVersion,
} from '@kalyth/contracts'
import { elementLabel, ensurePrincipal, type KalythServices } from '@kalyth/core'

/** The method recorded on every link reconciliation infers (ADR 0024). */
export const RECONCILE_METHOD = 'kalyth.reconcile'

/**
 * The principal that proposes the links reconciliation infers. It reads and proposes only, so
 * every link waits for a person to commit it.
 */
export const ensureReconciler = (services: KalythServices): Principal =>
  ensurePrincipal(services, 'reconciler', 'tool', 'Kalyth reconciler', [
    'project.read',
    'proposal.create',
  ])

/** The analyzer's principal, as the ingest command registers it: it commits observed facts only. */
export const ensureAnalyzer = (services: KalythServices): Principal =>
  ensurePrincipal(services, 'analyzer', 'tool', 'Repository analyzer', [
    'project.read',
    'proposal.create',
    'ingest.observed',
  ])

/** Types a proposed element may have (ADR 0022). */
const PROPOSABLE = new Set([
  'software.Container',
  'software.Component',
  'software.DataEntity',
  'software.Endpoint',
])
const SOFTWARE = /^software\./

const attr = (o: ObjectVersion, key: string): string => {
  const v = (o.attributes as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

/**
 * What makes an observed element the same as a proposed one: the type and the name, compared
 * without case, or for an endpoint the method and the path, ignoring a trailing slash. Null when
 * the element has no name to compare.
 */
export function matchKey(o: Pick<ObjectVersion, 'type' | 'attributes'>): string | null {
  const a = o.attributes as Record<string, unknown>
  if (o.type === 'software.Endpoint') {
    const method = typeof a.method === 'string' ? a.method.trim().toUpperCase() : ''
    const path = typeof a.path === 'string' ? a.path.trim() : ''
    if (!method || !path) return null
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
    return `${o.type}|${method} ${trimmed || '/'}`
  }
  const name = typeof a.name === 'string' ? a.name.trim().toLowerCase() : ''
  return name ? `${o.type}|${name}` : null
}

export interface ReconcileModel {
  objects: ReadonlyMap<string, ObjectVersion>
  relations: readonly RelationVersion[]
  /** Source files an element's evidence cites. */
  pathsOf: (elementId: string) => readonly string[]
}

/** A decision summary without its links, which the coordinator adds once it has proposed them. */
export type DecisionDraft = Omit<ReconciledDecision, 'proposed'> & {
  proposed: Omit<ReconciledElement, 'link'>[]
}

/**
 * Reconciles the decisions a task implements with the files its verified commit changed
 * (ADR 0024), read-only:
 *
 * - each direct change (`impacts`) of the alternatives that count is touched when a file its
 *   target's evidence cites is among `files`;
 * - each proposed (to-be) element those changes name, or that contains one of them, is matched
 *   with an active observed element of the same type and name.
 *
 * `implemented` is what the task implements: a decision counts its accepted alternatives, or all
 * of them while none is accepted; an alternative counts itself.
 */
export function reconcileDecisions(
  model: ReconcileModel,
  implemented: readonly { id: string; type: string }[],
  files: readonly string[],
): DecisionDraft[] {
  const active = model.relations.filter((r) => r.lifecycle === 'active')
  const changed = new Set(files)
  const label = (id: string) => {
    const o = model.objects.get(id)
    return o ? elementLabel(o).replace(/\s+/g, ' ') : id
  }
  const decisionOf = (alternativeId: string) =>
    active.find((r) => r.type === 'alternativeOf' && r.from === alternativeId)?.to

  // The alternatives that count, by decision.
  const counted = new Map<string, Set<string>>()
  const count = (decisionId: string, alternativeIds: readonly string[]) => {
    const set = counted.get(decisionId) ?? new Set<string>()
    for (const id of alternativeIds) set.add(id)
    counted.set(decisionId, set)
  }
  for (const target of implemented) {
    if (target.type === 'core.Decision') {
      const alternatives = active
        .filter((r) => r.type === 'alternativeOf' && r.to === target.id)
        .map((r) => model.objects.get(r.from))
        .filter((o): o is ObjectVersion => o?.type === 'core.Alternative')
      const accepted = alternatives.filter((a) => attr(a, 'status') === 'accepted')
      count(
        target.id,
        (accepted.length > 0 ? accepted : alternatives).map((a) => a.id),
      )
    } else if (target.type === 'core.Alternative') {
      const decisionId = decisionOf(target.id)
      if (decisionId) count(decisionId, [target.id])
    }
  }

  // Observed elements by what makes them the same as a proposed one.
  const observed = new Map<string, ObjectVersion>()
  for (const o of [...model.objects.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (o.lifecycle !== 'active' || o.stance !== 'asIs' || o.claim.basis !== 'observed') continue
    const key = matchKey(o)
    if (key && !observed.has(key)) observed.set(key, o)
  }
  const containerOf = new Map(
    active.filter((r) => r.type === 'contains').map((r) => [r.to, r.from] as const),
  )
  const isProposed = (o: ObjectVersion | undefined): o is ObjectVersion =>
    o !== undefined && o.lifecycle === 'active' && o.stance === 'toBe' && SOFTWARE.test(o.type)

  return [...counted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([decisionId, alternativeIds]): DecisionDraft[] => {
      const decision = model.objects.get(decisionId)
      if (!decision) return []
      const alternatives = [...alternativeIds]
        .sort()
        .map((id) => model.objects.get(id))
        .filter((o): o is ObjectVersion => o !== undefined)
      const changes: ReconciledChange[] = active
        .filter((r) => r.type === 'impacts' && alternativeIds.has(r.from))
        .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id < b.id ? -1 : 1))
        .map((r) => {
          const target = model.objects.get(r.to)
          const hits = [...new Set(model.pathsOf(r.to))].filter((p) => changed.has(p)).sort()
          return {
            relationId: r.id,
            alternativeId: r.from,
            target: r.to,
            label: label(r.to),
            type: target?.type ?? 'unknown',
            proposed: target?.stance === 'toBe',
            change: typeof r.properties.change === 'string' ? r.properties.change : '',
            touched: hits.length > 0,
            files: hits,
          }
        })

      // Proposed elements: the targets of the changes, and the proposed elements containing them.
      const proposedIds = new Set<string>()
      for (const change of changes) {
        let id: string | undefined = change.target
        const seen = new Set<string>()
        while (id !== undefined && !seen.has(id)) {
          seen.add(id)
          const o = model.objects.get(id)
          if (!isProposed(o)) break
          proposedIds.add(o.id)
          id = containerOf.get(id)
        }
      }
      const proposed = [...proposedIds]
        .sort()
        .map((id) => model.objects.get(id) as ObjectVersion)
        .filter((o) => PROPOSABLE.has(o.type))
        .map((o): Omit<ReconciledElement, 'link'> => {
          const key = matchKey(o)
          const match = key ? observed.get(key) : undefined
          return {
            id: o.id,
            type: o.type,
            label: label(o.id),
            match: match
              ? {
                  id: match.id,
                  label: label(match.id),
                  inCommit: model.pathsOf(match.id).some((p) => changed.has(p)),
                }
              : null,
          }
        })

      return [
        {
          id: decision.id,
          title: attr(decision, 'title'),
          status: attr(decision, 'status'),
          alternatives: alternatives.map((a) => ({
            id: a.id,
            title: attr(a, 'title'),
            status: attr(a, 'status'),
          })),
          changes,
          touched: changes.filter((c) => c.touched).length,
          proposed,
        },
      ]
    })
}
