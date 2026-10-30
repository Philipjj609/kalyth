import { readFileSync } from 'node:fs'
import type { ClaimInput, OperationInput } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { importProjectExport, stateSha256 } from '../src/index.ts'
import { setup, tool, unwrap } from './helpers.ts'

/**
 * K3 worked example: one game platform hosts an RTS and a fast shooter. At launch only the RTS
 * ships, on a shared fixed-point engine. The expansion adds the shooter, built on physics
 * middleware that is not deterministic, with players who change direction abruptly. The same
 * knowledge, from the real-time networking seed library (still proposed), gives different
 * verdicts per game and scenario, and says what it does not know.
 */
const seed = JSON.parse(
  readFileSync(
    new URL('../../../deploy/knowledge/real-time-networking.json', import.meta.url),
    'utf8',
  ),
) as { name: string; description: string; rationale: string; ops: OperationInput[] }
const stated: ClaimInput = { basis: 'stated' }

describe('multi-game platform: RTS and shooter, launch and expansion (K3 example)', () => {
  it('assesses per game and scenario, keeps unknowns visible, and tracks changes', () => {
    const ctx = setup()
    const { services, owner, agent } = ctx
    const head = (id: string) => ctx.store.getProject(id)?.headRevision ?? 0
    const commit = (projectId: string, ops: OperationInput[], by = owner) => {
      const p = unwrap(
        services.proposeChange(by, {
          projectId,
          baseRevision: head(projectId),
          ops,
          rationale: 'example',
        }),
      )
      if (p.status !== 'pending') throw new Error(JSON.stringify(p.issues))
      return unwrap(services.commitProposal(owner, { proposalId: p.proposalId })).refs
    }

    const lib = unwrap(
      services.createProject(owner, {
        name: seed.name,
        description: seed.description,
        kind: 'library',
      }),
    )
    const L = commit(lib.id, seed.ops, agent)
    const pin = (ref: string, id: string): OperationInput => ({
      op: 'recordEvidence',
      ref,
      evidence: {
        source: { kind: 'knowledge', library: lib.id, target: 'object', id, revision: 1 },
        collectedBy: tool,
      },
    })
    const element = (ref: string, type: string, name: string): OperationInput => ({
      op: 'createObject',
      ref,
      type,
      stance: 'toBe',
      attributes: { name },
      claim: stated,
    })
    const P = commit(ctx.project.id, [
      {
        op: 'createObject',
        ref: '$use',
        type: 'core.LibraryUse',
        stance: 'toBe',
        attributes: {
          library: lib.id,
          label: 'kalyth/real-time-networking',
          revision: 1,
          role: 'primary',
        },
        claim: stated,
      },
      pin('$deterministic', L.$deterministic as string),
      pin('$predictable', L.$predictable as string),
      pin('$lockstep', L.$lockstep as string),
      pin('$deadReckoning', L.$deadReckoning as string),
      pin('$authServer', L.$authServer as string),
      element('$platform', 'software.System', 'Game platform'),
      element('$rts', 'software.Container', 'RTS'),
      element('$shooter', 'software.Container', 'Arena shooter'),
      {
        op: 'createRelation',
        type: 'contains',
        from: '$platform',
        to: '$rts',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createRelation',
        type: 'contains',
        from: '$platform',
        to: '$shooter',
        stance: 'toBe',
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$launch',
        type: 'core.Scenario',
        stance: 'toBe',
        attributes: {
          name: 'Launch',
          order: 1,
          description: 'The RTS ships alone, on the shared fixed-point engine.',
          status: 'committed',
          rationale: 'Funded and scheduled.',
        },
        claim: stated,
      },
      {
        op: 'createObject',
        ref: '$expansion',
        type: 'core.Scenario',
        stance: 'toBe',
        attributes: {
          name: 'Expansion',
          order: 2,
          description: 'The arena shooter joins, on physics middleware.',
          base: '$launch',
          status: 'planned',
          rationale: 'On the roadmap, not funded.',
        },
        claim: stated,
      },
    ])
    const param = (
      ref: string,
      concept: string,
      scenario: string,
      value: boolean,
      elements: string[] = [],
    ): OperationInput =>
      ({
        op: 'createObject',
        ref,
        type: 'core.Parameter',
        stance: 'toBe',
        attributes: {
          concept: P[concept],
          scenario: P[scenario],
          elements: elements.map((e) => P[e]),
          nature: 'expected',
          value: { kind: 'boolean', value },
          provenance: 'stated',
          note: '',
        },
        claim: stated,
      }) as OperationInput
    const V = commit(ctx.project.id, [
      // Launch: the whole platform runs on the shared fixed-point engine.
      param('$engineDeterministic', '$deterministic', '$launch', true),
      // Expansion: the shooter uses physics middleware, and its players move abruptly.
      param('$shooterPhysics', '$deterministic', '$expansion', false, ['$shooter']),
      param('$shooterMotion', '$predictable', '$expansion', false, ['$shooter']),
    ])

    const assess = (item: string, scenario: string, el: string) =>
      unwrap(
        services.assess(owner, {
          projectId: ctx.project.id,
          nature: 'expected',
          item: P[item],
          scenario: P[scenario],
          element: P[el],
        }),
      )

    // Two meaningfully different scenarios give different verdicts for the same knowledge.
    expect(assess('$lockstep', '$launch', '$rts').verdict).toBe('conditionsMet')
    expect(assess('$lockstep', '$expansion', '$rts').verdict).toBe('conditionsMet')
    const shooterLockstep = assess('$lockstep', '$expansion', '$shooter')
    expect(shooterLockstep.verdict).toBe('conditionsNotMet')
    expect(shooterLockstep.explanation.steps[0]).toMatchObject({
      relation: 'appliesWhen',
      result: 'false',
      parameters: [{ resolvedFrom: 'element' }],
    })
    expect(assess('$deadReckoning', '$expansion', '$shooter').verdict).toBe('conditionsNotMet')
    // Nobody stated whether RTS units move predictably: the verdict stays unknown, and says why.
    const rtsDead = assess('$deadReckoning', '$expansion', '$rts')
    expect(rtsDead.verdict).toBe('unknown')
    expect(rtsDead.explanation.missing[0]).toMatchObject({
      conceptName: 'Predictable entity motion',
      nature: 'expected',
    })
    // The library declares nothing that must hold for an authoritative server. The empty
    // conjunction is true, but that establishes nothing, so the verdict is unknown and the
    // item is underspecified (ADR 0028 A3). The seed is still proposed, and says so.
    const auth = assess('$authServer', '$expansion', '$shooter')
    expect(auth).toMatchObject({
      verdict: 'unknown',
      explanation: {
        steps: [],
        evaluatedVerdict: 'conditionsMet',
        specification: 'underspecified',
        knowledge: { maturity: 'proposed' },
      },
    })
    expect(auth.explanation.meaning).toMatch(/not a recommendation/)
    expect(auth.explanation.scenario).toMatchObject({
      status: 'planned',
      rationale: 'On the roadmap, not funded.',
    })

    // Assessments are proposed, committed and tracked; missing values become open questions.
    const record = (item: string, scenario: string, el: string) => {
      const p = unwrap(
        services.proposeAssessment(owner, {
          projectId: ctx.project.id,
          nature: 'expected',
          item: P[item],
          scenario: P[scenario],
          element: P[el],
        }),
      )
      return unwrap(services.commitProposal(owner, { proposalId: p.proposalId })).refs
        .$assessment as string
    }
    const a1 = record('$lockstep', '$expansion', '$shooter')
    record('$deadReckoning', '$expansion', '$rts')
    const questions = unwrap(
      services.queryObjects(owner, { projectId: ctx.project.id, types: ['core.Question'] }),
    ).objects
    expect(questions.map((q) => q.attributes.text).join(' ')).toMatch(/Predictable entity motion/)

    // The team switches the shooter to the fixed-point engine: the assessment goes stale, and
    // re-evaluating now would change its verdict. Nothing changes until someone reassesses.
    commit(ctx.project.id, [
      {
        op: 'updateObject',
        id: V.$shooterPhysics as string,
        set: { value: { kind: 'boolean', value: true } },
      },
    ])
    const status = unwrap(
      services.getAssessmentStatus(owner, { projectId: ctx.project.id }),
    ).assessments
    expect(status.find((s) => s.id === a1)).toMatchObject({
      status: 'stale',
      verdict: 'conditionsNotMet',
      verdictNow: 'conditionsMet',
    })

    // The seed library was never promoted by being used.
    const items = unwrap(services.getKnowledgeStatus(owner, { projectId: lib.id })).items
    expect(items.every((i) => i.maturity === 'proposed')).toBe(true)

    // The project, with its assessments, exports and replays to the same state.
    const bundle = unwrap(services.exportProject(owner, { projectId: ctx.project.id }))
    const elsewhere = setup()
    unwrap(importProjectExport(elsewhere.store, JSON.parse(JSON.stringify(bundle))))
    expect(stateSha256(elsewhere.store, ctx.project.id)).toBe(
      stateSha256(ctx.store, ctx.project.id),
    )
  })
})
