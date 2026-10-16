import type { InstructionOrigin, Lifecycle, ProposalStatus, Stance } from '@kalyth/contracts'
import type { LucideIcon } from 'lucide-react'
import type { FreshnessStatus } from '../api/freshness.ts'
import { cn } from '../lib/cn.ts'
import { humanize } from '../model/format.ts'
import {
  basisMeta,
  DECISION_STATUS_TONE,
  FRESHNESS_META,
  LIFECYCLE_META,
  ORIGIN_META,
  objectTypeMeta,
  PROPOSAL_STATUS_META,
  STANCE_META,
  type Tone,
} from '../model/semantics.ts'
import { BASIS_ICONS, FRESHNESS_ICONS, ORIGIN_ICONS, PROPOSAL_ICONS, typeIcon } from './icons.tsx'

/**
 * One badge component for every status dimension: icon + visible text label + tone. The
 * description goes into the title so pointer users can read it; the label alone is meaningful.
 */
export function StatusBadge({
  tone,
  icon: Icon,
  label,
  description,
  prefix,
  size = 'md',
  className,
}: {
  tone: Tone
  icon?: LucideIcon | undefined
  label: string
  description?: string | undefined
  /** Visually hidden dimension name read before the label, e.g. "Basis:". */
  prefix?: string | undefined
  size?: 'sm' | 'md' | undefined
  className?: string | undefined
}) {
  return (
    <span
      title={description}
      className={cn(
        `tone-${tone}`,
        'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded border border-tone-bd bg-tone-bg font-medium text-tone-fg',
        size === 'sm' ? 'h-[18px] px-1 text-2xs' : 'h-5 px-1.5 text-xs',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className={size === 'sm' ? 'size-3' : 'size-3.5'} />}
      {prefix && <span className="sr-only">{prefix} </span>}
      <span className="truncate">{label}</span>
    </span>
  )
}

type Size = { size?: 'sm' | 'md' | undefined; className?: string | undefined }

export function BasisBadge({ basis, ...rest }: { basis: string } & Size) {
  const meta = basisMeta(basis)
  return (
    <StatusBadge
      tone={meta.tone}
      icon={BASIS_ICONS[basis]}
      label={meta.label}
      description={meta.description}
      prefix="Basis:"
      {...rest}
    />
  )
}

export function FreshnessBadge({ status, ...rest }: { status: FreshnessStatus } & Size) {
  const meta = FRESHNESS_META[status]
  return (
    <StatusBadge
      tone={meta.tone}
      icon={FRESHNESS_ICONS[status]}
      label={meta.label}
      description={meta.description}
      prefix="Freshness:"
      {...rest}
    />
  )
}

export function ProposalStatusBadge({ status, ...rest }: { status: ProposalStatus } & Size) {
  const meta = PROPOSAL_STATUS_META[status] ?? {
    label: humanize(status),
    tone: 'neutral' as const,
    description: '',
  }
  return (
    <StatusBadge
      tone={meta.tone}
      icon={PROPOSAL_ICONS[status]}
      label={meta.label}
      description={meta.description}
      prefix="Status:"
      {...rest}
    />
  )
}

export function OriginBadge({ origin, ...rest }: { origin: InstructionOrigin } & Size) {
  const meta = ORIGIN_META[origin] ?? {
    label: humanize(origin),
    tone: 'neutral' as const,
    description: '',
  }
  return (
    <StatusBadge
      tone={meta.tone}
      icon={ORIGIN_ICONS[origin]}
      label={meta.label}
      description={meta.description}
      prefix="Origin:"
      {...rest}
    />
  )
}

export function StanceBadge({ stance, ...rest }: { stance: Stance } & Size) {
  const meta = STANCE_META[stance]
  return (
    <StatusBadge
      tone={meta.tone}
      label={meta.label}
      description={meta.description}
      prefix="Stance:"
      {...rest}
    />
  )
}

export function LifecycleBadge({ lifecycle, ...rest }: { lifecycle: Lifecycle } & Size) {
  const meta = LIFECYCLE_META[lifecycle]
  return (
    <StatusBadge
      tone={meta.tone}
      label={meta.label}
      description={meta.description}
      prefix="Lifecycle:"
      className={lifecycle === 'retired' ? 'line-through decoration-1' : undefined}
      {...rest}
    />
  )
}

export function ConfidenceBadge({ level, ...rest }: { level: 'low' | 'medium' | 'high' } & Size) {
  return (
    <StatusBadge
      tone="inferred"
      label={`${humanize(level)} confidence`}
      description="Qualitative confidence stated with the inference. Not a probability."
      {...rest}
    />
  )
}

export function DecisionStatusBadge({ status, ...rest }: { status: string } & Size) {
  return (
    <StatusBadge
      tone={DECISION_STATUS_TONE[status] ?? 'neutral'}
      label={humanize(status)}
      description="Changed only by a person, through a dedicated operation."
      prefix="Decision status:"
      {...rest}
    />
  )
}

/** Object type with its icon, e.g. [icon] Module. */
export function TypeLabel({
  type,
  className,
  showPack = false,
}: {
  type: string
  className?: string
  showPack?: boolean
}) {
  const Icon = typeIcon(type)
  const meta = objectTypeMeta(type)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={type}>
      <Icon aria-hidden className="size-3.5 shrink-0" style={{ color: meta.accent }} />
      <span className="truncate">{showPack ? type : meta.label}</span>
    </span>
  )
}

/** A short line sample for a relation type and basis, used in legends and lists. */
export function EdgeSample({
  color,
  dash,
  width = 28,
}: {
  color: string
  dash: string | undefined
  width?: number
}) {
  return (
    <svg width={width} height="8" aria-hidden className="shrink-0 overflow-visible">
      <line
        x1="1"
        y1="4"
        x2={width - 1}
        y2="4"
        style={{ stroke: color }}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  )
}
