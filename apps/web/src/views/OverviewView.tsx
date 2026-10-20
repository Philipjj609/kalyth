import type { Basis } from '@kalyth/contracts'
import { ArrowRight, Download } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { FRESHNESS_STATUSES } from '../api/freshness.ts'
import { api, useHistory } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  BasisBadge,
  EdgeSample,
  FreshnessBadge,
  OriginBadge,
  TypeLabel,
} from '../components/badges.tsx'
import { Button, Panel, Skeleton } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, relativeTime, shortId } from '../model/format.ts'
import { BASIS_META, BASIS_ORDER, compareTypes, relationMeta } from '../model/semantics.ts'
import { useProposalIndex } from './HistoryView.tsx'
import { SituationHeader } from './SituationHeader.tsx'
import { ErrorNotice } from './shared.tsx'

export function OverviewView() {
  const wb = useWorkbench()
  const { overview } = wb
  const objectTotal = sum(overview.objectCounts)
  const relationTotal = sum(overview.relationCounts)

  const basisCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const o of wb.model?.objects ?? [])
      counts[o.claim.basis] = (counts[o.claim.basis] ?? 0) + 1
    for (const r of wb.model?.relations ?? [])
      counts[r.claim.basis] = (counts[r.claim.basis] ?? 0) + 1
    return counts
  }, [wb.model])

  const [exportError, setExportError] = useState<unknown>(null)

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-[19px] tracking-tight">
            {overview.project.name}
          </h1>
          {overview.project.description && (
            <p className="mt-0.5 max-w-3xl text-fg-muted">{overview.project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-fg-subtle text-xs">
            <span className="font-mono">{shortId(overview.project.id)}</span> · created{' '}
            <time
              dateTime={overview.project.createdAt}
              title={absoluteTime(overview.project.createdAt)}
            >
              {relativeTime(overview.project.createdAt)}
            </time>
          </p>
          <ExportButton projectId={overview.project.id} onError={setExportError} />
        </div>
      </div>
      {exportError !== null && <ErrorNotice error={exportError} title="Export refused" />}

      <SituationHeader />

      <h2 className="k-eyebrow pt-2">Details</h2>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Revision"
          value={`r${wb.revision}`}
          hint={wb.isHistorical ? `head is r${wb.headRevision}` : 'head'}
          mono
        />
        <Stat
          label="Objects"
          value={objectTotal}
          hint={`${Object.keys(overview.objectCounts).length} types`}
        />
        <Stat
          label="Relations"
          value={relationTotal}
          hint={`${Object.keys(overview.relationCounts).length} types`}
        />
        <Stat label="Evidence" value={overview.evidenceCount} hint="pinned source records" />
        <Stat
          label="Pending proposals"
          value={overview.pendingProposals}
          hint="waiting for review"
          tone={overview.pendingProposals > 0 ? 'warning' : undefined}
          action={
            overview.pendingProposals > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="-mr-1"
                onClick={() => wb.setView('proposals')}
              >
                Review <ArrowRight aria-hidden />
              </Button>
            ) : undefined
          }
        />
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Objects by type" aside={<Total n={objectTotal} />}>
          <BarList
            rows={Object.entries(overview.objectCounts)
              .sort(([a], [b]) => compareTypes(a, b))
              .map(([type, n]) => ({ key: type, label: <TypeLabel type={type} />, n }))}
            empty="No objects at this revision."
          />
        </Panel>
        <Panel title="Relations by type" aside={<Total n={relationTotal} />}>
          <BarList
            rows={Object.entries(overview.relationCounts)
              .sort(([, a], [, b]) => b - a)
              .map(([type, n]) => ({
                key: type,
                label: (
                  <span
                    className="inline-flex items-center gap-2"
                    title={relationMeta(type).description}
                  >
                    <EdgeSample color={relationMeta(type).color} dash={undefined} width={18} />
                    <span className="font-mono text-xs">{type}</span>
                  </span>
                ),
                n,
                color: relationMeta(type).color,
              }))}
            empty="No relations at this revision."
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Claim basis"
          aside={<span className="text-fg-subtle text-xs">objects and relations</span>}
        >
          {wb.model ? (
            <BasisMix counts={basisCounts} />
          ) : (
            <div className="p-4">
              <Skeleton className="h-16" />
            </div>
          )}
        </Panel>
        {wb.freshness.available && wb.freshness.report ? (
          <Panel
            title="Freshness"
            aside={
              <span className="text-fg-subtle text-xs">against the latest source snapshot</span>
            }
          >
            <div className="flex flex-wrap gap-2 p-4">
              {FRESHNESS_STATUSES.filter((s) => (wb.freshness.report?.summary[s] ?? 0) > 0).map(
                (s) => (
                  <span
                    key={s}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
                  >
                    <FreshnessBadge status={s} size="sm" />
                    <span className="font-semibold tabular-nums">
                      {wb.freshness.report?.summary[s]}
                    </span>
                  </span>
                ),
              )}
            </div>
          </Panel>
        ) : (
          <RecentChanges />
        )}
      </div>
      {wb.freshness.available && <RecentChanges />}
    </div>
  )
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0)
}

function Total({ n }: { n: number }) {
  return (
    <span className="font-mono text-fg-subtle text-xs tabular-nums">{n.toLocaleString('en')}</span>
  )
}

function Stat({
  label,
  value,
  hint,
  mono,
  tone,
  action,
}: {
  label: string
  value: number | string
  hint?: string
  mono?: boolean
  tone?: 'warning' | undefined
  action?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-surface px-4 py-3 shadow-panel',
        tone ? `tone-${tone} border-tone-bd` : 'border-border',
      )}
    >
      <dt className="flex items-center justify-between gap-2 text-fg-muted text-xs">
        {label}
        {action}
      </dt>
      <dd
        className={cn(
          'font-semibold text-[22px] leading-7 tabular-nums tracking-tight',
          mono && 'font-mono',
          tone && 'text-tone-fg',
        )}
      >
        {typeof value === 'number' ? value.toLocaleString('en') : value}
      </dd>
      {hint && <dd className="text-fg-subtle text-xs">{hint}</dd>}
    </div>
  )
}

function BarList({
  rows,
  empty,
}: {
  rows: { key: string; label: ReactNode; n: number; color?: string }[]
  empty: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  if (rows.length === 0) return <p className="p-4 text-fg-muted">{empty}</p>
  return (
    <ul className="space-y-1.5 px-4 py-3">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,180px)_1fr_auto] items-center gap-3">
          <span className="min-w-0 truncate text-fg">{r.label}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span
              className="block h-full rounded-full bg-fg-subtle"
              style={{
                width: `${(r.n / max) * 100}%`,
                ...(r.color ? { background: r.color } : {}),
              }}
            />
          </span>
          <span className="w-10 text-right font-mono text-xs tabular-nums">
            {r.n.toLocaleString('en')}
          </span>
        </li>
      ))}
    </ul>
  )
}

function BasisMix({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return <p className="p-4 text-fg-muted">Nothing recorded at this revision.</p>
  const known = BASIS_ORDER.filter((b) => (counts[b] ?? 0) > 0)
  return (
    <div className="space-y-3 p-4">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        {known.map((b) => (
          <span
            key={b}
            className={cn(`tone-${BASIS_META[b].tone}`, 'h-full bg-tone-fg')}
            style={{ width: `${((counts[b] ?? 0) / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
        {known.map((b: Basis) => {
          return (
            <li key={b} className="flex items-start gap-2">
              <BasisBadge basis={b} size="sm" />
              <span className="font-semibold tabular-nums">{counts[b]}</span>
              <span className="text-fg-subtle text-xs tabular-nums">
                {Math.round(((counts[b] ?? 0) / total) * 100)}%
              </span>
            </li>
          )
        })}
      </ul>
      <p className="text-fg-muted text-xs">
        Observed means a tool saw it in pinned source within stated coverage. It is not runtime
        verification.
      </p>
    </div>
  )
}

function RecentChanges() {
  const wb = useWorkbench()
  const history = useHistory(wb.projectId)
  const proposals = useProposalIndex(wb.projectId)
  const recent = history.data?.changeSets.slice(0, 5) ?? []
  return (
    <Panel
      title="Recent changes"
      aside={
        <Button size="sm" variant="ghost" onClick={() => wb.setView('history')}>
          History <ArrowRight aria-hidden />
        </Button>
      }
    >
      {history.isLoading ? (
        <div className="p-4">
          <Skeleton className="h-16" />
        </div>
      ) : recent.length === 0 ? (
        <p className="p-4 text-fg-muted">No commits yet.</p>
      ) : (
        <ol className="divide-y divide-border">
          {recent.map((c) => {
            const proposal = proposals.get(c.proposalId)
            return (
              <li key={c.id} className="flex items-start gap-3 px-4 py-2">
                <span className="w-8 shrink-0 pt-0.5 font-mono font-semibold text-xs">
                  r{c.revision}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {proposal?.rationale ?? 'Change set'}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
                    {proposal && <OriginBadge origin={proposal.origin} size="sm" />}
                    <span>
                      {c.writeCount.toLocaleString('en')} {c.writeCount === 1 ? 'write' : 'writes'}
                      {c.rebasedFrom !== null && ` · rebased from r${c.rebasedFrom}`}
                    </span>
                  </span>
                </span>
                <time
                  className="shrink-0 pt-0.5 text-fg-subtle text-xs"
                  dateTime={c.committedAt}
                  title={absoluteTime(c.committedAt)}
                >
                  {relativeTime(c.committedAt)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}

/**
 * Downloads the whole project as one file (ADR 0014): its events, the evidence content they refer
 * to and the principals in its history. `pnpm project:import` rebuilds it in another store.
 */
export function ExportButton({
  projectId,
  onError,
}: {
  projectId: string
  onError: (error: unknown) => void
}) {
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    onError(null)
    try {
      const { fileName, text } = await api.exportProject(projectId)
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      onClick={download}
      disabled={busy}
      title="Download the project's history and evidence as one file; pnpm project:import rebuilds it in another store"
    >
      <Download aria-hidden />
      <span className="ml-1.5">{busy ? 'Exporting…' : 'Export'}</span>
    </Button>
  )
}
