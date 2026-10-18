import type { ReactNode } from 'react'
import { Panel } from '../components/ui.tsx'
import { taskTrailer } from '../model/tasks.ts'

/** The MCP tools agents use for tasks (ADR 0013), in the order an agent meets them. */
export const AGENT_TASK_TOOLS: readonly { name: string; does: string }[] = [
  { name: 'list_tasks', does: 'lists the project’s tasks and their status' },
  { name: 'claim_task', does: 'takes a lease on a ready task and returns its context package' },
  { name: 'renew_task_lease', does: 'extends the lease while the work goes on' },
  { name: 'release_task', does: 'gives the task back before the lease runs out, with a reason' },
  {
    name: 'submit_execution_report',
    does: 'reports the outcome, the commit, the files changed and the tests run',
  },
]

/**
 * How agents work on tasks. Agents claim, renew, release and report over MCP only; this page
 * never does those for them. `handoffLink` is a link to the Handoff view, where tokens are issued.
 */
export function AgentTasksNote({ handoffLink }: { handoffLink: ReactNode }) {
  return (
    <Panel title="How agents work on tasks">
      <div className="space-y-2.5 p-4 text-sm">
        <p>
          Agents connect over MCP with an agent token. Issue one and copy the setup in {handoffLink}
          .
        </p>
        <ul className="space-y-1 text-xs">
          {AGENT_TASK_TOOLS.map((t) => (
            <li key={t.name}>
              <code className="font-mono text-fg">{t.name}</code>{' '}
              <span className="text-fg-muted">{t.does}</span>
            </li>
          ))}
        </ul>
        <p>
          Every commit for a task carries the trailer{' '}
          <code className="whitespace-nowrap rounded border border-border bg-surface-2 px-1 font-mono text-xs">
            {taskTrailer('<task id>')}
          </code>{' '}
          in its message.
        </p>
        <p className="text-fg-muted">
          Kalyth checks the commit in the task repository before the task can be completed: the
          verification moves it to review, and a person completes it. An agent never completes or
          cancels a task.
        </p>
      </div>
    </Panel>
  )
}
