import type { ChangeSetSummary, Proposal } from '@kalyth/contracts'
import { Eye, GitCommitHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { useHistory, useProposals } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { OriginBadge } from '../components/badges.tsx'
import { Button, EmptyState, Skeleton } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, relativeTime, shortId } from '../model/format.ts'
import { ErrorNotice, ViewHeader } from './shared.tsx'

/** Proposal id -> proposal, to show what each change set was and who asked for it. */
export function useProposalIndex(projectId: string): Map<string, Proposal> {
  const proposals = useProposals(projectId)
  return useMemo(
    () => new Map((proposals.data?.proposals ?? []).map((p) => [p.id, p])),
    [proposals.data],
  )
}

export function HistoryView() {
  const wb = useWorkbench()
  const history = useHistory(wb.projectId)
  const proposals = useProposalIndex(wb.projectId)
  const changeSets = history.data?.changeSets ?? []

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-6">
      <ViewHeader
        title="History"
        description="Every commit is one change set and one new revision. Change sets are immutable; any revision can be viewed."
      />
      {history.error ? (
        <ErrorNotice error={history.error} title="History could not be loaded" />
      ) : history.isLoading ? (
        <Skeleton className="h-48" />
      ) : changeSets.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState icon={<GitCommitHorizontal />} title="No commits yet">
            Committed proposals appear here, newest first.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Change sets, newest first</caption>
            <thead className="bg-surface-2 text-left text-fg-muted text-xs">
              <tr>
                <th scope="col" className="border-border border-b px-3 py-2 font-medium">
                  Revision
                </th>
                <th scope="col" className="border-border border-b px-3 py-2 font-medium">
                  Change
                </th>
                <th scope="col" className="border-border border-b px-3 py-2 font-medium">
                  Proposed
                </th>
                <th scope="col" className="border-border border-b px-3 py-2 font-medium">
                  Committed
                </th>
                <th scope="col" className="border-border border-b px-3 py-2 text-right font-medium">
                  Writes
                </th>
                <th scope="col" className="border-border border-b px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {changeSets.map((c) => (
                <HistoryRow key={c.id} change={c} proposal={proposals.get(c.proposalId)} />
              ))}
              <tr>
                <td className="px-3 py-2.5 font-mono font-semibold text-fg-muted">r0</td>
                <td className="px-3 py-2.5 text-fg-muted" colSpan={5}>
                  Project created{' '}
                  <span className="text-fg-subtle">
                    {relativeTime(wb.overview.project.createdAt)} by{' '}
                    <span className="font-mono text-xs">
                      {shortId(wb.overview.project.createdBy)}
                    </span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-fg-subtle text-xs">
        Principals are shown by id; the API does not expose display names yet. The commit origin is
        the authority under which the change was applied.
      </p>
    </div>
  )
}

function HistoryRow({
  change: c,
  proposal,
}: {
  change: ChangeSetSummary
  proposal: Proposal | undefined
}) {
  const wb = useWorkbench()
  const viewing = wb.revision === c.revision
  const cell = 'border-border border-b px-3 py-2.5 align-top'
  return (
    <tr className={cn(viewing && 'bg-accent-soft')}>
      <td className={cn(cell, 'whitespace-nowrap font-mono font-semibold')}>
        r{c.revision}
        {c.revision === wb.headRevision && (
          <span className="ml-2 rounded border border-border px-1 font-medium font-sans text-2xs text-fg-muted">
            head
          </span>
        )}
      </td>
      <td className={cn(cell, 'max-w-[420px]')}>
        <p className="line-clamp-2 text-fg">
          {proposal?.rationale ?? <span className="text-fg-subtle">Proposal not listed</span>}
        </p>
        <p className="mt-0.5 font-mono text-2xs text-fg-subtle">
          {shortId(c.proposalId)}
          {c.rebasedFrom !== null && (
            <span
              className="ml-2 font-sans"
              title="Based on an older revision; re-checked and applied on a newer head."
            >
              rebased from r{c.rebasedFrom}
            </span>
          )}
        </p>
      </td>
      <td className={cell}>
        <div className="flex flex-col items-start gap-1">
          {proposal && <OriginBadge origin={proposal.origin} size="sm" />}
          <span className="font-mono text-2xs text-fg-subtle" title={c.proposedBy}>
            {shortId(c.proposedBy)}
          </span>
        </div>
      </td>
      <td className={cell}>
        <div className="flex flex-col items-start gap-1">
          <span className="flex items-center gap-1.5">
            <OriginBadge origin={c.origin} size="sm" />
            <time
              className="text-fg-muted text-xs"
              dateTime={c.committedAt}
              title={absoluteTime(c.committedAt)}
            >
              {relativeTime(c.committedAt)}
            </time>
          </span>
          <span className="font-mono text-2xs text-fg-subtle" title={c.committedBy}>
            {shortId(c.committedBy)}
          </span>
        </div>
      </td>
      <td className={cn(cell, 'text-right font-mono text-xs tabular-nums')}>{c.writeCount}</td>
      <td className={cn(cell, 'text-right')}>
        <Button
          size="sm"
          variant="ghost"
          disabled={viewing}
          aria-label={`View the model at revision ${c.revision}`}
          onClick={() => wb.setRevision(c.revision === wb.headRevision ? undefined : c.revision)}
        >
          <Eye aria-hidden /> {viewing ? 'Viewing' : 'View'}
        </Button>
      </td>
    </tr>
  )
}
