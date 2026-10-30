import type { Caller, ClaimInput, OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, stateSha256 } from '../src/index.ts'
import { errorOf, setup, tool, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>

const meta = {
  title: 'A networking book',
  authors: ['A. Author'],
  licence: 'unknown' as const,
  quotePolicy: 'none' as const,
}
const imported = (...refs: string[]): ClaimInput => ({
  basis: 'imported',
  supports: [{ allOf: refs }],
})
const stated: ClaimInput = { basis: 'stated' }

function run(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  return ctx.services.proposeChange(caller, {
    projectId,
    baseRevision: head,
    ops,
    rationale: 'test',
  })
}
function commit(ctx: Ctx, projectId: string, ops: OperationInput[]) {
  const p = unwrap(run(ctx, projectId, ops))
  if (p.status !== 'pending') throw new Error(`proposal ${p.status}: ${JSON.stringify(p.issues)}`)
  return unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).refs
}
function refused(ctx: Ctx, projectId: string, ops: OperationInput[]) {
  const p = unwrap(run(ctx, projectId, ops))
  expect(p.status).toBe('invalid')
  return p.issues.map((i) => i.code)
}

const obj = (
  ref: string,
  type: string,
  attributes: Record<string, unknown>,
  claim = imported('$s'),
): OperationInput =>
  ({ op: 'createObject', ref, type, stance: 'asIs', attributes, claim }) as OperationInput
const rel = (
  type: string,
  from: string,
  to: string,
  properties: Record<string, unknown> = {},
): OperationInput =>
  ({
    op: 'createRelation',
    type,
    from,
    to,
    stance: 'asIs',
    properties,
    claim: imported('$s'),
  }) as OperationInput
const concept = (ref: string, name: string, kind: string, extra: Record<string, unknown> = {}) =>
  obj(ref, 'knowledge.Concept', { name, definition: name, kind, ...extra })
const condition = (ref: string, subject: string, test: Record<string, unknown>) =>
  obj(ref, 'knowledge.Condition', { subject, test, text: `${ref} ${JSON.stringify(test)}` })
const pattern = (ref: string, name: string, extra: Record<string, unknown> = {}) =>
  obj(ref, 'knowledge.Pattern', {
    name,
    problem: 'p',
    solution: 's',
    structure: 's',
    consequences: 'c',
    ...extra,
  })

/**
 * A test library: lockstep applies when the simulation is deterministic and there are at most
 * 8 players, and is unsuitable above 250 ms round trip; prediction requires an authoritative
 * server, which needs at least 2 players; a principle is excepted for single-player games.
 */
function testLibrary(ctx: Ctx) {
  const lib = unwrap(
    ctx.services.createProject(ctx.owner, { name: 'Test networking', kind: 'library' }),
  )
  const refs = commit(ctx, lib.id, [
    {
      op: 'recordEvidence',
      ref: '$s',
      evidence: {
        source: { kind: 'document', uri: 'urn:x:book', locator: 'ch. 1', meta },
        collectedBy: tool,
      },
    },
    concept('$players', 'Players per match', 'quantity', { dimension: 'count' }),
    concept('$rtt', 'Round-trip time', 'quantity', { dimension: 'time' }),
    concept('$det', 'Deterministic simulation', 'property', { dimension: 'boolean' }),
    concept('$genre', 'Genre', 'property', {
      dimension: 'category',
      values: ['rts', 'shooter', 'solo'],
    }),
    concept('$fair', 'Fairness', 'quality'),
    condition('$isDet', '$det', { op: 'is', value: true }),
    condition('$few', '$players', { op: 'le', value: '8', unit: '1' }),
    condition('$slow', '$rtt', { op: 'gt', value: '250', unit: 'ms' }),
    condition('$many', '$players', { op: 'ge', value: '2', unit: '1' }),
    condition('$solo', '$genre', { op: 'in', values: ['solo'] }),
    pattern('$lockstep', 'Deterministic lockstep'),
    rel('appliesWhen', '$lockstep', '$isDet'),
    rel('appliesWhen', '$lockstep', '$few'),
    rel('unsuitableWhen', '$lockstep', '$slow'),
    rel('affects', '$lockstep', '$fair', { effect: 'mixed', note: 'n' }),
    pattern('$auth', 'Authoritative server'),
    rel('appliesWhen', '$auth', '$many'),
    rel('affects', '$auth', '$fair', { effect: 'improves', note: 'n' }),
    pattern('$predict', 'Client prediction'),
    rel('requires', '$predict', '$auth'),
    rel('affects', '$predict', '$fair', { effect: 'mixed', note: 'n' }),
    pattern('$idea', 'A new idea', { maturity: 'hypothesis' }),
    rel('appliesWhen', '$idea', '$few'),
    rel('affects', '$idea', '$fair', { effect: 'mixed', note: 'n' }),
    obj('$trust', 'knowledge.Principle', {
      statement: 'Do not trust the client.',
      rationale: 'r',
      scope: 'multiplayer',
    }),
    rel('exceptWhen', '$trust', '$solo'),
  ])
  return { lib, refs }
}

/**
 * A project: a platform system containing an RTS and a shooter, using the library, with pins for
 * the concepts and items, and a launch scenario that an expansion scenario builds on.
 */
function platform(ctx: Ctx) {
  const { lib, refs: L } = testLibrary(ctx)
  const pin = (ref: string, id: string): OperationInput =>
    ({
      op: 'recordEvidence',
      ref,
      evidence: {
        source: { kind: 'knowledge', library: lib.id, target: 'object', id, revision: 1 },
        collectedBy: tool,
      },
    }) as OperationInput
  const P = commit(
    ctx,
    ctx.project.id,
    [
      {
        op: 'createObject',
        ref: '$use',
        type: 'core.LibraryUse',
        stance: 'toBe',
        attributes: { library: lib.id, label: 'test', revision: 1, role: 'primary' },
        claim: stated,
      },
      ...[
        '$players',
        '$rtt',
        '$det',
        '$genre',
        '$lockstep',
        '$auth',
        '$predict',
        '$idea',
        '$trust',
      ].map((r) => pin(`$pin${r.slice(1)}`, L[r] as string)),
      obj('$platform', 'software.System', { name: 'Game platform' }, stated),
      obj('$rts', 'software.Container', { name: 'RTS' }, stated),
      obj('$shooter', 'software.Container', { name: 'Shooter' }, stated),
      rel('contains', '$platform', '$rts'),
      rel('contains', '$platform', '$shooter'),
      obj(
        '$launch',
        'core.Scenario',
        {
          name: 'Launch',
          order: 1,
          description: 'RTS only',
          status: 'committed',
          rationale: 'funded',
        },
        stated,
      ),
      obj(
        '$expansion',
        'core.Scenario',
        {
          name: 'Expansion',
          order: 2,
          description: 'adds the shooter',
          base: '$launch',
          status: 'planned',
          rationale: 'roadmap',
        },
        stated,
      ),
    ].map((op) => (op.op === 'createRelation' ? { ...op, claim: stated } : op)) as OperationInput[],
  )
  return { lib, L, P }
}

type Fixture = ReturnType<typeof platform>
const param = (
  f: Fixture,
  conceptRef: string,
  scenarioRef: string,
  value: Record<string, unknown>,
  options: { elements?: string[]; nature?: string; ref?: string } = {},
): OperationInput =>
  ({
    op: 'createObject',
    ...(options.ref ? { ref: options.ref } : {}),
    type: 'core.Parameter',
    stance: 'toBe',
    attributes: {
      concept: f.P[`$pin${conceptRef.slice(1)}`],
      scenario: f.P[scenarioRef],
      elements: (options.elements ?? []).map((e) => f.P[e]),
      nature: options.nature ?? 'expected',
      value,
      provenance: 'stated',
    },
    claim: stated,
  }) as OperationInput
const point = (value: string, unit = '1') => ({ kind: 'point', value, unit })
const yes = { kind: 'boolean', value: true }
const no = { kind: 'boolean', value: false }

function assess(
  ctx: Ctx,
  f: Fixture,
  item: string,
  scenario: string,
  element?: string,
  nature?: string,
) {
  return unwrap(
    ctx.services.assess(ctx.owner, {
      projectId: ctx.project.id,
      item: f.P[`$pin${item.slice(1)}`],
      scenario: f.P[scenario],
      ...(element ? { element: f.P[element] } : {}),
      nature: nature ?? 'expected',
    }),
  )
}
const stepOf = (r: ReturnType<typeof assess>, conditionRef: string, f: Fixture) =>
  r.explanation.steps.find((s) => s.condition === f.L[conditionRef])

describe('scope, inheritance and precedence (ADR 0028 §3)', () => {
  it('uses the most specific value for each element, and siblings keep the broader one', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', yes),
      param(f, '$players', '$launch', point('4')),
      param(f, '$rtt', '$launch', point('80', 'ms')),
      param(f, '$det', '$expansion', no, { elements: ['$shooter'] }),
    ])
    expect(assess(ctx, f, '$lockstep', '$launch', '$rts').verdict).toBe('conditionsMet')
    const shooter = assess(ctx, f, '$lockstep', '$expansion', '$shooter')
    expect(shooter.verdict).toBe('conditionsNotMet')
    expect(stepOf(shooter, '$isDet', f)?.parameters[0]?.resolvedFrom).toBe('element')
    // The RTS, a sibling, inherits the launch scenario's system-wide value.
    const rts = assess(ctx, f, '$lockstep', '$expansion', '$rts')
    expect(rts.verdict).toBe('conditionsMet')
    expect(stepOf(rts, '$isDet', f)?.parameters[0]?.resolvedFrom).toBe(`base:${f.P.$launch}/system`)
  })

  it('puts the scenario first: a system-wide value in it beats an element value in its base', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', no, { elements: ['$rts'] }),
      param(f, '$det', '$expansion', yes),
      param(f, '$players', '$launch', point('4')),
      param(f, '$rtt', '$launch', point('80', 'ms')),
    ])
    const r = assess(ctx, f, '$lockstep', '$expansion', '$rts')
    expect(stepOf(r, '$isDet', f)).toMatchObject({
      result: 'true',
      parameters: [{ resolvedFrom: 'system' }],
    })
    // An ancestor's value is used for an element without its own.
    commit(ctx, ctx.project.id, [
      param(f, '$rtt', '$expansion', point('300', 'ms'), { elements: ['$platform'] }),
    ])
    const s = assess(ctx, f, '$lockstep', '$expansion', '$shooter')
    expect(stepOf(s, '$slow', f)?.parameters[0]?.resolvedFrom).toBe(`ancestor:${f.P.$platform}`)
    expect(s.verdict).toBe('conditionsNotMet')
  })
})

describe('conflicts, nature and missing values (ADR 0028 §3, amendment A1)', () => {
  it('reports two values of one nature at one scope as contradictory, never merged', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', yes),
      param(f, '$rtt', '$launch', point('80', 'ms')),
      param(f, '$players', '$launch', point('4')),
      param(f, '$players', '$launch', point('6')),
    ])
    const r = assess(ctx, f, '$lockstep', '$launch')
    expect(stepOf(r, '$few', f)).toMatchObject({ result: 'unknown', reason: 'contradictory' })
    expect(stepOf(r, '$few', f)?.parameters).toHaveLength(2)
    expect(r.verdict).toBe('unknown')
  })

  it('keeps natures apart: a current value and a forecast are both shown, and neither stands in for the other', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', yes),
      param(f, '$rtt', '$launch', point('80', 'ms')),
      param(f, '$players', '$launch', point('4'), { nature: 'current' }),
      param(f, '$players', '$launch', point('12'), { nature: 'expected' }),
      param(f, '$players', '$launch', point('16'), { nature: 'limit' }),
    ])
    const expected = assess(ctx, f, '$lockstep', '$launch')
    expect(expected.explanation.nature).toBe('expected')
    expect(stepOf(expected, '$few', f)).toMatchObject({
      result: 'false',
      parameters: [{ value: { value: '12' } }],
    })
    expect(
      stepOf(expected, '$few', f)
        ?.context?.map((c) => c.nature)
        .sort(),
    ).toEqual(['current', 'limit'])
    expect(expected.verdict).toBe('conditionsNotMet')
    // For current values, players pass, but determinism and round trip were stated only as
    // expected values: they are missing for this nature, not borrowed.
    const current = assess(ctx, f, '$lockstep', '$launch', undefined, 'current')
    expect(stepOf(current, '$few', f)).toMatchObject({ result: 'true' })
    expect(stepOf(current, '$isDet', f)).toMatchObject({ result: 'unknown', reason: 'missing' })
    expect(current.verdict).toBe('unknown')
    // No target is stated, so a target assessment is missing values: nothing is derived.
    const target = assess(ctx, f, '$lockstep', '$launch', undefined, 'target')
    expect(target.verdict).toBe('unknown')
    expect(target.explanation.missing.map((m) => m.nature)).toContain('target')
  })

  it('keeps missing and declared-unknown values unknown, and asks for the missing ones', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', { kind: 'unknown', reason: 'engine not chosen' }),
      param(f, '$players', '$launch', point('4')),
    ])
    const r = assess(ctx, f, '$lockstep', '$launch')
    expect(stepOf(r, '$isDet', f)).toMatchObject({ result: 'unknown', reason: 'declared-unknown' })
    expect(stepOf(r, '$slow', f)).toMatchObject({ result: 'unknown', reason: 'missing' })
    expect(r.verdict).toBe('unknown')
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        nature: 'expected',
        item: f.P.$pinlockstep,
        scenario: f.P.$launch,
      }),
    )
    expect(p.status).toBe('pending')
    const proposal = unwrap(ctx.services.getProposal(ctx.owner, { proposalId: p.proposalId }))
    const question = proposal.ops.find((o) => o.op === 'createObject' && o.type === 'core.Question')
    expect(question?.op === 'createObject' && String(question.attributes.text)).toMatch(
      /expected value of "Round-trip time"/,
    )
  })
})

describe('units, intervals and boundaries (ADR 0028 §1, §4)', () => {
  const rttCase = (value: Record<string, unknown>) => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [param(f, '$rtt', '$launch', value)])
    return stepOf(assess(ctx, f, '$lockstep', '$launch'), '$slow', f)
  }
  it('compares exactly across units, with exclusive and inclusive bounds', () => {
    expect(rttCase(point('250', 'ms'))).toMatchObject({ result: 'false' })
    expect(rttCase(point('0.25', 's'))).toMatchObject({ result: 'false' })
    expect(rttCase(point('250.001', 'ms'))).toMatchObject({ result: 'true' })
    expect(rttCase(point('251000', 'µs'))).toMatchObject({ result: 'true' })
  })
  it('reads an interval as true only when every value passes, otherwise straddles', () => {
    const interval = (
      min: string | undefined,
      max: string | undefined,
      minInclusive = true,
      maxInclusive = true,
    ) => ({
      kind: 'interval',
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
      unit: 'ms',
      minInclusive,
      maxInclusive,
    })
    expect(rttCase(interval('300', '400'))).toMatchObject({ result: 'true' })
    expect(rttCase(interval('100', '250'))).toMatchObject({ result: 'false' })
    expect(rttCase(interval('200', '300'))).toMatchObject({
      result: 'unknown',
      reason: 'straddles',
    })
    expect(rttCase(interval('250', '400', false))).toMatchObject({ result: 'true' })
    expect(rttCase(interval('260', undefined))).toMatchObject({ result: 'true' })
    expect(rttCase(interval(undefined, '300'))).toMatchObject({
      result: 'unknown',
      reason: 'straddles',
    })
  })
  it('refuses a value in the wrong dimension, a non-integer count and runtime measurements', () => {
    const ctx = setup()
    const f = platform(ctx)
    expect(refused(ctx, ctx.project.id, [param(f, '$rtt', '$launch', point('3', 'MB'))])).toContain(
      'parameter.value_invalid',
    )
    expect(refused(ctx, ctx.project.id, [param(f, '$players', '$launch', point('2.5'))])).toContain(
      'parameter.value_invalid',
    )
    expect(
      refused(ctx, ctx.project.id, [
        param(f, '$genre', '$launch', { kind: 'category', value: 'mmo' }),
      ]),
    ).toContain('parameter.value_invalid')
    const measured = param(f, '$players', '$launch', point('4')) as {
      attributes: Record<string, unknown>
    }
    measured.attributes.provenance = 'runtimeMeasured'
    expect(refused(ctx, ctx.project.id, [measured as unknown as OperationInput])).toContain(
      'parameter.runtime_measured_reserved',
    )
  })
})

describe('verdicts (ADR 0028 §5)', () => {
  it('handles requires, principles with exceptions, and hypotheses', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [
      param(f, '$players', '$launch', point('1')),
      param(f, '$genre', '$launch', { kind: 'category', value: 'solo' }),
    ])
    // Prediction requires the authoritative server, which needs at least two players.
    const predict = assess(ctx, f, '$predict', '$launch')
    expect(predict.verdict).toBe('conditionsNotMet')
    expect(predict.explanation.steps[0]).toMatchObject({
      relation: 'requires',
      requiredVerdict: 'conditionsNotMet',
    })
    expect(assess(ctx, f, '$trust', '$launch').verdict).toBe('excepted')
    expect(assess(ctx, f, '$idea', '$launch')).toMatchObject({
      verdict: 'notAssessed',
      explanation: { knowledge: { maturity: 'hypothesis' } },
    })
    // Every explanation says what a verdict does not mean.
    expect(predict.explanation.meaning).toMatch(/not a recommendation/)
  })
})

describe('assessment records (ADR 0029)', () => {
  function assessed(ctx: Ctx) {
    const f = platform(ctx)
    const values = commit(ctx, ctx.project.id, [
      param(f, '$det', '$launch', yes),
      param(f, '$players', '$launch', point('4'), { ref: '$p4' }),
      param(f, '$rtt', '$launch', point('80', 'ms')),
    ])
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        nature: 'expected',
        item: f.P.$pinlockstep,
        scenario: f.P.$launch,
        element: f.P.$rts,
      }),
    )
    const { refs } = unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    return { f, assessment: refs.$assessment as string, p4: values.$p4 as string }
  }
  const statusOf = (ctx: Ctx, id: string) =>
    unwrap(
      ctx.services.getAssessmentStatus(ctx.owner, { projectId: ctx.project.id }),
    ).assessments.find((a) => a.id === id)

  it('records the verdict with the pins and versions it read, and starts current', () => {
    const ctx = setup()
    const { f, assessment } = assessed(ctx)
    const a = unwrap(
      ctx.services.queryObjects(ctx.owner, { projectId: ctx.project.id, ids: [assessment] }),
    ).objects[0]
    expect(a?.attributes).toMatchObject({ verdict: 'conditionsMet', nature: 'expected' })
    const inputs = a?.attributes.inputs as {
      knowledge: unknown[]
      parameters: unknown[]
      scenarios: unknown[]
      elements: unknown[]
    }
    expect(inputs.parameters).toHaveLength(3)
    expect(inputs.scenarios).toHaveLength(1)
    expect(inputs.elements).toHaveLength(2)
    expect(inputs.knowledge.length).toBeGreaterThanOrEqual(7)
    expect(a?.claim).toMatchObject({ basis: 'inferred', supports: [{ allOf: [f.P.$pinlockstep] }] })
    expect(statusOf(ctx, assessment)).toMatchObject({ status: 'current', reasons: [] })
  })

  it('refuses a verdict that the evaluator would not give', () => {
    const ctx = setup()
    const f = platform(ctx)
    commit(ctx, ctx.project.id, [param(f, '$det', '$launch', no)])
    const honest = unwrap(
      ctx.services.assess(ctx.owner, {
        projectId: ctx.project.id,
        nature: 'expected',
        item: f.P.$pinlockstep,
        scenario: f.P.$launch,
      }),
    )
    const forged: OperationInput = {
      op: 'createObject',
      type: 'core.Assessment',
      stance: 'toBe',
      attributes: {
        item: f.P.$pinlockstep as string,
        scenario: f.P.$launch as string,
        nature: 'expected',
        verdict: 'conditionsMet',
        explanation: { ...honest.explanation, verdict: 'conditionsMet' } as never,
        inputs: honest.inputs as never,
        producedBy: { kind: 'evaluator', evaluatorVersion: honest.inputs.evaluatorVersion },
      },
      claim: {
        basis: 'inferred',
        confidence: { level: 'high', rationale: 'r' },
        supports: [{ allOf: [f.P.$pinlockstep as string] }],
      },
    }
    expect(refused(ctx, ctx.project.id, [forged])).toContain('assessment.not_reproducible')
    // An honest proposal is refused at commit if its inputs changed in between.
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        nature: 'expected',
        item: f.P.$pinlockstep,
        scenario: f.P.$launch,
      }),
    )
    commit(ctx, ctx.project.id, [param(f, '$players', '$launch', point('4'))])
    const error = errorOf(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    expect(error.issues.map((i) => i.code)).toContain('assessment.stale_at_head')
  })

  it('goes stale when a parameter changes or a more specific one appears, and reassessing supersedes it', () => {
    const ctx = setup()
    const { f, assessment, p4 } = assessed(ctx)
    commit(ctx, ctx.project.id, [{ op: 'updateObject', id: p4, set: { value: point('10') } }])
    expect(statusOf(ctx, assessment)).toMatchObject({
      status: 'stale',
      verdictNow: 'conditionsNotMet',
    })
    expect(statusOf(ctx, assessment)?.reasons).toContain(`${p4} changed`)
    const refs = commit(ctx, ctx.project.id, [
      param(f, '$rtt', '$launch', point('90', 'ms'), { elements: ['$rts'], ref: '$near' }),
    ])
    expect(statusOf(ctx, assessment)?.reasons).toContain(`${refs.$near} is now read`)
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        nature: 'expected',
        item: f.P.$pinlockstep,
        scenario: f.P.$launch,
        element: f.P.$rts,
      }),
    )
    const { refs: again } = unwrap(
      ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }),
    )
    expect(statusOf(ctx, assessment)?.reasons).toContain(`superseded by ${again.$assessment}`)
    expect(statusOf(ctx, again.$assessment as string)).toMatchObject({
      status: 'current',
      verdict: 'conditionsNotMet',
    })
    // Assessments are never edited.
    expect(
      refused(ctx, ctx.project.id, [
        { op: 'updateObject', id: assessment, set: { verdict: 'unknown' } },
      ]),
    ).toContain('assessment.immutable')
  })

  it('goes stale when the knowledge it read changes under the LibraryUse, or the scenario changes', () => {
    const ctx = setup()
    const { f, assessment } = assessed(ctx)
    commit(ctx, f.lib.id, [
      { op: 'updateObject', id: f.L.$lockstep as string, set: { aliases: ['lockstep'] } },
    ])
    expect(statusOf(ctx, assessment)?.status).toBe('current')
    commit(ctx, ctx.project.id, [
      { op: 'updateObject', id: f.P.$use as string, set: { revision: 2 } },
    ])
    expect(statusOf(ctx, assessment)?.reasons).toContain(
      `knowledge ${f.L.$lockstep} changed at library revision 2`,
    )
    commit(ctx, ctx.project.id, [
      { op: 'updateObject', id: f.P.$launch as string, set: { status: 'planned' } },
    ])
    expect(statusOf(ctx, assessment)?.reasons).toContain(`${f.P.$launch} changed`)
  })

  it('replays and imports deterministically; without the library it reports what it cannot re-check', () => {
    const ctx = setup()
    const { assessment } = assessed(ctx)
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    const elsewhere = setup()
    unwrap(importProjectExport(elsewhere.store, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(elsewhere.store, ctx.project.id)).toBe(bundle.stateSha256)
    const s = unwrap(
      elsewhere.services.getAssessmentStatus(elsewhere.owner, { projectId: ctx.project.id }),
    ).assessments.find((a) => a.id === assessment)
    expect(s?.status).toBe('stale')
    expect(s?.reasons.join(' ')).toMatch(/not present|unknown-library/)
  })

  it('refuses a scenario whose base chain loops', () => {
    const ctx = setup()
    const f = platform(ctx)
    expect(
      refused(ctx, ctx.project.id, [
        { op: 'updateObject', id: f.P.$launch as string, set: { base: f.P.$expansion as string } },
      ]),
    ).toContain('scenario.base_cycle')
  })
})
