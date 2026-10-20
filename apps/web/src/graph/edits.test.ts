import type { RelationTypeDescriptor } from '@kalyth/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { obj, rel, resetIds } from '../test/records.ts'
import {
  addElementOps,
  addElementRationale,
  allowedRelationTypes,
  allowedTargets,
  connectOps,
  containerCandidates,
  draftProblems,
  ELEMENT_REF,
  renameOps,
  retireOps,
} from './edits.ts'

beforeEach(resetIds)

const descriptor = (
  type: string,
  from: string[],
  to: string[],
  extra: Partial<RelationTypeDescriptor> = {},
): RelationTypeDescriptor => ({
  type,
  version: 1,
  pack: 'software',
  description: type,
  from,
  to,
  acyclic: false,
  symmetric: false,
  temporal: false,
  impact: 'none',
  ...extra,
})

const UNITS = ['software.Container', 'software.Component', 'software.Module']
const REGISTRY = [
  descriptor(
    'contains',
    ['software.System', ...UNITS],
    [...UNITS, 'software.Endpoint', 'software.DataEntity'],
  ),
  descriptor('dependsOn', UNITS, [...UNITS, 'software.Library']),
  descriptor('reads', [...UNITS, 'software.Endpoint'], ['software.DataEntity']),
  descriptor('realizes', [...UNITS, 'software.DataEntity'], [...UNITS, 'software.DataEntity'], {
    fromStance: 'asIs',
  }),
  descriptor('decides', ['core.Decision'], ['*']),
]

describe('adding an element', () => {
  it('proposes a stated, to-be element, contained when a container is chosen', () => {
    const backend = obj('software.Container', { name: 'backend' })
    const ops = addElementOps({
      type: 'software.DataEntity',
      name: '  Organisation ',
      within: backend.id,
      stance: 'toBe',
    })
    expect(ops).toEqual([
      {
        op: 'createObject',
        ref: ELEMENT_REF,
        type: 'software.DataEntity',
        stance: 'toBe',
        attributes: { name: 'Organisation' },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: backend.id,
        to: ELEMENT_REF,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    ])
  })

  it('gives an endpoint its method and path, and checks them', () => {
    const draft = {
      type: 'software.Endpoint' as const,
      name: '/visits/',
      method: 'POST',
      stance: 'asIs' as const,
    }
    expect(draftProblems(draft)).toEqual([])
    expect(addElementOps(draft)).toEqual([
      {
        op: 'createObject',
        ref: ELEMENT_REF,
        type: 'software.Endpoint',
        stance: 'asIs',
        attributes: { method: 'POST', path: '/visits/' },
        claim: { basis: 'stated' },
      },
    ])
    expect(addElementRationale(draft)).toBe('Record the endpoint “POST /visits/”')
    expect(draftProblems({ ...draft, name: 'visits' })).toEqual([
      'An endpoint path starts with a slash, as in /items/.',
    ])
    expect(draftProblems({ type: 'software.Container', name: ' ', stance: 'toBe' })).toEqual([
      'Give the element a name.',
    ])
  })

  it('offers containers the registry allows to contain the type', () => {
    const system = obj('software.System', { name: 's' })
    const backend = obj('software.Container', { name: 'backend' })
    const entity = obj('software.DataEntity', { name: 'Item' })
    const gone = obj('software.Container', { name: 'old' }, { lifecycle: 'retired' })
    const all = [system, backend, entity, gone]
    expect(containerCandidates(REGISTRY, 'software.DataEntity', all)).toEqual([system, backend])
    expect(containerCandidates(REGISTRY, 'software.Library', all)).toEqual([])
  })
})

describe('renaming, connecting and retiring', () => {
  it('renames by the attribute that names the element, with a stated claim', () => {
    const container = obj('software.Container', { name: 'api' })
    const module = obj('software.Module', { path: 'a/b.py' })
    expect(renameOps(container, ' gateway ')).toEqual([
      {
        op: 'updateObject',
        id: container.id,
        set: { name: 'gateway' },
        claim: { basis: 'stated' },
      },
    ])
    expect(renameOps(module, 'a/c.py')[0]).toMatchObject({ set: { path: 'a/c.py' } })
  })

  it('offers the relation types the registry allows, by type and stance', () => {
    const endpoint = obj('software.Endpoint', { method: 'GET', path: '/x' })
    const entity = obj('software.DataEntity', { name: 'Item' })
    const proposed = obj('software.DataEntity', { name: 'Org' }, { stance: 'toBe' })
    const container = obj('software.Container', { name: 'api' })
    expect(allowedRelationTypes(REGISTRY, endpoint).map((d) => d.type)).toEqual(['reads'])
    expect(allowedRelationTypes(REGISTRY, entity).map((d) => d.type)).toEqual(['realizes'])
    // realizes must start at an as-is element.
    expect(allowedRelationTypes(REGISTRY, proposed)).toEqual([])
    expect(allowedRelationTypes(REGISTRY, container, entity).map((d) => d.type)).toEqual([
      'contains',
      'reads',
      'realizes',
    ])
    const reads = REGISTRY.find((d) => d.type === 'reads') as RelationTypeDescriptor
    expect(allowedTargets(reads, endpoint, [endpoint, entity, container, proposed])).toEqual([
      entity,
      proposed,
    ])
    expect(connectOps(endpoint, entity, 'reads', 'toBe')).toEqual([
      {
        op: 'createRelation',
        type: 'reads',
        from: endpoint.id,
        to: entity.id,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    ])
  })

  it('retires the active relations first, then the element, with the reason', () => {
    const a = obj('software.Module', { path: 'a.py' })
    const b = obj('software.Module', { path: 'b.py' })
    const c = obj('software.Module', { path: 'c.py' })
    const out = rel('dependsOn', a, b)
    const into = rel('dependsOn', c, a)
    const old = rel('dependsOn', a, c, 'observed', { lifecycle: 'retired' })
    const other = rel('dependsOn', b, c)
    expect(retireOps(a, [out, into, old, other], ' replaced by b.py ')).toEqual([
      { op: 'retireRelation', id: out.id, reason: 'replaced by b.py' },
      { op: 'retireRelation', id: into.id, reason: 'replaced by b.py' },
      { op: 'retireObject', id: a.id, reason: 'replaced by b.py' },
    ])
  })
})
