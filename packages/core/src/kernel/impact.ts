import type { ImpactedElement, ImpactStep, ObjectVersion, RelationVersion } from '@kalyth/contracts'
import type { TypeRegistry } from '../registry/registry.ts'

/** Element types a module defines; changing one changes its module (ADR 0010). */
const DEFINED_IN_MODULE = new Set(['software.Endpoint', 'software.DataEntity'])

export interface ImpactTrace {
  elements: ImpactedElement[]
  truncated: boolean
}

/**
 * Deterministic impact traversal (ADR 0010). From the seeds, follows active relations in the
 * direction their type's impact rule declares, plus definitional containment from endpoints and
 * data entities to their module. Breadth-first from all seeds at once, so each element gets a
 * shortest path from its nearest seed; ties are broken by relation id, so results are stable.
 */
export function traceImpact(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
  registry: TypeRegistry,
  seeds: readonly string[],
  limits: { maxDepth: number; maxNodes: number },
): ImpactTrace {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const next = new Map<string, ImpactStep[]>()
  const add = (at: string, step: ImpactStep) => {
    const list = next.get(at)
    if (list) list.push(step)
    else next.set(at, [step])
  }
  for (const r of [...relations].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (r.lifecycle !== 'active') continue
    const rule = registry.relationType(r.type)?.impact ?? 'none'
    const base = { relationId: r.id, type: r.type }
    if (rule === 'sourceToTarget' || rule === 'both') {
      add(r.from, { ...base, from: r.from, to: r.to, direction: 'forward', rule: 'relation' })
    }
    if (rule === 'targetToSource' || rule === 'both') {
      add(r.to, { ...base, from: r.to, to: r.from, direction: 'reverse', rule: 'relation' })
    }
    if (
      r.type === 'contains' &&
      byId.get(r.from)?.type === 'software.Module' &&
      DEFINED_IN_MODULE.has(byId.get(r.to)?.type ?? '')
    ) {
      add(r.to, { ...base, from: r.to, to: r.from, direction: 'reverse', rule: 'definition' })
    }
  }

  const reached = new Map<string, ImpactedElement>()
  let frontier: ImpactedElement[] = []
  for (const id of seeds) {
    const o = byId.get(id)
    if (!o || reached.has(id)) continue
    const seed = { id, type: o.type, label: elementLabel(o), depth: 0, seed: id, path: [] }
    reached.set(id, seed)
    frontier.push(seed)
  }

  let truncated = false
  for (let depth = 1; frontier.length > 0; depth++) {
    const following: ImpactedElement[] = []
    for (const current of frontier) {
      for (const step of next.get(current.id) ?? []) {
        if (reached.has(step.to)) continue
        const target = byId.get(step.to)
        if (target?.lifecycle !== 'active') continue
        if (depth > limits.maxDepth || reached.size >= limits.maxNodes) {
          truncated = true
          continue
        }
        const element = {
          id: target.id,
          type: target.type,
          label: elementLabel(target),
          depth,
          seed: current.seed,
          path: [...current.path, step],
        }
        reached.set(target.id, element)
        following.push(element)
      }
    }
    frontier = following
  }
  return { elements: [...reached.values()], truncated }
}

/** A short human label for an element, used by impact results and model context. */
export function elementLabel(o: Pick<ObjectVersion, 'type' | 'attributes'>): string {
  const a = o.attributes as Record<string, unknown>
  const s = (key: string) => (typeof a[key] === 'string' ? (a[key] as string) : undefined)
  switch (o.type) {
    case 'software.Module':
      return s('path') ?? o.type
    case 'software.Endpoint':
      return `${s('method') ?? ''} ${s('path') ?? ''}`.trim()
    case 'core.Question':
      return truncate(s('text') ?? o.type)
    case 'core.Assertion':
    case 'core.Requirement':
    case 'core.Constraint':
      return truncate(s('title') ?? s('statement') ?? o.type)
    default:
      return s('name') ?? s('title') ?? s('repo') ?? o.type
  }
}

const truncate = (text: string, max = 120) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
