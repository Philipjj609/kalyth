import { Graph, layout } from '@dagrejs/dagre'
import type { TaskStatus, TaskView } from '@kalyth/contracts'

/**
 * The task graph (Tier B): tasks with what they require and what they implement. Prerequisites sit
 * above the tasks that wait for them, and the decisions, alternatives and requirements a task
 * carries out sit above it, so work reads top to bottom in the order it can happen.
 */

export interface TaskGraphNode {
  id: string
  kind: 'task' | 'target'
  label: string
  /** Record type: core.Task for tasks, the target's type otherwise. */
  type: string
  status?: TaskStatus
  leaseExpired?: boolean
}

export interface TaskGraphEdge {
  id: string
  kind: 'requires' | 'implements'
  /** Drawn from the prerequisite or target down to the task. */
  source: string
  target: string
  /** For requires: whether the prerequisite is done (completed task, accepted decision). */
  satisfied: boolean
}

export interface TaskGraphModel {
  nodes: TaskGraphNode[]
  edges: TaskGraphEdge[]
}

export function taskGraphModel(tasks: readonly TaskView[]): TaskGraphModel {
  const nodes = new Map<string, TaskGraphNode>()
  for (const t of tasks) {
    nodes.set(t.id, {
      id: t.id,
      kind: 'task',
      label: t.title,
      type: 'core.Task',
      status: t.status,
      leaseExpired: t.leaseExpired,
    })
  }
  const edges: TaskGraphEdge[] = []
  for (const t of tasks) {
    for (const r of t.requires) {
      if (!nodes.has(r.id))
        nodes.set(r.id, { id: r.id, kind: 'target', label: r.label, type: r.type })
      edges.push({
        id: `requires:${t.id}:${r.id}`,
        kind: 'requires',
        source: r.id,
        target: t.id,
        satisfied: r.satisfied,
      })
    }
    for (const i of t.implements) {
      if (!nodes.has(i.id))
        nodes.set(i.id, { id: i.id, kind: 'target', label: i.label, type: i.type })
      edges.push({
        id: `implements:${t.id}:${i.id}`,
        kind: 'implements',
        source: i.id,
        target: t.id,
        satisfied: true,
      })
    }
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return { nodes: [...nodes.values()].sort(byId), edges: edges.sort(byId) }
}

export const TASK_NODE_SIZE = { width: 240, height: 64 } as const
export const TARGET_NODE_SIZE = { width: 220, height: 48 } as const

export interface PositionedNode extends TaskGraphNode {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/**
 * Top-left positions from dagre, deterministic for a given model, and each edge's route: the
 * points dagre chose so that long edges pass between nodes rather than behind them.
 */
export function layoutTaskGraph(model: TaskGraphModel): {
  nodes: PositionedNode[]
  routes: Map<string, Point[]>
  width: number
  height: number
} {
  const g = new Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 64, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  const size = (n: TaskGraphNode) => (n.kind === 'task' ? TASK_NODE_SIZE : TARGET_NODE_SIZE)
  for (const n of model.nodes) g.setNode(n.id, { ...size(n) })
  for (const e of model.edges) g.setEdge(e.source, e.target)
  layout(g)
  const nodes = model.nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number }
    const { width, height } = size(n)
    return { ...n, width, height, x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2) }
  })
  const routes = new Map<string, Point[]>()
  for (const e of model.edges) {
    const points = (g.edge(e.source, e.target) as { points?: Point[] } | undefined)?.points ?? []
    routes.set(
      e.id,
      points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    )
  }
  const graph = g.graph() as { width?: number; height?: number }
  return { nodes, routes, width: graph.width ?? 0, height: graph.height ?? 0 }
}

/** An SVG path through a route, with the corners rounded. */
export function routePath(points: readonly Point[], radius = 10): string {
  const [first, ...rest] = points
  if (!first) return ''
  if (rest.length === 0) return `M ${first.x} ${first.y}`
  let d = `M ${first.x} ${first.y}`
  for (let i = 0; i < rest.length; i++) {
    const at = rest[i] as Point
    const next = rest[i + 1]
    if (!next) {
      d += ` L ${at.x} ${at.y}`
      break
    }
    const prev = (i === 0 ? first : rest[i - 1]) as Point
    const into = Math.min(radius, Math.hypot(at.x - prev.x, at.y - prev.y) / 2)
    const out = Math.min(radius, Math.hypot(next.x - at.x, next.y - at.y) / 2)
    const a = toward(at, prev, into)
    const b = toward(at, next, out)
    d += ` L ${a.x} ${a.y} Q ${at.x} ${at.y} ${b.x} ${b.y}`
  }
  return d
}

function toward(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const k = distance / length
  return {
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
  }
}
