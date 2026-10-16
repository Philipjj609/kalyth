import type { Caller } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { commitAsOwner, errorOf, seedSystem, setup, stated, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>
const propose = (
  ctx: Ctx,
  baseRevision: number,
  ops: unknown[],
  extra: Record<string, unknown> = {},
  caller: Caller = ctx.owner,
) =>
  unwrap(
    ctx.services.proposeChange(caller, {
      projectId: ctx.project.id,
      baseRevision,
      rationale: 'x',
      ops,
      ...extra,
    }),
  )

describe('optimistic concurrency and rebase', () => {
  it('rejects a proposal as stale when something it relies on changed', () => {
    const ctx = setup()
    const { moduleId } = seedSystem(ctx)
    const first = propose(ctx, 1, [{ op: 'updateObject', id: moduleId, set: { language: 'py' } }])
    const second = propose(ctx, 1, [
      { op: 'updateObject', id: moduleId, set: { language: 'python3' } },
    ])
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: first.proposalId }))
    const error = errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: second.proposalId }))
    expect(error).toMatchObject({ code: 'stale', currentRevision: 2, changedRefs: [moduleId] })
    expect(ctx.store.getProposal(second.proposalId)?.status).toBe('stale')
  })

  it('treats a relation endpoint as read state', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    const addEndpoint = propose(ctx, 1, [
      {
        op: 'createObject',
        ref: '$e',
        type: 'software.Endpoint',
        stance: 'asIs',
        attributes: { method: 'GET', path: '/items' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'exposes',
        from: moduleId,
        to: '$e',
        stance: 'asIs',
        claim: stated,
      },
    ])
    commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'py' } }], 1)
    expect(
      errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: addEndpoint.proposalId })),
    ).toMatchObject({ code: 'stale', changedRefs: [moduleId] })
    expect(apiId).toBeTruthy()
  })

  it('rebases automatically when nothing it relies on changed', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    const touchApi = propose(ctx, 1, [
      { op: 'updateObject', id: apiId, set: { technology: 'FastAPI' } },
    ])
    commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'py' } }], 1)
    const result = unwrap(
      ctx.services.commitProposal(ctx.owner, { proposalId: touchApi.proposalId }),
    )
    expect(result).toMatchObject({ revision: 3, rebasedFrom: 1 })
    expect(
      unwrap(ctx.services.getHistory(ctx.owner, { projectId: ctx.project.id })).changeSets[0],
    ).toMatchObject({ revision: 3, rebasedFrom: 1 })
  })

  it('re-checks cross-object invariants at head even when read sets are disjoint (R1)', () => {
    const ctx = setup()
    commitAsOwner(ctx, [
      {
        op: 'createObject',
        ref: '$d',
        type: 'core.Decision',
        stance: 'toBe',
        attributes: { title: 'Tenancy', question: 'Which model?' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$a',
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: { title: 'Shared schema', summary: 'tenant_id column' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$b',
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: { title: 'Schema per tenant', summary: 'one schema each' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: '$a',
        to: '$d',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'alternativeOf',
        from: '$b',
        to: '$d',
        stance: 'toBe',
        claim: stated,
      },
    ])
    const alts = unwrap(
      ctx.services.queryObjects(ctx.owner, {
        projectId: ctx.project.id,
        types: ['core.Alternative'],
      }),
    ).objects
    const [a, b] = alts.map((o) => o.id) as [string, string]
    const acceptA = propose(ctx, 1, [
      { op: 'setDecisionStatus', id: a, status: 'accepted', rationale: 'simplest' },
    ])
    const acceptB = propose(ctx, 1, [
      { op: 'setDecisionStatus', id: b, status: 'accepted', rationale: 'strongest isolation' },
    ])
    expect(acceptA.status).toBe('pending')
    expect(acceptB.status).toBe('pending')
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: acceptA.proposalId }))
    const error = errorOf(
      ctx.services.commitProposal(ctx.owner, { proposalId: acceptB.proposalId }),
    )
    expect(error.code).toBe('conflicting')
    expect(error.issues.map((i) => i.code)).toEqual(['decision.multiple_accepted'])
    expect(ctx.store.getProposal(acceptB.proposalId)?.status).toBe('conflicting')
  })

  it('re-checks referential invariants at head: no active relation may point at a retired object (R1)', () => {
    const ctx = setup()
    commitAsOwner(ctx, [
      {
        op: 'createObject',
        ref: '$m',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'a.py' },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$l',
        type: 'software.Library',
        stance: 'asIs',
        attributes: { name: 'sqlmodel' },
        claim: stated,
      },
    ])
    const objects = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
    ).objects
    const lib = objects.find((o) => o.type === 'software.Library')?.id as string
    const retireLib = propose(ctx, 1, [
      { op: 'retireObject', id: lib, reason: 'dependency removed' },
    ])
    // A concurrent proposal creates a relation to the library; its read set includes lib, but the
    // retire proposal's read and write sets do not include the new relation.
    const mod = objects.find((o) => o.type === 'software.Module')?.id as string
    commitAsOwner(
      ctx,
      [
        {
          op: 'createRelation',
          type: 'dependsOn',
          from: mod,
          to: lib,
          stance: 'asIs',
          claim: stated,
        },
      ],
      1,
    )
    const error = errorOf(
      ctx.services.commitProposal(ctx.owner, { proposalId: retireLib.proposalId }),
    )
    expect(error.code).toBe('conflicting')
    expect(error.issues.map((i) => i.code)).toEqual(['object.has_active_relations'])
  })

  it('makes a proposal stale when a declared predicate result changes (R1)', () => {
    const ctx = setup()
    seedSystem(ctx)
    const noItemsRoute = {
      id: 'no-items-route',
      query: { kind: 'objects', types: ['software.Endpoint'], attributeEquals: { path: '/items' } },
    }
    const addRoute = propose(
      ctx,
      1,
      [
        {
          op: 'createObject',
          type: 'software.Endpoint',
          stance: 'toBe',
          attributes: { method: 'GET', path: '/items' },
          claim: stated,
        },
      ],
      { predicates: [noItemsRoute] },
    )
    commitAsOwner(
      ctx,
      [
        {
          op: 'createObject',
          type: 'software.Endpoint',
          stance: 'asIs',
          attributes: { method: 'GET', path: '/items' },
          claim: stated,
        },
      ],
      1,
    )
    expect(
      errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: addRoute.proposalId })),
    ).toMatchObject({
      code: 'stale',
      changedRefs: ['predicate:no-items-route'],
    })
  })

  it('returns the original result when a committed proposal is committed again', () => {
    const ctx = setup()
    const { proposalId, commit } = commitAsOwner(ctx, [
      {
        op: 'createObject',
        type: 'core.Assertion',
        stance: 'asIs',
        attributes: { statement: 'x' },
        claim: stated,
      },
    ])
    expect(unwrap(ctx.services.commitProposal(ctx.owner, { proposalId }))).toEqual(commit)
    expect(ctx.store.getProject(ctx.project.id)?.headRevision).toBe(1)
  })
})
