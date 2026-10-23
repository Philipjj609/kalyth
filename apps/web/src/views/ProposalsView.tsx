import type { Proposal, ProposalStatus } from '@kalyth/contracts'
import { Check, ChevronRight, GitPullRequest, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useCommitProposal, useProposals, useRejectProposal } from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useWorkbench } from '../app/workbench.ts'
import { BasisBadge, MockBadge, OriginBadge, ProposalStatusBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, EmptyState, Segmented, Skeleton, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import { hasMockOutput } from '../model/navigator.ts'
import { describeOps, OP_LABEL, opCounts } from '../model/ops.ts'
import { PROPOSAL_STATUS_META, PROPOSAL_STATUS_ORDER } from '../model/semantics.ts'
import { ErrorNotice, IssueList, PrincipalLabel, ViewHeader } from './shared.tsx'

type Filter = ProposalStatus | 'all'

export function ProposalsView() {
  const wb = useWorkbench()
  const [loc] = useAppLocation()
  const proposals = useProposals(wb.projectId)
  const [filter, setFilter] = useState<Filter>('pending')
  // A deep-linked proposal (?proposal=) is listed whatever the filter, and brought into view.
  const focused = loc.proposal
  const [rejecting, setRejecting] = useState<Proposal | null>(null)
  // Proposals acted on here stay listed under the current filter, so the outcome of a commit or
  // reject (including a stale or conflicting error) remains visible after the status changes.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const touch = (id: string) => setTouched((t) => new Set(t).add(id))

  const all = useMemo(
    () =>
      [...(proposals.data?.proposals ?? [])].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      ),
    [proposals.data],
  )
  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: all.length }
    for (const p of all) c[p.status] = (c[p.status] ?? 0) + 1
    return c
  }, [all])
  const shown =
    filter === 'all'
      ? all
      : all.filter((p) => p.status === filter || touched.has(p.id) || p.id === focused)

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-6">
      <ViewHeader
        title="Proposals"
        description="Agents and tools propose typed changes against a base revision. People commit or reject them; nothing is applied silently."
      >
        <Segmented
          label="Filter by status"
          value={filter}
          onChange={(f) => {
            setFilter(f)
            setTouched(new Set())
          }}
          options={[
            ...PROPOSAL_STATUS_ORDER.filter((s) => s === 'pending' || (counts[s] ?? 0) > 0).map(
              (s) => ({
                value: s as Filter,
                label: PROPOSAL_STATUS_META[s].label,
                count: counts[s] ?? 0,
              }),
            ),
            { value: 'all' as Filter, label: 'All', count: counts.all ?? 0 },
          ]}
        />
      </ViewHeader>

      {proposals.error ? (
        <ErrorNotice error={proposals.error} title="Proposals could not be loaded" />
      ) : proposals.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState
            icon={<GitPullRequest />}
            title={filter === 'pending' ? 'Nothing waiting for review' : 'No proposals here'}
          >
            {filter === 'pending' &&
              'Agents propose changes over MCP; they appear here for review.'}
          </EmptyState>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((p) => (
            <li key={p.id}>
              <ProposalCard
                proposal={p}
                focused={p.id === focused}
                onActed={() => touch(p.id)}
                onReject={() => {
                  touch(p.id)
                  setRejecting(p)
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <RejectDialog proposal={rejecting} onClose={() => setRejecting(null)} />
    </div>
  )
}

function ProposalCard({
  proposal: p,
  focused,
  onReject,
  onActed,
}: {
  proposal: Proposal
  focused: boolean
  onReject: () => void
  onActed: () => void
}) {
  const wb = useWorkbench()
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView({ block: 'center' })
  }, [focused])
  const mock = useMemo(() => hasMockOutput(p.ops), [p.ops])
  const notify = useToast()
  const commit = useCommitProposal(wb.projectId)
  const runCommit = () => {
    onActed()
    commit.mutate(p.id, {
      onSuccess: (result) =>
        notify({
          tone: 'success',
          title: `Committed as r${result.revision}${result.rebasedFrom !== null ? `, rebased from r${result.rebasedFrom}` : ''}`,
          body: p.rationale,
        }),
      onError: (error) =>
        notify({
          tone: error.body.code === 'stale' ? 'caution' : 'danger',
          title: `Not committed: ${error.body.code}`,
          body: error.body.message,
        }),
    })
  }
  const [open, setOpen] = useState(p.status === 'pending')
  const bodyId = useId()
  const lines = useMemo(() => describeOps(p.ops, (id) => wb.model?.nameOf(id)), [p.ops, wb.model])
  const counts = opCounts(p.ops)
  const pending = p.status === 'pending'
  const behind = pending && p.baseRevision < wb.headRevision

  return (
    <article
      ref={cardRef}
      aria-labelledby={`${bodyId}-title`}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'rounded-lg border bg-surface shadow-panel',
        pending ? 'border-border-strong' : 'border-border',
        focused && 'border-accent ring-2 ring-accent/30',
      )}
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ProposalStatusBadge status={p.status} />
            <OriginBadge origin={p.origin} size="sm" />
            {mock && <MockBadge size="sm" />}
            <span className="font-mono text-2xs text-fg-subtle">{shortId(p.id)}</span>
          </div>
          <h2
            id={`${bodyId}-title`}
            className="mt-1.5 font-medium text-[14px] text-fg leading-snug"
          >
            {p.rationale}
          </h2>
          <p className="mt-1 text-fg-muted text-xs">
            Proposed by <PrincipalLabel id={p.proposedBy} /> ·{' '}
            <time dateTime={p.createdAt} title={absoluteTime(p.createdAt)}>
              {relativeTime(p.createdAt)}
            </time>{' '}
            · base <span className="font-mono">r{p.baseRevision}</span>
            {p.decidedAt && p.decidedBy && (
              <>
                {' '}
                · {p.status} by <PrincipalLabel id={p.decidedBy} />{' '}
                <time dateTime={p.decidedAt} title={absoluteTime(p.decidedAt)}>
                  {relativeTime(p.decidedAt)}
                </time>
              </>
            )}
            {p.result && (
              <>
                {' '}
                · produced <span className="font-mono">r{p.result.revision}</span>
                {p.result.rebasedFrom !== null && ` (rebased from r${p.result.rebasedFrom})`}
              </>
            )}
          </p>
        </div>
        {pending && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onReject} disabled={commit.isPending}>
              <X aria-hidden /> Reject…
            </Button>
            <Button
              variant="primary"
              onClick={runCommit}
              disabled={commit.isPending}
              aria-describedby={behind ? `${bodyId}-behind` : undefined}
            >
              {commit.isPending ? (
                <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Committing" />
              ) : (
                <Check aria-hidden />
              )}
              Commit
            </Button>
          </div>
        )}
      </header>

      <div className="space-y-2 px-4 pb-3">
        {behind && (
          <p id={`${bodyId}-behind`} className="text-fg-muted text-xs">
            Based on r{p.baseRevision}; the head is r{wb.headRevision}. Committing re-checks it at
            the head: unrelated changes rebase, overlapping ones make it stale.
          </p>
        )}
        {commit.isError && (
          <ErrorNotice
            error={commit.error}
            resolveName={(id) => wb.model?.nameOf(id)}
            onSelect={wb.select}
          />
        )}
        {commit.isSuccess && (
          <p
            role="status"
            className="tone-success rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs"
          >
            Committed as revision r{commit.data.revision}
            {commit.data.rebasedFrom !== null && `, rebased from r${commit.data.rebasedFrom}`}.
          </p>
        )}
        {p.decisionNote && (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
            <span className="font-medium text-fg-muted">Reason: </span>
            {p.decisionNote}
          </p>
        )}
        {p.issues.length > 0 && !commit.isError && (
          <div
            className={cn(
              `tone-${PROPOSAL_STATUS_META[p.status].tone}`,
              'rounded-md border border-tone-bd bg-tone-bg px-3 py-2',
            )}
          >
            <p className="mb-1 font-medium text-tone-fg text-xs">
              {plural(p.issues.length, 'issue')}
            </p>
            <IssueList
              issues={p.issues}
              resolveName={(id) => wb.model?.nameOf(id)}
              onSelect={wb.select}
            />
          </div>
        )}

        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${bodyId}-ops`}
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded text-fg-muted text-xs hover:text-fg"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
            {plural(p.ops.length, 'operation')}:
            <span className="text-fg-subtle">
              {counts.map(([op, n]) => `${n} ${OP_LABEL[op] ?? op}`).join(' · ')}
            </span>
          </button>
          {open && (
            <ol
              id={`${bodyId}-ops`}
              className="mt-2 divide-y divide-border rounded-md border border-border"
            >
              {lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: operations are immutable and ordered; the index is their identity
                <li key={i} className="flex items-start gap-3 px-3 py-1.5 text-xs">
                  <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-fg-subtle">
                    {i + 1}
                  </span>
                  <span className="w-24 shrink-0 pt-0.5 font-medium text-fg-muted">
                    {line.verb}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="break-words text-fg">{line.subject}</span>
                    {line.detail && (
                      <span className="block break-words text-fg-subtle">{line.detail}</span>
                    )}
                  </span>
                  {line.basis && <BasisBadge basis={line.basis} size="sm" />}
                  {line.refs.some((id) => wb.model?.objectById.has(id)) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-my-1 h-6 px-1.5"
                      aria-label={`Inspect ${line.subject}`}
                      onClick={() =>
                        wb.select(line.refs.find((id) => wb.model?.objectById.has(id)))
                      }
                    >
                      Inspect
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </article>
  )
}

/** Asks for the reason a proposal is rejected; the reason is kept with the proposal. */
function RejectDialog({ proposal, onClose }: { proposal: Proposal | null; onClose: () => void }) {
  const wb = useWorkbench()
  const reject = useRejectProposal(wb.projectId)
  const notify = useToast()
  const ref = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (proposal && !dialog.open) {
      setReason('')
      reject.reset()
      dialog.showModal()
    } else if (!proposal && dialog.open) {
      dialog.close()
    }
  }, [proposal, reject.reset])

  const trimmed = reason.trim()
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(520px,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-fg shadow-pop"
    >
      {proposal && (
        <form
          method="dialog"
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!trimmed) return
            reject.mutate(
              { proposalId: proposal.id, reason: trimmed },
              {
                onSuccess: () => {
                  ref.current?.close()
                  notify({ tone: 'neutral', title: 'Proposal rejected', body: trimmed })
                },
              },
            )
          }}
        >
          <h2 id={titleId} className="font-semibold text-[15px]">
            Reject proposal
          </h2>
          <p className="text-fg-muted text-sm">
            “{proposal.rationale}”. The proposal stays readable with your reason; nothing is
            applied.
          </p>
          <label className="block space-y-1">
            <span className="font-medium text-xs">Reason (required)</span>
            <textarea
              autoFocus
              required
              maxLength={2000}
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
              placeholder="What is wrong, and what would make it acceptable?"
            />
          </label>
          {reject.isError && <ErrorNotice error={reject.error} />}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={() => ref.current?.close()}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={!trimmed || reject.isPending}>
              {reject.isPending ? <Spinner label="Rejecting" /> : <X aria-hidden />}
              Reject
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}
