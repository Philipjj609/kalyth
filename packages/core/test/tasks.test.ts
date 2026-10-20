import { type Caller, canonicalJson, type OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { ensurePrincipal, replayEvents, SqliteStore } from '../src/index.ts'
import { errorOf, setup, unwrap } from './helpers.ts'

const stated = { basis: 'stated' as const }
const lease = (holder: string, n = 1) => ({
  id: `lease_${n.toString(16).padStart(32, '0')}`,
  holder,
  expiresAt: '2026-10-17T13:00:00.000Z',
})

function world() {
  const t = setup()
  const coordinatorPrincipal = ensurePrincipal(
    t.services,
    'task-coordinator',
    'tool',
    'Task coordinator',
    ['project.read', 'proposal.create', 'task.coordinate'],
  )
  const coordinator: Caller = { principalId: coordinatorPrincipal.id, origin: 'tool' }
  const projectId = t.project.id
  const head = () =>
    unwrap(t.services.getProjectOverview(t.owner, { projectId })).project.headRevision
  /** Proposes as `proposer` and commits as `committer`; returns the commit result. */
  const run = (proposer: Caller, committer: Caller, ops: OperationInput[]) => {
    const p = unwrap(
      t.services.proposeChange(proposer, {
        projectId,
        baseRevision: head(),
        rationale: 'test',
        ops,
      }),
    )
    if (p.status !== 'pending') {
      return {
        ok: false as const,
        error: { code: 'invalid' as const, message: 'invalid proposal', issues: p.issues },
      }
    }
    return t.services.commitProposal(committer, { proposalId: p.proposalId })
  }
  const created = run(t.owner, t.owner, [
    {
      op: 'createObject',
      ref: '$t',
      type: 'core.Task',
      stance: 'toBe',
      attributes: { title: 'Add tenant_id' },
      claim: stated,
    },
  ])
  if (!created.ok) throw new Error('task not created')
  const taskId = unwrap(t.services.queryObjects(t.owner, { projectId, types: ['core.Task'] }))
    .objects[0]?.id as string
  const status = () =>
    unwrap(t.services.queryObjects(t.owner, { projectId, ids: [taskId] })).objects[0]
      ?.attributes as {
      status: string
      lease: unknown
    }
  const set = (who: Caller, s: string, extra: Record<string, unknown> = {}) =>
    run(who, who, [
      { op: 'setTaskStatus', id: taskId, status: s as 'ready', rationale: 'test', ...extra },
    ])
  return { ...t, coordinator, projectId, taskId, run, status, set }
}

describe('task lifecycle in the kernel (ADR 0013)', () => {
  it('starts proposed with no lease, and only setTaskStatus changes status or lease', () => {
    const w = world()
    expect(w.status()).toMatchObject({ status: 'proposed', lease: null })
    const reserved = w.services.proposeChange(w.owner, {
      projectId: w.projectId,
      baseRevision: 1,
      rationale: 'cheat',
      ops: [{ op: 'updateObject', id: w.taskId, set: { status: 'completed' } }],
    })
    expect(
      unwrap(reserved)
        .issues.map((i) => i.message)
        .join(),
    ).toMatch(/use setTaskStatus/)
    const created = w.services.proposeChange(w.owner, {
      projectId: w.projectId,
      baseRevision: 1,
      rationale: 'cheat',
      ops: [
        {
          op: 'createObject',
          type: 'core.Task',
          stance: 'toBe',
          attributes: { title: 'x', status: 'running' },
          claim: stated,
        },
      ],
    })
    expect(unwrap(created).status).toBe('invalid')
  })

  it('enforces the transitions and the lease rules', () => {
    const w = world()
    expect(errorOf(w.set(w.owner, 'completed')).code).toBe('invalid')
    expect(w.set(w.owner, 'ready').ok).toBe(true)
    expect(errorOf(w.set(w.owner, 'running')).issues.map((i) => i.code)).toContain(
      'task.lease_required',
    )
    expect(w.set(w.coordinator, 'running', { lease: lease(w.agentPrincipal.id) }).ok).toBe(true)
    expect(w.status().lease).toMatchObject({ holder: w.agentPrincipal.id })
    expect(w.set(w.coordinator, 'unknown_outcome').ok).toBe(true)
    expect(w.status()).toMatchObject({
      status: 'unknown_outcome',
      lease: { holder: w.agentPrincipal.id },
    })
    expect(w.set(w.coordinator, 'ready').ok).toBe(true)
    expect(w.status()).toMatchObject({ status: 'ready', lease: null })
  })

  it('lets the coordinator commit only task lifecycle records, never completion', () => {
    const w = world()
    w.set(w.owner, 'ready')
    w.set(w.coordinator, 'running', { lease: lease(w.agentPrincipal.id) })
    // The agent proposes, the coordinator commits: a report and a move to review.
    const report = w.run(w.agent, w.coordinator, [
      {
        op: 'createObject',
        ref: '$r',
        type: 'core.ExecutionReport',
        stance: 'asIs',
        attributes: {
          outcome: 'succeeded',
          summary: 'done',
          leaseId: lease('x').id,
          idempotencyKey: 'report-0001',
        },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'reports',
        from: '$r',
        to: w.taskId,
        stance: 'asIs',
        claim: stated,
      },
      { op: 'setTaskStatus', id: w.taskId, status: 'review', rationale: 'verified' },
    ])
    expect(report.ok).toBe(true)
    expect(errorOf(w.set(w.coordinator, 'completed')).code).toBe('unauthorized')
    const sneaky = w.run(w.agent, w.coordinator, [
      {
        op: 'createObject',
        type: 'core.Requirement',
        stance: 'toBe',
        attributes: { title: 'x', statement: 'y' },
        claim: stated,
      },
    ])
    expect(errorOf(sneaky).code).toBe('unauthorized')
    // A person, acting through relayed text, cannot complete it either; acting directly they can.
    expect(errorOf(w.set({ ...w.owner, origin: 'relayed' }, 'completed')).code).toBe('unauthorized')
    expect(w.set(w.owner, 'completed').ok).toBe(true)
    expect(errorOf(w.set(w.owner, 'ready')).code).toBe('invalid')
  })

  it('keeps task requirements acyclic', () => {
    const w = world()
    const other = w.run(w.owner, w.owner, [
      {
        op: 'createObject',
        ref: '$b',
        type: 'core.Task',
        stance: 'toBe',
        attributes: { title: 'B' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'requires',
        from: w.taskId,
        to: '$b',
        stance: 'toBe',
        claim: stated,
      },
    ])
    expect(other.ok).toBe(true)
    const b = unwrap(
      w.services.queryObjects(w.owner, { projectId: w.projectId, types: ['core.Task'] }),
    ).objects.find((o) => o.attributes.title === 'B')?.id as string
    const cycle = w.run(w.owner, w.owner, [
      {
        op: 'createRelation',
        type: 'requires',
        from: b,
        to: w.taskId,
        stance: 'toBe',
        claim: stated,
      },
    ])
    expect(cycle.ok).toBe(false)
  })

  it('keeps a finding while the outcome is unknown, clears it after, and lets only the coordinator record one', () => {
    const w = world()
    const sha = (c: string) => c.repeat(40)
    const finding = { commits: [sha('a')] }
    w.set(w.owner, 'ready')
    w.set(w.coordinator, 'running', { lease: lease(w.agentPrincipal.id) })
    // Only with unknown_outcome, and only the coordinator, which searched git.
    expect(errorOf(w.set(w.coordinator, 'ready', { finding })).issues.map((i) => i.code)).toContain(
      'task.finding_unexpected',
    )
    expect(errorOf(w.set(w.owner, 'unknown_outcome', { finding })).code).toBe('unauthorized')
    expect(w.set(w.coordinator, 'unknown_outcome', { finding }).ok).toBe(true)
    expect(w.status()).toMatchObject({
      status: 'unknown_outcome',
      finding,
      lease: { holder: w.agentPrincipal.id },
    })

    // A later search records what git shows now, keeping the state and the last holder's lease.
    const newer = { commits: [sha('b'), sha('a')] }
    expect(w.set(w.coordinator, 'unknown_outcome', { finding: newer }).ok).toBe(true)
    expect(w.status()).toMatchObject({ finding: newer, lease: { holder: w.agentPrincipal.id } })
    // Without a finding, staying in unknown_outcome is no transition at all.
    expect(errorOf(w.set(w.coordinator, 'unknown_outcome')).issues.map((i) => i.code)).toContain(
      'task.transition_invalid',
    )
    // No one edits it by hand.
    const edited = unwrap(
      w.services.proposeChange(w.owner, {
        projectId: w.projectId,
        baseRevision: unwrap(w.services.getProjectOverview(w.owner, { projectId: w.projectId }))
          .project.headRevision,
        rationale: 'cheat',
        ops: [{ op: 'updateObject', id: w.taskId, set: { finding: null } }],
      }),
    )
    expect(edited.issues.map((i) => i.message).join()).toMatch(/use setTaskStatus/)

    // Leaving unknown_outcome clears it; the history keeps the version that had it.
    expect(w.set(w.owner, 'ready').ok).toBe(true)
    expect(w.status()).toMatchObject({ status: 'ready', lease: null })
    expect(w.status()).not.toHaveProperty('finding')
    const replica = new SqliteStore(':memory:')
    replayEvents(replica, w.store.listEvents(w.projectId))
    expect(canonicalJson(replica.dumpRevisionedState(w.projectId))).toBe(
      canonicalJson(w.store.dumpRevisionedState(w.projectId)),
    )
  })
})
