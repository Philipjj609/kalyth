import {
  type AnalysisResult,
  type EvidenceSpan,
  type ObjectFact,
  objectKey,
} from '@kalyth/analyzer'
import type {
  JsonValue,
  ObjectVersion,
  ObservedElementChange,
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

// ---------- what the source shows changed ----------

/** The base and the verified commit, compared element by element (ADR 0024 amendment). */
export interface ObservedChangeSet {
  base: string
  commit: string
  byKey: ReadonlyMap<string, ObservedElementChange>
  /** The same entries by type and name (see `matchKey`), for proposed elements. */
  byMatch: ReadonlyMap<string, ObservedElementChange>
}

const VERBS: Record<string, [string, string]> = {
  reads: ['now reads', 'no longer reads'],
  writes: ['now writes', 'no longer writes'],
  references: ['now references', 'no longer references'],
  exposes: ['now exposes', 'no longer exposes'],
  contains: ['now contains', 'no longer contains'],
  dependsOn: ['now depends on', 'no longer depends on'],
}

const factLabel = (f: ObjectFact): string => {
  const a = f.attributes
  const text = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (f.type === 'software.Endpoint') return `${text('method')} ${text('path')}`.trim()
  return text('name') || text('path') || f.key
}

const spanHashes = (f: { supports: EvidenceSpan[][] }) =>
  [...new Set(f.supports.flatMap((g) => g.map((e) => e.spanSha256)))].sort().join(',')

const firstSpan = (f: { supports: EvidenceSpan[][] }) => {
  const e = f.supports[0]?.[0]
  return e ? `${e.path}:${e.startLine}-${e.endLine}` : ''
}

type Named = { name: string } & Record<string, JsonValue>
const named = (v: JsonValue | undefined): Named[] =>
  Array.isArray(v)
    ? v.filter(
        (x): x is Named =>
          typeof x === 'object' && x !== null && !Array.isArray(x) && typeof x.name === 'string',
      )
    : []
const describeItem = (f: Named) => {
  const parts = [
    typeof f.type === 'string' ? f.type : null,
    typeof f.references === 'string' ? `references ${f.references}` : null,
    typeof f.location === 'string' ? `in ${f.location}` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `${f.name} (${parts.join(', ')})` : f.name
}

/** Fields or parameters added, removed or changed, by name. */
function listDiff(noun: string, before: JsonValue | undefined, after: JsonValue | undefined) {
  const b = new Map(named(before).map((x) => [x.name, x]))
  const a = new Map(named(after).map((x) => [x.name, x]))
  const out: string[] = []
  for (const [name, x] of a) {
    const old = b.get(name)
    if (!old) out.push(`${noun} ${describeItem(x)} added`)
    else if (JSON.stringify(old) !== JSON.stringify(x))
      out.push(`${noun} ${name} changed: ${describeItem(old)} to ${describeItem(x)}`)
  }
  for (const [name] of b) if (!a.has(name)) out.push(`${noun} ${name} removed`)
  return out
}

/**
 * What changed between two analyses of the same repository by the same analyzer, keyed by the
 * analyzer's stable element keys: elements added or removed, elements whose own evidenced source
 * changed, fields and parameters added or removed, and relations added or removed (told from the
 * side they start from). Read-only; nothing here touches the model.
 */
export function observeChange(before: AnalysisResult, after: AnalysisResult): ObservedChangeSet {
  const b = new Map(before.objects.map((o) => [o.key, o]))
  const a = new Map(after.objects.map((o) => [o.key, o]))
  const byKey = new Map<string, ObservedElementChange>()
  const labels = new Map<string, string>()
  for (const f of [...before.objects, ...after.objects]) labels.set(f.key, factLabel(f))
  const entry = (f: ObjectFact, change: ObservedElementChange['change']) => {
    const e: ObservedElementChange = {
      key: f.key,
      type: f.type,
      label: factLabel(f),
      change,
      sourceChanged: change !== 'changed',
      details: [],
    }
    byKey.set(f.key, e)
    return e
  }
  for (const [key, f] of a) {
    const old = b.get(key)
    if (!old) {
      entry(f, 'added').details.push(`observed in ${firstSpan(f)}`)
      continue
    }
    const details: string[] = []
    if (f.type === 'software.DataEntity')
      details.push(...listDiff('field', old.attributes.fields, f.attributes.fields))
    if (f.type === 'software.Endpoint')
      details.push(...listDiff('parameter', old.attributes.parameters, f.attributes.parameters))
    const sourceChanged = spanHashes(old) !== spanHashes(f)
    if (sourceChanged || details.length > 0) {
      const e = entry(f, 'changed')
      e.sourceChanged = sourceChanged
      if (sourceChanged) e.details.push(`its source changed (${firstSpan(f)})`)
      e.details.push(...details)
    }
  }
  for (const [key, f] of b)
    if (!a.has(key)) entry(f, 'removed').details.push('no longer in the source')

  const rb = new Map(before.relations.map((r) => [r.key, r]))
  const ra = new Map(after.relations.map((r) => [r.key, r]))
  const relate = (key: string, text: string) => {
    let e = byKey.get(key)
    if (!e) {
      const f = a.get(key) ?? b.get(key)
      if (!f) return
      e = entry(f, 'changed')
      e.sourceChanged = false
    }
    if (e.details.length < 50 && !e.details.includes(text)) e.details.push(text)
  }
  for (const [key, r] of ra)
    if (!rb.has(key)) relate(r.from, `${VERBS[r.type]?.[0] ?? r.type} ${labels.get(r.to) ?? r.to}`)
  for (const [key, r] of rb)
    if (!ra.has(key)) relate(r.from, `${VERBS[r.type]?.[1] ?? r.type} ${labels.get(r.to) ?? r.to}`)
  const byMatch = new Map<string, ObservedElementChange>()
  for (const e of byKey.values()) {
    const f = a.get(e.key) ?? b.get(e.key)
    const m = f ? matchKey(f) : null
    if (m && !byMatch.has(m)) byMatch.set(m, e)
  }
  return { base: before.commit, commit: after.commit, byKey, byMatch }
}

/**
 * The observed change for a model element: by the analyzer's key, or for a proposed element, by
 * type and name, which is how a proposed element is matched with an observed one.
 */
export function observedFor(
  observed: ObservedChangeSet,
  o: Pick<ObjectVersion, 'type' | 'attributes' | 'stance'>,
): ObservedElementChange | undefined {
  const key = objectKey(o)
  const exact = key ? observed.byKey.get(key) : undefined
  if (exact || o.stance !== 'toBe') return exact
  const m = matchKey(o)
  return m ? observed.byMatch.get(m) : undefined
}

/** Element kinds a person reads as architecture; modules are counted, not listed. */
const STRUCTURAL = new Set([
  'software.Container',
  'software.Component',
  'software.DataEntity',
  'software.Endpoint',
])

/** Changed structural elements: how many, and those none of the planned keys names. */
export function summariseObserved(observed: ObservedChangeSet, planned: ReadonlySet<string>) {
  const all = [...observed.byKey.values()]
  return {
    elementsChanged: all.filter((e) => STRUCTURAL.has(e.type)).length,
    modulesChanged: all.filter((e) => e.type === 'software.Module').length,
    unplanned: all
      .filter((e) => STRUCTURAL.has(e.type) && !planned.has(e.key))
      .sort((x, y) => (x.key < y.key ? -1 : 1))
      .slice(0, 100),
  }
}

/** The analyzer key a model element has, so it can be found in an observed change set. */
export const keyOf = (o: Pick<ObjectVersion, 'type' | 'attributes'>): string | undefined =>
  objectKey(o)

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
  seenInSource: ObservedChangeSet | null = null,
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
          const seen = target && seenInSource ? observedFor(seenInSource, target) : undefined
          const status: ReconciledChange['observed'] =
            seenInSource === null
              ? null
              : seen
                ? 'changed'
                : hits.length > 0
                  ? 'nearby'
                  : 'unchanged'
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
            observed: status,
            details: seen?.details ?? [],
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
          changed: changes.filter((c) => c.observed === 'changed').length,
          proposed,
        },
      ]
    })
}
