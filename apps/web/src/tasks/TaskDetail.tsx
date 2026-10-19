import type { TaskView } from '@kalyth/contracts'
import { FlaskConical, GitCommitHorizontal, ShieldCheck } from 'lucide-react'
import { type ReactNode, type Ref, useId } from 'react'
import {
  BasisBadge,
  ReportOutcomeBadge,
  StatusBadge,
  TaskStatusBadge,
  TypeLabel,
  VerificationBadge,
} from '../components/badges.tsx'
import { CopyButton, ScrollRegion, SectionTitle } from '../components/ui.tsx'
import { plural, shortId, shortSha } from '../model/format.ts'
import { reportsNewestFirst, type TaskReport, taskStatusMeta, taskTrailer } from '../model/tasks.ts'
import { LeaseLine, type TaskLinks, When } from './TaskBoard.tsx'

// ---------- execution reports ----------

/** Tests the agent says it ran. Kalyth never runs analysed code, so these stay stated. */
export function ReportedTests({ tests }: { tests: TaskReport['tests'] }) {
  const captionId = useId()
  return (
    <div className="space-y-1">
      <p id={captionId} className="flex flex-wrap items-center gap-1.5 text-xs">
        <FlaskConical aria-hidden className="size-3.5 text-fg-subtle" />
        <span className="font-medium">Tests</span>
        <span className="text-fg-muted">reported by the agent, not run by Kalyth</span>
      </p>
      {tests.length === 0 ? (
        <p className="text-fg-subtle text-xs">None reported.</p>
      ) : (
        <ScrollRegion
          label="Reported tests"
          className="overflow-x-auto rounded-md border border-border scrollbar-thin"
        >
          <table aria-describedby={captionId} className="w-full text-left text-xs">
            <thead className="bg-surface-2 text-fg-muted">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  Command
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Passed
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Failed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tests.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: reported tests are an immutable, ordered list without ids
                <tr key={i} className="align-top">
                  <td className="px-2 py-1">
                    <code className="break-all font-mono text-fg">{t.command}</code>
                    {t.note && <span className="block break-words text-fg-muted">{t.note}</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{t.passed}</td>
                  <td
                    className={
                      t.failed > 0
                        ? 'tone-danger px-2 py-1 text-right font-medium text-tone-fg tabular-nums'
                        : 'px-2 py-1 text-right tabular-nums'
                    }
                  >
                    {t.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </div>
  )
}

/**
 * What Kalyth's git verifier observed about the reported commit: a fact about the task repository
 * within the checks it makes, never a claim that the code works.
 */
export function VerificationBlock({ verification }: { verification: TaskReport['verification'] }) {
  if (!verification) {
    return (
      <p className="rounded-md border border-border border-dashed px-3 py-2 text-fg-muted text-xs">
        Not verified: Kalyth’s git verifier has recorded nothing for this report.
      </p>
    )
  }
  return (
    <div className="tone-observed space-y-1 rounded-md border border-tone-bd bg-tone-bg/50 px-3 py-2">
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <ShieldCheck aria-hidden className="size-3.5 text-tone-fg" />
        <span className="font-medium">Verification</span>
        <VerificationBadge outcome={verification.outcome} size="sm" />
        <BasisBadge basis="observed" size="sm" />
        <span className="text-fg-muted">observed by Kalyth’s git verifier</span>
      </p>
      <p className="whitespace-pre-wrap break-words text-fg text-sm">{verification.summary}</p>
      <p className="text-fg-muted text-xs">
        It reads the task repository: the commit, its trailer, the files it changed and its base. It
        does not run the code or the tests.
      </p>
    </div>
  )
}

export function ReportCard({
  report,
  number,
  now,
}: {
  report: TaskReport
  number: number
  now?: number | undefined
}) {
  const headingId = useId()
  return (
    <article
      aria-labelledby={headingId}
      className="space-y-2.5 rounded-md border border-border p-3"
    >
      <header className="flex flex-wrap items-center gap-1.5">
        <h4 id={headingId} className="font-semibold text-xs">
          Report {number}
        </h4>
        <ReportOutcomeBadge outcome={report.outcome} size="sm" />
        <BasisBadge basis="stated" size="sm" />
        <span className="text-fg-muted text-xs">stated by the agent</span>
        <span className="ml-auto text-2xs text-fg-subtle">
          <When iso={report.reportedAt} now={now} />
          <span aria-hidden> · </span>
          <span className="font-mono">r{report.revision}</span>
        </span>
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">{report.summary}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-fg-muted">Commit</dt>
        <dd className="flex min-w-0 items-center gap-1">
          {report.commit ? (
            <>
              <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
              <code className="font-mono text-fg" title={report.commit}>
                {shortSha(report.commit)}
              </code>
              <CopyButton text={report.commit} label="Copy the commit sha" />
            </>
          ) : (
            <span className="text-fg-subtle">None reported</span>
          )}
        </dd>
        <dt className="text-fg-muted">Files changed</dt>
        <dd className="min-w-0">
          {report.filesChanged.length === 0 ? (
            <span className="text-fg-subtle">None reported</span>
          ) : (
            <details>
              <summary className="cursor-pointer text-fg">
                {plural(report.filesChanged.length, 'file')}
              </summary>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto scrollbar-thin">
                {report.filesChanged.map((f) => (
                  <li key={f} className="break-all font-mono text-[11.5px]">
                    {f}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </dd>
      </dl>
      <ReportedTests tests={report.tests} />
      <VerificationBlock verification={report.verification} />
    </article>
  )
}

/** Every report on a task, newest first, numbered in the order they came. */
export function ReportList({
  task,
  now,
}: {
  task: Pick<TaskView, 'reports'>
  now?: number | undefined
}) {
  const reports = reportsNewestFirst(task)
  if (reports.length === 0) {
    return (
      <p className="text-fg-muted text-sm">
        No execution reports yet. An agent reports over MCP with submit_execution_report after it
        commits its work.
      </p>
    )
  }
  return (
    <ol className="space-y-3">
      {reports.map((report, i) => (
        <li key={report.id}>
          <ReportCard report={report} number={reports.length - i} now={now} />
        </li>
      ))}
    </ol>
  )
}

// ---------- the task ----------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  )
}

function Links({ task, links }: { task: TaskView; links: TaskLinks }) {
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="text-fg-muted text-xs">Implements</dt>
        <dd>
          {task.implements.length === 0 ? (
            <span className="text-fg-subtle text-xs">Nothing recorded</span>
          ) : (
            <ul className="space-y-1">
              {task.implements.map((i) => (
                <li key={i.id} className="flex min-w-0 items-center gap-2">
                  <TypeLabel type={i.type} className="shrink-0 text-fg-muted text-xs" />
                  <span className="min-w-0 truncate">{links.record(i.id, i.label)}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-fg-muted text-xs">Requires</dt>
        <dd>
          {task.requires.length === 0 ? (
            <span className="text-fg-subtle text-xs">Nothing; it can start once ready</span>
          ) : (
            <ul className="space-y-1">
              {task.requires.map((r) => (
                <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <TypeLabel type={r.type} className="shrink-0 text-fg-muted text-xs" />
                  <span className="min-w-0 truncate">
                    {r.type === 'core.Task'
                      ? links.task(r.id, r.label)
                      : links.record(r.id, r.label)}
                  </span>
                  {r.satisfied ? (
                    <StatusBadge tone="success" label="Done" size="sm" prefix="Requirement:" />
                  ) : (
                    <StatusBadge
                      tone="warning"
                      label="Waiting for it"
                      description="Not completed or accepted yet; agents cannot claim this task until it is."
                      size="sm"
                      prefix="Requirement:"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  )
}

/**
 * A task in full: what to do, what it implements and waits for, who holds it, its context
 * package and every execution report with its verification. `actions` and `headerActions` are
 * slots for the container's controls.
 */
export function TaskDetailView({
  task,
  links,
  now,
  actions,
  headerActions,
  headingRef,
}: {
  task: TaskView
  links: TaskLinks
  now?: number | undefined
  actions?: ReactNode
  headerActions?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
}) {
  const headingId = useId()
  const status = taskStatusMeta(task.status)
  const trailer = taskTrailer(task.id)
  return (
    <section
      aria-labelledby={headingId}
      data-task-detail={task.id}
      className="@container rounded-lg border border-border bg-surface shadow-panel"
    >
      <header className="flex flex-wrap items-start gap-3 border-border border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <span className="font-mono text-2xs text-fg-subtle" title={task.id}>
              {shortId(task.id)}
            </span>
            <span className="font-mono text-2xs text-fg-subtle">r{task.revision}</span>
            <span className="text-2xs text-fg-subtle">
              Created <When iso={task.createdAt} now={now} />
              {task.updatedAt !== task.createdAt && (
                <>
                  , updated <When iso={task.updatedAt} now={now} />
                </>
              )}
            </span>
          </div>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="mt-1.5 break-words font-semibold text-[15px] text-fg leading-snug outline-none"
          >
            {task.title}
          </h2>
        </div>
        {headerActions && <div className="flex items-center gap-1">{headerActions}</div>}
      </header>

      <div className="grid items-start gap-5 p-4 @4xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-5">
          <Section title="Description">
            {task.description ? (
              <p className="whitespace-pre-wrap break-words text-sm">{task.description}</p>
            ) : (
              <p className="text-fg-subtle text-sm">No description.</p>
            )}
          </Section>
          <Section title="Acceptance criteria">
            {task.acceptanceCriteria.length === 0 ? (
              <p className="text-fg-subtle text-sm">None stated.</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-sm marker:text-fg-subtle">
                {task.acceptanceCriteria.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: criteria are an ordered list without ids
                  <li key={i} className="break-words">
                    {c}
                  </li>
                ))}
              </ol>
            )}
          </Section>
          <Section title="Status">
            <p className="text-sm">
              <span className="font-medium">{status.label}.</span>{' '}
              <span className="text-fg-muted">{status.description}</span>
            </p>
            {task.statusRationale ? (
              <p className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
                <span className="font-medium text-fg-muted">Rationale: </span>
                {task.statusRationale}
              </p>
            ) : (
              <p className="mt-1 text-fg-subtle text-xs">No rationale recorded.</p>
            )}
            {task.lease && (
              <div className="mt-2">
                <LeaseLine task={task} links={links} now={now} />
              </div>
            )}
          </Section>
          <Section title={`Execution reports (${task.reports.length})`}>
            <ReportList task={task} now={now} />
          </Section>
        </div>

        <div className="min-w-0 space-y-5">
          {actions}
          <Section title="Links">
            <Links task={task} links={links} />
          </Section>
          <Section title="Context package">
            {task.contextPackageId ? (
              <p className="text-sm">
                {links.contextPackage(
                  task.contextPackageId,
                  <span className="font-mono">{shortId(task.contextPackageId)}</span>,
                )}{' '}
                <span className="text-fg-muted text-xs">opens in Handoff</span>
              </p>
            ) : (
              <p className="text-fg-subtle text-sm">
                None chosen. When an agent claims the task, Kalyth gives it a context package for
                the task.
              </p>
            )}
          </Section>
          <Section title="Base commit">
            {task.baseCommit ? (
              <p className="flex items-center gap-1 text-sm">
                <code className="font-mono" title={task.baseCommit}>
                  {shortSha(task.baseCommit)}
                </code>
                <CopyButton text={task.baseCommit} label="Copy the base commit" />
                <span className="text-fg-muted text-xs">
                  the reported commit must descend from it
                </span>
              </p>
            ) : (
              <p className="text-fg-subtle text-sm">Not set.</p>
            )}
          </Section>
          <Section title="Commit trailer">
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[11.5px]">
                {trailer}
              </code>
              <CopyButton text={trailer} label="Copy the commit trailer" />
            </div>
            <p className="mt-1 text-fg-muted text-xs">
              The agent puts this line in its commit message, so the git verifier can find the work.
            </p>
          </Section>
        </div>
      </div>
    </section>
  )
}
