import { beforeEach, describe, expect, it } from 'vitest'
import { claim, demoScaleModel, obj, rel, resetIds } from '../test/records.ts'
import { layoutProjection } from './layout.ts'
import { clusterId, type GroupNode, projectGraph } from './projection.ts'

beforeEach(resetIds)

function smallModel() {
  const system = obj('software.System', { name: 'Shop' })
  const api = obj('software.Container', { name: 'api' })
  const web = obj('software.Container', { name: 'web' })
  const routes = obj('software.Module', { path: 'api/routes.py' })
  const db = obj('software.Module', { path: 'api/db.py' })
  const client = obj('software.Module', { path: 'web/client.ts' })
  const endpoint = obj('software.Endpoint', { method: 'GET', path: '/items' })
  const item = obj('software.DataEntity', { name: 'Item' })
  const objects = [system, api, web, routes, db, client, endpoint, item]
  const relations = [
    rel('contains', system, api),
    rel('contains', system, web),
    rel('contains', api, routes),
    rel('contains', api, db),
    rel('contains', api, endpoint),
    rel('contains', web, client),
    rel('dependsOn', routes, db),
    rel('exposes', routes, endpoint),
    rel('dependsOn', client, routes, 'inferred'),
    rel('dependsOn', client, db, 'inferred'),
    rel('dependsOn', client, routes, 'observed'),
    rel('reads', endpoint, item, 'inferred'),
  ]
  return { objects, relations, system, api, web, routes, db, client, endpoint, item }
}

describe('projectGraph', () => {
  it('starts collapsed: system, containers as groups with member counts', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    expect(p.nodes.map((n) => [n.kind, n.id])).toEqual([
      ['object', m.system.id],
      ['group', m.api.id],
      ['group', m.web.id],
      ['object', m.item.id],
    ])
    const api = p.nodes[1] as GroupNode
    expect(api.expanded).toBe(false)
    expect(api.memberCounts).toEqual({ 'software.Module': 2, 'software.Endpoint': 1 })
    expect(p.representative.get(m.routes.id)).toBe(m.api.id)
    expect(p.containerOf.get(m.client.id)).toBe(m.web.id)
    expect(p.expandable).toEqual([m.api.id, m.web.id])
  })

  it('aggregates edges of hidden members per type and basis, and drops internal ones', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    const summary = p.edges.map((e) => [e.source, e.target, e.type, e.basis, e.relationIds.length])
    expect(summary).toContainEqual([m.system.id, m.api.id, 'contains', 'observed', 1])
    expect(summary).toContainEqual([m.web.id, m.api.id, 'dependsOn', 'inferred', 2])
    expect(summary).toContainEqual([m.web.id, m.api.id, 'dependsOn', 'observed', 1])
    expect(summary).toContainEqual([m.api.id, m.item.id, 'reads', 'inferred', 1])
    // Four contains plus routes -> db and routes -> endpoint fold inside the groups.
    expect(p.edges).toHaveLength(5)
    expect(p.stats.internalRelations).toBe(6)
    const parallel = p.edges.filter((e) => e.source === m.web.id && e.target === m.api.id)
    expect(parallel.map((e) => [e.parallelIndex, e.parallelCount])).toEqual([
      [0, 2],
      [1, 2],
    ])
    expect(parallel.every((e) => e.aggregated)).toBe(true)
  })

  it('expands a group: members nest under it and relations between them are drawn', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, { expanded: new Set([m.api.id]) })
    const nested = p.nodes.filter((n) => n.parentId === m.api.id).map((n) => n.id)
    expect(nested.sort()).toEqual([m.routes.id, m.db.id, m.endpoint.id].sort())
    // Parents precede children.
    const order = p.nodes.map((n) => n.id)
    expect(order.indexOf(m.api.id)).toBeLessThan(order.indexOf(m.routes.id))
    const edges = p.edges.map((e) => [e.source, e.target, e.type])
    expect(edges).toContainEqual([m.routes.id, m.db.id, 'dependsOn'])
    expect(edges).toContainEqual([m.routes.id, m.endpoint.id, 'exposes'])
    expect(edges).toContainEqual([m.web.id, m.routes.id, 'dependsOn'])
    expect(edges).toContainEqual([m.endpoint.id, m.item.id, 'reads'])
    // Nesting replaces the container -> member contains edges.
    expect(edges.filter(([s, , t]) => s === m.api.id && t === 'contains')).toEqual([])
    const direct = p.edges.find((e) => e.source === m.routes.id && e.target === m.db.id)
    expect(direct?.aggregated).toBe(false)
  })

  it('filters by relation type and by object type', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, {
      expanded: new Set([m.api.id, m.web.id]),
      hiddenRelationTypes: new Set(['dependsOn']),
      hiddenObjectTypes: new Set(['software.DataEntity']),
    })
    expect(p.edges.some((e) => e.type === 'dependsOn')).toBe(false)
    expect(p.nodes.some((n) => n.id === m.item.id)).toBe(false)
    expect(p.stats.hiddenObjects).toBe(1)
    // 4 dependsOn + 1 reads whose target is hidden.
    expect(p.stats.hiddenRelations).toBe(5)
  })

  it('hiding the container type lifts members to the top level', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, {
      hiddenObjectTypes: new Set(['software.Container']),
    })
    expect(p.nodes.every((n) => n.kind === 'object')).toBe(true)
    expect(p.nodes.map((n) => n.id)).toContain(m.routes.id)
  })

  it('clusters many top-level objects of one type, and expands the cluster', () => {
    const app = obj('software.Container', { name: 'app' })
    const libs = Array.from({ length: 6 }, (_, i) => obj('software.Library', { name: `lib${i}` }))
    const relations = libs.map((l) => rel('dependsOn', app, l))
    const collapsed = projectGraph([app, ...libs], relations)
    const id = clusterId('software.Library')
    expect(collapsed.nodes.map((n) => n.id)).toEqual([app.id, id])
    expect(collapsed.edges).toHaveLength(1)
    expect(collapsed.edges[0]?.relationIds).toHaveLength(6)

    const open = projectGraph([app, ...libs], relations, { expanded: new Set([id]) })
    expect(open.nodes.filter((n) => n.parentId === id)).toHaveLength(6)
    expect(open.edges).toHaveLength(6)
    expect(projectGraph([app, ...libs.slice(1)], relations.slice(1)).nodes).toHaveLength(6)
  })

  it('handles unknown types and ignores retired records', () => {
    const odd = obj('acme.Gizmo', { label: 'gizmo' })
    const sys = obj('software.System', { name: 's' })
    const gone = obj('software.Module', { path: 'x.py' }, { lifecycle: 'retired' })
    const relations = [
      rel('poweredBy', odd, sys),
      rel('contains', sys, gone),
      rel('dependsOn', odd, sys, 'observed', { lifecycle: 'retired' }),
    ]
    const p = projectGraph([odd, sys, gone], relations)
    expect(p.nodes.map((n) => n.id)).toEqual([sys.id, odd.id])
    expect(p.edges.map((e) => e.type)).toEqual(['poweredBy'])
  })

  it('rolls member freshness up onto collapsed groups', () => {
    const m = smallModel()
    const status: Record<string, string> = { [m.routes.id]: 'stale', [m.db.id]: 'current' }
    const p = projectGraph(m.objects, m.relations, { freshnessOf: (id) => status[id] })
    const api = p.nodes.find((n) => n.id === m.api.id) as GroupNode
    expect(api.memberFreshness).toEqual({ stale: 1, current: 1 })
  })

  it('keeps one basis per drawn edge', () => {
    const a = obj('software.Container', { name: 'a' })
    const b = obj('software.Container', { name: 'b' })
    const relations = (['observed', 'inferred', 'stated', 'imported'] as const).map((basis) =>
      rel('dependsOn', a, b, basis, { claim: claim(basis) }),
    )
    const p = projectGraph([a, b], relations)
    expect(p.edges.map((e) => e.basis).sort()).toEqual([
      'imported',
      'inferred',
      'observed',
      'stated',
    ])
  })
})

describe('demo-scale projection', () => {
  it('reduces ~250 objects and ~500 relations to a readable default view', () => {
    const model = demoScaleModel()
    expect(model.objects.length).toBeGreaterThanOrEqual(240)
    expect(model.relations.length).toBeGreaterThanOrEqual(480)
    const started = performance.now()
    const p = projectGraph(model.objects, model.relations)
    const placed = layoutProjection(p)
    const elapsed = performance.now() - started
    expect(p.nodes.length).toBeLessThanOrEqual(12)
    expect(p.edges.length).toBeLessThanOrEqual(20)
    expect(placed.boxes.size).toBe(p.nodes.length)
    expect(elapsed).toBeLessThan(2000)
  })

  it('lays out an expanded container of 130 members without overlaps', () => {
    const model = demoScaleModel()
    const p = projectGraph(model.objects, model.relations, {
      expanded: new Set([model.backend.id]),
    })
    const placed = layoutProjection(p)
    const group = placed.boxes.get(model.backend.id)
    expect(group).toBeDefined()
    const kids = p.nodes.filter((n) => n.parentId === model.backend.id)
    expect(kids).toHaveLength(130)
    const boxes = kids.map((k) => placed.boxes.get(k.id) as NonNullable<typeof group>)
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual((group?.width ?? 0) + 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual((group?.height ?? 0) + 0.5)
    }
    expectNoOverlap(boxes)
    const top = p.nodes.filter((n) => n.parentId === undefined)
    expectNoOverlap(top.map((n) => placed.boxes.get(n.id) as NonNullable<typeof group>))
  })
})

describe('layoutProjection', () => {
  it('is deterministic', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, { expanded: new Set([m.api.id]) })
    const a = layoutProjection(p)
    const b = layoutProjection(p)
    expect([...a.boxes.entries()]).toEqual([...b.boxes.entries()])
  })

  it('places the system above the containers it contains', () => {
    const m = smallModel()
    const placed = layoutProjection(projectGraph(m.objects, m.relations))
    const system = placed.boxes.get(m.system.id)
    const api = placed.boxes.get(m.api.id)
    expect(system && api && system.y + system.height <= api.y).toBe(true)
  })

  it('ranks annotations below what they are about, keeping the system on top', () => {
    const m = smallModel()
    const decision = obj('core.Decision', { title: 'Cache?' }, { stance: 'toBe' })
    const alternative = obj('core.Alternative', { title: 'Redis' }, { stance: 'toBe' })
    const relations = [
      ...m.relations,
      rel('decides', decision, m.web, 'stated'),
      rel('alternativeOf', alternative, decision, 'stated'),
    ]
    const placed = layoutProjection(projectGraph([...m.objects, decision, alternative], relations))
    const y = (id: string) => placed.boxes.get(id)?.y ?? Number.NaN
    expect(y(m.system.id)).toBeLessThan(y(m.web.id))
    expect(y(m.web.id)).toBeLessThan(y(decision.id))
    expect(y(decision.id)).toBeLessThan(y(alternative.id))
  })
})

function expectNoOverlap(boxes: { x: number; y: number; width: number; height: number }[]) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as (typeof boxes)[number]
      const b = boxes[j] as (typeof boxes)[number]
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlap, `boxes ${i} and ${j} overlap`).toBe(false)
    }
  }
}
