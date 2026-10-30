import type { Caller, MethodRun, OperationInput, Proposal } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, KalythServices, SqliteStore, stateSha256 } from '../src/index.ts'
import { errorOf, setup, stated, unwrap } from './helpers.ts'
import {
  commitOps,
  elementOp,
  fileLibrary,
  multiGame,
  parameterOp,
  pinOp,
  scenarioOp,
} from './method-fixture.ts'
import { databaseSeed } from './method-libraries.ts'

type Ctx = ReturnType<typeof setup>
const run = (ctx: Ctx, input: object, by: Caller = ctx.owner): MethodRun =>
  unwrap(ctx.services.startMethodRun(by, input))
const head = (ctx: Ctx, id = ctx.project.id) => ctx.store.getProject(id)?.headRevision ?? 0
const pending = (ctx: Ctx) =>
  unwrap(ctx.services.listProposals(ctx.owner, { projectId: ctx.project.id, status: 'pending' }))
    .proposals.length

/** The orders database of a shop, using the database-scaling library. */
function shop(ctx: Ctx, options: Parameters<typeof databaseSeed>[0] = {}) {
  const { lib, L } = fileLibrary(ctx, databaseSeed(options))
  const id = (ref: string) => L[ref] as string
  const P = commitOps(ctx, ctx.project.id, [
    {
      op: 'createObject',
      ref: '$use',
      type: 'core.LibraryUse',
      stance: 'toBe',
      attributes: { library: lib.id, label: 'test/database-scaling', revision: 1, role: 'primary' },
      claim: stated,
    },
    pinOp(lib.id, '$method', id('$scale')),
    pinOp(lib.id, '$readsDominate', id('$readsDominate')),
    pinOp(lib.id, '$strong', id('$strong')),
    elementOp('$orders', 'software.Container', 'Orders database'),
    scenarioOp('$peak', 'Peak season', 1, 'committed'),
  ])
  const p = (ref: string) => P[ref] as string
  commitOps(ctx, ctx.project.id, [
    parameterOp('$reads', p('$readsDominate'), p('$peak'), { kind: 'boolean', value: true }),
    parameterOp('$weak', p('$strong'), p('$peak'), { kind: 'boolean', value: false }),
  ])
  const input = {
    projectId: ctx.project.id,
    method: p('$method'),
    elements: [p('$orders')],
    scenarios: [p('$peak')],
    natures: ['expected'],
  }
  return { lib, L, P, input }
}

describe('method runs: selection (ADR 0033 §3, test 2)', () => {
  it('cuts in the fixed order at maxCandidates, and lists every cut item with its sources', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const r = run(ctx, { ...input, limits: { maxCandidates: 4, maxHops: 2, maxAssessments: 60 } })
    expect(r.selection.candidates.map((c) => c.name)).toEqual([
      'Authoritative server',
      'Deterministic lockstep',
      'Snapshot interpolation',
      'Dead reckoning',
    ])
    expect(r.selection.cut.map((c) => [c.name, c.sources.map((s) => s.source)])).toEqual([
      ['Client-side prediction with server reconciliation', ['graph']],
      ['Entity interpolation', ['graph']],
      ['Lag compensation', ['graph']],
    ])
    expect(r.selection.cut.every((c) => /maxCandidates 4/.test(c.reason ?? ''))).toBe(true)
  })

  it('finds an item beyond maxHops through the lexical source only', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const r = run(ctx, {
      ...input,
      request: 'lag compensation',
      limits: { maxCandidates: 12, maxHops: 0, maxAssessments: 60 },
    })
    const names = r.selection.candidates.map((c) => c.name)
    expect(names).not.toContain('Entity interpolation')
    const lag = r.selection.candidates.find((c) => c.name === 'Lag compensation')
    expect(lag?.sources.map((s) => s.source)).toEqual(['lexical'])
    expect(lag?.sources[0]?.score).toBeGreaterThan(0)
    expect(names.at(-1)).toBe('Lag compensation')
  })

  it('lists hypotheses as ideas, never as candidates', () => {
    const ctx = setup()
    const { input } = shop(ctx, { hypothesis: true })
    const r = run(ctx, input)
    expect(r.selection.ideas.map((c) => c.name)).toEqual(['Read-through cache'])
    expect(r.selection.candidates.map((c) => c.name)).not.toContain('Read-through cache')
  })
})

describe('method runs: no model (ADR 0033 §1, test 3)', () => {
  it('fails a method with a model step, and costs nothing', () => {
    const ctx = setup()
    const { input } = shop(ctx, { modelStep: true })
    const before = pending(ctx)
    const r = run(ctx, input)
    expect(r).toMatchObject({
      status: 'failed',
      failure: { code: 'method.model_steps_not_enabled' },
      proposal: null,
      cost: { modelCalls: 0, microUsd: 0 },
    })
    expect(pending(ctx)).toBe(before)
  })
})

describe('method runs on another discipline (ADR 0033 Generalisation, test 9)', () => {
  it('runs unchanged on a small database-scaling library', () => {
    const ctx = setup()
    const { input } = shop(ctx)
    const r = run(ctx, input)
    expect(r.status).toBe('proposed')
    expect(r.selection.candidates.map((c) => [c.name, c.sources.map((s) => s.source)])).toEqual([
      ['Read replicas', ['explicit', 'parameter']],
      ['Sharding', ['explicit']],
      ['Command and query responsibility segregation', ['graph']],
    ])
    expect(
      r.comparison.map((e) => [e.name, e.contexts.map((v) => v.verdict), Boolean(e.alternative)]),
    ).toEqual([
      ['Read replicas', ['conditionsMet'], true],
      ['Sharding', ['unknown'], true],
      ['Command and query responsibility segregation', ['unknown'], true],
    ])
    const proposal = ctx.store.getProposal(r.proposal as string) as Proposal
    const questions = proposal.ops
      .filter((o) => o.op === 'createObject' && o.type === 'core.Question')
      .map((o) => (o.op === 'createObject' ? String(o.attributes.text) : ''))
    expect(questions.some((q) => q.includes('"Writes exceed one node"'))).toBe(true)
    expect(questions.some((q) => q.startsWith('Which conditions must hold for "Command'))).toBe(
      true,
    )
    expect(questions.some((q) => q.startsWith('No pinned knowledge'))).toBe(false)
    expect(r.checks.every((c) => c.passed)).toBe(true)
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: r.proposal as string }))
  })
})

/** The multi-game run committed, with handy lookups of its assessments. */
function committedRun(ctx: Ctx) {
  const x = multiGame(ctx)
  const r = run(ctx, x.input)
  unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: r.proposal as string }))
  const entry = (name: string) =>
    r.comparison.find((e) => e.name === name) as MethodRun['comparison'][number]
  const assessment = (name: string, scenario: string, element: string) =>
    entry(name).contexts.find(
      (v) => x.names.get(v.scenario) === scenario && x.names.get(v.element as string) === element,
    )?.assessment as string
  const pin = (name: string) => r.selection.candidates.find((c) => c.name === name)?.pin as string
  const decision = ctx.store
    .view(ctx.project.id, head(ctx))
    .listObjects({ types: ['core.Decision'] })[0]?.id as string
  return { ...x, r, entry, assessment, pin, decision }
}

const alternative = (
  ref: string,
  decision: string,
  basis: {
    pins: string[]
    covers: string[]
    ruledOut?: string[]
    disputed?: string[]
    hypotheses?: string[]
    worsens?: string[]
    unbacked?: boolean
  },
): OperationInput[] => [
  {
    op: 'createObject',
    ref,
    type: 'core.Alternative',
    stance: 'toBe',
    attributes: {
      title: 'Crafted',
      summary: 'A hand-made alternative.',
      basis: {
        pins: basis.pins,
        covers: basis.covers,
        ruledOut: basis.ruledOut ?? [],
        disclosed: {
          disputed: basis.disputed ?? [],
          hypotheses: basis.hypotheses ?? [],
          worsens: basis.worsens ?? [],
          underspecified: [],
        },
        unbacked: basis.unbacked ?? false,
      },
    },
    claim: stated,
  },
  {
    op: 'createRelation',
    type: 'alternativeOf',
    from: ref,
    to: decision,
    stance: 'toBe',
    claim: stated,
  },
]

const propose = (ctx: Ctx, ops: OperationInput[], by: Caller = ctx.owner) =>
  unwrap(
    ctx.services.proposeChange(by, {
      projectId: ctx.project.id,
      baseRevision: head(ctx),
      ops,
      rationale: 'crafted',
    }),
  )
const failing = (p: ReturnType<typeof propose>) =>
  (p.checks ?? []).filter((c) => !c.passed).map((c) => c.check)

describe('exact coverage (ADR 0033 A1, test 5a)', () => {
  it('keeps the RTS covered and the shooter ruled out in the same scenario', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const lockstep = ctx.store
      .view(ctx.project.id, head(ctx))
      .getObject(x.entry('Deterministic lockstep').alternative as string)
    const basis = lockstep?.attributes.basis as { covers: string[]; ruledOut: string[] }
    expect(basis.covers).toContain(x.assessment('Deterministic lockstep', 'Expansion', 'RTS'))
    expect(basis.ruledOut).toEqual([
      x.assessment('Deterministic lockstep', 'Expansion', 'Arena shooter'),
    ])
  })

  it('refuses a basis that could mislead', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const lock = x.pin('Deterministic lockstep')
    const met = x.assessment('Deterministic lockstep', 'Expansion', 'RTS')
    const notMet = x.assessment('Deterministic lockstep', 'Expansion', 'Arena shooter')
    const other = x.assessment('Entity interpolation', 'Launch', 'RTS')
    const refused = (basis: Parameters<typeof alternative>[2]) => {
      const p = propose(ctx, alternative('$alt', x.decision, basis))
      expect(p.status).toBe('invalid')
      return p.issues.map((i) => i.code)
    }
    // A conditionsNotMet assessment listed as covered.
    expect(refused({ pins: [lock], covers: [met, notMet] })).toContain(
      'alternative.basis_inconsistent',
    )
    // One context in both lists.
    expect(refused({ pins: [lock], covers: [met], ruledOut: [met] })).toContain(
      'alternative.basis_inconsistent',
    )
    // An assessment of an item it does not rely on.
    expect(refused({ pins: [lock], covers: [met, other] })).toContain(
      'alternative.basis_inconsistent',
    )
    // A pin without an assessment.
    expect(refused({ pins: [lock, x.pin('Entity interpolation')], covers: [met] })).toContain(
      'alternative.basis_inconsistent',
    )
    // The consistent one is accepted as a proposal.
    expect(
      propose(
        ctx,
        alternative('$alt', x.decision, {
          pins: [lock],
          covers: [met],
          ruledOut: [notMet],
          worsens: ['Input responsiveness'],
        }),
      ).status,
    ).toBe('pending')
  })
})

describe('the check catalogue (ADR 0033 §8, test 4)', () => {
  it('fails each coverage check on a crafted proposal and passes the corrected one', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const lock = x.pin('Deterministic lockstep')
    const entity = x.pin('Entity interpolation')
    const lockNotMet = x.assessment('Deterministic lockstep', 'Expansion', 'Arena shooter')
    const lockMet = x.assessment('Deterministic lockstep', 'Launch', 'RTS')
    const worsens = ['Input responsiveness', 'Timeliness of remote entities']

    // Only ruled out: it covers nothing.
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', x.decision, {
            pins: [lock],
            covers: [],
            ruledOut: [lockNotMet],
            worsens,
          }),
        ),
      ),
    ).toEqual(['alternatives-cite-assessments'])
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', x.decision, {
            pins: [lock],
            covers: [lockMet],
            ruledOut: [lockNotMet],
            worsens,
          }),
        ),
      ),
    ).toEqual([])

    // Covers the shooter in Expansion, where lockstep, which it also relies on, is ruled out.
    const entityShooter = x.assessment('Entity interpolation', 'Expansion', 'Arena shooter')
    const entityRts = x.assessment('Entity interpolation', 'Launch', 'RTS')
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', x.decision, {
            pins: [lock, entity],
            covers: [lockMet, entityShooter],
            worsens,
          }),
        ),
      ),
    ).toEqual(['no-reliance-on-ruled-out'])
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', x.decision, {
            pins: [lock, entity],
            covers: [lockMet, entityRts],
            worsens,
          }),
        ),
      ),
    ).toEqual([])

    // A worsened quality left undisclosed is advisory: the proposal is still pending.
    const quiet = propose(ctx, alternative('$a', x.decision, { pins: [lock], covers: [lockMet] }))
    expect(quiet.status).toBe('pending')
    expect(failing(quiet)).toEqual(['worsens-disclosed'])
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: quiet.proposalId }))
  })

  it('fails on undisclosed disputes and unlabelled hypotheses, and passes when disclosed', () => {
    const ctx = setup()
    const { input, lib, L } = shop(ctx, { dispute: true, hypothesis: true })
    const r = run(ctx, input)
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: r.proposal as string }))
    // The run disclosed the dispute itself, so its own alternatives pass.
    expect(r.checks.every((c) => c.passed)).toBe(true)
    const sharding = r.selection.candidates.find((c) => c.name === 'Sharding')?.pin as string
    const shardAssessment = r.comparison.find((e) => e.name === 'Sharding')?.contexts[0]
      ?.assessment as string
    const decision = ctx.store
      .view(ctx.project.id, head(ctx))
      .listObjects({ types: ['core.Decision'] })[0]?.id as string
    const worsens = ['Operational simplicity']
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', decision, { pins: [sharding], covers: [shardAssessment], worsens }),
        ),
      ),
    ).toEqual(['disputed-flagged'])
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', decision, {
            pins: [sharding],
            covers: [shardAssessment],
            worsens,
            disputed: [sharding],
          }),
        ),
      ),
    ).toEqual([])

    const cachePin = commitOps(ctx, ctx.project.id, [pinOp(lib.id, '$cache', L.$cache as string)])
      .$cache as string
    const withCache = {
      pins: [sharding, cachePin],
      covers: [shardAssessment],
      worsens: [...worsens, 'Freshness of reads'],
      disputed: [sharding],
      hypotheses: [cachePin],
    }
    expect(failing(propose(ctx, alternative('$a', decision, withCache)))).toEqual([
      'hypotheses-labelled',
    ])
    expect(
      failing(propose(ctx, alternative('$a', decision, { ...withCache, unbacked: true }))),
    ).toEqual([])
    // Disclosing a pin that is not a hypothesis as one does not excuse its missing assessment.
    const replicas = r.selection.candidates.find((c) => c.name === 'Read replicas')?.pin as string
    expect(
      failing(
        propose(
          ctx,
          alternative('$a', decision, {
            ...withCache,
            pins: [sharding, replicas],
            hypotheses: [replicas],
            unbacked: true,
          }),
        ),
      ),
    ).toContain('alternatives-cite-assessments')
  })
})

describe('the acceptance gate and exceptions (ADR 0033 §8, test 5)', () => {
  it('refuses the commit of a failing alternative unless a person excepts it, with a reason', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const lock = x.pin('Deterministic lockstep')
    const notMet = x.assessment('Deterministic lockstep', 'Expansion', 'Arena shooter')
    const p = propose(
      ctx,
      alternative('$a', x.decision, {
        pins: [lock],
        covers: [],
        ruledOut: [notMet],
        worsens: ['Input responsiveness'],
      }),
      ctx.agent,
    )
    expect(p.status).toBe('pending')
    const refused = errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    expect(refused.issues.map((i) => i.code)).toEqual(['check.failed'])
    const target = p.checks?.find((c) => !c.passed)?.target as string
    const exception = {
      check: 'alternatives-cite-assessments' as const,
      target,
      reason: 'Kept on record as the option we ruled out.',
    }
    // An agent cannot give one, nor can a person acting through an agent.
    expect(
      errorOf(
        ctx.services.commitProposal(ctx.agent, {
          proposalId: p.proposalId,
          exceptions: [exception],
        }),
      ).code,
    ).toBe('unauthorized')
    expect(
      errorOf(
        ctx.services.commitProposal(
          { principalId: ctx.owner.principalId, origin: 'agent' },
          { proposalId: p.proposalId, exceptions: [exception] },
        ),
      ).code,
    ).toBe('unauthorized')
    // An exception must answer a failure.
    expect(
      errorOf(
        ctx.services.commitProposal(ctx.owner, {
          proposalId: p.proposalId,
          exceptions: [{ ...exception, check: 'disputed-flagged' }],
        }),
      ).issues.map((i) => i.code),
    ).toEqual(['check_exception.not_failing'])
    const done = unwrap(
      ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId, exceptions: [exception] }),
    )
    expect(done.exceptions).toHaveLength(2)
    // It is in history, in the same change set, stated by the person.
    const view = ctx.store.view(ctx.project.id, done.revision)
    const [recorded] = view.listObjects({ types: ['core.CheckException'] })
    expect(recorded?.attributes).toMatchObject({ ...exception, checkVersion: 1 })
    expect(recorded?.revision).toBe(done.revision)
    const statement = view.getEvidence(recorded?.claim.supports[0]?.allOf[0] as string)
    expect(statement?.source).toEqual({ kind: 'statement', statedBy: ctx.owner.principalId })
    const history = unwrap(ctx.services.getHistory(ctx.owner, { projectId: ctx.project.id }))
    expect(history.changeSets[0]).toMatchObject({
      revision: done.revision,
      proposalId: p.proposalId,
      committedBy: ctx.owner.principalId,
      writeCount: 4,
    })
  })

  it('refuses an ordinary proposal that creates a check exception', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const p = propose(
      ctx,
      [
        {
          op: 'createObject',
          type: 'core.CheckException',
          stance: 'toBe',
          attributes: {
            check: 'no-reliance-on-ruled-out',
            checkVersion: 1,
            target: x.entry('Deterministic lockstep').alternative as string,
            reason: 'trust me',
          },
          claim: stated,
        },
      ],
      ctx.agent,
    )
    expect(p.status).toBe('invalid')
    expect(p.issues.map((i) => i.code)).toContain('check_exception.commit_only')
  })

  it('refuses accepting an alternative whose covered context is now ruled out', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const altId = x.entry('Deterministic lockstep').alternative as string
    // The RTS turns out not to be deterministic at launch either; a re-run records it.
    commitOps(ctx, ctx.project.id, [
      parameterOp(
        '$rtsPhysics',
        x.P.$deterministic as string,
        x.P.$launch as string,
        { kind: 'boolean', value: false },
        [x.P.$rts as string],
      ),
    ])
    const again = run(ctx, { ...x.input, previous: x.r.id })
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: again.proposal as string }))
    const accept = (
      exceptions?: { check: 'no-reliance-on-ruled-out'; target: string; reason: string }[],
    ) => {
      const p = propose(ctx, [
        { op: 'setDecisionStatus', id: altId, status: 'accepted', rationale: 'chosen' },
      ])
      return ctx.services.commitProposal(ctx.owner, {
        proposalId: p.proposalId,
        ...(exceptions ? { exceptions } : {}),
      })
    }
    const refused = errorOf(accept())
    expect(refused.issues[0]?.message).toMatch(/^no-reliance-on-ruled-out/)
    unwrap(
      accept([
        {
          check: 'no-reliance-on-ruled-out',
          target: altId,
          reason: 'We will fix the RTS engine first.',
        },
      ]),
    )
  })
})

describe('method runs: permissions (ADR 0033 §2, A2, test 6)', () => {
  it('lets an agent with project and library read run, and never commits', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const r = run(ctx, input, ctx.agent)
    expect(r).toMatchObject({ status: 'proposed', origin: 'agent', proposalStatus: 'pending' })
    expect(ctx.store.getProposal(r.proposal as string)?.origin).toBe('agent')
  })

  it('refuses a delegated-only agent, and one that cannot read every used library', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const delegated = ctx.services.createPrincipal('agent', 'Delegated agent')
    ctx.services.grant(
      delegated.id,
      ['project.read', 'proposal.create', 'knowledge.pinned.read'],
      ctx.project.id,
    )
    const caller: Caller = { principalId: delegated.id, origin: 'agent' }
    const before = pending(ctx)
    const refused = errorOf(ctx.services.startMethodRun(caller, input))
    expect(refused.code).toBe('unauthorized')
    expect(refused.issues.map((i) => i.code)).toEqual(['method.library_read_required'])
    // Read on one library of two is not enough.
    const { lib: second } = fileLibrary(ctx, databaseSeed())
    commitOps(ctx, ctx.project.id, [
      {
        op: 'createObject',
        type: 'core.LibraryUse',
        stance: 'toBe',
        attributes: {
          library: second.id,
          label: 'test/database-scaling',
          revision: 1,
          role: 'supplementary',
        },
        claim: stated,
      },
    ])
    const lib = ctx.store.getProject(
      String(
        ctx.store
          .view(ctx.project.id, head(ctx))
          .listObjects({ types: ['core.LibraryUse'] })
          .find((u) => u.attributes.library !== second.id)?.attributes.library,
      ),
    )
    ctx.services.grant(delegated.id, ['project.read'], lib?.id as string)
    const partly = errorOf(ctx.services.startMethodRun(caller, input))
    expect(partly.issues[0]?.message).toBe(second.id)
    ctx.services.grant(delegated.id, ['project.read'], second.id)
    expect(run(ctx, input, caller).status).toBe('proposed')
    // No run is recorded for a refusal, and nothing is left pending by one.
    expect(
      unwrap(ctx.services.listMethodRuns(ctx.owner, { projectId: ctx.project.id })).runs,
    ).toHaveLength(1)
    expect(pending(ctx)).toBe(before + 1)
  })

  it('refuses a stranger to start, read or list runs', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const r = run(ctx, input)
    const stranger: Caller = {
      principalId: ctx.services.createPrincipal('agent', 'Stranger').id,
      origin: 'agent',
    }
    expect(errorOf(ctx.services.startMethodRun(stranger, input)).code).toBe('unauthorized')
    expect(
      errorOf(ctx.services.getMethodRun(stranger, { projectId: ctx.project.id, id: r.id })).code,
    ).toBe('unauthorized')
    expect(errorOf(ctx.services.listMethodRuns(stranger, { projectId: ctx.project.id })).code).toBe(
      'unauthorized',
    )
  })
})

describe('method runs: failures (ADR 0033 §10, test 7)', () => {
  it('records each failure with its reason and leaves no pending proposal', () => {
    const ctx = setup()
    const { input, P } = multiGame(ctx)
    const before = pending(ctx)
    expect(run(ctx, { ...input, method: P.$deterministic }).failure?.code).toBe(
      'method.not_resolved',
    )
    expect(
      run(ctx, { ...input, limits: { maxCandidates: 12, maxHops: 2, maxAssessments: 10 } }).failure,
    ).toMatchObject({ code: 'method.too_many_assessments', message: expect.stringMatching(/= 28/) })
    expect(run(ctx, { ...input, decision: P.$rts }).failure?.code).toBe('method.decision_not_open')
    expect(pending(ctx)).toBe(before)
    const runs = unwrap(ctx.services.listMethodRuns(ctx.owner, { projectId: ctx.project.id })).runs
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
    // A failed run keeps what it computed before failing.
    const tooMany = unwrap(
      ctx.services.getMethodRun(ctx.owner, {
        projectId: ctx.project.id,
        id: runs[1]?.id as string,
      }),
    )
    expect(tooMany.selection.candidates).toHaveLength(7)
  })

  it('refuses before starting when a scenario or element is not active, or no nature is given', () => {
    const ctx = setup()
    const { input, P } = multiGame(ctx)
    expect(
      errorOf(ctx.services.startMethodRun(ctx.owner, { ...input, scenarios: [P.$rts] })).issues.map(
        (i) => i.code,
      ),
    ).toEqual(['method.scenario_invalid'])
    expect(
      errorOf(
        ctx.services.startMethodRun(ctx.owner, { ...input, elements: [P.$launch] }),
      ).issues.map((i) => i.code),
    ).toEqual(['method.element_invalid'])
    expect(errorOf(ctx.services.startMethodRun(ctx.owner, { ...input, natures: [] })).code).toBe(
      'invalid',
    )
    expect(
      unwrap(ctx.services.listMethodRuns(ctx.owner, { projectId: ctx.project.id })).runs,
    ).toEqual([])
  })

  it('fails with no candidates when the libraries in use are not present', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    const store = new SqliteStore(':memory:')
    unwrap(importProjectExport(store, JSON.parse(JSON.stringify(bundle))))
    const services = new KalythServices({ store })
    const owner = services.createPrincipal('human', 'Owner')
    services.grant(owner.id, ['project.read', 'proposal.create'], ctx.project.id)
    const r = unwrap(services.startMethodRun({ principalId: owner.id, origin: 'human' }, input))
    // The method itself is read from the project's embedded copy; nothing can be selected.
    expect(r.failure?.code).toBe('method.no_candidates')
    expect(r.selection.missingLibraries).toHaveLength(1)
  })
})

describe('re-runs, export and replay (ADR 0033 §9, tests 8 and 11)', () => {
  it('supersedes earlier assessments after a question is answered, and the earlier run says so', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    // Someone answers: RTS units move predictably in both scenarios.
    commitOps(ctx, ctx.project.id, [
      parameterOp(
        '$rtsMotion',
        x.P.$predictable as string,
        x.P.$launch as string,
        { kind: 'boolean', value: true },
        [x.P.$rts as string],
      ),
    ])
    const again = run(ctx, { ...x.input, previous: x.r.id })
    const proposal = ctx.store.getProposal(again.proposal as string) as Proposal
    const supersedes = proposal.ops.filter(
      (o) => o.op === 'createRelation' && o.type === 'supersedes',
    )
    expect(supersedes).toHaveLength(28)
    const dead = again.comparison.find((e) => e.name === 'Dead reckoning')
    expect(
      dead?.contexts.map((v) => [
        x.names.get(v.scenario),
        x.names.get(v.element as string),
        v.verdict,
      ]),
    ).toEqual([
      ['Launch', 'RTS', 'unknown'],
      ['Launch', 'Arena shooter', 'unknown'],
      ['Expansion', 'RTS', 'unknown'],
      ['Expansion', 'Arena shooter', 'conditionsNotMet'],
    ])
    // The motion question for the RTS is no longer asked.
    const asked = proposal.ops
      .filter((o) => o.op === 'createObject' && o.type === 'core.Question')
      .map((o) => (o.op === 'createObject' ? String(o.attributes.text) : ''))
    expect(asked.filter((q) => q.includes(x.P.$rts as string))).toEqual([])
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: again.proposal as string }))
    const earlier = unwrap(
      ctx.services.getMethodRun(ctx.owner, { projectId: ctx.project.id, id: x.r.id }),
    )
    expect(earlier.proposalStatus).toBe('committed')
    const status = unwrap(
      ctx.services.getAssessmentStatus(ctx.owner, { projectId: ctx.project.id }),
    )
    expect(status.assessments.filter((a) => a.status === 'stale')).toHaveLength(28)
  })

  it('exports, imports and replays a project after a committed run; runs stay operational data', () => {
    const ctx = setup()
    const x = committedRun(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    expect(JSON.stringify(bundle)).not.toContain(x.r.id)
    const store = new SqliteStore(':memory:')
    unwrap(importProjectExport(store, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(store, ctx.project.id)).toBe(stateSha256(ctx.store, ctx.project.id))
    expect(store.listMethodRuns(ctx.project.id, 10)).toEqual([])
    expect(ctx.store.getProposal(x.r.proposal as string)?.rationale).toContain(x.r.id)
  })
})
