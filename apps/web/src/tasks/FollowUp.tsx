import type { ReconcileResult, ReportResult, TaskView } from '@kalyth/contracts'
import { CircleCheck, CircleDashed, GitCompareArrows, Link2 } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useSessionMode } from '../app/session.ts'
import { useWorkbench } from '../app/workbench.ts'
import { StatusBadge, VerificationBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, SectionTitle, Spinner } from '../components/ui.tsx'
import { cn } from '../lib/cn.ts'
import { plural, shortSha } from '../model/format.ts'
import { taskStatusMeta } from '../model/tasks.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'
import { type FileReportBody, useFileReport, useReconcileTask } from './api.ts'

const SHA = /^[0-9a-f]{40}$/
const MAX_SUMMARY = 4000
const MAX_FILES = 500

// ---------- when a person may act ----------

/** A person may file a report on a ready task, an unknown outcome, or a lease that ran out. */
export const canFileReport = (task: Pick<TaskView, 'status' | 'leaseExpired'>): boolean =>
  task.status === 'ready' ||
  task.status === 'unknown_outcome' ||
  (task.status === 'running' && task.leaseExpired)

/** The latest report git verified, which reconciliation starts from. */
export const verifiedReport = (task: Pick<TaskView, 'reports'>) =>
  [...task.reports].reverse().find((r) => r.verification?.outcome === 'pass' && r.commit)

/** Reconciliation follows a verified report, once the task is in review or completed. */
export const canReconcile = (task: Pick<TaskView, 'status' | 'reports'>): boolean =>
  (task.status === 'review' || task.status === 'completed') && verifiedReport(task) !== undefined

/** One path per line, trimmed, without blanks or repeats. */
export const parseFiles = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  ),
]

// ---------- a person's report ----------

export interface ReportDraft {
  commit: string
  files: string
  summary: string
  outcome: 'succeeded' | 'partial'
}

/** What stops a draft from being sent; empty when it can go. */
export function reportDraftProblems(draft: ReportDraft): string[] {
  const problems: string[] = []
  if (!SHA.test(draft.commit.trim())) problems.push('The commit must be a full 40-character sha.')
  const files = parseFiles(draft.files)
  if (files.length === 0) problems.push('List at least one file the work changed.')
  if (files.length > MAX_FILES) problems.push(`List at most ${MAX_FILES} files.`)
  if (!draft.summary.trim()) problems.push('Say in a sentence what the work did.')
  return problems
}

export const reportBody = (draft: ReportDraft, idempotencyKey: string): FileReportBody => ({
  idempotencyKey,
  outcome: draft.outcome,
  summary: draft.summary.trim(),
  commit: draft.commit.trim(),
  filesChanged: parseFiles(draft.files),
  tests: [],
})

/**
 * The form a person files a report with, for work done outside an agent session. Presentational:
 * the container sends it. The verifier compares the files listed with what git shows.
 */
export function FileReportForm({
  initialCommit,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initialCommit: string
  pending: boolean
  error: unknown
  onSubmit: (draft: ReportDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<ReportDraft>({
    commit: initialCommit,
    files: '',
    summary: '',
    outcome: 'succeeded',
  })
  const [tried, setTried] = useState(false)
  const headingId = useId()
  const filesHintId = useId()
  const problems = reportDraftProblems(draft)
  const set = (patch: Partial<ReportDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const field =
    'w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm disabled:bg-surface-2'
  return (
    <form
      aria-labelledby={headingId}
      className="space-y-2.5 rounded-md border border-border bg-surface-2/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (problems.length === 0 && !pending) onSubmit(draft)
      }}
    >
      <h4 id={headingId} className="font-semibold text-sm">
        File a report
      </h4>
      <p className="text-fg-muted text-xs">
        Stated by you and checked by Kalyth’s git verifier exactly like an agent’s report: the
        commit, its branch, its trailer and the files changed since the task base. A pass moves the
        task to review.
      </p>
      <label className="block space-y-1">
        <span className="font-medium text-xs">Commit sha</span>
        <input
          value={draft.commit}
          onChange={(e) => set({ commit: e.target.value })}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          required
          disabled={pending}
          className={cn(field, 'font-mono text-xs')}
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium text-xs">Files changed, one per line</span>
        <textarea
          value={draft.files}
          onChange={(e) => set({ files: e.target.value })}
          rows={3}
          spellCheck={false}
          required
          disabled={pending}
          aria-describedby={filesHintId}
          className={cn(field, 'resize-y font-mono text-xs')}
        />
      </label>
      <p id={filesHintId} className="text-fg-subtle text-xs">
        Every file the work changed since the task base. If they differ from git, the verdict says
        which.
      </p>
      <label className="block space-y-1">
        <span className="font-medium text-xs">Summary</span>
        <textarea
          value={draft.summary}
          onChange={(e) => set({ summary: e.target.value })}
          rows={2}
          maxLength={MAX_SUMMARY}
          required
          disabled={pending}
          className={cn(field, 'resize-y')}
        />
      </label>
      <fieldset className="flex flex-wrap items-center gap-3 text-xs">
        <legend className="sr-only">Outcome</legend>
        <span className="font-medium" aria-hidden>
          Outcome
        </span>
        {(['succeeded', 'partial'] as const).map((o) => (
          <label key={o} className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`${headingId}-outcome`}
              checked={draft.outcome === o}
              onChange={() => set({ outcome: o })}
              disabled={pending}
            />
            {o === 'succeeded' ? 'Done' : 'Partly done'}
          </label>
        ))}
      </fieldset>
      {tried && problems.length > 0 && (
        <ul role="alert" className="list-disc space-y-0.5 pl-5 text-tone-fg text-xs tone-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error ? <ErrorNotice error={error} title="The report was not filed" /> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending && <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Filing" />}
          File the report
        </Button>
      </div>
    </form>
  )
}

/** The verifier's verdict on a filed report, check by check. */
export function FiledVerdict({ result }: { result: ReportResult }) {
  const { verification } = result
  return (
    <div role="status" className="space-y-1.5 rounded-md border border-border px-3 py-2 text-xs">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">Report filed.</span>
        <span className="text-fg-muted">Git verification</span>
        <VerificationBadge outcome={verification.outcome} size="sm" />
        <span className="text-fg-muted">
          {verification.outcome === 'pass'
            ? `The task moved to ${taskStatusMeta(result.task.status).label}.`
            : 'The task did not move.'}
        </span>
      </p>
      <ul className="space-y-0.5">
        {verification.checks.map((c) => (
          <li key={c.name} className="flex gap-1.5">
            <span className={c.ok ? 'text-fg-muted' : 'tone-danger font-medium text-tone-fg'}>
              {c.ok ? 'ok' : 'failed'}
            </span>
            <span className="font-medium">{c.name}:</span>
            <span className="min-w-0 break-words">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- reconciliation ----------

const LINK_TEXT = {
  committed: 'linked',
  pending: 'link proposed, waiting for you',
  rejected: 'link rejected earlier',
} as const

/**
 * What reconciliation found (ADR 0024): the analysis of the verified commit, and per decision the
 * direct changes it touched and the proposed elements an observed element now matches. Links are
 * pending proposals a person commits in Proposals.
 */
export function ReconcileSummary({
  result,
  proposalLink,
}: {
  result: ReconcileResult
  proposalLink: (proposalId: string, children: ReactNode) => ReactNode
}) {
  const { analysis } = result
  return (
    <div className="space-y-3">
      <p role="status" className="text-xs">
        <span className="font-medium">
          {analysis.status === 'skipped' ? 'Analysis skipped: ' : 'Analysed: '}
        </span>
        {analysis.detail}.
        {analysis.status === 'analysed' && analysis.proposalId && (
          <span className="text-fg-muted">
            {' '}
            {plural(analysis.created, 'record')} created, {analysis.refreshed} refreshed.
          </span>
        )}
      </p>
      {result.decisions.length === 0 ? (
        <p className="text-fg-muted text-xs">
          The task implements no decision, so there is nothing to compare with it.
        </p>
      ) : (
        result.decisions.map((d) => (
          <section key={d.id} aria-label={`Decision: ${d.title}`} className="space-y-2">
            <p className="text-sm">
              <span className="font-medium">{d.title}</span>{' '}
              <span className="text-fg-muted text-xs">
                {d.changes.length > 0
                  ? `The commit touched ${d.touched} of ${plural(d.changes.length, 'direct change')}.`
                  : 'Its alternatives name no direct changes, so there is nothing to compare the commit with.'}
              </span>
            </p>
            {d.changes.length > 0 && (
              <ul className="space-y-1 text-xs">
                {d.changes.map((c) => (
                  <li key={c.relationId} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {c.proposed ? (
                      <StatusBadge
                        tone="neutral"
                        icon={CircleDashed}
                        label="Proposed"
                        prefix="Change:"
                        size="sm"
                      />
                    ) : c.touched ? (
                      <StatusBadge
                        tone="success"
                        icon={CircleCheck}
                        label="Touched"
                        prefix="Change:"
                        size="sm"
                      />
                    ) : (
                      <StatusBadge
                        tone="warning"
                        icon={CircleDashed}
                        label="Not touched"
                        prefix="Change:"
                        size="sm"
                      />
                    )}
                    <span className="min-w-0 break-words font-medium">{c.label}</span>
                    {c.files.length > 0 && (
                      <span className="min-w-0 break-all font-mono text-[11px] text-fg-muted">
                        {c.files.join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {d.proposed.length > 0 && (
              <ul className="space-y-1 text-xs">
                {d.proposed.map((p) => (
                  <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Link2 aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
                    <span className="font-medium">{p.label}</span>
                    {p.match ? (
                      <>
                        <span className="text-fg-muted">is now observed as</span>
                        <span className="font-medium">{p.match.label}</span>
                        {p.link && (
                          <span className="text-fg-muted">
                            ({LINK_TEXT[p.link.state]}
                            {p.link.proposalId && p.link.state === 'pending' && (
                              <>
                                {': '}
                                {proposalLink(p.link.proposalId, 'review it in Proposals')}
                              </>
                            )}
                            )
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-fg-muted">has no observed match yet</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  )
}

// ---------- the actions ----------

type FileReport = ReturnType<typeof useFileReport>
type Reconcile = ReturnType<typeof useReconcileTask>

/**
 * Filing a report for work done outside an agent session, or reviewing the commit git found as
 * one. Renders nothing when the task takes no report from a person and none was just filed.
 */
export function ReportAction({ task, file }: { task: TaskView; file: FileReport }) {
  const notify = useToast()
  const [reporting, setReporting] = useState<{ commit: string; key: number } | null>(null)
  const found = task.finding?.commits[0]
  const fileable = canFileReport(task)
  if (!fileable && !file.data && !reporting) return null
  const open = (commit: string) => {
    file.reset()
    setReporting((r) => ({ commit, key: (r?.key ?? 0) + 1 }))
  }
  return (
    <>
      {fileable && !reporting && (
        <div className="space-y-2">
          {found && (
            <p className="text-xs">
              Git found <code className="font-mono">{shortSha(found)}</code> with this task’s
              trailer. Review it as a report: list the files it changed and Kalyth’s git verifier
              checks them.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {found && (
              <Button size="sm" variant="primary" onClick={() => open(found)}>
                Review {shortSha(found)} as a report…
              </Button>
            )}
            <Button size="sm" onClick={() => open('')}>
              File a report…
            </Button>
          </div>
          <p className="text-fg-muted text-xs">
            For work done outside an agent session: name the commit and the files it changed.
          </p>
        </div>
      )}
      {reporting && (
        <FileReportForm
          key={reporting.key}
          initialCommit={reporting.commit}
          pending={file.isPending}
          error={file.error}
          onCancel={() => setReporting(null)}
          onSubmit={(draft) =>
            file.mutate(
              { taskId: task.id, body: reportBody(draft, `person-${crypto.randomUUID()}`) },
              {
                onSuccess: (result) => {
                  setReporting(null)
                  notify({
                    tone: result.verification.outcome === 'pass' ? 'success' : 'caution',
                    title: `Report filed: git verification ${result.verification.outcome}`,
                    body:
                      result.verification.outcome === 'pass'
                        ? 'The task is in review.'
                        : 'The task did not move; the checks say why.',
                  })
                },
              },
            )
          }
        />
      )}
      {file.data && !reporting && <FiledVerdict result={file.data} />}
    </>
  )
}

/**
 * Reconciling the model with a task's verified commit, and what that found. Renders nothing until
 * a report has passed git verification and the task is in review or completed.
 */
export function ReconcileAction({ task, reconcile }: { task: TaskView; reconcile: Reconcile }) {
  const demo = useSessionMode() === 'demo'
  const verified = verifiedReport(task)
  if (!(canReconcile(task) && verified?.commit) && !reconcile.data && !reconcile.error) return null
  return (
    <>
      {canReconcile(task) && verified?.commit && (
        <div className="space-y-2">
          <p className="text-xs">
            <span className="font-medium">Reconcile the model</span>{' '}
            <span className="text-fg-muted">
              with the verified commit{' '}
              <code className="font-mono">{shortSha(verified.commit)}</code>: Kalyth’s analyzer
              reads it from the task repository, then compares the model with the decision this task
              implements. Links it finds are proposed for you to commit.
            </span>
          </p>
          {demo ? (
            <p className="text-fg-muted text-xs">
              The hosted demo reads no repository, so it cannot reconcile. Run Kalyth locally to try
              it.
            </p>
          ) : (
            <Button
              size="sm"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate(task.id)}
            >
              {reconcile.isPending ? (
                <Spinner label="Reconciling" />
              ) : (
                <GitCompareArrows aria-hidden />
              )}
              Reconcile with {shortSha(verified.commit)}
            </Button>
          )}
        </div>
      )}
      {reconcile.error ? (
        <ErrorNotice error={reconcile.error} title="The model was not reconciled" />
      ) : null}
      {reconcile.data && (
        <ReconcileSummary
          result={reconcile.data}
          proposalLink={(proposalId, children) => (
            <AppLink to={{ view: 'proposals', proposal: proposalId }}>{children}</AppLink>
          )}
        />
      )}
    </>
  )
}

// ---------- the panel ----------

/**
 * A person's follow-up on a task (ADR 0024): file a report for work done outside an agent
 * session, review the commit git found as one, and reconcile the model once a report is verified.
 * Decision acceptance, implementation, verification and freshness stay separate; nothing here
 * completes the task.
 */
export function TaskFollowUp({ task }: { task: TaskView }) {
  const wb = useWorkbench()
  const file = useFileReport(wb.projectId)
  const reconcile = useReconcileTask(wb.projectId)
  if (!canFileReport(task) && !canReconcile(task) && !file.data && !reconcile.data) return null
  return (
    <section aria-label="Follow-up" className="space-y-3 rounded-md border border-border p-3">
      <SectionTitle>Follow-up</SectionTitle>
      <ReportAction task={task} file={file} />
      <ReconcileAction task={task} reconcile={reconcile} />
    </section>
  )
}
