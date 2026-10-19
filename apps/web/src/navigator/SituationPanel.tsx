import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { FRESHNESS_STATUSES } from '../api/freshness.ts'
import { useSituation } from '../api/queries.ts'
import type { Situation } from '../api/situation.ts'
import { useWorkbench } from '../app/workbench.ts'
import {
  DecisionStatusBadge,
  FreshnessBadge,
  InquiryRoleBadge,
  OriginBadge,
} from '../components/badges.tsx'
import { Skeleton } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'

const LIST_LIMIT = 6
const STALE_STATUSES = ['stale', 'derived-stale'] as const

function Column({
  title,
  count,
  children,
  className,
}: {
  title: string
  count: number
  children: ReactNode
  className?: string
}) {
  return (
    <section aria-label={`${title}, ${count}`} className={cn('min-w-0 px-4 py-3', className)}>
      <h3 className="mb-2 flex items-center justify-between gap-2 font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
        {title}
        <span className="font-mono text-fg-muted tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  )
}

function More({ total }: { total: number }) {
  if (total <= LIST_LIMIT) return null
  return <p className="mt-1.5 text-fg-subtle text-xs">and {total - LIST_LIMIT} more</p>
}

function RecordButton({
  id,
  label,
  onInspect,
  className,
}: {
  id: string
  label: string
  onInspect?: ((id: string) => void) | undefined
  className?: string
}) {
  if (!onInspect) return <span className={cn('break-words', className)}>{label}</span>
  return (
    <button
      type="button"
      onClick={() => onInspect(id)}
      title={id}
      className={cn(
        'max-w-full break-words rounded-sm text-left text-accent underline-offset-2 hover:underline',
        className,
      )}
    >
      {label}
    </button>
  )
}

/**
 * What needs a person now: open decisions with their alternatives, open questions, pending
 * proposals and how many claims are stale. Presentational; links are passed in.
 */
export function SituationView({
  situation: s,
  nameOf,
  onInspect,
  reviewLink,
}: {
  situation: Situation
  nameOf: (id: string) => string | undefined
  onInspect?: (id: string) => void
  reviewLink?: (proposalId: string) => ReactNode
}) {
  const staleCount = STALE_STATUSES.reduce((n, k) => n + (s.freshness[k] ?? 0), 0)
  const counted = FRESHNESS_STATUSES.filter((k) => (s.freshness[k] ?? 0) > 0)
  return (
    <div className="grid grid-cols-4 divide-x divide-border">
      <Column title="Open decisions" count={s.openDecisions.length}>
        {s.openDecisions.length === 0 ? (
          <p className="text-fg-subtle text-xs">None open.</p>
        ) : (
          <ul className="space-y-2.5">
            {s.openDecisions.slice(0, LIST_LIMIT).map((d) => (
              <li key={d.id}>
                <RecordButton
                  id={d.id}
                  label={d.title || nameOf(d.id) || shortId(d.id)}
                  onInspect={onInspect}
                  className="font-medium text-sm"
                />
                {d.alternatives.length === 0 ? (
                  <p className="text-fg-subtle text-xs">No alternatives yet.</p>
                ) : (
                  <ul className="mt-0.5 border-border border-l pl-2.5">
                    {d.alternatives.map((a) => (
                      <li key={a.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                        <RecordButton
                          id={a.id}
                          label={a.title || nameOf(a.id) || shortId(a.id)}
                          onInspect={onInspect}
                          className="min-w-0 truncate py-1"
                        />
                        <DecisionStatusBadge status={a.status} size="sm" className="ml-auto" />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <More total={s.openDecisions.length} />
      </Column>

      <Column title="Open questions" count={s.openQuestions.length}>
        {s.openQuestions.length === 0 ? (
          <p className="text-fg-subtle text-xs">None open.</p>
        ) : (
          <ul className="space-y-2">
            {s.openQuestions.slice(0, LIST_LIMIT).map((q) => (
              <li key={q.id} className="space-y-0.5">
                <InquiryRoleBadge role={q.inquiryRole} size="sm" />
                <RecordButton
                  id={q.id}
                  label={q.text || shortId(q.id)}
                  onInspect={onInspect}
                  className="block text-sm"
                />
                {q.concerns.length > 0 && (
                  <p className="flex flex-wrap items-center gap-x-1.5 text-fg-muted text-xs">
                    <span className="text-fg-subtle">about</span>
                    {q.concerns.map((c) => (
                      <RecordButton
                        key={c}
                        id={c}
                        label={nameOf(c) ?? shortId(c)}
                        onInspect={onInspect}
                        className="py-1"
                      />
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <More total={s.openQuestions.length} />
      </Column>

      <Column title="Pending proposals" count={s.pendingProposals.length}>
        {s.pendingProposals.length === 0 ? (
          <p className="text-fg-subtle text-xs">Nothing waiting for review.</p>
        ) : (
          <ul className="space-y-2">
            {s.pendingProposals.slice(0, LIST_LIMIT).map((p) => (
              <li key={p.id} className="space-y-0.5">
                <p className="line-clamp-2 break-words text-sm" title={p.rationale}>
                  {p.rationale}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-fg-muted text-xs">
                  <OriginBadge origin={p.origin} size="sm" />
                  <span>{plural(p.operations, 'operation')}</span>
                  <time dateTime={p.createdAt} title={absoluteTime(p.createdAt)}>
                    {relativeTime(p.createdAt)}
                  </time>
                  {reviewLink && <span className="ml-auto">{reviewLink(p.id)}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
        <More total={s.pendingProposals.length} />
      </Column>

      <Column title="Stale claims" count={staleCount}>
        {counted.length === 0 ? (
          <p className="text-fg-subtle text-xs">Freshness not reported.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {counted.map((k) => (
              <li
                key={k}
                className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5"
              >
                <FreshnessBadge status={k} size="sm" />
                <span className="font-semibold text-xs tabular-nums">
                  {(s.freshness[k] ?? 0).toLocaleString('en')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {s.staleClaims.length > 0 && (
          <ul className="mt-2.5 space-y-1">
            {s.staleClaims.slice(0, LIST_LIMIT).map((c) => (
              <li key={c.id} className="text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <FreshnessBadge status={c.status} size="sm" />
                  <RecordButton
                    id={c.id}
                    label={nameOf(c.id) ?? shortId(c.id)}
                    onInspect={onInspect}
                    className="min-w-0 truncate"
                  />
                </span>
                {c.reason && (
                  <span className="mt-0.5 line-clamp-2 block text-fg-subtle">{c.reason}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <More total={s.staleClaims.length} />
      </Column>
    </div>
  )
}

/** The Situation panel at the top of the Navigator view; hidden while the server lacks it. */
export function SituationPanel() {
  const wb = useWorkbench()
  const situation = useSituation(wb.projectId)
  if (situation.data === null) return null
  return (
    <section
      aria-label="Situation"
      className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel"
    >
      <header className="flex items-center justify-between gap-2 border-border border-b px-4 py-2.5">
        <h2 className="font-semibold text-fg text-sm">Situation</h2>
        {situation.data && (
          <span className="text-fg-subtle text-xs">
            at the head, <span className="font-mono">r{situation.data.revision}</span>
          </span>
        )}
      </header>
      {situation.error ? (
        <div className="p-4">
          <ErrorNotice error={situation.error} title="The situation could not be loaded" />
        </div>
      ) : !situation.data ? (
        <div className="p-4">
          <Skeleton className="h-24" />
        </div>
      ) : (
        <SituationView
          situation={situation.data}
          nameOf={(id) => wb.model?.nameOf(id)}
          onInspect={wb.select}
          reviewLink={(proposalId) => (
            <AppLink
              to={{ view: 'proposals', proposal: proposalId }}
              className="inline-flex items-center gap-0.5"
            >
              Review <ArrowRight aria-hidden className="size-3" />
            </AppLink>
          )}
        />
      )}
    </section>
  )
}
