import { Graph, layout } from '@dagrejs/dagre'
import { objectTypeMeta } from '../model/semantics.ts'
import type { ProjectedNode, Projection } from './projection.ts'

/**
 * Layout for a projection, with dagre (MIT). Two levels: the members of each expanded group or
 * cluster are laid out left to right inside it, then the top level is laid out top to bottom with
 * each expanded group at its resulting size. Nodes without edges are packed in rows below the
 * connected part instead of being strung along the first rank. Deterministic for a given input.
 *
 * Ranking follows structure, not edge direction: an edge from a less structural type to a more
 * structural one (a Decision deciding a Container, a Question concerning an Endpoint) is ranked
 * as if reversed, so systems and containers stay on top and annotations sit below what they are
 * about. Only the layout is affected; edges are still drawn in their true direction.
 */

export interface Size {
  width: number
  height: number
}

export interface Box extends Size {
  /** Top-left corner; relative to the parent group for nested nodes. */
  x: number
  y: number
}

export const NODE_SIZE = {
  object: { width: 232, height: 62 },
  group: { width: 280, height: 96 },
  cluster: { width: 256, height: 80 },
} as const satisfies Record<string, Size>

/** Space inside an expanded group: header height and padding around the members. */
export const GROUP_HEADER = 56
export const GROUP_PADDING = 20

interface Spacing {
  rankdir: 'TB' | 'LR'
  nodesep: number
  ranksep: number
}

const OUTER: Spacing = { rankdir: 'TB', nodesep: 40, ranksep: 84 }
const INNER: Spacing = { rankdir: 'LR', nodesep: 14, ranksep: 64 }

export interface LayoutResult {
  boxes: Map<string, Box>
  width: number
  height: number
}

export function collapsedSize(node: ProjectedNode): Size {
  return NODE_SIZE[node.kind]
}

export function layoutProjection(projection: Projection): LayoutResult {
  const boxes = new Map<string, Box>()
  const childrenOf = new Map<string, ProjectedNode[]>()
  const parentOf = new Map<string, string>()
  const rank = new Map<string, number>()
  for (const node of projection.nodes) {
    rank.set(node.id, structuralRank(node))
    if (node.parentId === undefined) continue
    parentOf.set(node.id, node.parentId)
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node)
    childrenOf.set(node.parentId, list)
  }

  // Inner layouts of expanded groups and clusters.
  const expandedSize = new Map<string, Size>()
  for (const [parentId, kids] of childrenOf) {
    const ids = new Set(kids.map((k) => k.id))
    const inner = projection.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ranked(e.source, e.target, e.type === 'contains' ? 2 : 1, rank))
    const block = layoutBlock(
      kids.map((k) => ({ id: k.id, ...collapsedSize(k) })),
      inner,
      INNER,
    )
    for (const kid of kids) {
      const p = block.positions.get(kid.id) as { x: number; y: number }
      boxes.set(kid.id, {
        x: p.x + GROUP_PADDING,
        y: p.y + GROUP_HEADER,
        ...collapsedSize(kid),
      })
    }
    expandedSize.set(parentId, {
      width: Math.max(block.width + GROUP_PADDING * 2, NODE_SIZE.group.width),
      height: block.height + GROUP_HEADER + GROUP_PADDING,
    })
  }

  // Top level, with edges lifted to the top-level ancestors of their endpoints.
  const top = projection.nodes.filter((n) => n.parentId === undefined)
  const topOf = (id: string) => parentOf.get(id) ?? id
  const outer = new Map<string, readonly [string, string, number]>()
  for (const e of projection.edges) {
    const s = topOf(e.source)
    const t = topOf(e.target)
    if (s === t) continue
    const [from, to, weight] = ranked(s, t, e.type === 'contains' ? 3 : 1, rank)
    const key = `${from}>${to}`
    const prev = outer.get(key)
    outer.set(key, [from, to, Math.max(weight, prev?.[2] ?? 0)])
  }
  const block = layoutBlock(
    top.map((n) => ({ id: n.id, ...(expandedSize.get(n.id) ?? collapsedSize(n)) })),
    [...outer.values()],
    OUTER,
  )
  for (const n of top) {
    const p = block.positions.get(n.id) as { x: number; y: number }
    boxes.set(n.id, { x: p.x, y: p.y, ...(expandedSize.get(n.id) ?? collapsedSize(n)) })
  }
  return { boxes, width: block.width, height: block.height }
}

/** Structural order of a node's type: System first, annotations such as Decisions later. */
function structuralRank(node: ProjectedNode): number {
  return objectTypeMeta(node.kind === 'cluster' ? node.type : node.object.type).rank
}

function ranked(
  source: string,
  target: string,
  weight: number,
  rank: ReadonlyMap<string, number>,
): readonly [string, string, number] {
  return (rank.get(source) ?? 0) > (rank.get(target) ?? 0)
    ? [target, source, weight]
    : [source, target, weight]
}

interface Item extends Size {
  id: string
}

/** Lays out one block: dagre for connected items, rows for isolated ones below them. */
export function layoutBlock(
  items: readonly Item[],
  edges: readonly (readonly [string, string, number])[],
  spacing: Spacing,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const positions = new Map<string, { x: number; y: number }>()
  const ids = new Set(items.map((i) => i.id))
  const usable = edges.filter(([s, t]) => s !== t && ids.has(s) && ids.has(t))
  const connected = new Set<string>()
  for (const [s, t] of usable) {
    connected.add(s)
    connected.add(t)
  }

  let width = 0
  let height = 0
  if (connected.size > 0) {
    const g = new Graph({ multigraph: false })
    g.setGraph({
      rankdir: spacing.rankdir,
      nodesep: spacing.nodesep,
      ranksep: spacing.ranksep,
      marginx: 0,
      marginy: 0,
    })
    g.setDefaultEdgeLabel(() => ({}))
    for (const item of items) {
      if (connected.has(item.id)) g.setNode(item.id, { width: item.width, height: item.height })
    }
    for (const [s, t, weight] of usable) g.setEdge(s, t, { weight, minlen: 1 })
    layout(g)
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    for (const item of items) {
      if (!connected.has(item.id)) continue
      const n = g.node(item.id) as { x: number; y: number }
      minX = Math.min(minX, n.x - item.width / 2)
      minY = Math.min(minY, n.y - item.height / 2)
    }
    for (const item of items) {
      if (!connected.has(item.id)) continue
      const n = g.node(item.id) as { x: number; y: number }
      const x = Math.round(n.x - item.width / 2 - minX)
      const y = Math.round(n.y - item.height / 2 - minY)
      positions.set(item.id, { x, y })
      width = Math.max(width, x + item.width)
      height = Math.max(height, y + item.height)
    }
  }

  const isolated = items.filter((i) => !connected.has(i.id))
  if (isolated.length > 0) {
    const gap = spacing.nodesep
    const widest = Math.max(...isolated.map((i) => i.width))
    const columns = Math.max(1, Math.ceil(Math.sqrt(isolated.length * 1.5)))
    const rowWidth = Math.max(width, columns * (widest + gap) - gap)
    let x = 0
    let y = height > 0 ? height + spacing.ranksep / 2 : 0
    let rowHeight = 0
    for (const item of isolated) {
      if (x > 0 && x + item.width > rowWidth) {
        x = 0
        y += rowHeight + gap
        rowHeight = 0
      }
      positions.set(item.id, { x, y })
      width = Math.max(width, x + item.width)
      rowHeight = Math.max(rowHeight, item.height)
      x += item.width + gap
    }
    height = y + rowHeight
  }
  return { positions, width, height }
}
