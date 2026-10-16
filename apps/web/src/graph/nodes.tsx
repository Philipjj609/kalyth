import type { ObjectVersion } from '@kalyth/contracts'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo } from 'react'
import type { FreshnessStatus } from '../api/freshness.ts'
import { FRESHNESS_ICONS, typeIcon } from '../components/icons.tsx'
import { cn } from '../lib/cn.ts'
import { typePlural } from '../model/format.ts'
import { objectDetail, objectLabel, objectShortLabel } from '../model/labels.ts'
import { basisMeta, compareTypes, FRESHNESS_META, objectTypeMeta } from '../model/semantics.ts'

/**
 * Canvas nodes. The node border pattern encodes the claim basis exactly as edge dash patterns do
 * (solid observed, dashed inferred, dotted stated, double imported), and every node also carries
 * the basis as text. To-be (intended) elements get a hatched fill and a "to-be" tag.
 */

export interface ObjectNodeData extends Record<string, unknown> {
  object: ObjectVersion
  freshness: FreshnessStatus | undefined
  /** True while the selection is this node's hidden member. */
  holdsSelection: boolean
  dimmed: boolean
}

export interface GroupNodeData extends Record<string, unknown> {
  object?: ObjectVersion
  /** Cluster type, for clusters. */
  clusterType?: string
  expanded: boolean
  memberCounts: Record<string, number>
  memberFreshness: Record<string, number>
  holdsSelection: boolean
  dimmed: boolean
  onToggle: (id: string) => void
}

export type ObjectFlowNode = Node<ObjectNodeData, 'object'>
export type GroupFlowNode = Node<GroupNodeData, 'group' | 'cluster'>

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

function BasisTag({ basis }: { basis: string }) {
  const meta = basisMeta(basis)
  return (
    <span
      className={cn(
        `tone-${meta.tone}`,
        'shrink-0 rounded-sm border border-tone-bd bg-tone-bg px-1 font-medium text-[10px] text-tone-fg leading-[14px]',
      )}
    >
      {meta.label.toLowerCase()}
    </span>
  )
}

function FreshnessMark({ status, compact }: { status: FreshnessStatus; compact?: boolean }) {
  const meta = FRESHNESS_META[status]
  const Icon = FRESHNESS_ICONS[status]
  if (status === 'not-applicable') return null
  const quiet = compact && status === 'current'
  return (
    <span
      title={`Freshness: ${meta.label}`}
      className={cn(
        `tone-${meta.tone}`,
        'inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium text-[10px] text-tone-fg leading-[14px]',
        !quiet && 'border border-tone-bd bg-tone-bg px-1',
      )}
    >
      {Icon && <Icon aria-hidden className="size-3" />}
      {quiet ? <span className="sr-only">{meta.label}</span> : meta.label.toLowerCase()}
    </span>
  )
}

function nodeFrame(basis: string, selected: boolean, holdsSelection: boolean, dimmed: boolean) {
  const meta = basisMeta(basis)
  return {
    className: cn(
      'relative h-full w-full overflow-hidden rounded-[10px] bg-surface text-left shadow-panel transition-[opacity,box-shadow] duration-150',
      dimmed && 'opacity-45',
      (selected || holdsSelection) && 'shadow-pop',
    ),
    style: {
      borderWidth: meta.border === 'double' ? 3 : 1.5,
      borderStyle: meta.border,
      borderColor: selected
        ? 'var(--k-accent)'
        : holdsSelection
          ? 'var(--k-focus)'
          : 'var(--k-border-strong)',
    },
  }
}

export const ObjectNode = memo(function ObjectNode({ data, selected }: NodeProps<ObjectFlowNode>) {
  const { object, freshness } = data
  const Icon = typeIcon(object.type)
  const type = objectTypeMeta(object.type)
  const { label, context } = objectShortLabel(object)
  const detail = context ?? objectDetail(object)
  const frame = nodeFrame(object.claim.basis, selected, data.holdsSelection, data.dimmed)
  const intended = object.stance === 'toBe'
  return (
    <div className={frame.className} style={frame.style}>
      <Handles />
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: type.accent }}
      />
      {intended && <span aria-hidden className="k-intended absolute inset-0" />}
      <div className="relative flex h-full flex-col justify-center gap-0.5 py-1.5 pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-fg-subtle leading-[14px]">
          <Icon aria-hidden className="size-3 shrink-0" style={{ color: type.accent }} />
          <span className="truncate">{type.label}</span>
          {intended && (
            <span className="tone-accent shrink-0 rounded-sm border border-tone-bd bg-tone-bg px-1 font-medium text-[10px] text-tone-fg">
              to-be
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {freshness && <FreshnessMark status={freshness} compact />}
            <BasisTag basis={object.claim.basis} />
          </span>
        </div>
        <div
          className="truncate font-medium text-[12.5px] text-fg leading-4"
          title={objectLabel(object)}
        >
          {label}
        </div>
        {detail && (
          <div
            className={cn(
              'truncate text-[10.5px] text-fg-subtle leading-[14px]',
              context && 'font-mono',
            )}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  )
})

function memberSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => compareTypes(a, b))
    .map(([type, n]) => typePlural(type, n))
    .join(' · ')
}

const WORRYING: FreshnessStatus[] = ['stale', 'derived-stale', 'weakened']

/** Containers (with members) and type clusters share one node design, collapsed or expanded. */
export const GroupNode = memo(function GroupNode({ id, data, selected }: NodeProps<GroupFlowNode>) {
  const object = data.object
  const type = object?.type ?? data.clusterType ?? ''
  const Icon = typeIcon(type)
  const meta = objectTypeMeta(type)
  const total = Object.values(data.memberCounts).reduce((a, b) => a + b, 0)
  const title = object ? objectLabel(object) : `${typePlural(type, total).replace(/^[\d,]+ /, '')}`
  const subtitle = object ? objectDetail(object) : undefined
  const frame = object
    ? nodeFrame(object.claim.basis, selected, data.holdsSelection, data.dimmed)
    : nodeFrame('observed', selected, data.holdsSelection, data.dimmed)
  const worrying = WORRYING.filter((s) => (data.memberFreshness[s] ?? 0) > 0)
  const Chevron = data.expanded ? ChevronDown : ChevronRight
  const toggleLabel = `${data.expanded ? 'Collapse' : 'Expand'} ${title} (${total} members)`

  return (
    <div
      className={cn(
        frame.className,
        data.expanded && 'bg-[color-mix(in_oklab,var(--k-surface)_55%,transparent)] shadow-none',
        !object && 'bg-surface-2',
      )}
      style={{
        ...frame.style,
        ...(object
          ? {}
          : {
              borderStyle: 'solid',
              borderColor: selected ? 'var(--k-accent)' : 'var(--k-border-strong)',
            }),
      }}
    >
      <Handles />
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: meta.accent }}
      />
      {object?.stance === 'toBe' && <span aria-hidden className="k-intended absolute inset-0" />}
      <div className="relative flex items-start gap-2 px-3 pt-2.5">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: meta.accent }} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-fg-subtle leading-[14px]">
            <span className="truncate">{object ? meta.label : 'Group of'}</span>
            {subtitle && <span className="truncate">· {subtitle}</span>}
            {object?.stance === 'toBe' && (
              <span className="tone-accent shrink-0 rounded-sm border border-tone-bd bg-tone-bg px-1 font-medium text-[10px] text-tone-fg">
                to-be
              </span>
            )}
            {object && (
              <span className="ml-auto">
                <BasisTag basis={object.claim.basis} />
              </span>
            )}
          </div>
          <div className="truncate font-semibold text-[13.5px] text-fg leading-5" title={title}>
            {object ? title : `${title} · ${total}`}
          </div>
        </div>
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
          className="nodrag nopan -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <Chevron aria-hidden className="size-3.5" />
        </button>
      </div>
      <div className="relative flex min-w-0 items-center gap-2 px-3 pt-1 text-[11px] text-fg-muted">
        <span className="truncate">{memberSummary(data.memberCounts)}</span>
        {worrying.length > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {worrying.map((s) => (
              <span key={s} className="flex items-center gap-0.5">
                <FreshnessMark status={s} />
                <span className="tabular-nums">{data.memberFreshness[s]}</span>
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
})

export const nodeTypes = { object: ObjectNode, group: GroupNode, cluster: GroupNode }
