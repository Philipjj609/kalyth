import { afterEach, describe, expect, it } from 'vitest'
import { FixtureRepo } from '../../../packages/analyzer/test/fixture-repo.ts'
import { harness, stated } from './fixture.ts'

let h: Awaited<ReturnType<typeof harness>>
let repo: FixtureRepo | undefined
afterEach(async () => {
  await h?.close()
  repo?.dispose()
  repo = undefined
})

/** A person creates a ready task over HTTP and registers the task repository. */
async function readyTask(options: Parameters<typeof harness>[0] = {}) {
  h = await harness(options)
  repo = new FixtureRepo()
  repo.write({ 'app/models.py': 'class Item:\n    pass\n' })
  const base = repo.commit('base')
  const projectId = (await h.http('POST', '/api/v1/projects', { name: 'Tasks' })).body.id as string
  const commit = async (baseRevision: number, ops: unknown[]) => {
    const p = await h.http('POST', `/api/v1/projects/${projectId}/proposals`, {
      baseRevision,
      rationale: 'test',
      ops,
    })
    return h.http('POST', `/api/v1/proposals/${p.body.proposalId}/commit`)
  }
  const created = await commit(0, [
    {
      op: 'createObject',
      ref: '$t',
      type: 'core.Task',
      stance: 'toBe',
      attributes: {
        title: 'Add tenant_id',
        acceptanceCriteria: ['Item has tenant_id'],
        baseCommit: base,
      },
      claim: stated,
    },
  ])
  // The commit names the id the task's local ref became.
  const taskId = created.body.refs.$t as string
  const list = await h.http('GET', `/api/v1/projects/${projectId}/tasks`)
  expect(list.body.tasks.map((t: { id: string }) => t.id)).toEqual([taskId])
  await commit(1, [{ op: 'setTaskStatus', id: taskId, status: 'ready', rationale: 'scoped' }])
  return { projectId, taskId, commit, repo }
}

describe('tasks over HTTP and MCP (ADR 0013)', () => {
  it('runs a task from claim to a verified report to completion by a person', async () => {
    const { projectId, taskId, commit, repo } = await readyTask()

    const unset = await h.http('GET', `/api/v1/projects/${projectId}/task-repository`)
    expect(unset.body).toMatchObject({ projectId, path: null })
    const missing = await h.http('PUT', `/api/v1/projects/${projectId}/task-repository`, {
      path: `${repo.path}-missing`,
    })
    expect(missing.status).toBe(422)
    const set = await h.http('PUT', `/api/v1/projects/${projectId}/task-repository`, {
      path: repo.path,
    })
    expect(set.status).toBe(200)
    expect(set.body.setBy).toBe(h.owner.id)

    const ready = await h.mcp('list_tasks', { projectId, status: 'ready' })
    expect(ready.body.tasks.map((t: { id: string }) => t.id)).toEqual([taskId])

    const claim = await h.mcp('claim_task', { taskId })
    expect(claim.isError).toBe(false)
    expect(claim.body.task.status).toBe('running')
    expect(claim.body.lease.holder).toBe(h.agent.id)
    const leaseId = claim.body.lease.id as string

    repo.write({ 'app/models.py': 'class Item:\n    tenant_id: int\n' })
    const sha = repo.commit(`Add tenant_id\n\nKalyth-Task: ${taskId}`)
    const reported = await h.mcp('submit_execution_report', {
      taskId,
      leaseId,
      idempotencyKey: 'report-0001',
      outcome: 'succeeded',
      summary: 'Added tenant_id.',
      commit: sha,
      filesChanged: ['app/models.py'],
      tests: [{ command: 'pytest', passed: 3, failed: 0 }],
    })
    expect(reported.isError).toBe(false)
    expect(reported.body.verification.outcome).toBe('pass')

    const viaHttp = await h.http('GET', `/api/v1/tasks/${taskId}`)
    expect(viaHttp.body).toMatchObject({
      status: 'review',
      lease: null,
      reports: [
        {
          id: reported.body.reportId,
          commit: sha,
          verification: { id: reported.body.verification.id, outcome: 'pass' },
        },
      ],
    })
    // Times come from the commits that wrote the task and its report.
    const history = (await h.http('GET', `/api/v1/projects/${projectId}/history`)).body
      .changeSets as { revision: number; committedAt: string }[]
    const committedAt = (revision: number) =>
      history.find((c) => c.revision === revision)?.committedAt
    expect(viaHttp.body.createdAt).toBe(committedAt(1))
    expect(viaHttp.body.updatedAt).toBe(committedAt(viaHttp.body.revision))
    expect(viaHttp.body.reports[0].reportedAt).toBe(committedAt(viaHttp.body.reports[0].revision))
    const listed = await h.mcp('list_tasks', { projectId })
    expect(listed.body.tasks[0]).toMatchObject({
      createdAt: viaHttp.body.createdAt,
      updatedAt: viaHttp.body.updatedAt,
    })

    // The agent has no way to complete it; the owner, through the UI's API, does.
    const head = (await h.http('GET', `/api/v1/projects/${projectId}`)).body.project.headRevision
    const proposed = await h.mcp('propose_change', {
      projectId,
      baseRevision: head,
      rationale: 'done',
      ops: [{ op: 'setTaskStatus', id: taskId, status: 'completed', rationale: 'done' }],
    })
    expect(proposed.body.status).toBe('pending')
    const done = await commit(head, [
      { op: 'setTaskStatus', id: taskId, status: 'completed', rationale: 'reviewed the commit' },
    ])
    expect(done.status).toBe(200)
    expect((await h.http('GET', `/api/v1/tasks/${taskId}`)).body.status).toBe('completed')
  })

  it('refuses a claim on a held task and a report without the lease', async () => {
    const { taskId } = await readyTask()
    expect((await h.mcp('claim_task', { taskId })).isError).toBe(false)
    const again = await h.mcp('claim_task', { taskId })
    expect(again.isError).toBe(true)
    expect(again.body.error.code).toBe('conflicting')
    const forged = await h.mcp('submit_execution_report', {
      taskId,
      leaseId: `lease_${'0'.repeat(32)}`,
      idempotencyKey: 'report-0002',
      outcome: 'succeeded',
      summary: 'x',
      filesChanged: [],
      tests: [],
    })
    expect(forged.body.error.code).toBe('unauthorized')
    const unknown = await h.http('GET', `/api/v1/tasks/${'0'.repeat(32)}`)
    expect(unknown.status).toBeGreaterThanOrEqual(400)
  })

  it('answers a late report with the task’s state and a retry with the original checks', async () => {
    const { projectId, taskId, repo } = await readyTask()
    await h.http('PUT', `/api/v1/projects/${projectId}/task-repository`, { path: repo.path })
    const claim = await h.mcp('claim_task', { taskId })
    const leaseId = claim.body.lease.id as string
    repo.write({ 'app/models.py': 'class Item:\n    tenant_id: int\n' })
    const sha = repo.commit(`Add tenant_id\n\nKalyth-Task: ${taskId}`)
    const report = (idempotencyKey: string) => ({
      taskId,
      leaseId,
      idempotencyKey,
      outcome: 'succeeded',
      summary: 'Added tenant_id.',
      commit: sha,
      filesChanged: ['app\\models.py'],
    })
    const first = await h.mcp('submit_execution_report', report('report-0001'))
    expect(first.body.verification.outcome).toBe('pass')
    expect(first.body.task.status).toBe('review')

    const retry = await h.mcp('submit_execution_report', report('report-0001'))
    expect(retry.isError).toBe(false)
    expect(retry.body.duplicate).toBe(true)
    expect(retry.body.verification).toEqual(first.body.verification)
    expect(retry.body.verification.checks.length).toBeGreaterThan(0)

    const late = await h.mcp('submit_execution_report', report('report-0002'))
    expect(late).toMatchObject({
      isError: true,
      body: {
        error: { code: 'conflicting', message: expect.stringMatching(/^the task is in review/) },
      },
    })
    // The UI reads the path as git writes it.
    const viaHttp = await h.http('GET', `/api/v1/tasks/${taskId}`)
    expect(viaHttp.body.reports[0].filesChanged).toEqual(['app/models.py'])
  })

  it('shows an expired lease over HTTP and MCP at read time, without writing', async () => {
    let now = Date.parse('2026-10-19T12:00:00.000Z')
    const { projectId, taskId } = await readyTask({ clock: () => new Date(now).toISOString() })
    expect((await h.mcp('claim_task', { taskId, leaseMinutes: 5 })).isError).toBe(false)
    const head = async () =>
      (await h.http('GET', `/api/v1/projects/${projectId}`)).body.project.headRevision as number
    const before = await head()
    expect((await h.http('GET', `/api/v1/tasks/${taskId}`)).body.leaseExpired).toBe(false)

    now += 6 * 60_000
    const viaHttp = (await h.http('GET', `/api/v1/tasks/${taskId}`)).body
    expect(viaHttp).toMatchObject({ status: 'running', leaseExpired: true })
    const listed = (await h.http('GET', `/api/v1/projects/${projectId}/tasks`)).body.tasks[0]
    expect(listed.leaseExpired).toBe(true)
    const viaMcp = await h.mcp('get_task', { taskId })
    expect(viaMcp.body).toMatchObject({ status: 'running', leaseExpired: true })
    expect((await h.mcp('list_tasks', { projectId })).body.tasks[0].leaseExpired).toBe(true)
    expect(await head()).toBe(before)
  })
})
