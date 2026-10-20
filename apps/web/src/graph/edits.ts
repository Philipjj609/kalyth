import type {
  ObjectVersion,
  OperationInput,
  RelationTypeDescriptor,
  RelationVersion,
} from '@kalyth/contracts'
import { objectLabel } from '../model/labels.ts'
import { objectTypeMeta } from '../model/semantics.ts'

/**
 * Direct semantic editing on the canvas (ADR 0020): every edit is a proposal. What a person adds,
 * renames, connects or retires is recorded with the claim basis `stated` (ADR 0022: what a person
 * says is never `observed`), and nothing reaches the model until a person commits it.
 */

/** Element types a person can add from the canvas. */
export const ADDABLE_TYPES = [
  'software.Container',
  'software.Component',
  'software.DataEntity',
  'software.Endpoint',
] as const
export type AddableType = (typeof ADDABLE_TYPES)[number]

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'ANY',
] as const

export const ELEMENT_REF = '$element'
const STATED = { basis: 'stated' } as const

export type Stance = 'toBe' | 'asIs'

export interface NewElementDraft {
  type: AddableType
  /** The name; for an endpoint, its path. */
  name: string
  /** Endpoints only. */
  method?: string
  /** The element that contains it, if any. */
  within?: string
  stance: Stance
}

/** Problems with a draft, as sentences; empty when it can be proposed. */
export function draftProblems(draft: NewElementDraft): string[] {
  const problems: string[] = []
  const name = draft.name.trim()
  if (draft.type === 'software.Endpoint') {
    if (!HTTP_METHODS.includes((draft.method ?? '') as (typeof HTTP_METHODS)[number]))
      problems.push('Choose the HTTP method.')
    if (!name.startsWith('/')) problems.push('An endpoint path starts with a slash, as in /items/.')
  } else if (name.length === 0) problems.push('Give the element a name.')
  if (name.length > 300) problems.push('Keep the name under 300 characters.')
  return problems
}

export function addElementOps(draft: NewElementDraft): OperationInput[] {
  const name = draft.name.trim()
  const attributes =
    draft.type === 'software.Endpoint' ? { method: draft.method as string, path: name } : { name }
  const ops: OperationInput[] = [
    {
      op: 'createObject',
      ref: ELEMENT_REF,
      type: draft.type,
      stance: draft.stance,
      attributes,
      claim: STATED,
    },
  ]
  if (draft.within) {
    ops.push({
      op: 'createRelation',
      type: 'contains',
      from: draft.within,
      to: ELEMENT_REF,
      stance: draft.stance,
      claim: STATED,
    })
  }
  return ops
}

export function addElementRationale(draft: NewElementDraft): string {
  const label =
    draft.type === 'software.Endpoint'
      ? `${draft.method ?? ''} ${draft.name.trim()}`.trim()
      : draft.name.trim()
  const kind = objectTypeMeta(draft.type).label.toLowerCase()
  return `${draft.stance === 'toBe' ? 'Propose' : 'Record'} the ${kind} “${label}”`
}

/** The attribute a rename changes, or null when the element has no name to change. */
export function renameField(
  object: Pick<ObjectVersion, 'type' | 'attributes'>,
): 'name' | 'path' | 'title' | null {
  const a = object.attributes as Record<string, unknown>
  if (object.type === 'software.Endpoint' || object.type === 'software.Module') return 'path'
  if (typeof a.name === 'string') return 'name'
  if (typeof a.title === 'string') return 'title'
  return null
}

export function currentName(object: Pick<ObjectVersion, 'type' | 'attributes'>): string {
  const field = renameField(object)
  const value = field ? (object.attributes as Record<string, unknown>)[field] : undefined
  return typeof value === 'string' ? value : ''
}

export function renameOps(object: ObjectVersion, newName: string): OperationInput[] {
  const field = renameField(object)
  if (!field) throw new Error(`${object.type} has no name to change`)
  return [{ op: 'updateObject', id: object.id, set: { [field]: newName.trim() }, claim: STATED }]
}

export const renameRationale = (object: ObjectVersion, newName: string) =>
  `Rename “${objectLabel(object)}” to “${newName.trim()}”`

const allows = (list: readonly string[], type: string) => list.includes('*') || list.includes(type)

/**
 * Relation types the registry allows from one element (to another, when given), the software
 * pack's first (structure and data access before core annotations). Types whose
 * source must have a stance the element lacks are left out.
 */
export function allowedRelationTypes(
  registry: readonly RelationTypeDescriptor[],
  from: Pick<ObjectVersion, 'type' | 'stance'>,
  to?: Pick<ObjectVersion, 'type'>,
): RelationTypeDescriptor[] {
  return registry
    .filter(
      (d) =>
        allows(d.from, from.type) &&
        (to === undefined || allows(d.to, to.type)) &&
        (d.fromStance === undefined || d.fromStance === from.stance),
    )
    .sort(
      (a, b) =>
        Number(a.pack !== 'software') - Number(b.pack !== 'software') ||
        a.type.localeCompare(b.type),
    )
}

/** Elements a relation of this type may end at, from the canvas elements. */
export function allowedTargets(
  descriptor: Pick<RelationTypeDescriptor, 'to'>,
  from: Pick<ObjectVersion, 'id'>,
  candidates: readonly ObjectVersion[],
): ObjectVersion[] {
  return candidates.filter((o) => o.id !== from.id && allows(descriptor.to, o.type))
}

export function connectOps(
  from: Pick<ObjectVersion, 'id'>,
  to: Pick<ObjectVersion, 'id'>,
  type: string,
  stance: Stance,
): OperationInput[] {
  return [{ op: 'createRelation', type, from: from.id, to: to.id, stance, claim: STATED }]
}

export const connectRationale = (from: ObjectVersion, to: ObjectVersion, type: string) =>
  `Connect “${objectLabel(from)}” ${type} “${objectLabel(to)}”`

/** The active relations a retirement must retire first: the kernel refuses to strand them. */
export function attachedRelations(
  object: Pick<ObjectVersion, 'id'>,
  relations: readonly RelationVersion[],
): RelationVersion[] {
  return relations.filter(
    (r) => r.lifecycle === 'active' && (r.from === object.id || r.to === object.id),
  )
}

export function retireOps(
  object: Pick<ObjectVersion, 'id'>,
  relations: readonly RelationVersion[],
  reason: string,
): OperationInput[] {
  const why = reason.trim()
  return [
    ...attachedRelations(object, relations).map(
      (r): OperationInput => ({ op: 'retireRelation', id: r.id, reason: why }),
    ),
    { op: 'retireObject', id: object.id, reason: why },
  ]
}

export const retireRationale = (object: ObjectVersion, reason: string) =>
  `Retire “${objectLabel(object)}”: ${reason.trim()}`.slice(0, 4000)

/** Elements that may contain an element of the given type, by the registry's `contains` rule. */
export function containerCandidates(
  registry: readonly RelationTypeDescriptor[],
  type: string,
  objects: readonly ObjectVersion[],
): ObjectVersion[] {
  const contains = registry.find((d) => d.type === 'contains')
  if (!contains || !allows(contains.to, type)) return []
  return objects.filter((o) => o.lifecycle === 'active' && allows(contains.from, o.type))
}
