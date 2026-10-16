import { canonicalJson } from '@kalyth/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { replayEvents, SqliteStore } from '../src/index.ts'
import {
  commitAsOwner,
  errorOf,
  evidenceOp,
  observed,
  seedSystem,
  setup,
  stated,
  unwrap,
} from './helpers.ts'

describe('transactional integrity', () => {
  for (const point of ['afterVersionWrites', 'afterEventInsert', 'beforeHeadUpdate'] as const) {
    it(`a failure at ${point} leaves no event, change set or version behind`, () => {
      let armed = false
      const ctx = setup({
        faults: (p) => {
          if (armed && p === point) throw new Error(`injected fault at ${p}`)
        },
      })
      const proposed = unwrap(
        ctx.services.proposeChange(ctx.owner, {
          projectId: ctx.project.id,
          baseRevision: 0,
          rationale: 'x',
          ops: [
            evidenceOp('$e'),
            {
              op: 'createObject',
              type: 'software.Module',
              stance: 'asIs',
              attributes: { path: 'a.py' },
              claim: observed('$e'),
            },
          ],
        }),
      )
      const before = canonicalJson(ctx.store.dumpRevisionedState(ctx.project.id))
      const eventsBefore = ctx.store.listEvents().length
      armed = true
      expect(() =>
        ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }),
      ).toThrow(/injected fault/)
      expect(canonicalJson(ctx.store.dumpRevisionedState(ctx.project.id))).toBe(before)
      expect(ctx.store.listEvents()).toHaveLength(eventsBefore)
      expect(ctx.store.getProposal(proposed.proposalId)?.status).toBe('pending')
      armed = false
      expect(
        unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId }))
          .revision,
      ).toBe(1)
    })
  }

  it('refuses to update or delete events, change sets, evidence or version rows', () => {
    const ctx = setup()
    seedSystem(ctx)
    const db = ctx.store.db
    expect(() => db.prepare("UPDATE events SET payload = '{}'").run()).toThrow(/immutable/)
    expect(() => db.prepare('DELETE FROM events').run()).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE change_sets SET committed_by = 'x'").run()).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE evidence SET source = '{}'").run()).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE object_versions SET attributes = '{}'").run()).toThrow(
      /only be closed/,
    )
    expect(() => db.prepare('DELETE FROM relation_versions').run()).toThrow(/never deleted/)
  })

  it('keeps rejected and invalid proposals with their provenance', () => {
    const ctx = setup()
    const proposed = unwrap(
      ctx.services.proposeChange(ctx.agent, {
        projectId: ctx.project.id,
        baseRevision: 0,
        rationale: 'agent suggestion',
        ops: [
          {
            op: 'createObject',
            type: 'core.Assertion',
            stance: 'asIs',
            attributes: { statement: 'x' },
            claim: stated,
          },
        ],
      }),
    )
    const rejected = unwrap(
      ctx.services.rejectProposal(ctx.owner, {
        proposalId: proposed.proposalId,
        reason: 'not useful',
      }),
    )
    expect(rejected).toMatchObject({
      status: 'rejected',
      proposedBy: ctx.agentPrincipal.id,
      origin: 'agent',
      decidedBy: ctx.ownerPrincipal.id,
      decisionNote: 'not useful',
    })
    expect(
      errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId })).code,
    ).toBe('invalid')
    const all = unwrap(
      ctx.services.listProposals(ctx.owner, { projectId: ctx.project.id }),
    ).proposals
    expect(all.map((p) => p.status)).toEqual(['rejected'])
  })

  it('creates one proposal per idempotency key and refuses key reuse for different content', () => {
    const ctx = setup()
    const input = {
      projectId: ctx.project.id,
      baseRevision: 0,
      rationale: 'once',
      idempotencyKey: 'agent-run-42-step-1',
      ops: [
        {
          op: 'createObject',
          type: 'core.Assertion',
          stance: 'asIs',
          attributes: { statement: 'x' },
          claim: stated,
        },
      ],
    }
    const a = unwrap(ctx.services.proposeChange(ctx.agent, input))
    const b = unwrap(ctx.services.proposeChange(ctx.agent, input))
    expect(b.proposalId).toBe(a.proposalId)
    expect(
      unwrap(ctx.services.listProposals(ctx.owner, { projectId: ctx.project.id })).proposals,
    ).toHaveLength(1)
    expect(
      errorOf(ctx.services.proposeChange(ctx.agent, { ...input, rationale: 'different' })).issues[0]
        ?.code,
    ).toBe('idempotency.key_reused')
  })
})

describe('event replay (R3)', () => {
  it('rebuilds identical revisioned state from events alone', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'py' } }])
    const relation = unwrap(ctx.services.queryRelations(ctx.owner, { projectId: ctx.project.id }))
      .relations[0]?.id as string
    commitAsOwner(ctx, [{ op: 'retireRelation', id: relation, reason: 'moved' }])
    commitAsOwner(ctx, [{ op: 'updateObject', id: apiId, set: { technology: 'FastAPI' } }])

    const replica = new SqliteStore(':memory:')
    replayEvents(replica, ctx.store.listEvents(ctx.project.id))
    expect(canonicalJson(replica.dumpRevisionedState(ctx.project.id))).toBe(
      canonicalJson(ctx.store.dumpRevisionedState(ctx.project.id)),
    )
  })

  it('refuses events with an unknown schema version', () => {
    const ctx = setup()
    const events = ctx.store
      .listEvents(ctx.project.id)
      .map((e) => ({ ...e, schemaVersion: 99 })) as never
    expect(() => replayEvents(new SqliteStore(':memory:'), events)).toThrow(/schema version 99/)
  })

  it('replay matches the live store for random sequences of proposals (property test)', () => {
    const step = fc.oneof(
      fc.record({
        kind: fc.constant('create' as const),
        name: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      fc.record({
        kind: fc.constant('rename' as const),
        pick: fc.nat(),
        name: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      fc.record({ kind: fc.constant('link' as const), a: fc.nat(), b: fc.nat() }),
      fc.record({ kind: fc.constant('retire' as const), pick: fc.nat() }),
    )
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (steps) => {
        const ctx = setup()
        for (const s of steps) {
          const objects = unwrap(
            ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
          ).objects
          const pick = (n: number) => objects[n % Math.max(objects.length, 1)]
          const head = ctx.store.getProject(ctx.project.id)?.headRevision ?? 0
          let ops: unknown[] = []
          if (s.kind === 'create')
            ops = [
              {
                op: 'createObject',
                type: 'software.Component',
                stance: 'asIs',
                attributes: { name: s.name },
                claim: stated,
              },
            ]
          else if (s.kind === 'rename' && objects.length > 0)
            ops = [{ op: 'updateObject', id: pick(s.pick)?.id, set: { name: s.name } }]
          else if (s.kind === 'link' && objects.length > 1)
            ops = [
              {
                op: 'createRelation',
                type: 'dependsOn',
                from: pick(s.a)?.id,
                to: pick(s.b)?.id,
                stance: 'asIs',
                claim: stated,
              },
            ]
          else if (s.kind === 'retire' && objects.length > 0)
            ops = [{ op: 'retireObject', id: pick(s.pick)?.id, reason: 'gone' }]
          if (ops.length === 0) continue
          const p = unwrap(
            ctx.services.proposeChange(ctx.owner, {
              projectId: ctx.project.id,
              baseRevision: head,
              rationale: 'prop',
              ops,
            }),
          )
          // Invalid proposals (self-loops, retiring linked objects) are part of the property: they must leave state untouched.
          if (p.status === 'pending')
            unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
        }
        const replica = new SqliteStore(':memory:')
        replayEvents(replica, ctx.store.listEvents(ctx.project.id))
        expect(canonicalJson(replica.dumpRevisionedState(ctx.project.id))).toBe(
          canonicalJson(ctx.store.dumpRevisionedState(ctx.project.id)),
        )
      }),
      { numRuns: 40 },
    )
  })
})
