import type { ReconcileResult, ReportResult } from '@kalyth/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isApiError } from '../api/client.ts'
import { TooltipProvider } from '../components/ui.tsx'
import { taskActions } from '../model/tasks.ts'
import { DECISION, id, PROJECT } from '../test/navigator.ts'
import { COMMIT, report, runningTask, TASK, taskView } from '../test/tasks.ts'
import { createTaskApi } from './api.ts'
import {
  canFileReport,
  canReconcile,
  FiledVerdict,
  FileReportForm,
  parseFiles,
  ReconcileSummary,
  reportBody,
  reportDraftProblems,
} from './FollowUp.tsx'
import { discardsFinding, StatusDialog, statusHint } from './TaskActions.tsx'
import type { TaskLinks } from './TaskBoard.tsx'
import { ReportCard, TaskDetailView } from './TaskDetail.tsx'

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

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

const links: TaskLinks = {
  task: (taskId, children) => <a href={`?view=tasks&task=${taskId}`}>{children}</a>,
  record: (recordId, children) => <a href={`#inspect-${recordId}`}>{children}</a>,
  contextPackage: (packageId, children) => (
    <a href={`?view=handoff&package=${packageId}`}>{children}</a>
  ),
  holderLabelOf: () => undefined,
}

const FOUND = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const PROMPT = `Work on Kalyth task ${TASK}: "Add tenant_id to Item".\n\n1. Call claim_task …`

describe('task detail (ADR 0024)', () => {
  it('says which commit git found, and gives the prompt for an agent', () => {
    const task = taskView({
      status: 'unknown_outcome',
      finding: { commits: [FOUND, COMMIT] },
      agentPrompt: PROMPT,
    })
    const text = textOf(render(<TaskDetailView task={task} links={links} />))
    expect(text).toContain(
      'Git found commit c0ffee00 with this task’s trailer, and 1 earlier commit.',
    )
    expect(text).toContain('marking the task ready discards this finding')
    expect(text).toContain(`Prompt for an agent Work on Kalyth task ${TASK}`)
    expect(text).toContain('It holds no token')
    // A final task takes no more work, so it offers no prompt.
    const done = textOf(
      render(<TaskDetailView task={{ ...task, status: 'completed' }} links={links} />),
    )
    expect(done).not.toContain('Prompt for an agent')
  })

  it('says who stated a report a person filed', () => {
    const text = textOf(
      render(<ReportCard report={report({ filedBy: id('pcp', 1) })} number={1} />),
    )
    expect(text).toContain('stated by a person')
    expect(text).toContain('Tests reported by a person, not run by Kalyth')
    expect(textOf(render(<ReportCard report={report()} number={1} />))).toContain(
      'stated by the agent',
    )
  })
})

describe('marking ready a task with a finding', () => {
  const task = taskView({ status: 'unknown_outcome', finding: { commits: [FOUND] } })
  const ready = taskActions('unknown_outcome').find((a) => a.to === 'ready') ?? null

  it('warns that it discards the finding, in the dialog’s description', () => {
    const html = render(
      <StatusDialog
        task={task}
        action={ready}
        pending={false}
        error={null}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    )
    const text = textOf(html)
    expect(text).toContain(
      'Git found commit c0ffee00 with this task’s trailer. Marking the task ready discards that finding: the next agent starts the work again and is not told about the commit.',
    )
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1]?.split(' ') ?? []
    expect(described).toHaveLength(2)
    expect(statusHint(task)).toMatch(/git shows commit c0ffee00 /)
  })

  it('says nothing more when git found nothing, and names the loss for other actions', () => {
    expect(discardsFinding(taskView({ status: 'unknown_outcome' }), 'ready')).toBeNull()
    expect(discardsFinding(task, 'failed')).toMatch(/This discards that finding/)
    const html = render(
      <StatusDialog
        task={taskView({ status: 'unknown_outcome' })}
        action={ready}
        pending={false}
        error={null}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    )
    expect(textOf(html)).not.toContain('Git found')
  })
})

describe('a person’s report', () => {
  it('is offered on a ready task, an unknown outcome or an expired lease', () => {
    expect(canFileReport(taskView({ status: 'ready' }))).toBe(true)
    expect(canFileReport(taskView({ status: 'unknown_outcome' }))).toBe(true)
    expect(canFileReport(runningTask())).toBe(false)
    expect(canFileReport(runningTask({ leaseExpired: true }))).toBe(true)
    expect(canFileReport(taskView({ status: 'review' }))).toBe(false)
  })

  it('checks the draft and sends the files one per line', () => {
    expect(parseFiles(' app/models.py\r\n\napp/crud.py\napp/models.py ')).toEqual([
      'app/models.py',
      'app/crud.py',
    ])
    const draft = { commit: 'abc', files: '', summary: ' ', outcome: 'succeeded' as const }
    expect(reportDraftProblems(draft)).toEqual([
      'The commit must be a full 40-character sha.',
      'List at least one file the work changed.',
      'Say in a sentence what the work did.',
    ])
    const ok = { ...draft, commit: ` ${COMMIT} `, files: 'app/models.py', summary: ' Done. ' }
    expect(reportDraftProblems(ok)).toEqual([])
    expect(reportBody(ok, 'person-0001')).toEqual({
      idempotencyKey: 'person-0001',
      outcome: 'succeeded',
      summary: 'Done.',
      commit: COMMIT,
      filesChanged: ['app/models.py'],
      tests: [],
    })
  })

  it('opens prefilled with the commit git found, with every field labelled', () => {
    const html = render(
      <FileReportForm
        initialCommit={FOUND}
        pending={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain(`value="${FOUND}"`)
    const text = textOf(html)
    for (const label of ['Commit sha', 'Files changed, one per line', 'Summary', 'Outcome']) {
      expect(text).toContain(label)
    }
    expect(text).toContain('A pass moves the task to review.')
  })

  it('shows the verdict check by check', () => {
    const result: ReportResult = {
      task: taskView({ status: 'ready' }),
      reportId: id('obj', 900),
      verification: {
        id: id('obj', 901),
        outcome: 'fail',
        checks: [
          { name: 'commit exists', ok: true, detail: COMMIT },
          { name: 'files changed', ok: false, detail: 'changed but not reported: app/crud.py' },
        ],
      },
      duplicate: false,
    }
    const text = textOf(render(<FiledVerdict result={result} />))
    expect(text).toContain('Report filed. Git verification')
    expect(text).toContain('The task did not move.')
    expect(text).toContain('failed files changed: changed but not reported: app/crud.py')
  })
})

describe('reconciliation', () => {
  const MODULE = id('obj', 801)
  const PROPOSED = id('obj', 802)
  const OBSERVED = id('obj', 803)
  const result: ReconcileResult = {
    taskId: TASK,
    projectId: PROJECT,
    report: { id: id('obj', 711), commit: COMMIT, filesChanged: ['app/routes/items.py'] },
    analysis: {
      repo: 'fixture-app',
      commit: COMMIT,
      status: 'analysed',
      detail: "the analyzer's observations of 1a2b3c4d5e6f were committed as r14",
      proposalId: id('prp', 1),
      created: 2,
      refreshed: 1,
      unchanged: 30,
    },
    revision: 14,
    decisions: [
      {
        id: DECISION,
        title: 'Create items',
        status: 'accepted',
        alternatives: [{ id: id('obj', 800), title: 'A POST route', status: 'accepted' }],
        changes: [
          {
            relationId: id('rel', 1),
            alternativeId: id('obj', 800),
            target: MODULE,
            label: 'app/routes/items.py',
            type: 'software.Module',
            proposed: false,
            change: 'add the handler',
            touched: true,
            files: ['app/routes/items.py'],
            observed: null,
            details: [],
          },
          {
            relationId: id('rel', 2),
            alternativeId: id('obj', 800),
            target: PROPOSED,
            label: 'POST /items',
            type: 'software.Endpoint',
            proposed: true,
            change: 'new endpoint',
            touched: false,
            files: [],
            observed: null,
            details: [],
          },
        ],
        touched: 1,
        changed: 0,
        proposed: [
          {
            id: PROPOSED,
            type: 'software.Endpoint',
            label: 'POST /items',
            match: { id: OBSERVED, label: 'POST /items/', inCommit: true },
            link: { state: 'pending', relationId: null, proposalId: id('prp', 2), created: true },
          },
        ],
      },
    ],
    observed: null,
  }

  it('says what the commit touched and links the pending proposal', () => {
    const html = render(
      <ReconcileSummary
        result={result}
        proposalLink={(proposalId, children) => (
          <a href={`?view=proposals&proposal=${proposalId}`}>{children}</a>
        )}
      />,
    )
    const text = textOf(html)
    expect(text).toContain("Analysed: the analyzer's observations of 1a2b3c4d5e6f were committed")
    expect(text).toContain('Create items The commit touched 1 of 2 direct changes.')
    expect(text).toContain('Touched app/routes/items.py app/routes/items.py')
    expect(text).toContain('Proposed POST /items')
    expect(text).toContain(
      'POST /items is now observed as POST /items/ (link proposed, waiting for you: review it in Proposals )',
    )
    expect(html).toContain(`href="?view=proposals&amp;proposal=${id('prp', 2)}"`)
  })

  it('says what the source shows for each change, and what changed beyond the decision', () => {
    const [decision] = result.decisions
    if (!decision) throw new Error('no decision')
    const [module, endpoint] = decision.changes
    if (!module || !endpoint) throw new Error('no changes')
    const observed: ReconcileResult = {
      ...result,
      observed: {
        base: '0'.repeat(40),
        commit: COMMIT,
        analyzer: 'kalyth-analyzer 0.3.0',
        elementsChanged: 2,
        modulesChanged: 1,
        unplanned: [
          {
            key: 'entity:Team',
            type: 'software.DataEntity',
            label: 'Team',
            change: 'added',
            sourceChanged: true,
            details: ['observed in app/models.py:4-6'],
          },
        ],
        note: null,
      },
      decisions: [
        {
          ...decision,
          changed: 1,
          changes: [
            {
              ...module,
              observed: 'changed',
              details: ['its source changed (app/routes/items.py:1-20)'],
            },
            { ...endpoint, observed: 'unchanged' },
          ],
        },
      ],
    }
    const text = textOf(render(<ReconcileSummary result={observed} proposalLink={(_, c) => c} />))
    expect(text).toContain('Compared 00000000 with 1a2b3c4d using kalyth-analyzer 0.3.0')
    expect(text).toContain('it says nothing about how the code runs')
    expect(text).toContain('The source shows 1 of 2 direct changes changed.')
    expect(text).toContain(
      'Changed app/routes/items.py its source changed (app/routes/items.py:1-20)',
    )
    expect(text).toContain('Not changed POST /items')
    expect(text).toContain('Also changed')
    expect(text).toContain('Team added: observed in app/models.py:4-6')
  })

  it('is offered once a verified report has moved the task on', () => {
    expect(canReconcile(taskView({ status: 'review', reports: [report()] }))).toBe(true)
    expect(canReconcile(taskView({ status: 'completed', reports: [report()] }))).toBe(true)
    expect(
      canReconcile(
        taskView({
          status: 'review',
          reports: [report({ verification: { id: id('obj', 1), outcome: 'fail', summary: '' } })],
        }),
      ),
    ).toBe(false)
    expect(canReconcile(taskView({ status: 'ready', reports: [report()] }))).toBe(false)
  })
})

describe('the follow-up requests', () => {
  it('sends the session token, the UI header and the body, and reads the error envelope', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const replies = [
      new Response(JSON.stringify({ reportId: 'x' }), { status: 201 }),
      new Response(
        JSON.stringify({
          error: { code: 'conflicting', message: 'the task is ready', issues: [] },
        }),
        { status: 409 },
      ),
    ]
    const api = createTaskApi(
      () => 'session-token-0123',
      async (url, init) => {
        calls.push({ url, init })
        return replies.shift() as Response
      },
    )
    await api.fileReport(TASK, {
      idempotencyKey: 'person-0001',
      summary: 'Done.',
      commit: COMMIT,
      filesChanged: ['app/models.py'],
      outcome: 'succeeded',
      tests: [],
    })
    expect(calls[0]?.url).toBe(`/api/v1/tasks/${TASK}/reports`)
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer session-token-0123',
      'x-kalyth-ui': '1',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ commit: COMMIT })

    const refused = await api.reconcile(TASK).catch((e: unknown) => e)
    expect(calls[1]?.url).toBe(`/api/v1/tasks/${TASK}/reconcile`)
    expect(isApiError(refused) && refused.body.code).toBe('conflicting')
  })
})
