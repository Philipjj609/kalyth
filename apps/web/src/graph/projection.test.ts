import { beforeEach, describe, expect, it } from 'vitest'
import { claim, demoScaleModel, obj, rel, resetIds } from '../test/records.ts'
import { type Box, layoutProjection, packIsolated, routeBetween } from './layout.ts'
import {
  clusterId,
  commonDirectory,
  type GroupNode,
  type ObjectNode,
  type PackageNode,
  packageId,
  projectGraph,
  siblingsBetween,
  typeCounts,
} from './projection.ts'

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

const node = (p: ReturnType<typeof projectGraph>, id: string) => p.nodes.find((n) => n.id === id)
const edgeList = (p: ReturnType<typeof projectGraph>) =>
  p.edges.map((e) => [e.source, e.target, e.type, e.basis, e.relationIds.length])

describe('projectGraph: structure', () => {
  it('opens a small model: the system frame, its containers, and endpoints as rows', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    const shape = p.nodes.map((n) => [
      n.kind,
      n.id,
      n.parentId ?? null,
      n.kind === 'object' ? n.row : (n as GroupNode).expanded,
    ])
    expect(shape).toEqual([
      ['group', m.system.id, null, true],
      ['object', m.item.id, null, false],
      ['group', m.api.id, m.system.id, true],
      ['group', m.web.id, m.system.id, true],
      ['object', m.db.id, m.api.id, false],
      ['group', m.routes.id, m.api.id, true],
      ['object', m.client.id, m.web.id, false],
      ['object', m.endpoint.id, m.routes.id, true],
    ])
    // The endpoint belongs to the module exposing it, inside its own container.
    expect(p.ancestors.get(m.endpoint.id)).toEqual([m.system.id, m.api.id, m.routes.id])
    expect(p.containerOf.get(m.endpoint.id)).toBe(m.routes.id)
    expect([...p.defaultOpen].sort()).toEqual([m.system.id, m.api.id, m.web.id, m.routes.id].sort())
  })

  it('every holder precedes its children', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    const order = p.nodes.map((n) => n.id)
    for (const n of p.nodes) {
      if (n.parentId) expect(order.indexOf(n.parentId)).toBeLessThan(order.indexOf(n.id))
    }
  })

  it('collapsed holders stand for their members, with member counts', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, { collapsed: new Set([m.api.id, m.web.id]) })
    expect(p.nodes.map((n) => n.id)).toEqual([m.system.id, m.item.id, m.api.id, m.web.id])
    const api = node(p, m.api.id) as GroupNode
    expect(api.expanded).toBe(false)
    expect(api.memberCounts).toEqual({ 'software.Module': 2, 'software.Endpoint': 1 })
    expect(p.representative.get(m.endpoint.id)).toBe(m.api.id)
    expect(p.representative.get(m.routes.id)).toBe(m.api.id)
    expect(p.expandable).toEqual([m.system.id, m.api.id, m.routes.id, m.web.id])
  })

  it('starts containers collapsed when the model is large', () => {
    const model = demoScaleModel()
    const p = projectGraph(model.objects, model.relations)
    expect((node(p, model.system.id) as GroupNode).expanded).toBe(true)
    expect((node(p, model.backend.id) as GroupNode).expanded).toBe(false)
    expect((node(p, model.frontend.id) as GroupNode).expanded).toBe(false)
  })

  it('leaves decisions, alternatives and other records out of the canvas', () => {
    const model = demoScaleModel()
    const p = projectGraph(model.objects, model.relations)
    const kinds = p.nodes.flatMap((n) =>
      n.kind === 'object' || n.kind === 'group' ? [n.object.type] : [],
    )
    expect(kinds.some((t) => t.startsWith('core.'))).toBe(false)
    expect(p.stats.offCanvas).toBe(3)
    expect(p.edges.some((e) => e.type === 'decides' || e.type === 'alternativeOf')).toBe(false)
    expect(typeCounts(model.objects, model.relations).objectTypes.map(([t]) => t)).not.toContain(
      'core.Decision',
    )
  })

  it('hiding the container type lifts members to the system frame', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, {
      hiddenObjectTypes: new Set(['software.Container']),
    })
    expect(p.nodes.some((n) => n.kind === 'group' && n.object.type === 'software.Container')).toBe(
      false,
    )
    expect(node(p, m.routes.id)?.parentId).toBe(m.system.id)
    expect(node(p, m.client.id)?.parentId).toBe(m.system.id)
  })

  it('an endpoint with two exposing modules stays with its container', () => {
    const m = smallModel()
    const relations = [...m.relations, rel('exposes', m.db, m.endpoint)]
    const p = projectGraph(m.objects, relations)
    expect(node(p, m.endpoint.id)?.parentId).toBe(m.api.id)
    expect((node(p, m.endpoint.id) as ObjectNode).row).toBe(false)
  })
})

describe('projectGraph: edges', () => {
  it('aggregates edges of collapsed members per type and basis, and drops internal ones', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, { collapsed: new Set([m.api.id, m.web.id]) })
    const summary = edgeList(p)
    expect(summary).toContainEqual([m.web.id, m.api.id, 'dependsOn', 'inferred', 2])
    expect(summary).toContainEqual([m.web.id, m.api.id, 'dependsOn', 'observed', 1])
    // The read leaves the system frame: it joins the frame and the entity outside it.
    expect(summary).toContainEqual([m.system.id, m.item.id, 'reads', 'inferred', 1])
    expect(p.edges).toHaveLength(3)
    const parallel = p.edges.filter((e) => e.source === m.web.id && e.target === m.api.id)
    expect(parallel.map((e) => [e.parallelIndex, e.parallelCount])).toEqual([
      [0, 2],
      [1, 2],
    ])
    expect(parallel.every((e) => e.aggregated)).toBe(true)
  })

  it('shows contains and exposes by nesting, not as edges', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    expect(p.edges.some((e) => e.type === 'contains' || e.type === 'exposes')).toBe(false)
  })

  it('joins the frames that separate the ends of an edge, unless one end is the selection', () => {
    const m = smallModel()
    const lifted = projectGraph(m.objects, m.relations)
    expect(edgeList(lifted)).toContainEqual([m.web.id, m.api.id, 'dependsOn', 'inferred', 2])
    expect(edgeList(lifted)).toContainEqual([m.system.id, m.item.id, 'reads', 'inferred', 1])
    const exact = projectGraph(m.objects, m.relations, { exactFor: m.client.id })
    expect(edgeList(exact)).toContainEqual([m.client.id, m.routes.id, 'dependsOn', 'inferred', 1])
    expect(edgeList(exact)).toContainEqual([m.client.id, m.db.id, 'dependsOn', 'inferred', 1])
    const read = projectGraph(m.objects, m.relations, { exactFor: m.endpoint.id })
    expect(edgeList(read)).toContainEqual([m.endpoint.id, m.item.id, 'reads', 'inferred', 1])
  })

  it('draws imports between members of one container only for the selection, or on request', () => {
    const m = smallModel()
    const quiet = projectGraph(m.objects, m.relations)
    expect(edgeList(quiet)).not.toContainEqual([m.routes.id, m.db.id, 'dependsOn', 'observed', 1])
    expect(quiet.stats.detailRelations).toBe(1)
    const all = projectGraph(m.objects, m.relations, { detail: 'all' })
    expect(edgeList(all)).toContainEqual([m.routes.id, m.db.id, 'dependsOn', 'observed', 1])
    const selected = projectGraph(m.objects, m.relations, { exactFor: m.db.id })
    expect(edgeList(selected)).toContainEqual([m.routes.id, m.db.id, 'dependsOn', 'observed', 1])
    // Between containers of a system, imports stay visible.
    expect(
      edgeList(quiet).some(
        ([s, t, type]) => s === m.web.id && t === m.api.id && type === 'dependsOn',
      ),
    ).toBe(true)
  })

  it('filters by relation type and by object type', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, {
      hiddenRelationTypes: new Set(['dependsOn']),
      hiddenObjectTypes: new Set(['software.DataEntity']),
    })
    expect(p.edges.some((e) => e.type === 'dependsOn')).toBe(false)
    expect(p.nodes.some((n) => n.id === m.item.id)).toBe(false)
    expect(p.stats.hiddenObjects).toBe(1)
    // 4 dependsOn + 1 reads whose target is hidden.
    expect(p.stats.hiddenRelations).toBe(5)
  })

  it('keeps one basis per drawn edge, and marks to-be edges', () => {
    const a = obj('software.Container', { name: 'a' })
    const b = obj('software.Container', { name: 'b' })
    const relations = (['observed', 'inferred', 'stated', 'imported'] as const).map((basis) =>
      rel('dependsOn', a, b, basis, {
        claim: claim(basis),
        stance: basis === 'stated' ? 'toBe' : 'asIs',
      }),
    )
    const p = projectGraph([a, b], relations)
    expect(p.edges.map((e) => [e.basis, e.toBe]).sort()).toEqual([
      ['imported', false],
      ['inferred', false],
      ['observed', false],
      ['stated', true],
    ])
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
})

describe('projectGraph: clusters and packages', () => {
  it('clusters many top-level objects of one type, and opens the cluster', () => {
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
    // The edges reach into the open cluster's frame, and to each library for the selection.
    expect(open.edges).toHaveLength(1)
    expect(
      projectGraph([app, ...libs], relations, { expanded: new Set([id]), exactFor: app.id }).edges,
    ).toHaveLength(6)
    expect(projectGraph([app, ...libs.slice(1)], relations.slice(1)).nodes).toHaveLength(6)
  })

  it('finds the common directory of paths', () => {
    expect(commonDirectory(['a/b/c.py', 'a/b/d/e.py'])).toBe('a/b/')
    expect(commonDirectory(['a/b.py', 'c/d.py'])).toBe('')
    expect(commonDirectory(['a/b/c.py'])).toBe('a/b/')
  })

  it('groups a container with many modules into directory packages', () => {
    const backend = obj('software.Container', { name: 'backend' })
    const paths = [
      ...['__init__', 'crud', 'main', 'models', 'utils'].map((f) => `backend/app/${f}.py`),
      ...['env', 'v1', 'v2', 'v3', 'v4', 'v5'].map((f) => `backend/app/alembic/${f}.py`),
      ...['deps', 'main', 'routes/items', 'routes/users', 'routes/login'].map(
        (f) => `backend/app/api/${f}.py`,
      ),
      ...['config', 'db'].map((f) => `backend/app/core/${f}.py`),
      ...Array.from({ length: 9 }, (_, i) => `backend/tests/test_${i}.py`),
    ]
    const modules = paths.map((path) => obj('software.Module', { path }))
    const relations = modules.map((m) => rel('contains', backend, m))
    const p = projectGraph([backend, ...modules], relations, { expanded: new Set([backend.id]) })
    const level = p.nodes.filter((n) => n.parentId === backend.id)
    const packages = level.filter((n): n is PackageNode => n.kind === 'package')
    expect(packages.map((n) => [n.title, n.memberIds.length])).toEqual([
      ['app/alembic/', 6],
      ['app/api/', 5],
      ['tests/', 9],
    ])
    // Directories with fewer than three modules stay loose.
    expect(level.filter((n) => n.kind === 'object')).toHaveLength(7)
    expect(packages.every((n) => !n.expanded)).toBe(true)
    const api = packageId(backend.id, 'backend/app/api/')
    expect(p.expandable).toContain(api)
    const open = projectGraph([backend, ...modules], relations, {
      expanded: new Set([backend.id, api]),
    })
    expect(open.nodes.filter((n) => n.parentId === api)).toHaveLength(5)
    expect(open.ancestors.get(modules[12]?.id as string)).toEqual([backend.id, api])
  })

  it('finds the nodes where the ends of an edge meet', () => {
    const ancestors = new Map([
      ['a', ['s', 'c1']],
      ['b', ['s', 'c2', 'p']],
      ['c1', ['s']],
    ])
    expect(siblingsBetween('a', 'b', ancestors)).toEqual(['c1', 'c2'])
    expect(siblingsBetween('c1', 'a', ancestors)).toEqual(['c1', 'a'])
    expect(siblingsBetween('x', 'y', ancestors)).toEqual(['x', 'y'])
  })

  it('rolls member freshness up onto collapsed holders', () => {
    const m = smallModel()
    const status: Record<string, string> = { [m.routes.id]: 'stale', [m.db.id]: 'current' }
    const p = projectGraph(m.objects, m.relations, { freshnessOf: (id) => status[id] })
    const api = node(p, m.api.id) as GroupNode
    expect(api.memberFreshness).toEqual({ stale: 1, current: 1 })
  })
})

describe('demo-scale projection and layout', () => {
  it('reduces ~250 objects and ~500 relations to a readable default view', () => {
    const model = demoScaleModel()
    expect(model.objects.length).toBeGreaterThanOrEqual(240)
    expect(model.relations.length).toBeGreaterThanOrEqual(480)
    const started = performance.now()
    const p = projectGraph(model.objects, model.relations)
    const placed = layoutProjection(p)
    const elapsed = performance.now() - started
    expect(p.nodes.length).toBeLessThanOrEqual(12)
    expect(p.edges.length).toBeLessThanOrEqual(8)
    expect(placed.boxes.size).toBe(p.nodes.length)
    expect(elapsed).toBeLessThan(2000)
  })

  it('lays out an opened container of 100 modules and 30 endpoints without overlaps', () => {
    const model = demoScaleModel()
    const p = projectGraph(model.objects, model.relations, {
      expanded: new Set([model.backend.id]),
    })
    const placed = layoutProjection(p)
    const group = placed.boxes.get(model.backend.id) as Box
    const kids = p.nodes.filter((n) => n.parentId === model.backend.id)
    expect(kids).toHaveLength(100)
    const boxes = kids.map((k) => placed.boxes.get(k.id) as Box)
    for (const box of boxes) expectInside(box, group)
    expectNoOverlap(boxes)
    // Endpoint rows sit inside the module that exposes them.
    const rows = p.nodes.filter((n) => n.kind === 'object' && n.row)
    expect(rows).toHaveLength(30)
    for (const row of rows) {
      const parent = placed.boxes.get(row.parentId as string) as Box
      expectInside(placed.boxes.get(row.id) as Box, parent)
    }
    const top = p.nodes.filter((n) => n.parentId === undefined)
    expectNoOverlap(top.map((n) => placed.boxes.get(n.id) as Box))
  })
})

describe('layoutProjection', () => {
  it('is deterministic', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations, { detail: 'all' })
    const a = layoutProjection(p)
    const b = layoutProjection(p)
    expect([...a.boxes.entries()]).toEqual([...b.boxes.entries()])
  })

  it('places members inside their open holders, below the header', () => {
    const m = smallModel()
    const p = projectGraph(m.objects, m.relations)
    const placed = layoutProjection(p)
    const system = placed.boxes.get(m.system.id) as Box
    const api = placed.boxes.get(m.api.id) as Box
    expectInside(api, system)
    expect(api.y).toBeGreaterThanOrEqual(30)
  })

  it('ranks a constraint below what it constrains, keeping the system on top', () => {
    const m = smallModel()
    const constraint = obj('core.Constraint', { title: 'No logs' }, { stance: 'toBe' })
    const relations = [...m.relations, rel('constrains', constraint, m.item, 'stated')]
    const placed = layoutProjection(
      projectGraph([...m.objects, constraint], relations, { collapsed: new Set([m.system.id]) }),
    )
    const y = (id: string) => placed.boxes.get(id)?.y ?? Number.NaN
    expect(y(m.item.id)).toBeLessThan(y(constraint.id))
  })

  it('keeps the lanes dagre reserved for sibling edges, oriented either way', () => {
    const a = obj('software.Container', { name: 'a' })
    const b = obj('software.Container', { name: 'b' })
    const c = obj('software.Container', { name: 'c' })
    const relations = [rel('dependsOn', a, b), rel('dependsOn', b, c), rel('dependsOn', a, c)]
    const placed = layoutProjection(projectGraph([a, b, c], relations))
    const forward = routeBetween(placed.routes, a.id, c.id)
    const back = routeBetween(placed.routes, c.id, a.id)
    expect(forward?.lanes.length).toBeGreaterThan(0)
    expect(back?.lanes).toEqual([...(forward?.lanes ?? [])].reverse())
  })

  it('packs a large frame and a grid of small items into one landscape block', () => {
    const items = [
      { id: 'big', width: 600, height: 400 },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, width: 200, height: 50 })),
    ]
    const packed = packIsolated(items, 20)
    expect(packed.positions.get('big')).toEqual({ x: 0, y: 0 })
    expect(packed.width / packed.height).toBeGreaterThan(1)
    expect(packed.width / packed.height).toBeLessThan(2.2)
    expectNoOverlap(
      items.map((it) => ({
        ...(packed.positions.get(it.id) as { x: number; y: number }),
        width: it.width,
        height: it.height,
      })),
    )
  })

  it('keeps a block of frames and modules near a landscape sheet, not one long row', () => {
    // The shape of backend/app/api/ in the FastAPI template with its route modules open: one tall
    // frame, four shorter frames and four plain modules, none connected.
    const items = [
      { id: 'users', width: 264, height: 322 },
      ...['init', 'deps', 'main', 'routes'].map((id) => ({ id, width: 200, height: 54 })),
      { id: 'items', width: 264, height: 182 },
      { id: 'login', width: 264, height: 182 },
      { id: 'private', width: 264, height: 70 },
      { id: 'utils', width: 264, height: 98 },
    ]
    const packed = packIsolated(items, 20)
    expect(packed.width / packed.height).toBeLessThan(3)
    expect(packed.width / packed.height).toBeGreaterThan(0.8)
    expectNoOverlap(
      items.map((it) => ({
        ...(packed.positions.get(it.id) as { x: number; y: number }),
        width: it.width,
        height: it.height,
      })),
    )
  })
})

describe('larger repositories', () => {
  const DOMAINS = [
    'account',
    'cart',
    'core',
    'order',
    'payment',
    'product',
    'search',
    'shipping',
    'tax',
    'user',
  ]
  /**
   * One container holding ten domain packages and a small hidden tooling folder, like a Django
   * project: every package imports core, order imports payment more than product.
   */
  function oneContainer() {
    const system = obj('software.System', { name: 'shop' })
    const container = obj('software.Container', { name: 'shop' })
    const objects = [system, container]
    const relations = [rel('contains', system, container)]
    const modules = new Map<string, ReturnType<typeof obj>[]>()
    const add = (dir: string, count: number) => {
      const list: ReturnType<typeof obj>[] = []
      for (let i = 0; i < count; i++) {
        const m = obj('software.Module', { path: `${dir}/m${i}.py`, language: 'python' })
        list.push(m)
        objects.push(m)
        relations.push(rel('contains', container, m))
      }
      modules.set(dir, list)
    }
    for (const d of DOMAINS) add(`shop/${d}`, 8)
    add('.semgrep', 4)
    const pick = (dir: string, i: number) => modules.get(dir)?.[i] as ReturnType<typeof obj>
    for (const d of DOMAINS.filter((x) => x !== 'core'))
      relations.push(rel('dependsOn', pick(`shop/${d}`, 0), pick('shop/core', 0)))
    for (let i = 0; i < 3; i++)
      relations.push(rel('dependsOn', pick('shop/order', i), pick('shop/payment', i)))
    relations.push(rel('dependsOn', pick('shop/order', 4), pick('shop/product', 4)))
    return { objects, relations, container }
  }
  const pkg = (p: ReturnType<typeof projectGraph>, path: string) =>
    p.nodes.find((n): n is PackageNode => n.kind === 'package' && n.path === path)

  it('opens a container that is the whole of its level, not parts of a level that shows its parts', () => {
    const m = oneContainer()
    const p = projectGraph(m.objects, m.relations)
    // The one container is all of the system: it opens onto its packages.
    expect(p.defaultOpen.has(m.container.id)).toBe(true)
    // Ten comparable packages already show the structure; none, and not the hidden folder, opens.
    expect(DOMAINS.filter((d) => pkg(p, `shop/${d}/`)?.expanded)).toEqual([])
    expect(pkg(p, '.semgrep/')?.expanded).toBe(false)

    // Two containers of similar size: the system shows both, closed.
    const system = obj('software.System', { name: 'two' })
    const a = obj('software.Container', { name: 'api' })
    const b = obj('software.Container', { name: 'web' })
    const objects = [system, a, b]
    const relations = [rel('contains', system, a), rel('contains', system, b)]
    for (const [c, dir] of [
      [a, 'api'],
      [b, 'web'],
    ] as const)
      for (let i = 0; i < 20; i++) {
        const mod = obj('software.Module', { path: `${dir}/m${i}.py` })
        objects.push(mod)
        relations.push(rel('contains', c, mod))
      }
    const two = projectGraph(objects, relations)
    expect(two.defaultOpen.has(a.id) || two.defaultOpen.has(b.id)).toBe(false)
  })

  it('draws the strongest import of each package, and names a hub instead of drawing its star', () => {
    const m = oneContainer()
    // Everything closed, so the imports are between packages.
    const p = projectGraph(m.objects, m.relations, {
      collapsed: new Set(
        DOMAINS.map((d) => `shop/${d}/`).flatMap((path) => {
          const id = pkg(projectGraph(m.objects, m.relations), path)?.id
          return id ? [id] : []
        }),
      ),
    })
    const name = (id: string) => p.nodes.find((x) => x.id === id && x.kind === 'package')
    const imports = p.edges
      .filter((e) => e.type === 'dependsOn')
      .map((e) => {
        const s = name(e.source)
        const t = name(e.target)
        return `${s?.kind === 'package' ? s.path : e.source} > ${t?.kind === 'package' ? t.path : e.target}`
      })
    expect(imports.some((i) => i.endsWith('> shop/core/'))).toBe(false)
    expect(pkg(p, 'shop/core/')?.importedBy).toBe(DOMAINS.length - 1)
    expect(imports).toContain('shop/order/ > shop/payment/')
    expect(imports).not.toContain('shop/order/ > shop/product/')
    expect(p.stats.detailRelations).toBeGreaterThan(0)
  })
})

function expectInside(box: Box, parent: Box) {
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(parent.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(parent.height + 0.5)
}

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
