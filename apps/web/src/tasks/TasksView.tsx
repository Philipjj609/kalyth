import type { TaskView } from '@kalyth/contracts'
import { Network, Plus, ScanSearch, SquareKanban, TriangleAlert, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  useAcceptedDecisions,
  useAgentTokens,
  useTask,
  useTaskRepository,
  useTasks,
} from '../api/queries.ts'
import { useAppLocation } from '../app/location.ts'
import { useSessionMode } from '../app/session.ts'
import { useWorkbench } from '../app/workbench.ts'
import { Button, EmptyState, Segmented, Skeleton, Tip } from '../components/ui.tsx'
import { shortId } from '../model/format.ts'
import { tokenLabeller } from '../model/handoff.ts'
import { draftFromDecision, EMPTY_TASK_DRAFT, type TaskDraft } from '../model/tasks.ts'
import { AppLink, ErrorNotice, RecordLink, ViewHeader } from '../views/shared.tsx'
import { AgentTasksNote } from './AgentTasksNote.tsx'
import { CreateTaskForm } from './CreateTaskForm.tsx'
import { DecisionsToPlan } from './DecisionsToPlan.tsx'
import { TaskActionsPanel } from './TaskActions.tsx'
import { TaskBoard, type TaskLinks } from './TaskBoard.tsx'
import { TaskDetailView } from './TaskDetail.tsx'
import { TASK_REPOSITORY_INPUT_ID, TaskRepositoryPanel } from './TaskRepositoryPanel.tsx'

// React Flow is only loaded when someone opens the graph.
const TaskGraph = lazy(() => import('./TaskGraph.tsx'))

/** Moves focus to the board card of a task, once it has rendered. */
function focusCard(taskId: string) {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-task-card="${taskId}"] a`)?.focus()
  })
}

/**
 * Tasks (ADR 0013): a board of the project's tasks by status, a task's detail with its execution
 * reports and the actions a person may take, a form to plan a task from an accepted decision, the
 * task repository and how agents work on tasks. A task is deep-linkable as ?view=tasks&task=obj_….
 * Tasks are always shown at the head.
 */
export function TasksView() {
  const demo = useSessionMode() === 'demo'
  const [loc, navigate] = useAppLocation()
  const wb = useWorkbench()
  const list = useTasks(wb.projectId)
  const tokens = useAgentTokens(wb.projectId)
  const decisions = useAcceptedDecisions(wb.projectId)
  const repository = useTaskRepository(wb.projectId)
  // The draft the form opens with; a new key remounts the form for each opening.
  const [creating, setCreating] = useState<{ draft: TaskDraft; key: number } | null>(null)
  const formHeading = useRef<HTMLHeadingElement>(null)
  const tasks = list.data?.tasks ?? []
  // Changes are proposed against the revision the person saw the tasks at.
  const baseRevision = list.data?.revision ?? wb.headRevision

  const links = useMemo<TaskLinks>(() => {
    const labelOf = tokenLabeller(tokens.data?.tokens)
    return {
      task: (taskId, children, className) => (
        <AppLink to={{ view: 'tasks', task: taskId }} className={className ?? ''}>
          {children}
        </AppLink>
      ),
      record: (id, children) => <RecordLink id={id}>{children}</RecordLink>,
      contextPackage: (packageId, children) => (
        <AppLink to={{ view: 'handoff', package: packageId }}>{children}</AppLink>
      ),
      holderLabelOf: labelOf,
    }
  }, [tokens.data])

  const openForm = (draft: TaskDraft) =>
    setCreating((prev) => ({ draft, key: (prev?.key ?? 0) + 1 }))

  // Bring the form into view and move focus to its heading each time it opens.
  useEffect(() => {
    if (!creating) return
    formHeading.current?.focus({ preventScroll: true })
    formHeading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [creating])

  const unavailable = list.data === null
  const repositoryUnset = repository.data?.path === null

  return (
    <div className="@container mx-auto w-full max-w-[1600px] space-y-4 p-6">
      <ViewHeader
        title="Tasks"
        description="Work for coding agents, planned from accepted decisions. Agents claim, renew and report over MCP; Kalyth checks their commits in the task repository, and a person completes each task. Always shown at the head."
      >
        <Button variant="primary" disabled={unavailable} onClick={() => openForm(EMPTY_TASK_DRAFT)}>
          <Plus aria-hidden />
          New task
        </Button>
      </ViewHeader>

      {repositoryUnset && !demo && (
        <p className="tone-warning flex flex-wrap items-center gap-2 rounded-md border border-tone-bd bg-tone-bg px-3 py-2 text-tone-fg text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          <span>
            No task repository is registered, so reports cannot be verified until you register one.
          </span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => {
              const input = document.getElementById(TASK_REPOSITORY_INPUT_ID)
              input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              input?.focus({ preventScroll: true })
            }}
          >
            Register one
          </Button>
        </p>
      )}

      {creating && (
        <CreateTaskForm
          key={creating.key}
          initialDraft={creating.draft}
          tasks={tasks}
          baseRevision={baseRevision}
          headingRef={formHeading}
          onCancel={() => setCreating(null)}
          onCreated={(taskId) => {
            setCreating(null)
            if (taskId) navigate({ task: taskId })
          }}
        />
      )}

      {list.error ? (
        <ErrorNotice error={list.error} title="Tasks could not be loaded" />
      ) : list.isLoading ? (
        <div className="flex gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 flex-1" />
          ))}
        </div>
      ) : unavailable ? (
        <div className="rounded-lg border border-border border-dashed bg-surface">
          <EmptyState icon={<SquareKanban />} title="This server has no task routes">
            The server answered that the task routes do not exist. Update and restart the Kalyth
            server to use tasks.
          </EmptyState>
        </div>
      ) : (
        <>
          {tasks.length === 0 && (
            <p className="text-fg-muted text-sm">
              No tasks yet. Plan one from an accepted decision below, or with New task.
            </p>
          )}
          <Segmented
            label="Show tasks as"
            value={loc.taskLayout ?? 'board'}
            options={[
              {
                value: 'board',
                label: (
                  <>
                    <SquareKanban aria-hidden className="size-3.5" /> Board
                  </>
                ),
              },
              {
                value: 'graph',
                label: (
                  <>
                    <Network aria-hidden className="size-3.5" /> Graph
                  </>
                ),
              },
            ]}
            onChange={(layout) =>
              navigate({ taskLayout: layout === 'graph' ? 'graph' : undefined }, 'replace')
            }
          />
          {loc.taskLayout === 'graph' ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <TaskGraph tasks={tasks} />
            </Suspense>
          ) : (
            <TaskBoard
              tasks={tasks}
              selectedId={loc.task}
              links={links}
              columnAction={(status) =>
                status === 'proposed' ? (
                  <Tip label="New task">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="New task"
                      onClick={() => openForm(EMPTY_TASK_DRAFT)}
                    >
                      <Plus aria-hidden />
                    </Button>
                  </Tip>
                ) : null
              }
            />
          )}
        </>
      )}

      {loc.task && !unavailable && (
        <TaskSection
          key={loc.task}
          taskId={loc.task}
          listed={tasks.find((t) => t.id === loc.task)}
          listLoaded={list.data !== undefined}
          baseRevision={baseRevision}
          links={links}
          onClose={() => {
            const id = loc.task
            navigate({ task: undefined })
            if (id) focusCard(id)
          }}
        />
      )}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {decisions.error ? (
          <ErrorNotice error={decisions.error} title="Accepted decisions could not be loaded" />
        ) : (
          <DecisionsToPlan
            decisions={
              decisions.data === undefined ? undefined : (decisions.data?.decisions ?? null)
            }
            tasks={tasks}
            onPlan={(decision) => openForm(draftFromDecision(decision))}
          />
        )}
        <div className="space-y-4">
          <TaskRepositoryPanel />
          <AgentTasksNote
            handoffLink={<AppLink to={{ view: 'handoff' }}>the Handoff view</AppLink>}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The open task. It comes from the board's list when it is there; a deep link to a task the list
 * does not hold reads it by id.
 */
function TaskSection({
  taskId,
  listed,
  listLoaded,
  baseRevision,
  links,
  onClose,
}: {
  taskId: string
  listed: TaskView | undefined
  listLoaded: boolean
  baseRevision: number
  links: TaskLinks
  onClose: () => void
}) {
  const wb = useWorkbench()
  const single = useTask(taskId, listLoaded && !listed)
  const task = listed ?? single.data
  const heading = useRef<HTMLHeadingElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const ready = task !== undefined

  // Bring the task into view and move focus to its heading when it opens.
  useEffect(() => {
    if (!ready) return
    heading.current?.focus({ preventScroll: true })
    container.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [ready])

  if (!task) {
    if (single.error) {
      return (
        <ErrorNotice error={single.error} title={`Task ${shortId(taskId)} could not be loaded`} />
      )
    }
    return <Skeleton className="h-48" />
  }
  if (task.projectId !== wb.projectId) {
    return (
      <p className="rounded-lg border border-border border-dashed bg-surface p-4 text-fg-muted text-sm">
        Task <span className="font-mono">{shortId(task.id)}</span> belongs to another project.
      </p>
    )
  }
  return (
    <div ref={container} className="scroll-mt-4">
      <TaskDetailView
        task={task}
        links={links}
        headingRef={heading}
        headerActions={
          <>
            <Tip label="Inspect the task record">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Inspect the task record"
                onClick={() => wb.select(task.id)}
              >
                <ScanSearch aria-hidden />
              </Button>
            </Tip>
            <Tip label="Close the task">
              <Button variant="ghost" size="icon-sm" aria-label="Close the task" onClick={onClose}>
                <X aria-hidden />
              </Button>
            </Tip>
          </>
        }
        actions={
          <TaskActionsPanel task={task} baseRevision={listed ? baseRevision : wb.headRevision} />
        }
      />
    </div>
  )
}
