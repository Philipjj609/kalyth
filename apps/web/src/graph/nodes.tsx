import type { ObjectVersion } from '@kalyth/contracts'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type CSSProperties, memo, type ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import { objectDetail, objectShortLabel } from '../model/labels.ts'
import { objectTypeMeta } from '../model/semantics.ts'

/**
 * Canvas nodes in the Drafting Table language (ADR 0020): ink outlines on the sheet colour, a
 * small mono type tag and a readable label. Endpoints are compact rows with their method, open
 * holders are frames with a mono title, collapsed holders are stacked sheets with member counts.
 * Lens marks sit on the outline: a cobalt tint and numbered balloons for an alternative's direct
 * changes, a vermilion tint and revision triangle for claims that need review, a cobalt flag for
 * decisions, and line style for claim basis. Every mark is also in the node's accessible name.
 */

export interface NodeMarks {
  dimmed: boolean
  /** To-be (proposed) element: drawn as a dashed draft. */
  draft: boolean
  /** Claim basis, drawn as line style in the basis lens only. */
  basis?: string | undefined
  /** Numbers of an alternative's direct changes this node stands for. */
  changes?: readonly number[] | undefined
  /** Reached only through propagated impact. */
  reached?: boolean | undefined
  /** Claims that need review. */
  revisions?: number | undefined
  /** Decisions (D1, D2...) that change what it stands for. */
  decisions?: readonly string[] | undefined
  /** True while the selection is one of this node's hidden members. */
  holdsSelection: boolean
}

export interface ObjectNodeData extends Record<string, unknown> {
  object: ObjectVersion
  row: boolean
  /** Shared path prefix left out of endpoint rows (shown on the module frame). */
  pathPrefix: string
  marks: NodeMarks
}

export interface HolderNodeData extends Record<string, unknown> {
  holder: 'group' | 'package' | 'cluster'
  /** The holding object, for groups. */
  object?: ObjectVersion
  tag: string
  title: string
  /** Member summary, e.g. "44 modules · 23 endpoints". */
  summary: string
  memberTotal: number
  expanded: boolean
  /** System frames are drawn as a light boundary. */
  boundary: boolean
  marks: NodeMarks
  onToggle: (id: string) => void
}

export type ObjectFlowNode = Node<ObjectNodeData, 'object'>
export type HolderFlowNode = Node<HolderNodeData, 'holder'>

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

/** Outline and fill for a node's lens state; open frames get no fill. */
function outline(marks: NodeMarks, selected: boolean, frame = false): CSSProperties {
  let borderColor = 'var(--k-fg)'
  let borderStyle: CSSProperties['borderStyle'] = 'solid'
  let borderWidth = 1
  let background: string | undefined = frame ? 'transparent' : 'var(--k-surface)'
  if (marks.basis === 'inferred') {
    borderStyle = 'dashed'
    borderColor = 'var(--k-tone-inferred-bd)'
    borderWidth = 1.5
  } else if (marks.basis === 'imported') {
    borderStyle = 'double'
    borderWidth = 3
  }
  if (marks.draft) {
    borderStyle = 'dashed'
    borderWidth = 1.5
    borderColor = 'var(--k-fg-subtle)'
    if (!frame) background = 'color-mix(in oklab, var(--k-surface) 70%, transparent)'
  }
  if (marks.changes?.length) {
    borderColor = 'var(--k-accent)'
    borderWidth = 1.5
    if (!frame)
      background = 'linear-gradient(var(--k-impact-soft), var(--k-impact-soft)), var(--k-surface)'
  } else if (marks.reached) {
    borderColor = 'var(--k-accent)'
    borderWidth = 1
  }
  if (marks.revisions) {
    borderColor = 'var(--k-revision)'
    borderWidth = 1.5
    if (!frame)
      background =
        'linear-gradient(var(--k-revision-soft), var(--k-revision-soft)), var(--k-surface)'
  }
  if (marks.decisions?.length) {
    borderColor = 'var(--k-accent)'
    borderWidth = 1.5
  }
  if (marks.dimmed) {
    borderColor = 'var(--k-border-strong)'
    borderWidth = 1
    if (!frame) background = 'var(--k-surface-2)'
  }
  const style: CSSProperties = { borderColor, borderStyle, borderWidth }
  if (background !== undefined) style.background = background
  if (selected || marks.holdsSelection) {
    style.outline = `2px solid var(--k-accent)`
    style.outlineOffset = 3
  }
  return style
}

/** The lens marks drawn outside the outline: balloons, revision triangle, decision flag. */
function Marks({ marks, compact }: { marks: NodeMarks; compact?: boolean }) {
  if (marks.dimmed) return null
  const changes = marks.changes ?? []
  return (
    <>
      {changes.length > 0 && (
        <span
          aria-hidden
          className={cn(
            'absolute flex h-5 min-w-5 items-center justify-center rounded-full border-[1.5px] border-accent bg-surface px-1 font-mono font-semibold text-[10px] text-accent leading-none',
            compact ? '-top-2.5 -right-2.5' : '-top-2.5 -right-2.5',
          )}
        >
          {changes.length > 3 ? `${changes.length}×` : changes.join('·')}
        </span>
      )}
      {marks.revisions !== undefined && marks.revisions > 0 && (
        <span aria-hidden className="absolute -top-4 -right-3.5 h-[26px] w-[30px]">
          <svg aria-hidden width="30" height="26" viewBox="0 0 30 26" className="absolute inset-0">
            <path
              d="M15 1.5 L28.5 24.5 L1.5 24.5 Z"
              style={{ fill: 'var(--k-surface)', stroke: 'var(--k-revision)', strokeWidth: 1.5 }}
            />
          </svg>
          <span className="absolute inset-x-0 top-[11px] text-center font-mono font-bold text-[10px] text-revision leading-3">
            {marks.revisions}
          </span>
        </span>
      )}
      {marks.decisions && marks.decisions.length > 0 && (
        <span
          aria-hidden
          className="absolute -top-2 -right-2 border border-surface bg-accent px-1 font-mono font-semibold text-[9px] text-accent-fg leading-[14px] tracking-[0.05em]"
        >
          {marks.decisions.join(' ')}
        </span>
      )}
      {marks.basis === 'stated' && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 -left-[5px] w-[5px] border-accent border-y-2 border-l-2"
        />
      )}
    </>
  )
}

function TypeTag({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        'block truncate font-mono text-[9.5px] uppercase leading-[13px] tracking-[0.07em]',
        accent ? 'text-accent' : 'text-fg-subtle',
      )}
    >
      {children}
    </span>
  )
}

const typeTag = (object: ObjectVersion) => objectTypeMeta(object.type).label

export const ObjectNode = memo(function ObjectNode({ data, selected }: NodeProps<ObjectFlowNode>) {
  const { object, marks } = data
  const draftAccent = marks.draft && Boolean(marks.changes?.length)
  if (data.row) {
    const a = object.attributes as Record<string, unknown>
    const method = typeof a.method === 'string' ? a.method : ''
    const path = typeof a.path === 'string' ? a.path : ''
    const shown =
      data.pathPrefix && path.startsWith(data.pathPrefix) && path.length > data.pathPrefix.length
        ? path.slice(data.pathPrefix.length)
        : path
    return (
      <div
        className={cn(
          'relative flex h-full w-full items-center gap-2 px-2 font-mono text-[11.5px] leading-none',
          marks.dimmed ? 'text-fg-subtle' : 'text-fg',
        )}
        style={outline(marks, selected)}
        title={`${method} ${path}`}
      >
        <Handles />
        <span className="w-12 shrink-0 font-semibold text-[10px] tracking-[0.04em]">{method}</span>
        <span className="min-w-0 truncate">{shown}</span>
        {marks.draft && (
          <span
            className={cn(
              'ml-auto shrink-0 text-[9px] uppercase tracking-[0.07em]',
              draftAccent ? 'text-accent' : 'text-fg-subtle',
            )}
          >
            proposed
          </span>
        )}
        <Marks marks={marks} compact />
      </div>
    )
  }
  const { label, context } = objectShortLabel(object)
  const detail = context ?? objectDetail(object)
  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col justify-center px-2 py-[3px] text-left',
        marks.dimmed ? 'text-fg-subtle' : 'text-fg',
      )}
      style={outline(marks, selected)}
    >
      <Handles />
      <TypeTag accent={draftAccent}>
        {marks.draft ? `Proposed · ${typeTag(object)}` : typeTag(object)}
      </TypeTag>
      <span className="block truncate font-medium text-[13px] leading-[19px]" title={label}>
        {label}
      </span>
      {detail && (
        <span
          className={cn(
            'block truncate text-[11px] leading-[15px]',
            draftAccent ? 'text-accent' : 'text-fg-subtle',
            context && 'font-mono text-[10.5px]',
          )}
        >
          {detail}
        </span>
      )}
      <Marks marks={marks} />
    </div>
  )
})

/** Groups, packages and clusters: a frame when open, a stack of sheets when collapsed. */
export const HolderNode = memo(function HolderNode({
  id,
  data,
  selected,
}: NodeProps<HolderFlowNode>) {
  const { marks } = data
  const Chevron = data.expanded ? ChevronDown : ChevronRight
  const toggleLabel = `${data.expanded ? 'Collapse' : 'Expand'} ${data.title} (${data.memberTotal} ${data.memberTotal === 1 ? 'member' : 'members'})`
  const toggle = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        data.onToggle(id)
      }}
      onKeyDown={(e) => e.stopPropagation()}
      aria-expanded={data.expanded}
      aria-label={toggleLabel}
      title={toggleLabel}
      className="nodrag nopan inline-flex size-6 shrink-0 items-center justify-center border border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg"
    >
      <Chevron aria-hidden className="size-3.5" />
    </button>
  )
  if (data.expanded) {
    const style = outline(marks, selected, true)
    if (!marks.changes?.length && !marks.revisions && !marks.decisions?.length && !marks.draft) {
      style.borderColor = data.boundary ? 'var(--k-border-strong)' : 'var(--k-fg-subtle)'
    }
    return (
      <div
        className={cn(
          'relative h-full w-full',
          data.boundary
            ? 'bg-transparent'
            : 'bg-[color-mix(in_oklab,var(--k-surface)_45%,transparent)]',
        )}
        style={style}
      >
        <Handles />
        <div className="flex items-start gap-2 px-2.5 pt-1.5">
          <div className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate font-mono font-semibold leading-[17px]',
                data.boundary
                  ? 'text-[11px] uppercase tracking-[0.08em]'
                  : 'text-[12px] tracking-[0.02em]',
                marks.dimmed ? 'text-fg-subtle' : 'text-fg',
              )}
              title={data.title}
            >
              {data.title}
            </span>
            {data.summary && data.holder === 'group' && data.object?.type !== 'software.Module' && (
              <span className="block truncate text-[11px] text-fg-subtle leading-[14px]">
                {data.summary}
              </span>
            )}
          </div>
          {toggle}
        </div>
        <Marks marks={marks} />
      </div>
    )
  }
  const sheets = data.memberTotal >= 10 ? 2 : 1
  const shadow =
    sheets === 2
      ? '3px 3px 0 -1px var(--k-canvas), 3px 3px 0 0 var(--k-fg-subtle), 6px 6px 0 -1px var(--k-canvas), 6px 6px 0 0 var(--k-border-strong)'
      : '3px 3px 0 -1px var(--k-canvas), 3px 3px 0 0 var(--k-fg-subtle)'
  const draftAccent = marks.draft && Boolean(marks.changes?.length)
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center gap-2 py-1 pr-2 pl-2',
        marks.dimmed ? 'text-fg-subtle' : 'text-fg',
      )}
      style={{ ...outline(marks, selected), boxShadow: marks.dimmed ? undefined : shadow }}
    >
      <Handles />
      <div className="min-w-0 flex-1">
        <TypeTag accent={draftAccent}>{marks.draft ? `Proposed · ${data.tag}` : data.tag}</TypeTag>
        <span className="block truncate font-medium text-[13px] leading-[19px]" title={data.title}>
          {data.title}
        </span>
        <span className="block truncate text-[11px] text-fg-subtle leading-[14px]">
          {data.summary}
        </span>
      </div>
      {toggle}
      <Marks marks={marks} />
    </div>
  )
})

export const nodeTypes = { object: ObjectNode, holder: HolderNode }
