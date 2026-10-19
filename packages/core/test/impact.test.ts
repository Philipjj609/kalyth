import type { ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { defaultRegistry, traceImpact } from '../src/index.ts'

const claim = { basis: 'observed' as const, supports: [], contradictedBy: [], derivedFrom: [] }
const obj = (id: string, type: string, attributes: Record<string, string>): ObjectVersion => ({
  id,
  type,
  typeVersion: 1,
  stance: 'asIs',
  lifecycle: 'active',
  attributes,
  claim,
  revision: 1,
  retiredReason: null,
})
const rel = (
  id: string,
  type: string,
  from: string,
  to: string,
  lifecycle: 'active' | 'retired' = 'active',
): RelationVersion => ({
  id,
  type,
  typeVersion: 1,
  from,
  to,
  stance: 'asIs',
  lifecycle,
  properties: {},
  claim,
  revision: 1,
  retiredReason: null,
})

const objects = [
  obj('backend', 'software.Container', { name: 'backend' }),
  obj('models', 'software.Module', { path: 'app/models.py' }),
  obj('crud', 'software.Module', { path: 'app/crud.py' }),
  obj('routes', 'software.Module', { path: 'app/api/items.py' }),
  obj('tests', 'software.Module', { path: 'tests/test_items.py' }),
  obj('old', 'software.Module', { path: 'app/old.py' }),
  obj('item', 'software.DataEntity', { name: 'Item' }),
  obj('list_items', 'software.Endpoint', { method: 'GET', path: '/api/v1/items/' }),
  obj('sqlmodel', 'software.Library', { name: 'sqlmodel' }),
]
const relations = [
  rel('r01', 'contains', 'backend', 'models'),
  rel('r02', 'contains', 'models', 'item'),
  rel('r03', 'dependsOn', 'crud', 'models'),
  rel('r04', 'dependsOn', 'routes', 'crud'),
  rel('r05', 'exposes', 'routes', 'list_items'),
  rel('r06', 'dependsOn', 'tests', 'routes'),
  rel('r07', 'dependsOn', 'models', 'sqlmodel'),
  rel('r08', 'dependsOn', 'old', 'models', 'retired'),
]
const trace = (seeds: string[], maxDepth = 4, maxNodes = 100) =>
  traceImpact(objects, relations, defaultRegistry, seeds, { maxDepth, maxNodes })

describe('impact traversal (ADR 0010)', () => {
  it('follows declared impact rules and definitional containment, with typed paths', () => {
    const { elements, truncated } = trace(['item'])
    const byId = Object.fromEntries(elements.map((e) => [e.id, e]))
    expect(Object.keys(byId).sort()).toEqual(
      ['crud', 'item', 'list_items', 'models', 'routes', 'tests'].sort(),
    )
    expect(truncated).toBe(false)
    expect(byId.models?.path).toEqual([
      expect.objectContaining({ relationId: 'r02', rule: 'definition', direction: 'reverse' }),
    ])
    expect(byId.list_items?.path.map((s) => [s.type, s.direction])).toEqual([
      ['contains', 'reverse'],
      ['dependsOn', 'reverse'],
      ['dependsOn', 'reverse'],
      ['exposes', 'forward'],
    ])
    expect(byId.list_items).toMatchObject({ label: 'GET /api/v1/items/', depth: 4, seed: 'item' })
  })

  it('does not follow structural containment upwards, into libraries, or over retired relations', () => {
    const ids = trace(['models']).elements.map((e) => e.id)
    expect(ids).not.toContain('backend')
    expect(ids).not.toContain('sqlmodel')
    expect(ids).not.toContain('old')
  })

  it('reports truncation at the depth and node limits', () => {
    const shallow = trace(['item'], 2)
    expect(shallow.elements.map((e) => e.id).sort()).toEqual(['crud', 'item', 'models'])
    expect(shallow.truncated).toBe(true)
    const capped = trace(['item'], 8, 3)
    expect(capped.elements).toHaveLength(3)
    expect(capped.truncated).toBe(true)
  })

  it('is deterministic and assigns each element to its nearest seed', () => {
    const a = trace(['item', 'routes'])
    expect(trace(['item', 'routes'])).toEqual(a)
    const byId = Object.fromEntries(a.elements.map((e) => [e.id, e]))
    expect(byId.tests).toMatchObject({ seed: 'routes', depth: 1 })
    expect(byId.crud).toMatchObject({ seed: 'item', depth: 2 })
  })
})

describe('impact through data access (ADR 0021)', () => {
  // Two entities defined in one module. Endpoints say which of them they read and write; the
  // utils module imports models for an unrelated class, as the FastAPI template does.
  const objects = [
    obj('models', 'software.Module', { path: 'app/models.py' }),
    obj('items', 'software.Module', { path: 'app/api/items.py' }),
    obj('users', 'software.Module', { path: 'app/api/users.py' }),
    obj('utils', 'software.Module', { path: 'app/api/utils.py' }),
    obj('item', 'software.DataEntity', { name: 'Item' }),
    obj('user', 'software.DataEntity', { name: 'User' }),
    obj('tag', 'software.DataEntity', { name: 'Tag' }),
    obj('list_items', 'software.Endpoint', { method: 'GET', path: '/items/' }),
    obj('create_user', 'software.Endpoint', { method: 'POST', path: '/users/' }),
    obj('health', 'software.Endpoint', { method: 'GET', path: '/utils/health-check/' }),
  ]
  const base = [
    rel('a01', 'contains', 'models', 'item'),
    rel('a02', 'contains', 'models', 'user'),
    rel('a03', 'contains', 'models', 'tag'),
    rel('a04', 'dependsOn', 'items', 'models'),
    rel('a05', 'dependsOn', 'users', 'models'),
    rel('a06', 'dependsOn', 'utils', 'models'),
    rel('a07', 'exposes', 'items', 'list_items'),
    rel('a08', 'exposes', 'users', 'create_user'),
    rel('a09', 'exposes', 'utils', 'health'),
    rel('a10', 'reads', 'list_items', 'item'),
    rel('a11', 'writes', 'create_user', 'user'),
    rel('a12', 'references', 'item', 'user'),
  ]
  const run = (relations: RelationVersion[], seed: string) => {
    const result = traceImpact(objects, relations, defaultRegistry, [seed], {
      maxDepth: 6,
      maxNodes: 100,
    })
    return Object.fromEntries(result.elements.map((e) => [e.id, e]))
  }

  it('follows reads and writes instead of the defining module when they exist', () => {
    const fromItem = run(base, 'item')
    expect(Object.keys(fromItem).sort()).toEqual(['item', 'items', 'list_items'])
    expect(fromItem.list_items?.path.map((s) => [s.type, s.direction, s.rule])).toEqual([
      ['reads', 'reverse', 'relation'],
    ])
    // The endpoint still leads to its own module by definition, and the module to its endpoints.
    expect(fromItem.items?.path.at(-1)).toMatchObject({ type: 'exposes', direction: 'reverse' })
  })

  it('follows references from the referenced entity to the one that refers to it', () => {
    const fromUser = run(base, 'user')
    expect(Object.keys(fromUser).sort()).toEqual(
      ['create_user', 'item', 'items', 'list_items', 'user', 'users'].sort(),
    )
    expect(fromUser.item?.path.map((s) => [s.type, s.direction])).toEqual([
      ['references', 'reverse'],
    ])
    expect(fromUser).not.toHaveProperty('health')
    expect(fromUser).not.toHaveProperty('models')
  })

  it('falls back to the defining module for an entity without access relations', () => {
    const fromTag = run(base, 'tag')
    expect(fromTag.models?.path).toEqual([
      expect.objectContaining({ relationId: 'a03', rule: 'definition' }),
    ])
    expect(fromTag).toHaveProperty('health')
  })

  it('falls back again when the access relations are retired', () => {
    const retired = base.map((r) =>
      r.type === 'reads' ? rel(r.id, r.type, r.from, r.to, 'retired') : r,
    )
    const fromItem = run(retired, 'item')
    expect(fromItem.models?.path).toEqual([
      expect.objectContaining({ relationId: 'a01', rule: 'definition' }),
    ])
    expect(fromItem).toHaveProperty('health')
    expect(run(retired, 'item')).toEqual(fromItem)
  })
})
