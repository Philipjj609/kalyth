import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  type InternalNode,
  Position,
  useInternalNode,
} from '@xyflow/react'
import { type CSSProperties, memo } from 'react'
import { basisMeta, relationMeta } from '../model/semantics.ts'
import { edgeAnchors, orthogonalRoute, type Rect, routedAnchors, type Side } from './geometry.ts'
import type { Route } from './layout.ts'

/**
 * One edge per (source, target, relation type, basis), drawn as an orthogonal drafting line.
 * Colour encodes the relation type and the dash pattern the claim basis: solid for observed,
 * dashed for inferred, and a cobalt annotation mark at the middle for stated (basis lens).
 * Aggregated edges show how many relations they carry.
 */
export interface RelationEdgeData extends Record<string, unknown> {
  relationType: string
  basis: string
  toBe: boolean
  count: number
  aggregated: boolean
  parallelIndex: number
  parallelCount: number
  dimmed: boolean
  /** Touches an alternative's direct change (impact lens). */
  hot: boolean
  /** Show the stated annotation mark (basis lens). */
  annotate: boolean
  /** Lanes from the layout, for an edge between two nodes of one block. */
  route: Route | undefined
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

/** Stroke colour of a relation type; the palette has a colour for `references` (ADR 0021) too. */
export const relationColor = (type: string) =>
  type === 'references' ? 'var(--k-rel-references)' : relationMeta(type).color

/** Marker ids for arrowheads, one per stroke colour, defined once by <EdgeMarkers>. */
export const markerId = (key: string) => `k-arrow-${key}`

const DASH: Record<string, string | undefined> = {
  observed: undefined,
  inferred: '6 4',
  stated: undefined,
  imported: '10 3 2 3',
}

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
  const sourceRect = rectOf(sourceNode)
  const targetRect = rectOf(targetNode)
  let path: string
  let labelX: number
  let labelY: number
  if (data.route) {
    const a = routedAnchors(
      sourceRect,
      targetRect,
      data.route.vertical,
      data.parallelIndex,
      data.parallelCount,
    )
    const offset = (data.parallelIndex - (data.parallelCount - 1) / 2) * 12
    const lanes = data.route.lanes.map((p) =>
      data.route?.vertical ? { x: p.x + offset, y: p.y } : { x: p.x, y: p.y + offset },
    )
    const routed = orthogonalRoute(
      { x: a.sx, y: a.sy },
      lanes,
      { x: a.tx, y: a.ty },
      data.route.vertical,
    )
    path = routed.path
    // Labels of parallel edges are staggered along the run, so they do not cover each other.
    const shift = (data.parallelIndex - (data.parallelCount - 1) / 2) * 20
    labelX = routed.label.x + (data.route.vertical ? 0 : shift)
    labelY = routed.label.y + (data.route.vertical ? shift : 0)
  } else {
    const a = edgeAnchors(sourceRect, targetRect, data.parallelIndex, data.parallelCount)
    ;[path, labelX, labelY] = getSmoothStepPath({
      sourceX: a.sx,
      sourceY: a.sy,
      sourcePosition: SIDE_TO_POSITION[a.sourceSide],
      targetX: a.tx,
      targetY: a.ty,
      targetPosition: SIDE_TO_POSITION[a.targetSide],
      borderRadius: 3,
      offset: 14,
    })
    const shift = (data.parallelIndex - (data.parallelCount - 1) / 2) * 20
    const vertical = a.sourceSide === 'top' || a.sourceSide === 'bottom'
    labelX += vertical ? 0 : shift
    labelY += vertical ? shift : 0
  }
  const color = data.hot ? 'var(--k-accent)' : relationColor(data.relationType)
  const dash = data.basis in DASH ? DASH[data.basis] : (basisMeta(data.basis).dash ?? undefined)
  const marker = data.hot ? 'hot' : data.relationType in KNOWN_MARKERS ? data.relationType : 'other'
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className="kalyth-edge-path"
        markerEnd={`url(#${markerId(marker)})`}
        interactionWidth={14}
        // Width and opacity go through CSS variables so the selected, hover and focus styles in
        // styles.css can override them.
        style={
          {
            stroke: color,
            '--edge-width': selected ? 2.6 : data.hot || data.aggregated ? 1.5 : 1.1,
            strokeDasharray: dash,
            strokeLinecap: 'butt',
            '--edge-opacity': data.dimmed ? 0.16 : 1,
          } as CSSProperties
        }
      />
      {!data.dimmed && (data.count > 1 || (data.annotate && data.basis === 'stated')) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.annotate && data.basis === 'stated' && (
              <span
                aria-hidden
                className="block size-[7px] rotate-45 border-[1.5px] border-accent bg-surface"
              />
            )}
            {data.count > 1 && (
              <span
                className="border bg-surface px-1 font-medium font-mono text-[10px] text-fg-muted leading-[14px]"
                style={{ borderColor: color }}
              >
                {data.count}
              </span>
            )}
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
  references: true,
  realizes: true,
  satisfies: true,
  constrains: true,
  decides: true,
  alternativeOf: true,
  concerns: true,
}

/** SVG arrowhead definitions coloured through CSS variables, so they follow the theme. */
export function EdgeMarkers() {
  const keys = [...Object.keys(KNOWN_MARKERS), 'other', 'hot']
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <defs>
        {keys.map((key) => (
          <marker
            key={key}
            id={markerId(key)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path
              d="M 0 0 L 10 5 L 0 10 z"
              style={{ fill: key === 'hot' ? 'var(--k-accent)' : relationColor(key) }}
            />
          </marker>
        ))}
      </defs>
    </svg>
  )
}

export const edgeTypes = { relation: RelationEdge }
