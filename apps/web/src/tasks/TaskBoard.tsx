import type { TaskView } from '@kalyth/contracts'
import { Hourglass, TimerOff } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import {
  ReportOutcomeBadge,
  StatusBadge,
  taskStatusIcon,
  VerificationBadge,
} from '../components/badges.tsx'
import { cn } from '../lib/cn.ts'
import { absoluteTime, plural, relativeTime, shortId } from '../model/format.ts'
import {
  boardColumns,
  latestReport,
  TASK_STATUS_META,
  type BoardColumn as TaskColumn,
  unmetRequirements,
} from '../model/tasks.ts'

/**
 * How the task views reach the rest of the workbench. Passed in, so the board and the detail stay
 * presentational: the Tasks view gives real links, tests give plain markup.
 */
export interface TaskLinks {
  /** A link that opens a task's detail (?view=tasks&task=…). */
  task: (taskId: string, children: ReactNode, className?: string) => ReactNode
  /** Opens any other record, for example in the Inspector. */
  record: (id: string, children: ReactNode) => ReactNode
  /** The Handoff view's deep link to a context package. */
  contextPackage: (packageId: string, children: ReactNode) => ReactNode
  /** The label of the agent token whose principal holds a lease, when it is one of them. */
  holderLabelOf: (principalId: string) => string | undefined
}

/** "Claude Code on my laptop", or the principal's short id when no token label is known. */
export function HolderName({
  holder,
  links,
}: {
  holder: string
  links: Pick<TaskLinks, 'holderLabelOf'>
}) {
  const label = links.holderLabelOf(holder)
  return label ? (
    <span className="font-medium text-fg" title={holder}>
      {label}
    </span>
  ) : (
    <span className="font-mono text-fg" title={holder}>
      {shortId(holder)}
    </span>
  )
}

/** A time as "5 minutes ago", with the exact time on hover. */
export function When({ iso, now }: { iso: string; now?: number | undefined }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  )
}

/** When the task last changed, or when it was created if it has not changed since. */
export function UpdatedLine({
  task,
  now,
}: {
  task: Pick<TaskView, 'createdAt' | 'updatedAt'>
  now?: number | undefined
}) {
  const changed = task.updatedAt !== task.createdAt
  return (
    <p className="text-2xs text-fg-subtle">
      {changed ? 'Updated' : 'Created'}{' '}
      <When iso={changed ? task.updatedAt : task.createdAt} now={now} />
    </p>
  )
}

export function LeaseExpiredBadge() {
  return (
    <StatusBadge
      tone="danger"
      icon={TimerOff}
      label="Lease expired"
      description="The holder did not renew its lease in time. The next claim checks git for its commit before anyone works on it again."
      size="sm"
    />
  )
}

/**
 * Who holds the task and until when. Running tasks carry a lease; an unknown outcome keeps the
 * last holder's lease so it can still report.
 */
export function LeaseLine({
  task,
  links,
  now,
}: {
  task: Pick<TaskView, 'status' | 'lease' | 'leaseExpired'>
  links: Pick<TaskLinks, 'holderLabelOf'>
  now?: number | undefined
}) {
  const lease = task.lease
  if (!lease) return null
  const expiry = <When iso={lease.expiresAt} now={now} />
  if (task.status !== 'running') {
    return (
      <p className="text-fg-muted text-xs">
        Last held by <HolderName holder={lease.holder} links={links} />; its lease ended {expiry}.
      </p>
    )
  }
  return (
    <div className="space-y-1">
      {task.leaseExpired && <LeaseExpiredBadge />}
      <p className="flex flex-wrap items-center gap-x-1 text-fg-muted text-xs">
        <Hourglass aria-hidden className="size-3 shrink-0" />
        <span>
          Held by <HolderName holder={lease.holder} links={links} />
        </span>
        <span aria-hidden>·</span>
        <span>
          {task.leaseExpired ? 'lease expired' : 'lease expires'} {expiry}
        </span>
      </p>
    </div>
  )
}

/** The latest report's outcome and what the git verifier made of it. */
export function LatestReportLine({ task }: { task: Pick<TaskView, 'reports'> }) {
  const report = latestReport(task)
  if (!report) return null
  return (
    <p className="flex flex-wrap items-center gap-1 text-fg-muted text-xs">
      <span>Report</span>
      <ReportOutcomeBadge outcome={report.outcome} size="sm" />
      {report.verification ? (
        <>
          <span>verified</span>
          <VerificationBadge outcome={report.verification.outcome} size="sm" />
        </>
      ) : (
        <span>not verified</span>
      )}
    </p>
  )
}

export function TaskCard({
  task,
  selected,
  links,
  now,
}: {
  task: TaskView
  selected: boolean
  links: TaskLinks
  now?: number | undefined
}) {
  const titleId = useId()
  const unmet = unmetRequirements(task)
  return (
    <article
      aria-labelledby={titleId}
      aria-current={selected ? 'true' : undefined}
      data-task-card={task.id}
      className={cn(
        'relative space-y-1.5 rounded-md border bg-surface px-3 py-2.5 shadow-panel transition-colors hover:border-border-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-focus',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-border',
      )}
    >
      <h3 id={titleId} className="break-words font-medium text-sm leading-snug">
        {links.task(
          task.id,
          task.title,
          // The link covers the card, so the whole card opens the task.
          "text-fg no-underline outline-none after:absolute after:inset-0 after:rounded-md after:content-['']",
        )}
      </h3>
      {task.implements.length > 0 && (
        <p className="line-clamp-2 break-words text-fg-muted text-xs">
          Implements{' '}
          <span className="text-fg">{task.implements.map((i) => i.label).join(', ')}</span>
        </p>
      )}
      {unmet.length > 0 && (
        <p className="tone-warning rounded border border-tone-bd bg-tone-bg px-1.5 py-0.5 text-tone-fg text-xs">
          <span className="font-medium">Waiting for</span> {unmet.map((r) => r.label).join(', ')}
        </p>
      )}
      <LeaseLine task={task} links={links} now={now} />
      <LatestReportLine task={task} />
      <UpdatedLine task={task} now={now} />
    </article>
  )
}

function ColumnHeading({ column, id }: { column: TaskColumn; id: string }) {
  const meta = TASK_STATUS_META[column.status]
  const Icon = taskStatusIcon(column.status)
  return (
    <h2 id={id} className="flex min-w-0 items-center gap-1.5 font-semibold text-fg text-xs">
      {Icon && (
        <span className={cn(`tone-${meta.tone}`, 'text-tone-fg')}>
          <Icon aria-hidden className="size-3.5" />
        </span>
      )}
      <span className="truncate">{meta.label}</span>
      <span className="font-normal text-fg-subtle tabular-nums">
        <span className="sr-only">, </span>
        {plural(column.tasks.length, 'task')}
      </span>
    </h2>
  )
}

function Column({
  column,
  selectedId,
  links,
  now,
  className,
  action,
}: {
  column: TaskColumn
  selectedId: string | undefined
  links: TaskLinks
  now?: number | undefined
  className?: string
  action?: ReactNode
}) {
  const headingId = useId()
  const meta = TASK_STATUS_META[column.status]
  return (
    <section
      aria-labelledby={headingId}
      data-column={column.status}
      className={cn(
        'flex min-w-[13.5rem] flex-1 basis-0 flex-col rounded-lg border border-border bg-surface-2/60',
        className,
      )}
    >
      <header className="flex min-h-10 items-center gap-2 border-border border-b px-3 py-1.5">
        <ColumnHeading column={column} id={headingId} />
        {action && <span className="ml-auto">{action}</span>}
      </header>
      <p className="sr-only">{meta.description}</p>
      {column.tasks.length === 0 ? (
        <p className="px-3 py-4 text-fg-subtle text-xs">No tasks</p>
      ) : (
        <ul className="max-h-[560px] space-y-2 overflow-y-auto p-2 scrollbar-thin">
          {column.tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} selected={task.id === selectedId} links={links} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** An empty column folded to a narrow rail, so the main columns keep their room. */
function Rail({ column, className }: { column: TaskColumn; className?: string }) {
  const meta = TASK_STATUS_META[column.status]
  return (
    <section
      data-column={column.status}
      data-collapsed="true"
      title={`${meta.label}: no tasks. ${meta.description}`}
      className={cn(
        'flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border border-border border-dashed bg-surface-2/40 py-3',
        className,
      )}
    >
      <h2 className="rotate-180 whitespace-nowrap font-medium text-fg-muted text-xs [writing-mode:vertical-rl]">
        {meta.label}
        <span className="sr-only">, no tasks</span>
      </h2>
    </section>
  )
}

/**
 * One column per status, in the order the work flows. Empty columns other than the first four fold
 * to a rail when the board is narrower than all nine columns; the board scrolls sideways if it must.
 * `columnAction` adds a control to a column header, such as "New task" on Proposed.
 */
export function TaskBoard({
  tasks,
  selectedId,
  links,
  now,
  columnAction,
}: {
  tasks: readonly TaskView[]
  selectedId?: string | undefined
  links: TaskLinks
  now?: number | undefined
  columnAction?: (status: TaskColumn['status']) => ReactNode
}) {
  const columns = boardColumns(tasks)
  return (
    <div className="@container">
      <div className="flex items-start gap-3 overflow-x-auto pb-2 scrollbar-thin">
        {columns.map((column) =>
          column.collapsible ? (
            // Both forms are rendered; a container query shows one. The hidden one is display:none,
            // so assistive technology meets each column once.
            <div key={column.status} className="contents">
              <Rail column={column} className="@min-[128rem]:hidden" />
              <Column
                column={column}
                selectedId={selectedId}
                links={links}
                now={now}
                className="hidden @min-[128rem]:flex"
              />
            </div>
          ) : (
            <Column
              key={column.status}
              column={column}
              selectedId={selectedId}
              links={links}
              now={now}
              action={columnAction?.(column.status)}
            />
          ),
        )}
      </div>
    </div>
  )
}
