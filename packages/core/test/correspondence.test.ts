import type { Caller, ClaimInput, OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, stateSha256 } from '../src/index.ts'
import { errorOf, setup, tool, unwrap } from './helpers.ts'

type Ctx = ReturnType<typeof setup>

const meta = {
  title: 'Book',
  authors: ['A. Author'],
  licence: 'unknown' as const,
  quotePolicy: 'none' as const,
}
const imported: ClaimInput = { basis: 'imported', supports: [{ allOf: ['$s'] }] }
const stated: ClaimInput = { basis: 'stated' }

function commit(ctx: Ctx, projectId: string, ops: OperationInput[], caller: Caller = ctx.owner) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  const p = unwrap(
    ctx.services.proposeChange(caller, { projectId, baseRevision: head, ops, rationale: 't' }),
  )
  if (p.status !== 'pending') throw new Error(`proposal ${p.status}: ${JSON.stringify(p.issues)}`)
  return unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).refs
}
function refused(ctx: Ctx, projectId: string, ops: OperationInput[]) {
  const head = ctx.store.getProject(projectId)?.headRevision ?? 0
  const p = unwrap(
    ctx.services.proposeChange(ctx.owner, { projectId, baseRevision: head, ops, rationale: 't' }),
  )
  expect(p.status).toBe('invalid')
  return p.issues.map((i) => i.code)
}
const obj = (
  ref: string,
  type: string,
  attributes: Record<string, unknown>,
  claim = imported,
): OperationInput =>
  ({ op: 'createObject', ref, type, stance: 'asIs', attributes, claim }) as OperationInput
const rel = (
  type: string,
  from: string,
  to: string,
  properties: Record<string, unknown> = {},
  claim = imported,
): OperationInput =>
  ({ op: 'createRelation', type, from, to, stance: 'asIs', properties, claim }) as OperationInput

/**
 * A library with its own "Players per match" concept and a "Shared simulation" pattern that
 * applies up to `max` players; optionally a pattern that only declares when it is unsuitable.
 */
function library(ctx: Ctx, name: string, max: string, dimension = 'count') {
  const lib = unwrap(ctx.services.createProject(ctx.owner, { name, kind: 'library' }))
  const refs = commit(ctx, lib.id, [
    {
      op: 'recordEvidence',
      ref: '$s',
      evidence: {
        source: { kind: 'document', uri: `urn:x:${name}`, locator: 'p. 1', meta },
        collectedBy: tool,
      },
    },
    obj('$players', 'knowledge.Concept', {
      name: 'Players per match',
      definition: 'd',
      kind: 'quantity',
      dimension,
    }),
    obj('$fair', 'knowledge.Concept', { name: 'Fairness', definition: 'd', kind: 'quality' }),
    obj('$cond', 'knowledge.Condition', {
      subject: '$players',
      test: { op: 'le', value: max, unit: dimension === 'count' ? '1' : 's' },
      text: `at most ${max}`,
    }),
    obj('$shared', 'knowledge.Pattern', {
      name: 'Shared simulation',
      problem: 'p',
      solution: 's',
      structure: 's',
      consequences: 'c',
    }),
    rel('appliesWhen', '$shared', '$cond'),
    rel('affects', '$shared', '$fair', { effect: 'mixed', note: 'n' }),
    obj('$cap', 'knowledge.Condition', {
      subject: '$players',
      test: { op: 'gt', value: '1000', unit: dimension === 'count' ? '1' : 's' },
      text: 'over 1000',
    }),
    obj('$vague', 'knowledge.Pattern', {
      name: 'Vague pattern',
      problem: 'p',
      solution: 's',
      structure: 's',
      consequences: 'c',
    }),
    rel('unsuitableWhen', '$vague', '$cap'),
    rel('affects', '$vague', '$fair', { effect: 'mixed', note: 'n' }),
  ])
  return { lib, refs }
}

/** A project using libraries A and B, with a launch scenario. */
function project(ctx: Ctx, bDimension = 'count') {
  const A = library(ctx, 'Library A', '8')
  const B = library(ctx, 'Library B', '4', bDimension)
  const pin = (ref: string, lib: string, id: string): OperationInput =>
    ({
      op: 'recordEvidence',
      ref,
      evidence: {
        source: { kind: 'knowledge', library: lib, target: 'object', id, revision: 1 },
        collectedBy: tool,
      },
    }) as OperationInput
  const use = (ref: string, lib: string): OperationInput => ({
    op: 'createObject',
    ref,
    type: 'core.LibraryUse',
    stance: 'toBe',
    attributes: { library: lib, label: ref, revision: 1, role: 'primary' },
    claim: stated,
  })
  const P = commit(ctx, ctx.project.id, [
    use('$useA', A.lib.id),
    use('$useB', B.lib.id),
    pin('$aPlayers', A.lib.id, A.refs.$players as string),
    pin('$bPlayers', B.lib.id, B.refs.$players as string),
    pin('$aShared', A.lib.id, A.refs.$shared as string),
    pin('$bShared', B.lib.id, B.refs.$shared as string),
    pin('$aVague', A.lib.id, A.refs.$vague as string),
    obj(
      '$launch',
      'core.Scenario',
      { name: 'Launch', order: 1, description: 'd', status: 'committed', rationale: 'r' },
      stated,
    ),
    // The project states its player count on library A's concept only.
    {
      op: 'createObject',
      ref: '$six',
      type: 'core.Parameter',
      stance: 'toBe',
      attributes: {
        concept: '$aPlayers',
        scenario: '$launch',
        elements: [],
        nature: 'expected',
        value: { kind: 'point', value: '6', unit: '1' },
        provenance: 'stated',
      },
      claim: stated,
    },
  ])
  return { A, B, P }
}
const correspond = (
  P: Record<string, string>,
  a: string,
  b: string,
  relation: string,
): OperationInput =>
  obj(
    `$c${a.slice(1)}${b.slice(1)}`,
    'core.Correspondence',
    { a: P[a], b: P[b], relation, note: 'stated by the team' },
    stated,
  )

const assess = (ctx: Ctx, item: string, scenario: string, nature = 'expected') =>
  ctx.services.assess(ctx.owner, { projectId: ctx.project.id, item, scenario, nature })

describe('explicit nature (ADR 0028 amendment A3)', () => {
  it('refuses a new assessment request that does not say which values it is about', () => {
    const ctx = setup()
    const { P } = project(ctx)
    expect(
      errorOf(
        ctx.services.assess(ctx.owner, {
          projectId: ctx.project.id,
          item: P.$aShared,
          scenario: P.$launch,
        }),
      ).code,
    ).toBe('invalid')
    expect(
      errorOf(
        ctx.services.proposeAssessment(ctx.owner, {
          projectId: ctx.project.id,
          item: P.$aShared,
          scenario: P.$launch,
        }),
      ).code,
    ).toBe('invalid')
  })

  it('reads a stored assessment without a nature as about expected values', () => {
    const ctx = setup()
    const { P } = project(ctx)
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        item: P.$aShared,
        scenario: P.$launch,
        nature: 'expected',
      }),
    )
    const id = unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).refs
      .$assessment as string
    // Rewrite the stored row as an older build would have written it, without `nature`.
    const db = ctx.store.db
    db.exec('DROP TRIGGER object_versions_close_only')
    const row = db
      .prepare('SELECT attributes FROM object_versions WHERE id = ? AND rev_to IS NULL')
      .get(id) as { attributes: string }
    const { nature: _nature, ...older } = JSON.parse(row.attributes)
    db.prepare('UPDATE object_versions SET attributes = ? WHERE id = ? AND rev_to IS NULL').run(
      JSON.stringify(older),
      id,
    )
    const status = unwrap(
      ctx.services.getAssessmentStatus(ctx.owner, { projectId: ctx.project.id }),
    ).assessments
    expect(status.find((a) => a.id === id)).toMatchObject({
      status: 'current',
      verdict: 'conditionsMet',
    })
  })
})

describe('two libraries (ADR 0027 §5)', () => {
  it('never uses a value on another library’s same-named concept without a correspondence', () => {
    const ctx = setup()
    const { P } = project(ctx)
    const r = unwrap(assess(ctx, P.$bShared as string, P.$launch as string))
    expect(r.verdict).toBe('unknown')
    expect(r.explanation.steps[0]).toMatchObject({ result: 'unknown', reason: 'no-correspondence' })
    expect(r.explanation.steps[0]?.note).toMatch(/no sameAs correspondence/)
  })

  it('evaluates across libraries through a sameAs correspondence, and records it', () => {
    const ctx = setup()
    const { P } = project(ctx)
    const C = commit(ctx, ctx.project.id, [correspond(P, '$aPlayers', '$bPlayers', 'sameAs')])
    const r = unwrap(assess(ctx, P.$bShared as string, P.$launch as string))
    expect(r.explanation.steps[0]).toMatchObject({
      result: 'false',
      correspondence: C.$caPlayersbPlayers,
    })
    expect(r.verdict).toBe('conditionsNotMet')
    expect(r.inputs.correspondences?.map((c) => c.id)).toContain(C.$caPlayersbPlayers)
  })

  it('treats corresponding concepts with different dimensions as incompatible', () => {
    const ctx = setup()
    const { P } = project(ctx, 'time')
    commit(ctx, ctx.project.id, [correspond(P, '$aPlayers', '$bPlayers', 'sameAs')])
    const r = unwrap(assess(ctx, P.$bShared as string, P.$launch as string))
    expect(r.explanation.steps[0]).toMatchObject({ result: 'unknown', reason: 'incompatible' })
  })

  it('refuses a correspondence inside one library', () => {
    const ctx = setup()
    const { P } = project(ctx)
    expect(
      refused(ctx, ctx.project.id, [correspond(P, '$aShared', '$aVague', 'sameAs')]),
    ).toContain('correspondence.same_library')
  })
})

describe('contradictory guidance (ADR 0027 §5, ADR 0028 §5)', () => {
  function disagreeing(ctx: Ctx) {
    const f = project(ctx)
    const C = commit(ctx, ctx.project.id, [
      correspond(f.P, '$aPlayers', '$bPlayers', 'sameAs'),
      correspond(f.P, '$aShared', '$bShared', 'sameAs'),
    ])
    return { ...f, C }
  }
  it('is conflicting when libraries give opposing verdicts, with both explanations', () => {
    const ctx = setup()
    const { P } = disagreeing(ctx)
    const r = unwrap(assess(ctx, P.$aShared as string, P.$launch as string))
    expect(r.verdict).toBe('conflicting')
    expect(r.explanation.evaluatedVerdict).toBe('conditionsMet')
    expect(r.explanation.alternatives?.[0]).toMatchObject({
      verdict: 'conditionsNotMet',
      relation: 'sameAs',
    })
  })

  it('gives the chosen library’s verdict once a person accepts a decision, citing it', () => {
    const ctx = setup()
    const { P } = disagreeing(ctx)
    const D = commit(ctx, ctx.project.id, [
      obj(
        '$d',
        'core.Decision',
        { title: 'Which synchronisation guidance?', question: 'A or B?' },
        stated,
      ),
      obj(
        '$alt',
        'core.Alternative',
        { title: 'Follow library A', summary: 's' },
        { basis: 'imported', supports: [{ allOf: [P.$aShared as string] }] },
      ),
      rel('alternativeOf', '$alt', '$d', {}, stated),
    ])
    commit(ctx, ctx.project.id, [
      {
        op: 'setDecisionStatus',
        id: D.$alt as string,
        status: 'accepted',
        rationale: 'A covers our scale',
      },
      {
        op: 'setDecisionStatus',
        id: D.$d as string,
        status: 'accepted',
        rationale: 'A covers our scale',
      },
    ])
    const r = unwrap(assess(ctx, P.$aShared as string, P.$launch as string))
    expect(r.verdict).toBe('conditionsMet')
    // The decision chose which guidance to follow; the disagreement stays visible (K4 review).
    expect(r.explanation.conflict.state).toBe('settled')
    expect(r.explanation.conflict.note).toMatch(/does not make the other guidance wrong/)
    expect(r.explanation.alternatives?.[0]?.verdict).toBe('conditionsNotMet')
    expect(r.explanation.settledBy).toMatchObject({
      decision: D.$d,
      alternative: D.$alt,
      item: P.$aShared,
    })
    expect(r.inputs.decisions?.map((d) => d.id)).toEqual(expect.arrayContaining([D.$d, D.$alt]))
    // Reopening the decision makes the assessment stale (ADR 0027 §5).
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        item: P.$aShared,
        scenario: P.$launch,
        nature: 'expected',
      }),
    )
    const id = unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId })).refs
      .$assessment
    commit(ctx, ctx.project.id, [
      { op: 'setDecisionStatus', id: D.$d as string, status: 'open', rationale: 'reopened' },
    ])
    const status = unwrap(
      ctx.services.getAssessmentStatus(ctx.owner, { projectId: ctx.project.id }),
    ).assessments
    expect(status.find((a) => a.id === id)).toMatchObject({
      status: 'stale',
      verdictNow: 'conflicting',
    })
  })

  it('is conflicting when the project states that two items conflict', () => {
    const ctx = setup()
    const { P } = project(ctx)
    commit(ctx, ctx.project.id, [correspond(P, '$aShared', '$bShared', 'conflictsWith')])
    expect(unwrap(assess(ctx, P.$aShared as string, P.$launch as string)).verdict).toBe(
      'conflicting',
    )
  })
})

describe('insufficiently specified applicability (ADR 0028 amendment A3)', () => {
  it('never presents an item that declares nothing that must hold as met, and asks about it', () => {
    const ctx = setup()
    const { P } = project(ctx)
    const r = unwrap(assess(ctx, P.$aVague as string, P.$launch as string))
    expect(r).toMatchObject({
      verdict: 'unknown',
      explanation: { evaluatedVerdict: 'conditionsMet', specification: 'underspecified' },
    })
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        item: P.$aVague,
        scenario: P.$launch,
        nature: 'expected',
      }),
    )
    const ops = unwrap(ctx.services.getProposal(ctx.owner, { proposalId: p.proposalId })).ops
    const q = ops.find((o) => o.op === 'createObject' && o.type === 'core.Question')
    expect(q?.op === 'createObject' && String(q.attributes.text)).toMatch(
      /Its library declares none/,
    )
  })

  it('still rules an item out when a declared exclusion holds', () => {
    const ctx = setup()
    const { P } = project(ctx)
    commit(ctx, ctx.project.id, [
      {
        op: 'createObject',
        type: 'core.Parameter',
        stance: 'toBe',
        attributes: {
          concept: P.$aPlayers as string,
          scenario: P.$launch as string,
          elements: [],
          nature: 'limit',
          value: { kind: 'point', value: '5000', unit: '1' },
          provenance: 'stated',
        },
        claim: stated,
      },
    ])
    const limit = unwrap(assess(ctx, P.$aVague as string, P.$launch as string, 'limit'))
    expect(limit).toMatchObject({
      verdict: 'conditionsNotMet',
      explanation: { specification: 'underspecified' },
    })
  })

  it('replays a two-library project with correspondences and assessments exactly', () => {
    const ctx = setup()
    const { P } = project(ctx)
    commit(ctx, ctx.project.id, [correspond(P, '$aPlayers', '$bPlayers', 'sameAs')])
    const p = unwrap(
      ctx.services.proposeAssessment(ctx.owner, {
        projectId: ctx.project.id,
        item: P.$bShared,
        scenario: P.$launch,
        nature: 'expected',
      }),
    )
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: p.proposalId }))
    const bundle = unwrap(ctx.services.exportProject(ctx.owner, { projectId: ctx.project.id }))
    const elsewhere = setup()
    unwrap(importProjectExport(elsewhere.store, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(elsewhere.store, ctx.project.id)).toBe(bundle.stateSha256)
  })
})
