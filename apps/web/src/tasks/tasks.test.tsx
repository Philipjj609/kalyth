import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatLocation, parseLocation } from '../app/location.ts'
import { TooltipProvider } from '../components/ui.tsx'
import { taskActions } from '../model/tasks.ts'
import { AGENT, acceptedDecision, PACKAGE_ID, tokenSummary } from '../test/handoff.ts'
import { ALT_A, DECISION, id, PERSON, PROJECT } from '../test/navigator.ts'
import {
  BASE_COMMIT,
  COMMIT,
  LEASE,
  report,
  runningTask,
  TASK,
  TASK_B,
  TASK_C,
  taskView,
} from '../test/tasks.ts'
import { AgentTasksNote } from './AgentTasksNote.tsx'
import { ImplementsChoice, packageOptionLabel, RequiresPicker } from './CreateTaskForm.tsx'
import { DecisionsToPlan, tasksImplementing } from './DecisionsToPlan.tsx'
import { StatusDialog, statusHint, TaskActionButtons } from './TaskActions.tsx'
import { LeaseLine, TaskBoard, TaskCard, type TaskLinks } from './TaskBoard.tsx'
import { ReportCard, ReportList, TaskDetailView } from './TaskDetail.tsx'
import { TaskRepositoryForm } from './TaskRepositoryPanel.tsx'

/** Visible text of static markup, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

// Principal names come from a query; with no server they stay short ids.
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  )

/** Plain links, so the views render without a browser location. */
const links: TaskLinks = {
  task: (taskId, children) => <a href={`?view=tasks&task=${taskId}`}>{children}</a>,
  record: (recordId, children) => <a href={`#inspect-${recordId}`}>{children}</a>,
  contextPackage: (packageId, children) => (
    <a href={`?view=handoff&package=${packageId}`}>{children}</a>
  ),
  holderLabelOf: (principalId) =>
    principalId === tokenSummary().principalId ? tokenSummary().label : undefined,
}

const NOW = Date.parse('2026-10-17T10:00:00.000Z')

// ---------- the board ----------

describe('task board', () => {
  const tasks = [
    taskView(),
    runningTask(),
    taskView({ id: TASK_C, title: 'Write the migration', status: 'review', reports: [report()] }),
  ]
  const html = render(<TaskBoard tasks={tasks} selectedId={TASK_B} links={links} now={NOW} />)
  const text = textOf(html)

  it('has one column per status, in flow order, with counts', () => {
    const order = [...html.matchAll(/data-column="([a-z_]+)"/g)].map((m) => m[1])
    // Folded columns are rendered twice (rail and full column); a container query shows one.
    expect([...new Set(order)]).toEqual([
      'proposed',
      'ready',
      'running',
      'review',
      'blocked',
      'unknown_outcome',
      'failed',
      'completed',
      'cancelled',
    ])
    expect(text).toContain('Proposed , 1 task')
    // Each column also carries its status description for screen readers.
    expect(text).toContain(
      'Ready , 0 tasks Agents can claim it once everything it requires is completed or accepted. No tasks',
    )
    expect(text).toContain('Running , 1 task')
    expect(text).toContain('Review , 1 task')
  })

  it('folds the empty columns after the first four into rails when space is short', () => {
    const rails = [...html.matchAll(/data-column="([a-z_]+)" data-collapsed="true"/g)].map(
      (m) => m[1],
    )
    expect(rails).toEqual(['blocked', 'unknown_outcome', 'failed', 'completed', 'cancelled'])
    expect(html).toContain('@min-[128rem]:hidden')
    expect(html).toContain('hidden @min-[128rem]:flex')
    expect(text).toContain('Completed , no tasks')
  })

  it('puts each task in its column and links its card to the task', () => {
    const running = text.slice(text.indexOf('Running , 1 task'), text.indexOf('Review , 1 task'))
    expect(running).toContain('Filter the base query')
    expect(html).toContain(`href="?view=tasks&amp;task=${TASK_B}"`)
    expect(html).toMatch(new RegExp(`aria-current="true" data-task-card="${TASK_B}"`))
  })

  it('shows what each card implements and what it waits for', () => {
    expect(text).toContain('Add tenant_id to Item Implements Tenancy model')
    expect(text).toContain(
      'Filter the base query Implements Tenant column Waiting for Add tenant_id to Item',
    )
    // A satisfied requirement is not waited for.
    expect(text).not.toContain('Waiting for Add tenant_id to Item, Tenancy model')
  })

  it('shows the latest report and its verification on the card', () => {
    expect(text).toContain(
      "Write the migration Implements Tenancy model Report Agent's report: Succeeded verified Git verification: Pass",
    )
  })

  it('shows when each card last changed, or when it was created if it has not changed', () => {
    expect(text).toContain('Add tenant_id to Item Implements Tenancy model Updated 20 minutes ago')
    expect(html).toContain('<time dateTime="2026-10-17T09:40:00.000Z" title="17 Oct 2026')
    const fresh = taskView({ updatedAt: '2026-10-17T08:00:00.000Z' })
    expect(
      textOf(render(<TaskCard task={fresh} selected={false} links={links} now={NOW} />)),
    ).toMatch(/Created 2 hours ago$/)
  })

  it('renders task text as text, never as markup', () => {
    const hostile = render(
      <TaskBoard
        tasks={[taskView({ title: '<img src=x onerror=alert(1)>' })]}
        links={links}
        now={NOW}
      />,
    )
    expect(hostile).not.toContain('<img')
    expect(hostile).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('lease on a running task', () => {
  it('shows the holder by its agent token label and when the lease expires', () => {
    const text = textOf(render(<LeaseLine task={runningTask()} links={links} now={NOW} />))
    expect(text).toBe('Held by Claude Code on my laptop · lease expires in 30 minutes')
    expect(text).not.toContain('Lease expired')
  })

  it('warns when the lease has expired', () => {
    const task = runningTask({ leaseExpired: true })
    const text = textOf(render(<LeaseLine task={task} links={links} now={NOW + 3_600_000} />))
    expect(text).toBe(
      'Lease expired Held by Claude Code on my laptop · lease expired 30 minutes ago',
    )
    const card = textOf(render(<TaskCard task={task} selected={false} links={links} />))
    expect(card).toContain('Lease expired')
  })

  it('falls back to the principal id when no token label is known, and names the last holder of an unknown outcome', () => {
    const stranger = runningTask({ lease: { ...LEASE, holder: id('pcp', 99) } })
    expect(textOf(render(<LeaseLine task={stranger} links={links} now={NOW} />))).toContain(
      'Held by pcp…000063',
    )
    const unknown = runningTask({ status: 'unknown_outcome', leaseExpired: false })
    expect(
      textOf(render(<LeaseLine task={unknown} links={links} now={NOW + 3_600_000} />)),
    ).toContain('Last held by Claude Code on my laptop ; its lease ended 30 minutes ago')
    expect(render(<LeaseLine task={taskView()} links={links} />)).toBe('')
  })
})

// ---------- reports and verification ----------

describe('execution reports', () => {
  it('shows outcome, summary, short commit, files, tests and the verification', () => {
    const html = render(<ReportCard report={report()} number={1} now={NOW} />)
    const text = textOf(html)
    expect(text).toContain(
      "Report 1 Agent's report: Succeeded Basis: Stated stated by the agent 30 minutes ago · r12 Added tenant_id to Item and filtered the base query.",
    )
    expect(html).toContain('<time dateTime="2026-10-17T09:30:00.000Z" title="17 Oct 2026')
    expect(text).toContain(`Commit ${COMMIT.slice(0, 8)}`)
    expect(text).toContain('Files changed 2 files app/models.py app/crud.py')
    expect(text).toContain(
      'Tests reported by the agent, not run by Kalyth Command Passed Failed pytest -q 41 0',
    )
    expect(text).toContain(
      'Verification Git verification: Pass Basis: Observed observed by Kalyth’s git verifier Commit found with the task trailer; the files changed match the report.',
    )
    expect(text).toContain('It does not run the code or the tests.')
  })

  it('says when there is no commit, no tests and no verification', () => {
    const bare = report({
      outcome: 'partial',
      commit: null,
      filesChanged: [],
      tests: [],
      verification: null,
    })
    const text = textOf(render(<ReportCard report={bare} number={2} />))
    expect(text).toContain("Report 2 Agent's report: Partial")
    expect(text).toContain('Commit None reported Files changed None reported')
    expect(text).toContain('Tests reported by the agent, not run by Kalyth None reported.')
    expect(text).toContain(
      'Not verified: Kalyth’s git verifier has recorded nothing for this report.',
    )
    expect(text).not.toContain('Basis: Observed')
  })

  it('marks failing verification and failed tests', () => {
    const failing = report({
      tests: [{ command: 'pytest', passed: 3, failed: 2, note: 'two flaky' }],
      verification: { id: id('obj', 9), outcome: 'fail', summary: 'Files changed differ.' },
    })
    const html = render(<ReportCard report={failing} number={1} />)
    expect(textOf(html)).toContain('pytest two flaky 3 2')
    expect(textOf(html)).toContain('Git verification: Fail')
    expect(html).toContain('tone-danger')
  })

  it('lists every report newest first, numbered in the order they came', () => {
    const task = taskView({
      reports: [
        report({ id: id('obj', 1), revision: 10, summary: 'First try' }),
        report({ id: id('obj', 2), revision: 12, summary: 'Second try' }),
      ],
    })
    const text = textOf(render(<ReportList task={task} />))
    expect(text.indexOf('Report 2')).toBeLessThan(text.indexOf('Report 1'))
    expect(text.indexOf('Second try')).toBeLessThan(text.indexOf('First try'))
    expect(textOf(render(<ReportList task={taskView()} />))).toContain('No execution reports yet.')
  })

  it('renders report text as text', () => {
    const html = render(
      <ReportCard report={report({ summary: '<script>alert(1)</script>' })} number={1} />,
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------- the detail ----------

describe('task detail', () => {
  const task = runningTask({ reports: [report()] })
  const html = render(
    <TaskDetailView task={task} links={links} now={NOW} actions={<p>ACTIONS</p>} />,
  )
  const text = textOf(html)

  it('shows when the task was created and last changed, and when each report came', () => {
    // textOf leaves a space where the closing time tag was, before the comma.
    expect(text).toContain('r11 Created 2 hours ago , updated 20 minutes ago Filter the base query')
    expect(html).toContain('</time>, updated <time dateTime="2026-10-17T09:40:00.000Z"')
    expect(text).toContain('stated by the agent 30 minutes ago · r12')
    const unchanged = textOf(
      render(
        <TaskDetailView
          task={taskView({ updatedAt: '2026-10-17T08:00:00.000Z' })}
          links={links}
          now={NOW}
        />,
      ),
    )
    expect(unchanged).toContain('r9 Created 2 hours ago Add tenant_id to Item')
  })

  it('shows the description, acceptance criteria and status rationale', () => {
    expect(text).toContain('Task status: Running')
    expect(text).toContain('Filter the base query')
    expect(html).toContain('Scope every read by tenant.\nKeep the migration reversible.')
    expect(text).toContain('Acceptance criteria Every query filters by tenant Existing tests pass')
    expect(text).toContain('Rationale: Claimed by the agent.')
    expect(text).toContain('Held by Claude Code on my laptop')
  })

  it('links what it implements and requires, marking what it waits for', () => {
    expect(html).toContain(`href="#inspect-${ALT_A}"`)
    expect(text).toContain('Implements Alternative Tenant column')
    expect(html).toContain(`href="?view=tasks&amp;task=${TASK}"`)
    expect(text).toContain('Task Add tenant_id to Item Requirement: Waiting for it')
    expect(html).toContain(`href="#inspect-${DECISION}"`)
    expect(text).toContain('Decision Tenancy model Requirement: Done')
  })

  it('links the context package to the Handoff view and shows the base commit and trailer', () => {
    expect(html).toContain(`href="?view=handoff&amp;package=${PACKAGE_ID}"`)
    expect(text).toContain(`Base commit ${BASE_COMMIT.slice(0, 8)}`)
    expect(text).toContain(`Commit trailer Kalyth-Task: ${TASK_B}`)
    expect(text).toContain('Execution reports (1) Report 1')
    expect(text).toContain('ACTIONS')
  })

  it('says plainly that an expired lease is no longer worked on and what the next claim does', () => {
    const expired = runningTask({ leaseExpired: true })
    const detail = textOf(
      render(<TaskDetailView task={expired} links={links} now={NOW + 3_600_000} />),
    )
    expect(detail).toContain(
      'Status Running, lease expired. The lease has expired. The next claim checks git for a commit with this task’s trailer first.',
    )
    expect(detail).not.toContain('An agent holds a lease on it')
    expect(detail).toContain('lease expired 30 minutes ago')
    expect(statusHint(expired)).toBe(
      'The lease has expired: marking it ready here skips the git check the next claim makes.',
    )
    // While the lease holds, the task reads as before.
    expect(text).toContain('Running. An agent holds a lease on it and is working on it.')
    expect(statusHint(runningTask())).toMatch(/^An agent holds the lease\./)
  })

  it('says what is missing on a bare task', () => {
    const bare = textOf(
      render(
        <TaskDetailView
          task={taskView({ description: null, acceptanceCriteria: [], implements: [] })}
          links={links}
        />,
      ),
    )
    expect(bare).toContain('No description.')
    expect(bare).toContain('Acceptance criteria None stated.')
    expect(bare).toContain('No rationale recorded.')
    expect(bare).toContain('Context package None chosen.')
    expect(bare).toContain('Base commit Not set.')
    expect(bare).toContain('Requires Nothing; it can start once ready')
  })
})

// ---------- actions ----------

describe('task actions', () => {
  const buttons = (status: Parameters<typeof taskActions>[0]) =>
    textOf(render(<TaskActionButtons status={status} onChoose={() => {}} />))

  it('offers the actions for the current status and none to running', () => {
    expect(buttons('proposed')).toBe('Mark ready… Cancel task…')
    expect(buttons('ready')).toBe('Block… Cancel task…')
    expect(buttons('running')).toBe('Mark ready… Block… Fail…')
    expect(buttons('review')).toBe('Complete… Send back… Fail…')
    expect(buttons('blocked')).toBe('Unblock… Cancel task…')
    expect(buttons('failed')).toBe('Mark ready… Cancel task…')
    expect(buttons('unknown_outcome')).toBe('Mark ready… Fail… Cancel task…')
    expect(buttons('completed')).toBe('Completed is final: the task cannot change again.')
    expect(buttons('cancelled')).toBe('Cancelled is final: the task cannot change again.')
  })

  it('asks for a rationale, with the complete note and the latest verification', () => {
    const task = taskView({ status: 'review', reports: [report()] })
    const complete = taskActions('review')[0] ?? null
    const html = render(
      <StatusDialog
        task={task}
        action={complete}
        pending={false}
        error={null}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    )
    const text = textOf(html)
    expect(text).toContain('Complete: “Add tenant_id to Item”')
    expect(text).toContain('The repository shows the work; you confirm it. Completing is final.')
    expect(text).toContain(
      "Latest report Agent's report: Succeeded git verification Git verification: Pass",
    )
    expect(text).toContain('Review → Completed.')
    expect(text).toContain('Rationale (required)')
    expect(html).toMatch(/<textarea[^>]*required/)
    expect(
      render(
        <StatusDialog
          task={task}
          action={null}
          pending={false}
          error={null}
          onSubmit={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toContain('Rationale')
  })

  it('hints at what the status means for people', () => {
    expect(statusHint(taskView())).toContain('Mark it ready when they may.')
    expect(statusHint(taskView({ status: 'review' }))).toContain(
      'Only a person completes the task.',
    )
    expect(statusHint(taskView({ status: 'completed' }))).toBeNull()
  })
})

// ---------- creating ----------

describe('task form pieces', () => {
  it('chooses between the decision and its accepted alternative', () => {
    const html = render(
      <ImplementsChoice decision={acceptedDecision()} value={ALT_A} onChange={() => {}} />,
    )
    const text = textOf(html)
    expect(text).toContain(
      'It implements The decision: Tenancy model Its accepted alternative: Tenant column',
    )
    // The rejected alternative is not offered.
    expect(text).not.toContain('Database per tenant')
    expect(html.match(/checked=""/g)).toHaveLength(1)
  })

  it('offers existing tasks as requirements, without cancelled ones', () => {
    const text = textOf(
      render(
        <RequiresPicker
          tasks={[
            taskView(),
            taskView({ id: TASK_B, title: 'Dropped', status: 'cancelled' }),
            taskView({ id: TASK_C, title: 'Done already', status: 'completed', revision: 2 }),
          ]}
          value={[TASK]}
          onToggle={() => {}}
        />,
      ),
    )
    expect(text).toContain(
      'Add tenant_id to Item Task status: Proposed Done already Task status: Completed',
    )
    expect(text).not.toContain('Dropped')
    expect(textOf(render(<RequiresPicker tasks={[]} value={[]} onToggle={() => {}} />))).toContain(
      'No other tasks yet.',
    )
  })

  it('labels context packages, marking the chosen decision’s and blocked ones', () => {
    const pkg = {
      id: PACKAGE_ID,
      revision: 7,
      status: 'ready' as const,
      focus: [DECISION],
      taskTitle: 'Add tenant isolation',
      items: 5,
      chars: 18_240,
      firstCompiledAt: '2026-10-17T08:00:00.000Z',
    }
    expect(packageOptionLabel(pkg, DECISION)).toBe(
      `Add tenant isolation · r7 · ctx…${PACKAGE_ID.slice(-6)} · this decision`,
    )
    expect(packageOptionLabel({ ...pkg, taskTitle: null, status: 'blocked' }, null)).toBe(
      `Focus on 1 element · r7 · ctx…${PACKAGE_ID.slice(-6)} · blocked`,
    )
  })

  it('lists accepted decisions with how many tasks implement each', () => {
    const tasks = [taskView(), runningTask()]
    expect(tasksImplementing(acceptedDecision(), tasks)).toBe(2)
    const text = textOf(
      render(<DecisionsToPlan decisions={[acceptedDecision()]} tasks={tasks} onPlan={() => {}} />),
    )
    expect(text).toContain(
      'Tenancy model Accepted: Tenant column · 2 tasks Create a task for Tenancy model',
    )
    const none = textOf(render(<DecisionsToPlan decisions={[]} tasks={[]} onPlan={() => {}} />))
    expect(none).toContain('No accepted decisions yet')
  })
})

// ---------- the task repository and agents ----------

describe('task repository panel', () => {
  const save = { saving: false, error: null, onSave: () => {} }

  it('says reports cannot be verified until a repository is registered, and asks for a path', () => {
    const html = render(
      <TaskRepositoryForm
        repository={{ projectId: PROJECT, path: null, setBy: null, setAt: null }}
        {...save}
      />,
    )
    const text = textOf(html)
    expect(text).toContain('Not set: reports cannot be verified until you register one.')
    expect(text).toContain('Repository path')
    expect(text).toContain('Register')
    expect(html).toContain('id="task-repository-path"')
  })

  it('shows the registered path with who set it, and offers to change it', () => {
    const text = textOf(
      render(
        <TaskRepositoryForm
          repository={{
            projectId: PROJECT,
            path: 'C:\\src\\fastapi-app',
            setBy: PERSON,
            setAt: '2026-10-17T09:00:00.000Z',
          }}
          {...save}
        />,
      ),
    )
    expect(text).toContain('Path C:\\src\\fastapi-app')
    expect(text).toContain('Set by pcp…000002')
    expect(text).toContain('Change')
    expect(text).not.toContain('Not set')
    expect(text).not.toContain('Repository path')
  })

  it('explains a server without task routes, and shows a refusal', () => {
    expect(textOf(render(<TaskRepositoryForm repository={null} {...save} />))).toContain(
      'This server has no task routes.',
    )
    const refused = textOf(
      render(
        <TaskRepositoryForm
          repository={{ projectId: PROJECT, path: null, setBy: null, setAt: null }}
          saving={false}
          error={{ message: 'not a git repository' }}
          onSave={() => {}}
        />,
      ),
    )
    expect(refused).toContain('The task repository was not registered')
  })
})

describe('how agents work on tasks', () => {
  it('names the token, the MCP tools, the trailer and the check before completion', () => {
    const text = textOf(
      render(<AgentTasksNote handoffLink={<a href="?view=handoff">the Handoff view</a>} />),
    )
    expect(text).toContain('Agents connect over MCP with an agent token.')
    expect(text).toContain('the Handoff view')
    for (const tool of [
      'list_tasks',
      'claim_task',
      'renew_task_lease',
      'release_task',
      'submit_execution_report',
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).toContain('Kalyth-Task: <task id>')
    expect(text).toContain(
      'Kalyth checks the commit in the task repository before the task can be completed',
    )
  })
})

describe('tasks location', () => {
  it('deep-links a task in the Tasks view only', () => {
    const loc = parseLocation(`?project=${PROJECT}&view=tasks&task=${TASK}`)
    expect(loc.view).toBe('tasks')
    expect(loc.task).toBe(TASK)
    expect(formatLocation(loc)).toBe(`?project=${PROJECT}&view=tasks&task=${TASK}`)
    expect(formatLocation({ ...loc, view: 'handoff' })).toBe(`?project=${PROJECT}&view=handoff`)
    expect(parseLocation('?view=tasks&task=not-a-task').task).toBeUndefined()
    expect(parseLocation(`?view=tasks&task=${AGENT}`).task).toBeUndefined()
  })
})
