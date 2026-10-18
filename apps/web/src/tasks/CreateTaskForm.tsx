import type { ContextPackageSummary, DecisionSummary, TaskView } from '@kalyth/contracts'
import { Gavel, ListPlus } from 'lucide-react'
import { type RefObject, useId, useReducer } from 'react'
import { useAcceptedDecisions, useContextPackages, useCreateTask } from '../api/queries.ts'
import { useWorkbench } from '../app/workbench.ts'
import { TaskStatusBadge } from '../components/badges.tsx'
import { CriteriaEditor } from '../components/CriteriaEditor.tsx'
import { useToast } from '../components/toast.tsx'
import { Button, EmptyState, Panel, Skeleton, Spinner } from '../components/ui.tsx'
import { DecisionChoiceList } from '../handoff/HandoffSource.tsx'
import { cn } from '../lib/cn.ts'
import { plural, shortId } from '../model/format.ts'
import { acceptedAlternatives } from '../model/handoff.ts'
import {
  requirableTasks,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  type TaskDraft,
  taskDraftProblems,
  taskDraftReducer,
} from '../model/tasks.ts'
import { AppLink, ErrorNotice } from '../views/shared.tsx'

// ---------- presentational ----------

/**
 * What the task implements: the accepted decision itself, or one of its accepted alternatives.
 * Native radios give arrow-key selection.
 */
export function ImplementsChoice({
  decision,
  value,
  onChange,
  disabled,
}: {
  decision: DecisionSummary
  value: string | null
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const name = useId()
  const options = [
    { id: decision.id, label: 'The decision', detail: decision.title },
    ...acceptedAlternatives(decision).map((a) => ({
      id: a.id,
      label: 'Its accepted alternative',
      detail: a.title,
    })),
  ]
  return (
    <fieldset disabled={disabled} className="space-y-1">
      <legend className="font-medium text-xs">It implements</legend>
      {options.map((o) => (
        <label key={o.id} className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            className="mt-1 shrink-0 accent-accent"
          />
          <span className="min-w-0">
            <span className="text-fg-muted">{o.label}: </span>
            <span className="break-words font-medium">{o.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/** Tasks the new one must wait for, as checkboxes. Cancelled tasks are not offered. */
export function RequiresPicker({
  tasks,
  value,
  onToggle,
  disabled,
}: {
  tasks: readonly TaskView[]
  value: readonly string[]
  onToggle: (taskId: string) => void
  disabled?: boolean
}) {
  const options = requirableTasks(tasks)
  return (
    <fieldset disabled={disabled} className="space-y-1">
      <legend className="font-medium text-xs">
        Requires{' '}
        <span className="font-normal text-fg-muted">
          (optional: tasks that must be completed first)
        </span>
      </legend>
      {options.length === 0 ? (
        <p className="text-fg-subtle text-xs">No other tasks yet.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2 scrollbar-thin">
          {options.map((t) => (
            <li key={t.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.includes(t.id)}
                  onChange={() => onToggle(t.id)}
                  className="shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <TaskStatusBadge status={t.status} size="sm" />
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

/** "Tenancy model · r7 · ctx…abcdef", marking packages compiled for the chosen decision. */
export function packageOptionLabel(p: ContextPackageSummary, decisionId: string | null): string {
  const what = p.taskTitle ?? `Focus on ${plural(p.focus.length, 'element')}`
  const forDecision = decisionId !== null && p.focus.includes(decisionId)
  return [
    what,
    `r${p.revision}`,
    shortId(p.id),
    ...(forDecision ? ['this decision'] : []),
    ...(p.status === 'blocked' ? ['blocked'] : []),
  ].join(' · ')
}

// ---------- the form ----------

const fieldClass =
  'w-full rounded-md border border-border-strong bg-surface px-2 text-sm placeholder:text-fg-subtle disabled:bg-surface-2'

/**
 * Plans a task from an accepted decision: title, description, acceptance criteria, an optional
 * context package and base commit, and the tasks it requires. It proposes the stated core.Task
 * with its relations and commits it; the task starts as proposed.
 */
export function CreateTaskForm({
  initialDraft,
  tasks,
  baseRevision,
  headingRef,
  onCreated,
  onCancel,
}: {
  initialDraft: TaskDraft
  tasks: readonly TaskView[]
  baseRevision: number
  headingRef?: RefObject<HTMLHeadingElement | null>
  onCreated: (taskId: string | null) => void
  onCancel: () => void
}) {
  const wb = useWorkbench()
  const decisions = useAcceptedDecisions(wb.projectId)
  const packages = useContextPackages(wb.projectId)
  const create = useCreateTask(wb.projectId)
  const notify = useToast()
  const [draft, dispatch] = useReducer(taskDraftReducer, initialDraft)
  const titleId = useId()
  const descriptionId = useId()
  const packageId = useId()
  const commitId = useId()
  const commitHintId = useId()
  const problemsId = useId()
  const problems = taskDraftProblems(draft)
  const busy = create.isPending
  const decisionList = decisions.data?.decisions ?? []
  const chosen = decisionList.find((d) => d.id === draft.decisionId)
  const outcome = create.data

  return (
    <Panel
      title={
        <span ref={headingRef} tabIndex={-1} className="outline-none">
          New task
        </span>
      }
      aside={
        <span className="text-fg-subtle text-xs">
          proposed against <span className="font-mono">r{baseRevision}</span> and committed
        </span>
      }
    >
      <form
        className="@container space-y-4 p-4"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault()
          if (problems.length > 0 || busy) return
          create.mutate(
            { draft, baseRevision },
            {
              onSuccess: (result) => {
                if ('committed' in result) {
                  notify({
                    tone: 'success',
                    title: 'Task created as proposed',
                    body: `${draft.title.trim()}. Mark it ready when agents may claim it.`,
                  })
                  onCreated(result.taskId)
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
      >
        <div className="space-y-2">
          <p className="font-medium text-xs">Accepted decision</p>
          {decisions.error ? (
            <ErrorNotice error={decisions.error} title="Decisions could not be loaded" />
          ) : decisions.isLoading ? (
            <Skeleton className="h-16" />
          ) : decisions.data === null ? (
            <p className="rounded-md border border-border border-dashed px-3 py-2 text-fg-muted text-xs">
              This server has no decisions route, so there is nothing a task can implement yet.
            </p>
          ) : decisionList.length === 0 ? (
            <div className="rounded-md border border-border border-dashed">
              <EmptyState icon={<Gavel />} title="No accepted decisions yet" className="py-6">
                A task implements an accepted decision. Accept an alternative in the Navigator
                first.
              </EmptyState>
            </div>
          ) : (
            <DecisionChoiceList
              decisions={decisionList}
              value={draft.decisionId}
              disabled={busy}
              onChoose={(decision) => dispatch({ type: 'chooseDecision', decision })}
            />
          )}
          {chosen && acceptedAlternatives(chosen).length > 0 && (
            <ImplementsChoice
              decision={chosen}
              value={draft.implementsId}
              disabled={busy}
              onChange={(id) => dispatch({ type: 'implements', id })}
            />
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor={titleId} className="block font-medium text-xs">
            Title{' '}
            <span className="font-normal text-fg-muted">
              {draft.decisionId ? '(from the decision; edit freely)' : '(required)'}
            </span>
          </label>
          <input
            id={titleId}
            value={draft.title}
            maxLength={TASK_TITLE_MAX}
            disabled={busy}
            required
            onChange={(e) => dispatch({ type: 'title', title: e.target.value })}
            placeholder="What the agent should do"
            className={cn(fieldClass, 'h-8')}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={descriptionId} className="block font-medium text-xs">
            Description <span className="font-normal text-fg-muted">(optional)</span>
          </label>
          <textarea
            id={descriptionId}
            value={draft.description}
            maxLength={TASK_DESCRIPTION_MAX}
            disabled={busy}
            rows={3}
            onChange={(e) => dispatch({ type: 'description', description: e.target.value })}
            placeholder="Scope, constraints and anything the agent should know"
            className={cn(fieldClass, 'resize-y py-1.5')}
          />
        </div>

        <CriteriaEditor
          criteria={draft.criteria}
          dispatch={dispatch}
          disabled={busy}
          placeholder="For example: every query filters by tenant"
        />

        <div className="grid gap-4 @2xl:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={packageId} className="block font-medium text-xs">
              Context package <span className="font-normal text-fg-muted">(optional)</span>
            </label>
            <select
              id={packageId}
              value={draft.contextPackageId}
              disabled={busy || !packages.data}
              onChange={(e) => dispatch({ type: 'contextPackage', id: e.target.value })}
              className={cn(fieldClass, 'select-control h-8')}
            >
              <option value="">None</option>
              {(packages.data?.packages ?? []).map((p) => (
                <option key={p.id} value={p.id} disabled={p.status === 'blocked'}>
                  {packageOptionLabel(p, draft.decisionId)}
                </option>
              ))}
            </select>
            <p className="text-fg-subtle text-xs">
              {packages.data === null
                ? 'This server does not list packages.'
                : 'The 20 newest packages compiled in Handoff. Blocked ones cannot be handed off.'}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={commitId} className="block font-medium text-xs">
              Base commit <span className="font-normal text-fg-muted">(optional)</span>
            </label>
            <input
              id={commitId}
              value={draft.baseCommit}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              maxLength={40}
              aria-describedby={commitHintId}
              onChange={(e) => dispatch({ type: 'baseCommit', value: e.target.value })}
              placeholder="40-character sha"
              className={cn(fieldClass, 'h-8 font-mono text-xs')}
            />
            <p id={commitHintId} className="text-fg-subtle text-xs">
              The agent starts here; the reported commit must descend from it.
            </p>
          </div>
        </div>

        <RequiresPicker
          tasks={tasks}
          value={draft.requires}
          disabled={busy}
          onToggle={(id) => dispatch({ type: 'toggleRequires', id })}
        />

        {create.isError && (
          <ErrorNotice
            error={create.error}
            title="The task was not proposed"
            resolveName={(id) => wb.model?.nameOf(id)}
            onSelect={wb.select}
          />
        )}
        {outcome && 'refused' in outcome && (
          <div className="space-y-1.5">
            <ErrorNotice
              error={outcome.refused}
              resolveName={(id) => wb.model?.nameOf(id)}
              onSelect={wb.select}
            />
            <p className="text-fg-muted text-xs">
              The task proposal is still pending.{' '}
              <AppLink to={{ view: 'proposals', proposal: outcome.proposalId }}>
                Review it in Proposals
              </AppLink>
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {problems.length > 0 && (
            <p id={problemsId} className="mr-auto text-fg-muted text-xs">
              {problems.join(' ')}
            </p>
          )}
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={problems.length > 0 || busy}
            aria-describedby={problems.length > 0 ? problemsId : undefined}
          >
            {busy ? (
              <Spinner className="border-accent-fg/40 border-t-accent-fg" label="Creating" />
            ) : (
              <ListPlus aria-hidden />
            )}
            Create task
          </Button>
        </div>
        <p className="text-fg-subtle text-xs">
          The task starts as proposed: agents cannot claim it until you mark it ready.
        </p>
      </form>
    </Panel>
  )
}
