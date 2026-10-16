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
