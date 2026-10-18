import { TASK_TRANSITIONS as CONTRACT_TRANSITIONS, TaskStatus } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ID } from '../test/handoff.ts'
import { ALT_A, DECISION } from '../test/navigator.ts'
import { BASE_COMMIT, report, runningTask, TASK, TASK_B, TASK_C, taskView } from '../test/tasks.ts'
import {
  BOARD_ORDER,
  boardColumns,
  createTaskOps,
  createTaskRationale,
  draftFromDecision,
  EMPTY_TASK_DRAFT,
  latestReport,
  NOT_FOR_PEOPLE,
  reportsNewestFirst,
  requirableTasks,
  statusChangeOps,
  TASK_REF,
  TASK_TRANSITIONS,
  type TaskDraft,
  taskActions,
  taskDraftProblems,
  taskDraftReducer,
  taskTrailer,
  unmetRequirements,
} from './tasks.ts'

describe('task statuses', () => {
  it('mirrors the kernel transition table from the contracts exactly', () => {
    expect(TASK_TRANSITIONS).toEqual(CONTRACT_TRANSITIONS)
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TaskStatus.options].sort())
  })

  it('has one board column for every status, in the flow order', () => {
    expect(BOARD_ORDER).toEqual([
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
    expect([...BOARD_ORDER].sort()).toEqual([...TaskStatus.options].sort())
  })
})

describe('board columns', () => {
  const tasks = [
    taskView({ id: TASK, title: 'Older proposed', revision: 3 }),
    taskView({ id: TASK_B, title: 'Newer proposed', revision: 8 }),
    taskView({ id: TASK_C, title: 'In review', status: 'review', revision: 5 }),
    runningTask(),
  ]

  it('groups tasks by status in board order, newest change first', () => {
    const columns = boardColumns(tasks)
    expect(columns.map((c) => c.status)).toEqual(BOARD_ORDER)
    const byStatus = Object.fromEntries(columns.map((c) => [c.status, c.tasks.map((t) => t.title)]))
    expect(byStatus).toEqual({
      proposed: ['Newer proposed', 'Older proposed'],
      ready: [],
      running: ['Filter the base query'],
      review: ['In review'],
      blocked: [],
      unknown_outcome: [],
      failed: [],
      completed: [],
      cancelled: [],
    })
  })

  it('folds only empty columns after the first four', () => {
    const collapsible = boardColumns(tasks)
      .filter((c) => c.collapsible)
      .map((c) => c.status)
    // Ready is empty but is one of the main columns, so it keeps its room.
    expect(collapsible).toEqual(['blocked', 'unknown_outcome', 'failed', 'completed', 'cancelled'])
    const withFailed = boardColumns([...tasks, taskView({ id: 'obj_x', status: 'failed' })])
    expect(withFailed.find((c) => c.status === 'failed')?.collapsible).toBe(false)
  })

  it('keeps the order stable between polls when revisions tie', () => {
    const tied = [
      taskView({ id: TASK_B, title: 'Beta', revision: 4 }),
      taskView({ id: TASK, title: 'Alpha', revision: 4 }),
    ]
    expect(boardColumns(tied)[0]?.tasks.map((t) => t.title)).toEqual(['Alpha', 'Beta'])
  })

  it('finds unmet requirements and the latest report', () => {
    expect(unmetRequirements(runningTask()).map((r) => r.id)).toEqual([TASK])
    const older = report({ id: 'obj_old', revision: 10, outcome: 'failed' })
    const newer = report({ revision: 12 })
    const task = taskView({ reports: [older, newer] })
    expect(latestReport(task)).toBe(newer)
    expect(reportsNewestFirst(task)).toEqual([newer, older])
    expect(latestReport(taskView())).toBeUndefined()
  })
})

describe('actions a person may take', () => {
  const labels = (status: TaskStatus) => taskActions(status).map((a) => `${a.label} → ${a.to}`)

  it('offers each status its own actions, primary first and destructive last', () => {
    expect(labels('proposed')).toEqual(['Mark ready → ready', 'Cancel task → cancelled'])
    expect(labels('ready')).toEqual(['Block → blocked', 'Cancel task → cancelled'])
    expect(labels('running')).toEqual(['Mark ready → ready', 'Block → blocked', 'Fail → failed'])
    expect(labels('unknown_outcome')).toEqual([
      'Mark ready → ready',
      'Fail → failed',
      'Cancel task → cancelled',
    ])
    expect(labels('review')).toEqual(['Complete → completed', 'Send back → ready', 'Fail → failed'])
    expect(labels('blocked')).toEqual(['Unblock → ready', 'Cancel task → cancelled'])
    expect(labels('failed')).toEqual(['Mark ready → ready', 'Cancel task → cancelled'])
    expect(labels('completed')).toEqual([])
    expect(labels('cancelled')).toEqual([])
  })

  it('only offers transitions the kernel allows, and never running, review or unknown outcome', () => {
    for (const status of TaskStatus.options) {
      for (const action of taskActions(status)) {
        expect(CONTRACT_TRANSITIONS[status]).toContain(action.to)
        expect(NOT_FOR_PEOPLE.has(action.to)).toBe(false)
      }
    }
    expect([...NOT_FOR_PEOPLE].sort()).toEqual(['review', 'running', 'unknown_outcome'])
  })

  it('completes only from review, saying the repository shows the work and the person confirms it', () => {
    const completing = TaskStatus.options.filter((s) =>
      taskActions(s).some((a) => a.to === 'completed'),
    )
    expect(completing).toEqual(['review'])
    const complete = taskActions('review')[0]
    expect(complete?.note.toLowerCase()).toContain('the repository shows the work; you confirm it')
    expect(complete?.final).toBe(true)
    expect(taskActions('proposed').find((a) => a.to === 'cancelled')?.final).toBe(true)
  })

  it('says when an action ends an agent’s lease', () => {
    for (const action of taskActions('running')) {
      expect(action.note).toContain('lease ends')
    }
    expect(taskActions('ready').find((a) => a.to === 'blocked')?.note).not.toContain('lease')
  })

  it('proposes one setTaskStatus operation with the rationale and no lease', () => {
    expect(statusChangeOps(TASK, 'ready', 'Scope agreed.')).toEqual([
      { op: 'setTaskStatus', id: TASK, status: 'ready', rationale: 'Scope agreed.' },
    ])
  })

  it('names the commit trailer agents use', () => {
    expect(taskTrailer(TASK)).toBe(`Kalyth-Task: ${TASK}`)
  })
})

describe('the task form', () => {
  const decision = { id: DECISION, title: 'Tenancy model' }

  it('starts from a decision: it implements the decision and takes its title', () => {
    const draft = draftFromDecision(decision)
    expect(draft).toMatchObject({
      decisionId: DECISION,
      implementsId: DECISION,
      title: 'Tenancy model',
    })
    // An untouched title follows the next decision; an edited one is kept.
    let next = taskDraftReducer(draft, {
      type: 'chooseDecision',
      decision: { id: 'obj_2', title: 'Auth provider' },
    })
    expect(next.title).toBe('Auth provider')
    next = taskDraftReducer(next, { type: 'title', title: 'Isolate tenants' })
    next = taskDraftReducer(next, { type: 'chooseDecision', decision })
    expect(next.title).toBe('Isolate tenants')
    expect(taskDraftReducer(next, { type: 'implements', id: ALT_A }).implementsId).toBe(ALT_A)
  })

  it('edits criteria with the shared editor actions and toggles requirements', () => {
    let draft = draftFromDecision(decision)
    for (const text of ['  First  ', '', 'Second']) {
      draft = taskDraftReducer(draft, { type: 'addCriterion', text })
    }
    draft = taskDraftReducer(draft, { type: 'moveCriterion', index: 1, by: -1 })
    expect(draft.criteria).toEqual(['Second', 'First'])
    draft = taskDraftReducer(draft, { type: 'toggleRequires', id: TASK })
    draft = taskDraftReducer(draft, { type: 'toggleRequires', id: TASK_B })
    draft = taskDraftReducer(draft, { type: 'toggleRequires', id: TASK })
    expect(draft.requires).toEqual([TASK_B])
    expect(taskDraftReducer(draft, { type: 'reset' })).toEqual(EMPTY_TASK_DRAFT)
  })

  it('says why a draft cannot be proposed', () => {
    expect(taskDraftProblems(EMPTY_TASK_DRAFT)).toEqual([
      'Choose the accepted decision this task implements.',
      'Give the task a title.',
    ])
    const draft = draftFromDecision(decision)
    expect(taskDraftProblems(draft)).toEqual([])
    expect(taskDraftProblems({ ...draft, baseCommit: 'abc123' })).toEqual([
      'Give the base commit as a full 40-character sha, or leave it empty.',
    ])
    expect(taskDraftProblems({ ...draft, baseCommit: ` ${BASE_COMMIT.toUpperCase()} ` })).toEqual(
      [],
    )
    expect(taskDraftProblems({ ...draft, title: 'x'.repeat(301) })).toEqual([
      'Keep the title to 300 characters.',
    ])
  })

  it('creates a stated, to-be core.Task with implements and requires relations', () => {
    const draft: TaskDraft = {
      ...draftFromDecision(decision),
      implementsId: ALT_A,
      title: '  Add tenant_id to Item ',
      description: ' Scope every read by tenant. ',
      criteria: ['Every query filters by tenant', '   '],
      contextPackageId: PACKAGE_ID,
      baseCommit: BASE_COMMIT.toUpperCase(),
      requires: [TASK, TASK_B, TASK],
    }
    expect(createTaskOps(draft)).toEqual([
      {
        op: 'createObject',
        ref: TASK_REF,
        type: 'core.Task',
        stance: 'toBe',
        attributes: {
          title: 'Add tenant_id to Item',
          description: 'Scope every read by tenant.',
          acceptanceCriteria: ['Every query filters by tenant'],
          contextPackageId: PACKAGE_ID,
          baseCommit: BASE_COMMIT,
        },
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'implements',
        from: TASK_REF,
        to: ALT_A,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'requires',
        from: TASK_REF,
        to: TASK,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
      {
        op: 'createRelation',
        type: 'requires',
        from: TASK_REF,
        to: TASK_B,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    ])
    expect(createTaskRationale(draft)).toBe('Plan the task “Add tenant_id to Item”')
  })

  it('leaves out optional attributes, and never sets status or lease (the kernel starts it as proposed)', () => {
    const [created, ...relations] = createTaskOps(draftFromDecision(decision))
    expect(created).toMatchObject({
      attributes: { title: 'Tenancy model', acceptanceCriteria: [] },
    })
    const attributes = (created as { attributes: Record<string, unknown> }).attributes
    expect(Object.keys(attributes).sort()).toEqual(['acceptanceCriteria', 'title'])
    expect(relations).toEqual([
      {
        op: 'createRelation',
        type: 'implements',
        from: TASK_REF,
        to: DECISION,
        stance: 'toBe',
        claim: { basis: 'stated' },
      },
    ])
    expect(() => createTaskOps(EMPTY_TASK_DRAFT)).toThrow()
  })

  it('offers every task but cancelled ones as a requirement', () => {
    const tasks = [
      taskView({ id: TASK, status: 'completed' }),
      taskView({ id: TASK_B, status: 'cancelled' }),
      taskView({ id: TASK_C, status: 'running' }),
    ]
    expect(requirableTasks(tasks).map((t) => t.id)).toEqual([TASK, TASK_C])
  })
})
