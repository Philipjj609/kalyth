import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  type InternalNode,
  Position,
  useInternalNode,
} from '@xyflow/react'
import { memo } from 'react'
import { basisMeta, relationMeta } from '../model/semantics.ts'
import { edgeAnchors, type Rect, type Side } from './geometry.ts'

/**
 * One edge per (source, target, relation type, basis). Colour encodes the relation type; the dash
 * pattern encodes the basis (see the legend). Aggregated edges show how many relations they carry.
 */
export interface RelationEdgeData extends Record<string, unknown> {
  relationType: string
  basis: string
  count: number
  aggregated: boolean
  parallelIndex: number
  parallelCount: number
  dimmed: boolean
}

export type RelationFlowEdge = Edge<RelationEdgeData, 'relation'>

const SIDE_TO_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

function rectOf(node: InternalNode): Rect {
  const { x, y } = node.internals.positionAbsolute
  return {
    x,
    y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  }
}

/** Marker ids for arrowheads, one per stroke colour, defined once by <EdgeMarkers>. */
export const markerId = (relationType: string) => `k-arrow-${relationType}`

export const RelationEdge = memo(function RelationEdge({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<RelationFlowEdge>) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  if (!sourceNode || !targetNode || !data) return null
  const a = edgeAnchors(
    rectOf(sourceNode),
    rectOf(targetNode),
    data.parallelIndex,
    data.parallelCount,
  )
  const [path, labelX, labelY] = getBezierPath({
    sourceX: a.sx,
    sourceY: a.sy,
    sourcePosition: SIDE_TO_POSITION[a.sourceSide],
    targetX: a.tx,
    targetY: a.ty,
    targetPosition: SIDE_TO_POSITION[a.targetSide],
    curvature: 0.3,
  })
  const color = relationMeta(data.relationType).color
  const dash = basisMeta(data.basis).dash
  const known = data.relationType in KNOWN_MARKERS
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className="kalyth-edge-path"
        markerEnd={`url(#${markerId(known ? data.relationType : 'other')})`}
        interactionWidth={16}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : data.aggregated ? 2 : 1.6,
          strokeDasharray: dash,
          strokeLinecap: 'round',
          opacity: data.dimmed ? 0.18 : 1,
        }}
      />
      {data.count > 1 && !data.dimmed && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full border bg-surface px-1.5 font-medium font-mono text-[10px] text-fg-muted leading-4 shadow-panel"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
            }}
          >
            {data.count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const KNOWN_MARKERS: Record<string, true> = {
  contains: true,
  dependsOn: true,
  exposes: true,
  reads: true,
  writes: true,
  realizes: true,
  satisfies: true,
  constrains: true,
  decides: true,
  alternativeOf: true,
  concerns: true,
}

/** SVG arrowhead definitions coloured through CSS variables, so they follow the theme. */
export function EdgeMarkers() {
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <defs>
        {[...Object.keys(KNOWN_MARKERS), 'other'].map((type) => (
          <marker
            key={type}
            id={markerId(type)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: relationMeta(type).color }} />
          </marker>
        ))}
      </defs>
    </svg>
  )
}

export const edgeTypes = { relation: RelationEdge }
