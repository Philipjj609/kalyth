import { describe, expect, it } from 'vitest'
import { isClaimSupported } from '../src/index.ts'
import {
  BLOB,
  COMMIT,
  commitAsOwner,
  errorOf,
  evidenceOp,
  observed,
  seedSystem,
  setup,
  stated,
  unwrap,
} from './helpers.ts'

describe('projects and revisions', () => {
  it('creates a project at revision 0 with a creation event', () => {
    const ctx = setup()
    expect(ctx.project.headRevision).toBe(0)
    const events = ctx.store.listEvents(ctx.project.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'project.created',
      revision: 0,
      schemaVersion: 2,
      payload: { name: 'Fixture', description: 'test project', kind: 'project' },
      actor: ctx.ownerPrincipal.id,
    })
  })

  it('commits typed objects, relations and evidence as revision 1 and reads them back', () => {
    const ctx = setup()
    const { commit, apiId, moduleId } = seedSystem(ctx)
    expect(commit).toMatchObject({ status: 'committed', revision: 1, rebasedFrom: null })

    const objects = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
    ).objects
    expect(objects.map((o) => o.type).sort()).toEqual(['software.Container', 'software.Module'])
    expect(objects.every((o) => o.revision === 1 && o.lifecycle === 'active')).toBe(true)

    const relations = unwrap(
      ctx.services.queryRelations(ctx.owner, { projectId: ctx.project.id, from: apiId }),
    ).relations
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({ type: 'contains', from: apiId, to: moduleId })

    const evidenceId = objects[0]?.claim.supports[0]?.allOf[0] as string
    const evidence = unwrap(
      ctx.services.getEvidence(ctx.owner, { projectId: ctx.project.id, ids: [evidenceId] }),
    ).evidence
    expect(evidence[0]).toMatchObject({
      source: {
        kind: 'sourceSpan',
        commit: COMMIT,
        blobSha: BLOB,
        path: 'app/main.py',
        span: { startLine: 1, endLine: 2 },
      },
      excerptText: 'def main():\n    pass',
      excerptRedacted: false,
      revision: 1,
    })
    expect(evidence[0]?.excerpt?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names the id each local ref became, in the commit result and when it is asked again', () => {
    const ctx = setup()
    const { proposalId, commit } = commitAsOwner(ctx, [
      evidenceOp('$ev'),
      {
        op: 'createObject',
        ref: '$req',
        type: 'core.Requirement',
        stance: 'toBe',
        attributes: { title: 'Named', statement: 'S' },
        claim: stated,
      },
      {
        op: 'createObject',
        type: 'core.Requirement',
        stance: 'toBe',
        attributes: { title: 'Unnamed', statement: 'S' },
        claim: stated,
      },
    ])
    const objects = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
    ).objects
    const named = objects.find((o) => o.attributes.title === 'Named')?.id
    expect(commit.refs).toEqual({ $ev: expect.stringMatching(/^evd_[0-9a-f]{32}$/), $req: named })

    // The stored proposal keeps each created record's ref beside its id.
    const stored = unwrap(ctx.services.getProposal(ctx.owner, { proposalId }))
    expect(stored.ops[1]).toMatchObject({ op: 'createObject', id: named, ref: '$req' })
    expect(stored.ops[2]).not.toHaveProperty('ref')
    expect(stored.result?.refs).toEqual(commit.refs)
    expect(unwrap(ctx.services.commitProposal(ctx.owner, { proposalId }))).toEqual(commit)

    // A result stored before refs were kept reads back with an empty map.
    const { refs: _refs, ...before } = commit
    ctx.store.db
      .prepare('UPDATE proposals SET result = ? WHERE id = ?')
      .run(JSON.stringify(before), proposalId)
    expect(ctx.store.getProposal(proposalId)?.result).toEqual({ ...before, refs: {} })
  })

  it('pages objects and relations in id order after a cursor', () => {
    const ctx = setup()
    seedSystem(ctx)
    const all = unwrap(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id })).objects
    expect(all.length).toBeGreaterThan(1)
    const first = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, limit: 1 }),
    ).objects
    const rest = unwrap(
      ctx.services.queryObjects(ctx.owner, {
        projectId: ctx.project.id,
        after: first[first.length - 1]?.id,
      }),
    ).objects
    expect([...first, ...rest].map((o) => o.id)).toEqual(all.map((o) => o.id))
    const relations = unwrap(
      ctx.services.queryRelations(ctx.owner, { projectId: ctx.project.id }),
    ).relations
    const after = unwrap(
      ctx.services.queryRelations(ctx.owner, {
        projectId: ctx.project.id,
        after: relations[0]?.id,
      }),
    ).relations
    expect(after.map((r) => r.id)).toEqual(relations.slice(1).map((r) => r.id))
  })

  it('reads historical revisions after later commits', () => {
    const ctx = setup()
    const { moduleId } = seedSystem(ctx)
    commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'python3' } }])

    const at1 = unwrap(
      ctx.services.queryObjects(ctx.owner, {
        projectId: ctx.project.id,
        revision: 1,
        ids: [moduleId],
      }),
    )
    const at2 = unwrap(
      ctx.services.queryObjects(ctx.owner, {
        projectId: ctx.project.id,
        revision: 2,
        ids: [moduleId],
      }),
    )
    expect(at1.objects[0]?.attributes.language).toBe('python')
    expect(at2.objects[0]?.attributes.language).toBe('python3')
    expect(
      unwrap(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, revision: 0 }))
        .objects,
    ).toEqual([])
    expect(
      errorOf(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, revision: 9 }))
        .code,
    ).toBe('invalid')

    const history = unwrap(ctx.services.getHistory(ctx.owner, { projectId: ctx.project.id }))
    expect(history.headRevision).toBe(2)
    expect(history.changeSets.map((c) => c.revision)).toEqual([2, 1])
  })

  it('reads when objects were first written and when revisions were committed', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    commitAsOwner(ctx, [{ op: 'updateObject', id: moduleId, set: { language: 'python3' } }])
    const unknown = `obj_${'0'.repeat(32)}`
    expect(ctx.store.firstRevisions(ctx.project.id, [apiId, moduleId, unknown])).toEqual(
      new Map([
        [apiId, 1],
        [moduleId, 1],
      ]),
    )
    const changeSets = unwrap(
      ctx.services.getHistory(ctx.owner, { projectId: ctx.project.id }),
    ).changeSets
    expect(changeSets[0]?.committedAt).not.toBe(changeSets[1]?.committedAt)
    expect(ctx.store.commitTimes(ctx.project.id, [1, 2, 9])).toEqual(
      new Map(changeSets.map((c) => [c.revision, c.committedAt])),
    )
    expect(ctx.store.firstRevisions(ctx.project.id, [])).toEqual(new Map())
    expect(ctx.store.commitTimes(ctx.project.id, [])).toEqual(new Map())
  })

  it('retires instead of deleting, and keeps the retired version readable', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    const relation = unwrap(ctx.services.queryRelations(ctx.owner, { projectId: ctx.project.id }))
      .relations[0]
    commitAsOwner(ctx, [
      { op: 'retireRelation', id: relation?.id as string, reason: 'module moved' },
      { op: 'retireObject', id: moduleId, reason: 'file deleted' },
    ])
    const active = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }),
    ).objects
    expect(active.map((o) => o.id)).toEqual([apiId])
    const all = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, includeRetired: true }),
    ).objects
    expect(all.find((o) => o.id === moduleId)).toMatchObject({
      lifecycle: 'retired',
      retiredReason: 'file deleted',
    })
  })
})

describe('validation', () => {
  it('rejects a relation with a wrong endpoint type and writes nothing', () => {
    const ctx = setup()
    const proposed = unwrap(
      ctx.services.proposeChange(ctx.owner, {
        projectId: ctx.project.id,
        baseRevision: 0,
        rationale: 'bad edge',
        ops: [
          {
            op: 'createObject',
            ref: '$r',
            type: 'core.Requirement',
            stance: 'toBe',
            attributes: { title: 'R', statement: 'S' },
            claim: stated,
          },
          {
            op: 'createObject',
            ref: '$d',
            type: 'software.DataEntity',
            stance: 'asIs',
            attributes: { name: 'users' },
            claim: stated,
          },
          {
            op: 'createRelation',
            type: 'exposes',
            from: '$r',
            to: '$d',
            stance: 'asIs',
            claim: stated,
          },
        ],
      }),
    )
    expect(proposed.status).toBe('invalid')
    expect(proposed.issues.map((i) => i.code)).toEqual([
      'relation.endpoint_type',
      'relation.endpoint_type',
    ])
    expect(
      errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: proposed.proposalId })).code,
    ).toBe('invalid')
    expect(ctx.store.getProject(ctx.project.id)?.headRevision).toBe(0)
    expect(
      unwrap(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id })).objects,
    ).toEqual([])
  })

  it('rejects unknown types, unknown attributes and malformed input', () => {
    const ctx = setup()
    const propose = (ops: unknown[]) =>
      ctx.services.proposeChange(ctx.owner, {
        projectId: ctx.project.id,
        baseRevision: 0,
        rationale: 'x',
        ops,
      })
    expect(
      unwrap(
        propose([
          {
            op: 'createObject',
            type: 'software.Widget',
            stance: 'asIs',
            attributes: {},
            claim: stated,
          },
        ]),
      ).issues[0]?.code,
    ).toBe('type.unknown')
    expect(
      unwrap(
        propose([
          {
            op: 'createObject',
            type: 'software.Module',
            stance: 'asIs',
            attributes: { path: 'a.py', colour: 'red' },
            claim: stated,
          },
        ]),
      ).issues[0]?.code,
    ).toBe('attribute.invalid')
    expect(errorOf(propose([{ op: 'explode' }])).code).toBe('invalid')
    expect(
      unwrap(
        propose([
          {
            op: 'createRelation',
            type: 'contains',
            from: '$nope',
            to: '$nada',
            stance: 'asIs',
            claim: stated,
          },
        ]),
      ).issues[0]?.code,
    ).toBe('ref.unknown')
  })

  it('rejects cycles and enforces cardinality', () => {
    const ctx = setup()
    const { apiId, moduleId } = seedSystem(ctx)
    const propose = (ops: unknown[]) =>
      unwrap(
        ctx.services.proposeChange(ctx.owner, {
          projectId: ctx.project.id,
          baseRevision: 1,
          rationale: 'x',
          ops,
        }),
      )
    expect(
      propose([
        {
          op: 'createRelation',
          type: 'contains',
          from: moduleId,
          to: apiId,
          stance: 'asIs',
          claim: stated,
        },
      ]).issues.map((i) => i.code),
    ).toContain('relation.cycle')
    const second = propose([
      {
        op: 'createObject',
        ref: '$c2',
        type: 'software.Container',
        stance: 'asIs',
        attributes: { name: 'worker' },
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$c2',
        to: moduleId,
        stance: 'asIs',
        claim: stated,
      },
    ])
    expect(second.issues.map((i) => i.code)).toEqual(['relation.cardinality'])
  })

  it('protects decision status from ordinary updates', () => {
    const ctx = setup()
    const propose = (ops: unknown[], base = 0) =>
      unwrap(
        ctx.services.proposeChange(ctx.owner, {
          projectId: ctx.project.id,
          baseRevision: base,
          rationale: 'x',
          ops,
        }),
      )
    const decision = { op: 'createObject', type: 'core.Decision', stance: 'toBe', claim: stated }
    expect(
      propose([
        { ...decision, attributes: { title: 'Tenancy', question: 'How?', status: 'accepted' } },
      ]).issues[0]?.code,
    ).toBe('attribute.reserved')
    commitAsOwner(ctx, [
      { ...decision, attributes: { title: 'Tenancy', question: 'How?' } } as never,
    ])
    const id = unwrap(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }))
      .objects[0]?.id as string
    expect(
      propose([{ op: 'updateObject', id, set: { status: 'accepted' } }], 1).issues[0]?.code,
    ).toBe('attribute.reserved')
  })
})

describe('claims and evidence (R2, R4)', () => {
  const propose = (ctx: ReturnType<typeof setup>, ops: unknown[]) =>
    unwrap(
      ctx.services.proposeChange(ctx.owner, {
        projectId: ctx.project.id,
        baseRevision: 0,
        rationale: 'x',
        ops,
      }),
    )
  const module = {
    op: 'createObject',
    type: 'software.Module',
    stance: 'asIs',
    attributes: { path: 'a.py' },
  }

  it('requires observed claims to name the observing tool, its coverage and source evidence (R4)', () => {
    const ctx = setup()
    expect(
      propose(ctx, [
        evidenceOp('$e'),
        { ...module, claim: { basis: 'observed', supports: [{ allOf: ['$e'] }] } },
      ]).issues.map((i) => i.code),
    ).toEqual(['claim.observation_required'])
    expect(
      propose(ctx, [
        {
          ...module,
          claim: { basis: 'observed', observation: { tool: 't', toolVersion: '1', coverage: 'c' } },
        },
      ]).issues.map((i) => i.code),
    ).toEqual(['claim.support_required'])
    expect(
      propose(ctx, [
        evidenceOp('$e'),
        {
          ...module,
          claim: { ...observed('$e'), model: { provider: 'nebius', model: 'nemotron' } },
        },
      ]).issues.map((i) => i.code),
    ).toEqual(['claim.observed_from_model'])
    const statement = {
      op: 'recordEvidence',
      ref: '$s',
      evidence: {
        source: { kind: 'statement', statedBy: ctx.ownerPrincipal.id },
        collectedBy: { tool: 'ui', toolVersion: '1' },
      },
    }
    expect(
      propose(ctx, [statement, { ...module, claim: observed('$s') }]).issues.map((i) => i.code),
    ).toEqual(['claim.observed_needs_source_evidence'])
  })

  it('requires inferred claims about existing reality to be grounded and to state confidence', () => {
    const ctx = setup()
    const inferred = { basis: 'inferred', confidence: { level: 'medium', rationale: 'naming' } }
    expect(propose(ctx, [{ ...module, claim: inferred }]).issues.map((i) => i.code)).toEqual([
      'claim.grounding_required',
    ])
    expect(
      propose(ctx, [{ ...module, claim: { basis: 'inferred' } }]).issues.map((i) => i.code),
    ).toEqual(['claim.confidence_required', 'claim.grounding_required'])
    const toBe = {
      op: 'createObject',
      type: 'software.Component',
      stance: 'toBe',
      attributes: { name: 'TenantResolver' },
      claim: inferred,
    }
    expect(propose(ctx, [toBe]).status).toBe('pending')
  })

  it('treats evidence groups as alternatives of jointly required items (R2)', () => {
    const fresh = new Set(['evd_a', 'evd_c'])
    const isFresh = (id: string) => fresh.has(id)
    expect(isClaimSupported({ supports: [{ allOf: ['evd_a', 'evd_b'] }] }, isFresh)).toBe(false)
    expect(
      isClaimSupported(
        { supports: [{ allOf: ['evd_a', 'evd_b'] }, { allOf: ['evd_c'] }] },
        isFresh,
      ),
    ).toBe(true)
    expect(isClaimSupported({ supports: [] }, isFresh)).toBe(false)

    const ctx = setup()
    const p = propose(ctx, [
      evidenceOp('$e1'),
      evidenceOp('$e2', 'b.py'),
      {
        ...module,
        claim: {
          ...observed('$e1', '$e2'),
          supports: [{ allOf: ['$e1', '$e2'] }, { allOf: ['$e2'] }],
        },
      },
    ])
    expect(p.status).toBe('pending')
    const stored = ctx.store.getProposal(p.proposalId)?.ops.find((o) => o.op === 'createObject')
    expect(
      stored && 'claim' in stored ? stored.claim.supports.map((g) => g.allOf.length) : [],
    ).toEqual([2, 1])
  })

  it('keeps raw excerpts out of proposals and events, and redacts excerpts that look like secrets (R3)', () => {
    const ctx = setup()
    // Built at runtime so secret scanners do not flag this fixture (AWS's documented example key).
    const leaked = `AWS_KEY = "${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}"`
    const { proposalId } = commitAsOwner(ctx, [
      evidenceOp('$e', 'settings.py', leaked),
      { ...module, claim: observed('$e') } as never,
    ])
    const rawProposal = JSON.stringify(ctx.store.getProposal(proposalId))
    const rawEvents = JSON.stringify(ctx.store.listEvents(ctx.project.id))
    expect(rawProposal).not.toContain('AKIA')
    expect(rawEvents).not.toContain('AKIA')
    expect(rawEvents).not.toContain('def main')
    const evidenceId = unwrap(ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id }))
      .objects[0]?.claim.supports[0]?.allOf[0] as string
    const view = unwrap(
      ctx.services.getEvidence(ctx.owner, { projectId: ctx.project.id, ids: [evidenceId] }),
    ).evidence[0]
    expect(view).toMatchObject({ excerptText: null, excerptRedacted: true })
  })
})
