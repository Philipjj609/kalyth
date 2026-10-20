import { Graph, layout } from '@dagrejs/dagre'
import { objectTypeMeta } from '../model/semantics.ts'
import type { Point } from './geometry.ts'
import type { ProjectedNode, Projection } from './projection.ts'

/**
 * Layout for a projection, with dagre (MIT), bottom-up through the holder tree. Each open holder
 * lays out its children: endpoint rows in a column under the header, other members with dagre,
 * then takes the size it needs; its parent lays it out at that size. Nodes without edges are
 * packed in rows below the connected part instead of being strung along the first rank.
 * Deterministic for a given input.
 *
 * Each block is laid out top to bottom and left to right, and the one closer to a landscape
 * sheet (about 16:10) is kept, so wide ranks and long chains both stay readable. The lanes dagre
 * reserves for each edge are kept as routes, so an edge that spans several ranks runs beside the
 * nodes in between instead of behind them.
 *
 * Ranking follows structure, not edge direction: an edge from a less structural type to a more
 * structural one (a Constraint constraining a Container) is ranked as if reversed, so systems and
 * containers stay on top. Only the layout is affected; edges are still drawn in their true
 * direction.
 */

export interface Size {
  width: number
  height: number
}

export interface Box extends Size {
  /** Top-left corner; relative to the parent holder for nested nodes. */
  x: number
  y: number
}

/** The lanes of an edge between two siblings, in absolute canvas coordinates. */
export interface Route {
  /** One point per rank the edge crosses, from the first id of the key to the second. */
  lanes: Point[]
  /** True for a top-to-bottom block. */
  vertical: boolean
}

export const NODE_SIZE = {
  object: { width: 200, height: 54 },
  row: { width: 236, height: 24 },
  group: { width: 216, height: 60 },
  package: { width: 216, height: 56 },
  cluster: { width: 216, height: 56 },
} as const satisfies Record<string, Size>

/** Space inside an open holder: header height by kind, padding around the members. */
export const HOLDER_HEADER = { system: 50, holder: 50, module: 32 } as const
export const HOLDER_PADDING = 14
export const ROW_GAP = 4
/** Width over height that a block's layout aims for. */
export const TARGET_ASPECT = 1.6

interface Spacing {
  nodesep: number
  ranksep: number
}

const OUTER: Spacing = { nodesep: 36, ranksep: 64 }
const INNER: Spacing = { nodesep: 20, ranksep: 52 }

export interface LayoutResult {
  boxes: Map<string, Box>
  /** Routes keyed by `${a}>${b}`; look them up with `routeBetween`. */
  routes: Map<string, Route>
  width: number
  height: number
}

export function collapsedSize(node: ProjectedNode): Size {
  if (node.kind === 'object') return node.row ? NODE_SIZE.row : NODE_SIZE.object
  return NODE_SIZE[node.kind]
}

export function headerHeight(node: ProjectedNode): number {
  if (node.kind !== 'group') return HOLDER_HEADER.module
  if (node.object.type === 'software.System') return HOLDER_HEADER.system
  if (node.object.type === 'software.Module') return HOLDER_HEADER.module
  return HOLDER_HEADER.holder
}

/** The route of an edge between two siblings, oriented from `source` to `target`. */
export function routeBetween(
  routes: ReadonlyMap<string, Route>,
  source: string,
  target: string,
): Route | undefined {
  const forward = routes.get(`${source}>${target}`)
  if (forward) return forward
  const back = routes.get(`${target}>${source}`)
  return back ? { lanes: [...back.lanes].reverse(), vertical: back.vertical } : undefined
}

interface LevelRoute {
  key: string
  lanes: Point[]
  vertical: boolean
}

export function layoutProjection(projection: Projection): LayoutResult {
  const boxes = new Map<string, Box>()
  const byId = new Map(projection.nodes.map((n) => [n.id, n]))
  const childrenOf = new Map<string | undefined, ProjectedNode[]>()
  const rank = new Map<string, number>()
  for (const node of projection.nodes) {
    rank.set(node.id, structuralRank(node))
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node)
    childrenOf.set(node.parentId, list)
  }
  /** The ancestor of `id` (or `id` itself) whose parent is `parent`. */
  const lift = (id: string, parent: string | undefined): string | undefined => {
    let current = byId.get(id)
    while (current && current.parentId !== parent) {
      current = current.parentId === undefined ? undefined : byId.get(current.parentId)
    }
    return current?.id
  }

  const sizes = new Map<string, Size>()
  const sizeOf = (n: ProjectedNode) => sizes.get(n.id) ?? collapsedSize(n)
  /** Routes per level, relative to the level's parent box (the canvas for the top level). */
  const levelRoutes = new Map<string | undefined, LevelRoute[]>()

  const layoutLevel = (parent: string | undefined, spacing: Spacing, dx: number, dy: number) => {
    const kids = childrenOf.get(parent) ?? []
    const rows = kids.filter((k) => k.kind === 'object' && k.row)
    const others = kids.filter((k) => !(k.kind === 'object' && k.row))
    const ids = new Set(others.map((k) => k.id))
    const lifted = new Map<string, readonly [string, string, number]>()
    for (const e of projection.edges) {
      const s = lift(e.source, parent)
      const t = lift(e.target, parent)
      if (s === undefined || t === undefined || s === t || !ids.has(s) || !ids.has(t)) continue
      const [from, to, weight] = ranked(s, t, e.type === 'contains' ? 3 : 1, rank)
      const key = `${from}>${to}`
      const prev = lifted.get(key)
      lifted.set(key, [from, to, Math.max(weight, prev?.[2] ?? 0)])
    }
    const block = layoutBest(
      others.map((k) => ({ id: k.id, ...sizeOf(k) })),
      [...lifted.values()],
      spacing,
    )
    let y = 0
    let width = block.width
    for (const row of rows) {
      boxes.set(row.id, { x: dx, y: y + dy, ...NODE_SIZE.row })
      y += NODE_SIZE.row.height + ROW_GAP
      width = Math.max(width, NODE_SIZE.row.width)
    }
    const top = rows.length > 0 && others.length > 0 ? y + ROW_GAP * 2 : y
    for (const k of others) {
      const p = block.positions.get(k.id) as Point
      boxes.set(k.id, { x: p.x + dx, y: p.y + top + dy, ...sizeOf(k) })
    }
    levelRoutes.set(
      parent,
      [...block.routes].map(([key, lanes]) => ({
        key,
        lanes: lanes.map((p) => ({ x: p.x + dx, y: p.y + top + dy })),
        vertical: block.rankdir === 'TB',
      })),
    )
    const height = others.length > 0 ? top + block.height : Math.max(0, y - ROW_GAP)
    return { width, height }
  }

  // Deepest open holders first, so each parent knows its children's sizes.
  const open = projection.nodes
    .filter((n) => n.kind !== 'object' && n.expanded && (childrenOf.get(n.id)?.length ?? 0) > 0)
    .sort((a, b) => b.depth - a.depth)
  for (const holder of open) {
    const header = headerHeight(holder)
    const inner = layoutLevel(holder.id, INNER, HOLDER_PADDING, header)
    const minWidth = collapsedSize(holder).width
    sizes.set(holder.id, {
      width: Math.max(inner.width + HOLDER_PADDING * 2, minWidth),
      height: inner.height + header + HOLDER_PADDING,
    })
  }
  // Rows fill their holder's inner width.
  for (const node of projection.nodes) {
    if (node.kind !== 'object' || !node.row || node.parentId === undefined) continue
    const parent = sizes.get(node.parentId)
    const box = boxes.get(node.id)
    if (parent && box) box.width = parent.width - HOLDER_PADDING * 2
  }
  const outer = layoutLevel(undefined, OUTER, 0, 0)
  for (const node of projection.nodes) {
    const box = boxes.get(node.id)
    const size = sizes.get(node.id)
    if (box && size) {
      box.width = size.width
      box.height = size.height
    }
  }

  // Routes in absolute coordinates: each level is offset by its parent's absolute position.
  const absolute = new Map<string, Point>()
  const absOf = (id: string | undefined): Point => {
    if (id === undefined) return { x: 0, y: 0 }
    const cached = absolute.get(id)
    if (cached) return cached
    const box = boxes.get(id)
    const parent = absOf(byId.get(id)?.parentId)
    const p = { x: parent.x + (box?.x ?? 0), y: parent.y + (box?.y ?? 0) }
    absolute.set(id, p)
    return p
  }
  const routes = new Map<string, Route>()
  for (const [parent, list] of levelRoutes) {
    const origin = absOf(parent)
    for (const r of list) {
      routes.set(r.key, {
        lanes: r.lanes.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })),
        vertical: r.vertical,
      })
    }
  }
  return { boxes, routes, width: outer.width, height: outer.height }
}

/** Structural order of a node's type: System first, annotations such as Constraints later. */
function structuralRank(node: ProjectedNode): number {
  if (node.kind === 'package') return objectTypeMeta('software.Module').rank
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

export interface Block {
  positions: Map<string, Point>
  /** Lanes of each edge `${source}>${target}`, relative to the block. */
  routes: Map<string, Point[]>
  rankdir: 'TB' | 'LR'
  width: number
  height: number
}

/** Lays a block out both ways and keeps the one closer to a landscape sheet. */
export function layoutBest(
  items: readonly Item[],
  edges: readonly (readonly [string, string, number])[],
  spacing: Spacing,
): Block {
  const tb = layoutBlock(items, edges, { ...spacing, rankdir: 'TB' })
  if (edges.length === 0 || items.length < 3) return tb
  const lr = layoutBlock(items, edges, { ...spacing, rankdir: 'LR' })
  const miss = (b: Block) => Math.abs(Math.log((b.width || 1) / (b.height || 1) / TARGET_ASPECT))
  return miss(lr) + 0.15 < miss(tb) ? lr : tb
}

/** Lays out one block: dagre for connected items, rows for isolated ones below them. */
export function layoutBlock(
  items: readonly Item[],
  edges: readonly (readonly [string, string, number])[],
  spacing: Spacing & { rankdir: 'TB' | 'LR' },
): Block {
  const positions = new Map<string, Point>()
  const routes = new Map<string, Point[]>()
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
      edgesep: 12,
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
      const n = g.node(item.id) as Point
      minX = Math.min(minX, n.x - item.width / 2)
      minY = Math.min(minY, n.y - item.height / 2)
    }
    for (const item of items) {
      if (!connected.has(item.id)) continue
      const n = g.node(item.id) as Point
      const x = Math.round(n.x - item.width / 2 - minX)
      const y = Math.round(n.y - item.height / 2 - minY)
      positions.set(item.id, { x, y })
      width = Math.max(width, x + item.width)
      height = Math.max(height, y + item.height)
    }
    for (const [s, t] of usable) {
      const points = (g.edge(s, t) as { points?: Point[] } | undefined)?.points ?? []
      routes.set(
        `${s}>${t}`,
        points.slice(1, -1).map((p) => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) })),
      )
    }
  }

  const isolated = items.filter((i) => !connected.has(i.id))
  if (isolated.length > 0) {
    const packed = packIsolated(isolated, spacing.nodesep, width)
    const top = height > 0 ? height + spacing.ranksep / 2 : 0
    for (const [id, p] of packed.positions) positions.set(id, { x: p.x, y: p.y + top })
    width = Math.max(width, packed.width)
    height = top + packed.height
  }
  return { positions, routes, rankdir: spacing.rankdir, width, height }
}

/**
 * Packs unconnected items. Large ones (open frames, at least four times the median area) stand
 * side by side; the small ones form a grid beside them, as tall as the large ones, or a grid near
 * the landscape ratio (and at least `minWidth` wide) when there are no large ones.
 */
export function packIsolated(
  items: readonly Item[],
  gap: number,
  minWidth = 0,
): { positions: Map<string, Point>; width: number; height: number } {
  const positions = new Map<string, Point>()
  const areas = items.map((i) => i.width * i.height).sort((a, b) => a - b)
  const median = areas[Math.floor(areas.length / 2)] ?? 0
  const isLarge = (i: Item) => i.width * i.height > median * 4
  const large = items.filter(isLarge)
  const small = items.filter((i) => !isLarge(i))
  let x = 0
  let largeHeight = 0
  for (const item of large) {
    positions.set(item.id, { x, y: 0 })
    x += item.width + gap
    largeHeight = Math.max(largeHeight, item.height)
  }
  let width = Math.max(0, x - gap)
  let height = largeHeight
  if (small.length > 0) {
    const widest = Math.max(...small.map((i) => i.width))
    const tallest = Math.max(...small.map((i) => i.height))
    const columns =
      large.length > 0
        ? Math.ceil(small.length / Math.max(1, Math.floor((largeHeight + gap) / (tallest + gap))))
        : Math.max(
            1,
            Math.round(
              Math.sqrt((small.length * TARGET_ASPECT * (tallest + gap)) / (widest + gap)),
            ),
            Math.min(small.length, Math.floor((minWidth + gap) / (widest + gap))),
          )
    const left = large.length > 0 ? x : 0
    small.forEach((item, i) => {
      const col = i % columns
      const row = Math.floor(i / columns)
      const p = { x: left + col * (widest + gap), y: row * (tallest + gap) }
      positions.set(item.id, p)
      width = Math.max(width, p.x + item.width)
      height = Math.max(height, p.y + item.height)
    })
  }
  return { positions, width, height }
}
