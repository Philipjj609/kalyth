import type {
  Claim,
  Issue,
  JsonValue,
  ObjectVersion,
  ResolvedOperation,
  ResolvedWrite,
  TaskStatus,
} from '@kalyth/contracts'
import { AlternativeStatus, DecisionStatus, TASK_TRANSITIONS } from '@kalyth/contracts'
import type { TypeRegistry } from '../registry/registry.ts'
import { validateClaim } from './claims.ts'
import { OverlayState, type StateView } from './state.ts'

export interface ApplyOutcome {
  writes: ResolvedWrite[]
  issues: Issue[]
}

/**
 * Applies resolved operations to a state view and returns the version writes they produce.
 *
 * The same function validates a proposal against its base revision and applies it against the
 * head at commit time, so the head is always re-checked (R1): cross-object invariants are
 * evaluated on the state the writes will actually land on. Evidence operations run first; all
 * other operations run in the order given.
 */
export function applyOperations(
  state: StateView,
  ops: readonly ResolvedOperation[],
  registry: TypeRegistry,
  revision: number,
): ApplyOutcome {
  const overlay = new OverlayState(state, revision)
  const writes: ResolvedWrite[] = []
  const issues: Issue[] = []
  const write = (w: ResolvedWrite) => {
    overlay.apply(w)
    writes.push(w)
  }
  const ordered = ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => Number(b.op.op === 'recordEvidence') - Number(a.op.op === 'recordEvidence'))

  for (const { op, index } of ordered) {
    const add = (code: string, message: string, path?: (string | number)[]) =>
      issues.push(path ? { code, message, op: index, path } : { code, message, op: index })

    switch (op.op) {
      case 'recordEvidence': {
        if (overlay.getEvidence(op.id)) {
          add('id.exists', `evidence ${op.id} already exists`)
          break
        }
        write({
          kind: 'evidence',
          revision,
          record: {
            id: op.id,
            source: op.source,
            excerpt: op.excerpt,
            collectedBy: op.collectedBy,
            collectedAt: op.collectedAt,
          },
        })
        break
      }

      case 'createObject': {
        const def = registry.objectType(op.type)
        if (!def) {
          add('type.unknown', `unknown object type ${op.type}`, ['type'])
          break
        }
        if (overlay.getObject(op.id)) {
          add('id.exists', `object ${op.id} already exists`)
          break
        }
        for (const [key, initial] of Object.entries(def.reserved ?? {})) {
          const given = op.attributes[key]
          if (given !== undefined && JSON.stringify(given) !== JSON.stringify(initial)) {
            add(
              'attribute.reserved',
              `${op.type}.${key} must start as ${JSON.stringify(initial)}`,
              ['attributes', key],
            )
          }
        }
        const attributes = parseAttributes(def.attributes, op.attributes, add)
        if (!attributes) break
        issues.push(...validateClaim(op.claim, op.stance, op.id, overlay, index))
        write({
          kind: 'object',
          version: {
            id: op.id,
            type: def.type,
            typeVersion: def.version,
            stance: op.stance,
            lifecycle: 'active',
            attributes,
            claim: op.claim,
            revision,
            retiredReason: null,
          },
        })
        break
      }

      case 'updateObject': {
        const current = activeObject(overlay, op.id, add)
        if (!current) break
        const def = registry.objectType(current.type)
        if (!def) {
          add('type.unknown', `object type ${current.type} is no longer registered`)
          break
        }
        const reserved = Object.keys(def.reserved ?? {}).filter((key) => key in op.set)
        if (reserved.length > 0) {
          const via = current.type === 'core.Task' ? 'setTaskStatus' : 'setDecisionStatus'
          add('attribute.reserved', `use ${via} to change ${reserved.join(', ')}`, ['set'])
          break
        }
        const merged: Record<string, JsonValue> = { ...current.attributes }
        for (const [key, value] of Object.entries(op.set)) {
          if (value === null) delete merged[key]
          else merged[key] = value
        }
        const attributes = parseAttributes(def.attributes, merged, add)
        if (!attributes) break
        const claim: Claim = op.claim ?? current.claim
        if (op.claim) issues.push(...validateClaim(op.claim, current.stance, op.id, overlay, index))
        write({ kind: 'object', version: { ...current, attributes, claim, revision } })
        break
      }

      case 'retireObject': {
        const current = activeObject(overlay, op.id, add)
        if (!current) break
        const attached = [
          ...overlay.listRelations({ from: op.id }),
          ...overlay.listRelations({ to: op.id }),
        ]
        if (attached.length > 0) {
          add(
            'object.has_active_relations',
            `retire its active relations first: ${attached.map((r) => r.id).join(', ')}`,
          )
          break
        }
        write({
          kind: 'object',
          version: { ...current, lifecycle: 'retired', retiredReason: op.reason, revision },
        })
        break
      }

      case 'createRelation': {
        const def = registry.relationType(op.type)
        if (!def) {
          add('relation.type_unknown', `unknown relation type ${op.type}`, ['type'])
          break
        }
        if (overlay.getRelation(op.id)) {
          add('id.exists', `relation ${op.id} already exists`)
          break
        }
        const from = endpoint(overlay, op.from, 'from', add)
        const to = endpoint(overlay, op.to, 'to', add)
        if (!from || !to) break
        if (!registry.allowsEndpoint(def, 'from', from.type))
          add('relation.endpoint_type', `${op.type} cannot start at ${from.type}`, ['from'])
        if (!registry.allowsEndpoint(def, 'to', to.type))
          add('relation.endpoint_type', `${op.type} cannot end at ${to.type}`, ['to'])
        if (def.fromStance && from.stance !== def.fromStance)
          add('relation.endpoint_stance', `${op.type} must start at a ${def.fromStance} element`, [
            'from',
          ])
        if (from.id === to.id)
          add('relation.self_loop', `${op.type} cannot connect an object to itself`)
        if (def.maxOutgoingPerSource !== undefined) {
          const count = overlay.listRelations({ types: [def.type], from: from.id }).length
          if (count >= def.maxOutgoingPerSource)
            add('relation.cardinality', `${from.id} already has ${count} ${def.type} relation(s)`)
        }
        if (def.maxIncomingPerTarget !== undefined) {
          const count = overlay.listRelations({ types: [def.type], to: to.id }).length
          if (count >= def.maxIncomingPerTarget)
            add(
              'relation.cardinality',
              `${to.id} already has ${count} incoming ${def.type} relation(s)`,
            )
        }
        if (def.acyclic && from.id !== to.id && reaches(overlay, def.type, to.id, from.id))
          add('relation.cycle', `${op.type} from ${from.id} to ${to.id} would create a cycle`)
        issues.push(...validateClaim(op.claim, op.stance, op.id, overlay, index))
        write({
          kind: 'relation',
          version: {
            id: op.id,
            type: def.type,
            typeVersion: def.version,
            from: from.id,
            to: to.id,
            stance: op.stance,
            lifecycle: 'active',
            properties: op.properties,
            claim: op.claim,
            revision,
            retiredReason: null,
          },
        })
        break
      }

      case 'updateRelation': {
        const current = overlay.getRelation(op.id)
        if (!current) {
          add('relation.not_found', `relation ${op.id} does not exist`)
          break
        }
        if (current.lifecycle !== 'active') {
          add('relation.retired', `relation ${op.id} is retired`)
          break
        }
        const properties: Record<string, JsonValue> = { ...current.properties }
        for (const [key, value] of Object.entries(op.set)) {
          if (value === null) delete properties[key]
          else properties[key] = value
        }
        if (op.claim) issues.push(...validateClaim(op.claim, current.stance, op.id, overlay, index))
        write({
          kind: 'relation',
          version: { ...current, properties, claim: op.claim ?? current.claim, revision },
        })
        break
      }

      case 'retireRelation': {
        const current = overlay.getRelation(op.id)
        if (!current) {
          add('relation.not_found', `relation ${op.id} does not exist`)
          break
        }
        if (current.lifecycle !== 'active') {
          add('relation.retired', `relation ${op.id} is already retired`)
          break
        }
        write({
          kind: 'relation',
          version: { ...current, lifecycle: 'retired', retiredReason: op.reason, revision },
        })
        break
      }

      case 'setTaskStatus': {
        const current = activeObject(overlay, op.id, add)
        if (!current) break
        if (current.type !== 'core.Task') {
          add('task.not_a_task', `${current.type} has no task status`)
          break
        }
        const from = current.attributes.status as TaskStatus
        if (!TASK_TRANSITIONS[from]?.includes(op.status)) {
          add('task.transition_invalid', `a task cannot go from ${from} to ${op.status}`)
          break
        }
        if (op.status === 'running' && !op.lease) {
          add('task.lease_required', 'a running task needs a lease')
          break
        }
        const lease =
          op.status === 'running'
            ? op.lease
            : op.status === 'unknown_outcome'
              ? ((current.attributes.lease as JsonValue | undefined) ?? null)
              : null
        write({
          kind: 'object',
          version: {
            ...current,
            attributes: {
              ...current.attributes,
              status: op.status,
              statusRationale: op.rationale,
              lease,
            },
            revision,
          },
        })
        break
      }

      case 'setDecisionStatus': {
        const current = activeObject(overlay, op.id, add)
        if (!current) break
        const allowed =
          current.type === 'core.Decision'
            ? DecisionStatus.options
            : current.type === 'core.Alternative'
              ? AlternativeStatus.options
              : undefined
        if (!allowed) {
          add('decision.not_decidable', `${current.type} has no decision status`)
          break
        }
        if (!(allowed as readonly string[]).includes(op.status)) {
          add('decision.status_invalid', `${current.type} cannot have status ${op.status}`)
          break
        }
        if (current.type === 'core.Alternative' && op.status === 'accepted') {
          const parents = overlay.listRelations({ types: ['alternativeOf'], from: op.id })
          const decisionId = parents[0]?.to
          if (!decisionId) {
            add(
              'decision.alternative_unlinked',
              'an alternative must be linked to its decision before acceptance',
            )
            break
          }
          const accepted = overlay
            .listRelations({ types: ['alternativeOf'], to: decisionId })
            .map((r) => overlay.getObject(r.from))
            .filter((o) => o && o.id !== op.id && o.attributes.status === 'accepted')
          if (accepted.length > 0)
            add(
              'decision.multiple_accepted',
              `decision ${decisionId} already has an accepted alternative`,
            )
        }
        write({
          kind: 'object',
          version: {
            ...current,
            attributes: { ...current.attributes, status: op.status, statusRationale: op.rationale },
            revision,
          },
        })
        break
      }
    }
  }
  return { writes, issues }
}

function parseAttributes(
  schema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } },
  attributes: Record<string, JsonValue>,
  add: (code: string, message: string, path?: (string | number)[]) => void,
): Record<string, JsonValue> | undefined {
  const parsed = schema.safeParse(attributes)
  if (parsed.success) return parsed.data as Record<string, JsonValue>
  const zodIssues =
    (parsed.error as { issues?: { message: string; path: PropertyKey[] }[] }).issues ?? []
  for (const issue of zodIssues) {
    add('attribute.invalid', issue.message, ['attributes', ...issue.path.map(String)])
  }
  if (zodIssues.length === 0) add('attribute.invalid', 'attributes do not match the type schema')
  return undefined
}

function activeObject(
  state: StateView,
  id: string,
  add: (code: string, message: string) => void,
): ObjectVersion | undefined {
  const current = state.getObject(id)
  if (!current) {
    add('object.not_found', `object ${id} does not exist`)
    return undefined
  }
  if (current.lifecycle !== 'active') {
    add('object.retired', `object ${id} is retired`)
    return undefined
  }
  return current
}

function endpoint(
  state: StateView,
  id: string,
  side: 'from' | 'to',
  add: (code: string, message: string, path?: (string | number)[]) => void,
): ObjectVersion | undefined {
  const object = state.getObject(id)
  if (!object) {
    add('relation.endpoint_missing', `${side} object ${id} does not exist`, [side])
    return undefined
  }
  if (object.lifecycle !== 'active') {
    add('relation.endpoint_retired', `${side} object ${id} is retired`, [side])
    return undefined
  }
  return object
}

/** Depth-first search along active relations of one type. */
function reaches(state: StateView, type: string, start: string, goal: string): boolean {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const node = stack.pop() as string
    if (node === goal) return true
    if (seen.has(node)) continue
    seen.add(node)
    for (const r of state.listRelations({ types: [type], from: node })) stack.push(r.to)
  }
  return false
}
