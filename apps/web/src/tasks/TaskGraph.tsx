import '@xyflow/react/dist/base.css'
import type { TaskView } from '@kalyth/contracts'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import { TriangleAlert } from 'lucide-react'
import { memo, useMemo } from 'react'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { TaskStatusBadge } from '../components/badges.tsx'
import { typeIcon } from '../components/icons.tsx'
import { cn } from '../lib/cn.ts'
import { objectTypeMeta } from '../model/semantics.ts'
import {
  layoutTaskGraph,
  type Point,
  routePath,
  type TaskGraphNode,
  taskGraphModel,
} from '../model/taskGraph.ts'

/**
 * The task graph (Tier B): each task below what it requires and what it implements. Solid lines
 * are requirements already met, dashed amber lines requirements still open, dotted lines what a
 * task implements. Choosing a task opens it; choosing anything else inspects the record.
 */

type GraphNodeData = TaskGraphNode &
  Record<string, unknown> & { selected: boolean; description: string; onOpen: () => void }
type GraphNode = Node<GraphNodeData, 'task' | 'target'>

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

const TaskNode = memo(function TaskNode({ data }: NodeProps<GraphNode>) {
  return (
    <button
      type="button"
      onClick={data.onOpen}
      aria-label={data.description}
      aria-current={data.selected ? 'true' : undefined}
      className={cn(
        'flex h-16 w-60 flex-col justify-center gap-1 rounded-[10px] border bg-surface px-3 text-left shadow-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2',
        data.selected ? 'border-accent ring-2 ring-accent/40' : 'border-border-strong',
      )}
    >
      <Handles />
      <div className="flex items-center gap-1.5">
        {data.status && <TaskStatusBadge status={data.status} size="sm" />}
        {data.leaseExpired && (
          <span className="tone-warning inline-flex items-center gap-0.5 text-[10px] text-tone-fg">
            <TriangleAlert aria-hidden className="size-3" />
            lease expired
          </span>
        )}
      </div>
      <p className="truncate font-medium text-sm" title={data.label}>
        {data.label}
      </p>
    </button>
  )
})

const TargetNode = memo(function TargetNode({ data }: NodeProps<GraphNode>) {
  const Icon = typeIcon(data.type)
  return (
    <button
      type="button"
      onClick={data.onOpen}
      aria-label={data.description}
      className="flex h-12 w-[220px] items-center gap-2 rounded-[10px] border border-border border-dashed bg-surface-2 px-3 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"
    >
      <Handles />
      <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0">
        <p className="text-[10px] text-fg-subtle uppercase tracking-wide">
          {data.type === 'core.Task' ? 'Task (not listed)' : objectTypeMeta(data.type).label}
        </p>
        <p className="truncate text-sm" title={data.label}>
          {data.label}
        </p>
      </div>
    </button>
  )
})

const nodeTypes = { task: TaskNode, target: TargetNode }

type RoutedEdge = Edge<{ points: Point[] }, 'routed'>

/** Follows dagre's route, so long edges pass between nodes, not behind them. */
function Routed({
  data,
  style,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<RoutedEdge>) {
  const points = data?.points?.length
    ? data.points
    : [
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
      ]
  return (
    <BaseEdge
      path={routePath(points)}
      {...(style ? { style } : {})}
      {...(markerEnd ? { markerEnd } : {})}
    />
  )
}

const edgeTypes = { routed: Routed }

const EDGE_STYLE = {
  met: { stroke: 'var(--k-border-strong)', strokeWidth: 1.6 },
  open: { stroke: 'var(--k-tone-warning-fg)', strokeWidth: 1.8, strokeDasharray: '6 4' },
  implements: { stroke: 'var(--k-fg-muted)', strokeWidth: 1.2, strokeDasharray: '2 4' },
}

export default function TaskGraph({ tasks }: { tasks: readonly TaskView[] }) {
  return (
    <ReactFlowProvider>
      <Canvas tasks={tasks} />
    </ReactFlowProvider>
  )
}

function Canvas({ tasks }: { tasks: readonly TaskView[] }) {
  const [loc, navigate] = useAppLocation()
  const wb = useWorkbench()
  const model = useMemo(() => taskGraphModel(tasks), [tasks])
  const laidOut = useMemo(() => layoutTaskGraph(model), [model])
  const labels = useMemo(() => new Map(model.nodes.map((n) => [n.id, n.label])), [model])
  const listed = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks])

  const nodes = useMemo<GraphNode[]>(() => {
    const describe = (n: TaskGraphNode) =>
      n.kind === 'task' && listed.has(n.id)
        ? `Task ${n.label}, ${n.status}. Open the task.`
        : `${n.type === 'core.Task' ? 'Task' : objectTypeMeta(n.type).label} ${n.label}. Inspect the record.`
    return laidOut.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      // Nodes are neither draggable nor selectable, so React Flow would turn their pointer
      // events off; the button inside each node needs them.
      style: { pointerEvents: 'all' as const },
      data: {
        ...n,
        selected: n.id === loc.task,
        description: describe(n),
        onOpen: () => {
          if (n.kind === 'task' && listed.has(n.id)) navigate({ task: n.id })
          else wb.select(n.id)
        },
      },
    }))
  }, [laidOut, loc.task, listed, navigate, wb.select])
  const edges = useMemo<RoutedEdge[]>(
    () =>
      model.edges.map((e) => {
        const style =
          e.kind === 'implements'
            ? EDGE_STYLE.implements
            : e.satisfied
              ? EDGE_STYLE.met
              : EDGE_STYLE.open
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'routed' as const,
          data: { points: laidOut.routes.get(e.id) ?? [] },
          style,
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
          ariaLabel:
            e.kind === 'implements'
              ? `${labels.get(e.target)} implements ${labels.get(e.source)}`
              : `${labels.get(e.target)} requires ${labels.get(e.source)}, ${e.satisfied ? 'met' : 'still open'}`,
        }
      }),
    [model, labels, laidOut],
  )

  if (model.nodes.length === 0) {
    return <p className="p-6 text-fg-muted text-sm">No tasks to draw yet.</p>
  }
  return (
    <div
      className="relative h-[min(70vh,640px)] overflow-hidden rounded-lg border border-border"
      style={{ minHeight: Math.min(640, laidOut.height + 80) }}
    >
      <ReactFlow<GraphNode, RoutedEdge>
        className="kalyth-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
        attributionPosition="bottom-center"
        aria-label="Task graph"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="var(--k-canvas-dot)"
        />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <TaskGraphLegend />
    </div>
  )
}

function TaskGraphLegend() {
  const line = (style: (typeof EDGE_STYLE)[keyof typeof EDGE_STYLE]) => (
    <svg aria-hidden width="28" height="8" className="shrink-0">
      <line x1="0" y1="4" x2="28" y2="4" {...style} />
    </svg>
  )
  return (
    <div className="absolute top-2 right-2 space-y-1 rounded-md border border-border bg-surface/95 px-2.5 py-2 text-fg-muted text-xs shadow-sm">
      <p className="flex items-center gap-2">{line(EDGE_STYLE.met)} requirement met</p>
      <p className="flex items-center gap-2">{line(EDGE_STYLE.open)} requirement still open</p>
      <p className="flex items-center gap-2">{line(EDGE_STYLE.implements)} implements</p>
    </div>
  )
}
