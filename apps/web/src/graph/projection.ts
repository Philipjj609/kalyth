import type { ObjectVersion, RelationVersion } from '@kalyth/contracts'
import { objectLabel } from '../model/labels.ts'
import { compareTypes } from '../model/semantics.ts'

/**
 * Graph projection: turns the records of one revision into the nodes and edges the canvas shows.
 * Pure and deterministic, so it is unit-tested without a DOM.
 *
 * The default projection is hierarchical and collapsed, to stay readable at a few hundred objects:
 * - Containers (and Components outside a container) are groups. Everything they contain,
 *   transitively, is a member. Collapsed groups show member counts; expanded groups show their
 *   members nested and flat, with the relations between members.
 * - Top-level objects of one type (for example many Libraries) form a cluster once there are
 *   `clusterMin` of them; clusters collapse and expand like groups.
 * - `contains` is shown by nesting where nesting applies, and as an edge elsewhere (System to
 *   Container). Other relations are edges. When an endpoint is hidden inside a collapsed group or
 *   cluster, the edge attaches to the group and is aggregated per (source, target, type, basis),
 *   so every drawn edge has exactly one relation type and one claim basis.
 */

export const GROUP_TYPES: ReadonlySet<string> = new Set([
  'software.Container',
  'software.Component',
])
/** Types that are never folded into a type cluster. */
export const UNCLUSTERED_TYPES: ReadonlySet<string> = new Set([
  'software.System',
  'software.Container',
  'software.Component',
])
export const DEFAULT_CLUSTER_MIN = 6
export const CLUSTER_PREFIX = 'cluster:'

const EMPTY: ReadonlySet<string> = new Set()

export interface ProjectionOptions {
  /** Expanded group and cluster node ids. Groups and clusters not listed are collapsed. */
  expanded?: ReadonlySet<string>
  hiddenObjectTypes?: ReadonlySet<string>
  hiddenRelationTypes?: ReadonlySet<string>
  /** Top-level objects of one type are clustered when there are at least this many. */
  clusterMin?: number
  /** Optional claim freshness, rolled up onto groups and clusters as counts. */
  freshnessOf?: (claimId: string) => string | undefined
}

interface NodeBase {
  id: string
  /** The group or cluster node this node is drawn inside, when expanded. */
  parentId?: string
}

export interface ObjectNode extends NodeBase {
  kind: 'object'
  object: ObjectVersion
}

export interface GroupNode extends NodeBase {
  kind: 'group'
  /** The container object itself; the group node id is its object id. */
  object: ObjectVersion
  expanded: boolean
  memberIds: string[]
  memberCounts: Record<string, number>
  memberFreshness: Record<string, number>
}

export interface ClusterNode extends NodeBase {
  kind: 'cluster'
  /** Object type shared by every member. */
  type: string
  expanded: boolean
  memberIds: string[]
  memberFreshness: Record<string, number>
}

export type ProjectedNode = ObjectNode | GroupNode | ClusterNode

export interface ProjectedEdge {
  id: string
  source: string
  target: string
  /** Relation type. */
  type: string
  /** Claim basis shared by every relation in the edge. */
  basis: string
  relationIds: string[]
  /** True when the edge stands for relations of hidden members, or for more than one relation. */
  aggregated: boolean
  /** Index among edges joining the same two nodes in either direction, for curve offsets. */
  parallelIndex: number
  parallelCount: number
}

export interface ProjectionStats {
  objects: number
  relations: number
  /** Active objects removed by the object type filter. */
  hiddenObjects: number
  /** Active relations removed by a filter (their type, or a hidden endpoint). */
  hiddenRelations: number
  /** Relations folded inside one collapsed group or cluster. */
  internalRelations: number
}

export interface Projection {
  /** Nodes in render order: every group or cluster precedes its children. */
  nodes: ProjectedNode[]
  edges: ProjectedEdge[]
  /** Object id -> id of the node drawn for it now (itself, or its collapsed group or cluster). */
  representative: Map<string, string>
  /** Object id -> group or cluster node id it belongs to, expanded or not. */
  containerOf: Map<string, string>
  /** Ids of every group and cluster node, for expand-all and collapse-all. */
  expandable: string[]
  stats: ProjectionStats
}

export const clusterId = (type: string) => `${CLUSTER_PREFIX}${type}`
export const isClusterId = (id: string) => id.startsWith(CLUSTER_PREFIX)

function byTypeThenLabel(a: ObjectVersion, b: ObjectVersion): number {
  return (
    compareTypes(a.type, b.type) ||
    objectLabel(a).localeCompare(objectLabel(b), 'en') ||
    a.id.localeCompare(b.id)
  )
}

function tally(counts: Record<string, number>, key: string | undefined) {
  if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1
}

export function projectGraph(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
  options: ProjectionOptions = {},
): Projection {
  const expanded = options.expanded ?? EMPTY
  const hiddenObjectTypes = options.hiddenObjectTypes ?? EMPTY
  const hiddenRelationTypes = options.hiddenRelationTypes ?? EMPTY
  const clusterMin = options.clusterMin ?? DEFAULT_CLUSTER_MIN

  const active = objects.filter((o) => o.lifecycle === 'active')
  const activeIds = new Set(active.map((o) => o.id))
  const visible = active.filter((o) => !hiddenObjectTypes.has(o.type)).sort(byTypeThenLabel)
  const byId = new Map(visible.map((o) => [o.id, o]))
  const activeRelations = relations.filter((r) => r.lifecycle === 'active')

  // Structural parents over all active objects, so hidden intermediate types are skipped over.
  const parentOf = new Map<string, string>()
  for (const r of activeRelations) {
    if (r.type === 'contains' && activeIds.has(r.from) && activeIds.has(r.to)) {
      parentOf.set(r.to, r.from)
    }
  }

  // Group owner: the outermost visible ancestor of a group type.
  const groupOf = new Map<string, string>()
  for (const o of visible) {
    let owner: string | undefined
    const seen = new Set<string>([o.id])
    for (let p = parentOf.get(o.id); p !== undefined && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p)
      const ancestor = byId.get(p)
      if (ancestor && GROUP_TYPES.has(ancestor.type)) owner = p
    }
    if (owner !== undefined) groupOf.set(o.id, owner)
  }
  const groupMembers = new Map<string, ObjectVersion[]>()
  for (const o of visible) {
    const owner = groupOf.get(o.id)
    if (owner === undefined) continue
    const list = groupMembers.get(owner) ?? []
    list.push(o)
    groupMembers.set(owner, list)
  }

  // Type clusters among top-level objects that are not groups themselves.
  const topLevel = visible.filter((o) => !groupOf.has(o.id))
  const byType = new Map<string, ObjectVersion[]>()
  for (const o of topLevel) {
    if (UNCLUSTERED_TYPES.has(o.type) || groupMembers.has(o.id)) continue
    const list = byType.get(o.type) ?? []
    list.push(o)
    byType.set(o.type, list)
  }
  const clusterOf = new Map<string, string>()
  const clusters = new Map<string, { type: string; members: ObjectVersion[] }>()
  for (const [type, list] of byType) {
    if (list.length < clusterMin) continue
    const id = clusterId(type)
    clusters.set(id, { type, members: list })
    for (const o of list) clusterOf.set(o.id, id)
  }

  const representative = new Map<string, string>()
  const containerOf = new Map<string, string>()
  for (const o of visible) {
    const holder = groupOf.get(o.id) ?? clusterOf.get(o.id)
    if (holder === undefined) {
      representative.set(o.id, o.id)
      continue
    }
    containerOf.set(o.id, holder)
    representative.set(o.id, expanded.has(holder) ? o.id : holder)
  }

  const freshnessCounts = (members: readonly ObjectVersion[]) => {
    const counts: Record<string, number> = {}
    if (options.freshnessOf) for (const m of members) tally(counts, options.freshnessOf(m.id))
    return counts
  }

  // Top-level nodes, in type order; each expanded holder is followed later by its children.
  const nodes: ProjectedNode[] = []
  const children: ProjectedNode[] = []
  const emittedClusters = new Set<string>()
  for (const o of topLevel) {
    const cluster = clusterOf.get(o.id)
    if (cluster !== undefined) {
      if (emittedClusters.has(cluster)) continue
      emittedClusters.add(cluster)
      const { type, members } = clusters.get(cluster) as { type: string; members: ObjectVersion[] }
      const isOpen = expanded.has(cluster)
      nodes.push({
        kind: 'cluster',
        id: cluster,
        type,
        expanded: isOpen,
        memberIds: members.map((m) => m.id),
        memberFreshness: freshnessCounts(members),
      })
      if (isOpen) {
        for (const m of members)
          children.push({ kind: 'object', id: m.id, object: m, parentId: cluster })
      }
      continue
    }
    const members = groupMembers.get(o.id)
    if (members === undefined) {
      nodes.push({ kind: 'object', id: o.id, object: o })
      continue
    }
    const memberCounts: Record<string, number> = {}
    for (const m of members) tally(memberCounts, m.type)
    const isOpen = expanded.has(o.id)
    nodes.push({
      kind: 'group',
      id: o.id,
      object: o,
      expanded: isOpen,
      memberIds: members.map((m) => m.id),
      memberCounts,
      memberFreshness: freshnessCounts(members),
    })
    if (isOpen) {
      for (const m of members)
        children.push({ kind: 'object', id: m.id, object: m, parentId: o.id })
    }
  }
  nodes.push(...children)

  // Edges.
  let hiddenRelations = 0
  let internalRelations = 0
  const merged = new Map<string, Omit<ProjectedEdge, 'parallelIndex' | 'parallelCount'>>()
  for (const r of activeRelations) {
    if (hiddenRelationTypes.has(r.type) || !byId.has(r.from) || !byId.has(r.to)) {
      hiddenRelations++
      continue
    }
    const source = representative.get(r.from) as string
    const target = representative.get(r.to) as string
    if (source === target) {
      internalRelations++
      continue
    }
    // Nesting already shows that a group or cluster holds this member.
    if (r.type === 'contains' && containerOf.get(r.to) === source) continue
    const basis = r.claim.basis
    const key = `${source}>${target}:${r.type}:${basis}`
    const existing = merged.get(key)
    if (existing) {
      existing.relationIds.push(r.id)
      existing.aggregated = true
    } else {
      merged.set(key, {
        id: `e:${key}`,
        source,
        target,
        type: r.type,
        basis,
        relationIds: [r.id],
        aggregated: source !== r.from || target !== r.to,
      })
    }
  }

  const edges = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
  const pairs = new Map<string, number>()
  const pairKey = (e: { source: string; target: string }) =>
    e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
  for (const e of edges) pairs.set(pairKey(e), (pairs.get(pairKey(e)) ?? 0) + 1)
  const seenPairs = new Map<string, number>()
  const finalEdges: ProjectedEdge[] = edges.map((e) => {
    const key = pairKey(e)
    const index = seenPairs.get(key) ?? 0
    seenPairs.set(key, index + 1)
    return { ...e, parallelIndex: index, parallelCount: pairs.get(key) ?? 1 }
  })

  const expandable = [
    ...nodes.filter((n) => n.kind === 'group' || n.kind === 'cluster').map((n) => n.id),
  ]

  return {
    nodes,
    edges: finalEdges,
    representative,
    containerOf,
    expandable,
    stats: {
      objects: visible.length,
      relations: activeRelations.length - hiddenRelations,
      hiddenObjects: active.length - visible.length,
      hiddenRelations,
      internalRelations,
    },
  }
}

/** Type counts for the filter UI, over active records. */
export function typeCounts(
  objects: readonly ObjectVersion[],
  relations: readonly RelationVersion[],
): { objectTypes: [string, number][]; relationTypes: [string, number][] } {
  const o: Record<string, number> = {}
  const r: Record<string, number> = {}
  for (const x of objects) if (x.lifecycle === 'active') tally(o, x.type)
  for (const x of relations) if (x.lifecycle === 'active') tally(r, x.type)
  return {
    objectTypes: Object.entries(o).sort(([a], [b]) => compareTypes(a, b)),
    relationTypes: Object.entries(r).sort(([a], [b]) => a.localeCompare(b)),
  }
}
