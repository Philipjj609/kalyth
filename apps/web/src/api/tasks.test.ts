import type { TaskStatus } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import {
  createTaskOps,
  createTaskRationale,
  draftFromDecision,
  statusChangeOps,
  TASK_TRANSITIONS,
  taskActions,
} from '../model/tasks.ts'
import { proposal } from '../test/handoff.ts'
import { DECISION, id, PERSON, PROJECT } from '../test/navigator.ts'
import { TASK, TASK_B, taskView } from '../test/tasks.ts'
import { ApiError, createApi, type FetchLike } from './client.ts'
import { changeTaskStatus, createdTaskId, createTask } from './tasks.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { url: string; method: string; body: unknown; auth: string | undefined }

/** A fetch that answers each request in turn from a list, recording what was sent. */
function scripted(answers: Response[]) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`)
    return next
  }
  return { calls, api: createApi(() => 'session-token-123', fetchImpl) }
}

const PROPOSAL = id('prp', 88)
const pending = () => json(201, { proposalId: PROPOSAL, status: 'pending', issues: [] })
const committed = {
  status: 'committed',
  projectId: PROJECT,
  revision: 14,
  changeSetId: id('chg', 2),
  eventId: id('evt', 2),
  rebasedFrom: null,
}
const notFound = () => json(404, { error: { code: 'not_found', message: 'no route', issues: [] } })

describe('task routes', () => {
  it('lists tasks with the session token, optionally by status, and maps a missing route to null', async () => {
    const list = { projectId: PROJECT, revision: 13, tasks: [taskView()] }
    const { calls, api } = scripted([json(200, list), json(200, list), notFound()])
    await expect(api.tasks(PROJECT)).resolves.toEqual(list)
    await api.tasks(PROJECT, 'review')
    await expect(api.tasks(PROJECT)).resolves.toBeNull()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/projects/${PROJECT}/tasks`,
      `GET /api/v1/projects/${PROJECT}/tasks?status=review`,
      `GET /api/v1/projects/${PROJECT}/tasks`,
    ])
    expect(calls.every((c) => c.auth === 'Bearer session-token-123')).toBe(true)
  })

  it('reads one task, and throws a missing task with the error envelope', async () => {
    const { calls, api } = scripted([json(200, taskView()), notFound()])
    await expect(api.task(TASK)).resolves.toEqual(taskView())
    expect(calls[0]?.url).toBe(`/api/v1/tasks/${TASK}`)
    const error = await api.task(TASK_B).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).body.code).toBe('not_found')
  })

  it('reads and sets the task repository', async () => {
    const unset = { projectId: PROJECT, path: null, setBy: null, setAt: null }
    const set = {
      projectId: PROJECT,
      path: '/home/me/src/app',
      setBy: PERSON,
      setAt: '2026-10-17T09:00:00.000Z',
    }
    const { calls, api } = scripted([json(200, unset), json(200, set), notFound()])
    await expect(api.taskRepository(PROJECT)).resolves.toEqual(unset)
    await expect(api.setTaskRepository(PROJECT, '/home/me/src/app')).resolves.toEqual(set)
    await expect(api.taskRepository(PROJECT)).resolves.toBeNull()
    expect(calls.slice(0, 2)).toEqual([
      {
        url: `/api/v1/projects/${PROJECT}/task-repository`,
        method: 'GET',
        body: undefined,
        auth: 'Bearer session-token-123',
      },
      {
        url: `/api/v1/projects/${PROJECT}/task-repository`,
        method: 'PUT',
        body: { path: '/home/me/src/app' },
        auth: 'Bearer session-token-123',
      },
    ])
  })

  it('shows why a repository was refused', async () => {
    const refused = {
      code: 'invalid',
      message: 'not a git repository',
      issues: [{ code: 'repository.not_git', message: '/tmp/nothing' }],
    }
    const { api } = scripted([json(422, { error: refused })])
    const error = (await api.setTaskRepository(PROJECT, '/tmp/nothing').catch((e) => e)) as ApiError
    expect(error.status).toBe(422)
    expect(error.body).toEqual(refused)
  })
})

describe('changing a task status', () => {
  it('proposes each action’s operation against the revision seen, then commits it', async () => {
    const statuses = Object.keys(TASK_TRANSITIONS) as TaskStatus[]
    for (const from of statuses) {
      for (const action of taskActions(from)) {
        const { calls, api } = scripted([pending(), json(200, committed)])
        const rationale = `${action.label} from ${from}`
        const outcome = await changeTaskStatus(api, PROJECT, {
          taskId: TASK,
          status: action.to,
          rationale,
          baseRevision: 13,
        })
        expect(outcome).toEqual({ proposalId: PROPOSAL, committed })
        expect(calls).toEqual([
          {
            url: `/api/v1/projects/${PROJECT}/proposals`,
            method: 'POST',
            body: {
              baseRevision: 13,
              rationale,
              ops: [{ op: 'setTaskStatus', id: TASK, status: action.to, rationale }],
            },
            auth: 'Bearer session-token-123',
          },
          {
            url: `/api/v1/proposals/${PROPOSAL}/commit`,
            method: 'POST',
            body: undefined,
            auth: 'Bearer session-token-123',
          },
        ])
        expect(calls[0]?.body).toMatchObject({ ops: statusChangeOps(TASK, action.to, rationale) })
      }
    }
  })

  it.each([
    [
      409,
      {
        code: 'stale',
        message: 'state this proposal relies on changed since revision 13',
        issues: [{ code: 'stale.changed', message: TASK }],
        changedRefs: [TASK],
        currentRevision: 15,
      },
    ],
    [
      409,
      {
        code: 'conflicting',
        message: 'a task cannot go from completed to ready',
        issues: [{ code: 'task.transition_invalid', message: 'completed → ready', op: 0 }],
      },
    ],
    [
      403,
      {
        code: 'unauthorized',
        message: 'completing or cancelling a task requires a person acting directly',
        issues: [],
        requiredScopes: ['proposal.commit'],
      },
    ],
  ])(
    'keeps a refused commit (%s) as an outcome with the pending proposal',
    async (status, body) => {
      const { api } = scripted([pending(), json(status, { error: body })])
      const outcome = await changeTaskStatus(api, PROJECT, {
        taskId: TASK,
        status: 'completed',
        rationale: 'The commit is in main.',
        baseRevision: 13,
      })
      expect(outcome.proposalId).toBe(PROPOSAL)
      expect('refused' in outcome && outcome.refused.status).toBe(status)
      expect('refused' in outcome && outcome.refused.body).toEqual(body)
    },
  )

  it('reports an invalid proposal with its issues and never commits it', async () => {
    const issues = [{ code: 'task.lease_required', message: 'a running task needs a lease', op: 0 }]
    const { calls, api } = scripted([
      json(422, { proposalId: PROPOSAL, status: 'invalid', issues }),
    ])
    const error = await changeTaskStatus(api, PROJECT, {
      taskId: TASK,
      status: 'ready',
      rationale: 'x',
      baseRevision: 13,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).body).toMatchObject({ code: 'invalid', issues })
    expect((error as ApiError).body.message).toBe(
      'The status change was not proposed: the proposal is invalid.',
    )
    expect(calls).toHaveLength(1)
  })
})

describe('creating a task', () => {
  const draft = {
    ...draftFromDecision({ id: DECISION, title: 'Tenancy model' }),
    requires: [TASK_B],
  }
  const NEW_TASK = id('obj', 900)
  const stored = proposal({
    id: PROPOSAL,
    origin: 'human',
    proposedBy: PERSON,
    ops: [
      {
        op: 'createObject',
        id: NEW_TASK,
        type: 'core.Task',
        stance: 'toBe',
        attributes: { title: 'Tenancy model', acceptanceCriteria: [] },
        claim: { basis: 'stated', supports: [], contradictedBy: [], derivedFrom: [] },
      },
    ],
  })

  it('proposes the task with its implements and requires relations, commits, and reads back the new id', async () => {
    const { calls, api } = scripted([pending(), json(200, committed), json(200, stored)])
    const outcome = await createTask(api, PROJECT, { draft, baseRevision: 13 })
    expect(outcome).toEqual({ proposalId: PROPOSAL, committed, taskId: NEW_TASK })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/v1/projects/${PROJECT}/proposals`,
      `POST /api/v1/proposals/${PROPOSAL}/commit`,
      `GET /api/v1/proposals/${PROPOSAL}`,
    ])
    expect(calls[0]?.body).toEqual({
      baseRevision: 13,
      rationale: createTaskRationale(draft),
      ops: createTaskOps(draft),
    })
    const body = calls[0]?.body as { ops: { op: string; type: string; to?: string }[] }
    const ops = body.ops
    expect(ops.map((o) => `${o.op} ${o.type}${o.to ? ` → ${o.to}` : ''}`)).toEqual([
      'createObject core.Task',
      `createRelation implements → ${DECISION}`,
      `createRelation requires → ${TASK_B}`,
    ])
  })

  it('still reports the commit when the new id cannot be read back', async () => {
    const { api } = scripted([pending(), json(200, committed), notFound()])
    await expect(createTask(api, PROJECT, { draft, baseRevision: 13 })).resolves.toEqual({
      proposalId: PROPOSAL,
      committed,
      taskId: null,
    })
  })

  it('keeps a refused creation pending and does not read it back', async () => {
    const stale = { code: 'stale', message: 'the head moved', issues: [], currentRevision: 15 }
    const { calls, api } = scripted([pending(), json(409, { error: stale })])
    const outcome = await createTask(api, PROJECT, { draft, baseRevision: 13 })
    expect('refused' in outcome && outcome.refused.body).toEqual(stale)
    expect(calls).toHaveLength(2)
  })

  it('finds the created task among resolved operations', () => {
    expect(createdTaskId(stored.ops)).toBe(NEW_TASK)
    expect(createdTaskId([])).toBeNull()
  })
})
