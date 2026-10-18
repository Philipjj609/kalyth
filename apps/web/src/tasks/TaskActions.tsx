import type { TaskStatus, TaskView } from '@kalyth/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { useChangeTaskStatus } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { ReportOutcomeBadge, VerificationBadge } from '../components/badges.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, SectionTitle, Spinner } from '../components/ui.tsx'
import { latestReport, type TaskAction, taskActions, taskStatusMeta } from '../model/tasks.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'

const MAX_RATIONALE = 2000

/** One button per action a person may take from the task's status; none for a final status. */
export function TaskActionButtons({
  status,
  onChoose,
  disabled,
}: {
  status: TaskStatus
  onChoose: (action: TaskAction) => void
  disabled?: boolean
}) {
  const actions = taskActions(status)
  if (actions.length === 0) {
    return (
      <p className="text-fg-muted text-xs">
        {taskStatusMeta(status).label} is final: the task cannot change again.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => (
        <Button
          key={a.to}
          size="sm"
          variant={a.variant}
          disabled={disabled}
          onClick={() => onChoose(a)}
        >
          {a.label}…
        </Button>
      ))}
    </div>
  )
}

/** What a person should know before acting on a status that agents and the coordinator share. */
export function statusHint(task: Pick<TaskView, 'status'>): string | null {
  switch (task.status) {
    case 'proposed':
      return 'Agents cannot claim a proposed task. Mark it ready when they may.'
    case 'running':
      return 'An agent holds the lease. It renews, releases and reports over MCP; Kalyth’s git verifier then moves the task to review or keeps it running with the checks that failed.'
    case 'unknown_outcome':
      return 'The lease ran out before a report. The last holder can still report; otherwise decide here whether to try again.'
    case 'review':
      return 'Kalyth’s git verifier found the reported commit. Only a person completes the task.'
    default:
      return null
  }
}

/** Asks for the required rationale; the status change proposal carries it. */
export function StatusDialog({
  task,
  action,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  task: TaskView
  action: TaskAction | null
  pending: boolean
  error: unknown
  onSubmit: (rationale: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [rationale, setRationale] = useState('')
  const titleId = useId()
  const noteId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (action && !dialog.open) {
      setRationale('')
      dialog.showModal()
    } else if (!action && dialog.open) {
      dialog.close()
    }
  }, [action])
  const trimmed = rationale.trim()
  const report = action?.to === 'completed' ? latestReport(task) : undefined
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={noteId}
      onClose={onClose}
      className="m-auto w-[min(540px,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-fg shadow-pop"
    >
      {action && (
        <form
          method="dialog"
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed && !pending) onSubmit(trimmed)
          }}
        >
          <h2 id={titleId} className="font-semibold text-[15px]">
            {action.label}: “{task.title}”
          </h2>
          <p id={noteId} className="text-fg-muted text-sm">
            {action.note}
          </p>
          {report && (
            <p className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
              <span className="text-fg-muted">Latest report</span>
              <ReportOutcomeBadge outcome={report.outcome} size="sm" />
              {report.verification ? (
                <>
                  <span className="text-fg-muted">git verification</span>
                  <VerificationBadge outcome={report.verification.outcome} size="sm" />
                </>
              ) : (
                <span className="text-fg-muted">not verified</span>
              )}
            </p>
          )}
          <p className="text-fg-muted text-xs">
            {taskStatusMeta(task.status).label} → {taskStatusMeta(action.to).label}. Proposed
            against the head and committed at once.
          </p>
          <label className="block space-y-1">
            <span className="font-medium text-xs">Rationale (required)</span>
            <textarea
              autoFocus
              required
              maxLength={MAX_RATIONALE}
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className="w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
              placeholder="Why, in a sentence the history will keep"
            />
          </label>
          {error ? <ErrorNotice error={error} title="The status was not changed" /> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={() => ref.current?.close()} disabled={pending}>
              Back
            </Button>
            <Button
              type="submit"
              variant={action.variant === 'danger' ? 'danger' : 'primary'}
              disabled={!trimmed || pending}
            >
              {pending && (
                <Spinner
                  className={
                    action.variant === 'danger' ? '' : 'border-accent-fg/40 border-t-accent-fg'
                  }
                  label="Saving"
                />
              )}
              {action.label}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}

/**
 * The person's actions on a task. Each asks for a rationale, proposes one setTaskStatus operation
 * against the revision the person saw, and commits it. A refused commit (stale, conflicting,
 * unauthorized) leaves that proposal pending and is shown as the Proposals view shows it.
 */
export function TaskActionsPanel({ task, baseRevision }: { task: TaskView; baseRevision: number }) {
  const wb = useWorkbench()
  const notify = useToast()
  const change = useChangeTaskStatus(wb.projectId)
  const [choosing, setChoosing] = useState<TaskAction | null>(null)
  const outcome = change.data
  const done = change.variables
  const hint = statusHint(task)
  return (
    <section aria-label="Actions" className="space-y-2 rounded-md border border-border p-3">
      <SectionTitle>Actions</SectionTitle>
      {hint && <p className="text-fg-muted text-xs">{hint}</p>}
      <TaskActionButtons
        status={task.status}
        disabled={change.isPending}
        onChoose={(action) => {
          change.reset()
          setChoosing(action)
        }}
      />
      {outcome && 'committed' in outcome && done && (
        <p
          role="status"
          className="tone-success rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs"
        >
          Moved to {taskStatusMeta(done.status).label}. Committed as revision r
          {outcome.committed.revision}
          {outcome.committed.rebasedFrom !== null &&
            `, rebased from r${outcome.committed.rebasedFrom}`}
          .
        </p>
      )}
      {outcome && 'refused' in outcome && (
        <div className="space-y-1.5">
          <ErrorNotice
            error={outcome.refused}
            resolveName={(id) => (id === task.id ? task.title : wb.model?.nameOf(id))}
            onSelect={wb.select}
          />
          <p className="text-fg-muted text-xs">
            The status change is still pending.{' '}
            <AppLink to={{ view: 'proposals', proposal: outcome.proposalId }}>
              Review it in Proposals
            </AppLink>
          </p>
        </div>
      )}
      <StatusDialog
        task={task}
        action={choosing}
        pending={change.isPending}
        error={change.error}
        onClose={() => setChoosing(null)}
        onSubmit={(rationale) => {
          if (!choosing) return
          const action = choosing
          change.mutate(
            { taskId: task.id, status: action.to, rationale, baseRevision },
            {
              onSuccess: (result) => {
                setChoosing(null)
                if ('committed' in result) {
                  notify({
                    tone: 'success',
                    title: `${action.label}: ${task.title}`,
                    body: `Committed as r${result.committed.revision}. ${rationale}`,
                  })
                } else {
                  notify({
                    tone: result.refused.body.code === 'stale' ? 'caution' : 'danger',
                    title: `Not committed: ${result.refused.body.code}`,
                    body: result.refused.body.message,
                  })
                }
              },
            },
          )
        }}
      />
    </section>
  )
}
