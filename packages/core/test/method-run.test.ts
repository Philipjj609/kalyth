import type { MethodRun, ObjectVersion, Proposal } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { setup, unwrap } from './helpers.ts'
import { expectedRun, multiGame } from './method-fixture.ts'

type Ctx = ReturnType<typeof setup>

function run(ctx: Ctx, input: object, by = ctx.owner): MethodRun {
  return unwrap(ctx.services.startMethodRun(by, input))
}

/** The proposal's operations by type, as filed. */
function filed(ctx: Ctx, r: MethodRun) {
  const proposal = ctx.store.getProposal(r.proposal as string) as Proposal
  const created = (type: string) =>
    proposal.ops.filter(
      (o): o is Extract<typeof o, { op: 'createObject' }> =>
        o.op === 'createObject' && o.type === type,
    )
  return { proposal, created }
}

describe('deterministic method runs (ADR 0033)', () => {
  it('reproduces the frozen multi-game fixture, with the same hash on a second run', () => {
    const ctx = setup()
    const { input, names } = multiGame(ctx)
    const r = run(ctx, input)
    expect(r.failure).toBeNull()
    expect(r.status).toBe('proposed')
    expect(r.proposalStatus).toBe('pending')
    expect(r.cost).toEqual({ modelCalls: 0, microUsd: 0 })

    // Selection: every source per candidate, in the fixed order; nothing cut.
    expect(
      r.selection.candidates.map((c) => {
        const graph = c.sources.find((s) => s.source === 'graph')
        return {
          item: c.name,
          sources: c.sources.map((s) => s.source),
          ...(graph ? { hops: graph.hops } : {}),
        }
      }),
    ).toEqual(expectedRun.selection.candidates)
    expect(r.selection.cut).toEqual([])
    expect(r.selection.ideas).toEqual([])
    expect(r.selection.excluded).toEqual([])

    // Assessments: one per candidate and exact context, each verdict as frozen.
    const { proposal, created } = filed(ctx, r)
    const assessments = created('core.Assessment')
    expect(assessments).toHaveLength(expectedRun.assessmentCount)
    const verdictOf = (item: string, scenario?: string, element?: string) =>
      r.comparison
        .flatMap((e) => [
          { name: e.name, contexts: e.contexts },
          ...e.refinedBy.map((x) => ({ name: x.name, contexts: x.contexts })),
        ])
        .filter((e) => e.name === item)
        .flatMap((e) => e.contexts)
        .filter(
          (v) =>
            (!scenario || names.get(v.scenario) === scenario) &&
            (!element || names.get(v.element as string) === element),
        )
        .map((v) => ({ verdict: v.verdict, specification: v.specification }))
    for (const a of expectedRun.assessments) {
      const found = verdictOf(a.item, a.scenario, a.element)
      expect(found.length, a.item).toBe(a.everyContext ? 4 : 1)
      for (const f of found)
        expect(f, `${a.item} ${a.scenario} ${a.element}`).toEqual({
          verdict: a.verdict,
          specification: a.specification,
        })
    }

    // Questions: missing values per exact context, underspecified items, and one gap.
    const questions = created('core.Question').map((q) => String(q.attributes.text))
    const id = (name: string) => [...names].find(([, n]) => n === name)?.[0] as string
    const missing = expectedRun.questions.missing.map(
      (m: { concept: string; scenario: string; element: string; nature: string }) =>
        `What is the ${m.nature} value of "${m.concept}" for ${id(m.element)} in scenario ${id(m.scenario)} (boolean)?`,
    )
    const underspecified = expectedRun.questions.underspecified.map(
      (n: string) =>
        `Which conditions must hold for "${n}"? Its library declares none, so whether it applies is not established.`,
    )
    const gaps = expectedRun.questions.gaps.map(
      (g: { scenario: string; element: string; nature: string }) =>
        `No pinned knowledge has its declared conditions met for ${g.element} in ${g.scenario} (${g.nature} values). Is there an approach outside the libraries in use?`,
    )
    expect(questions.filter((q) => q.startsWith('What is'))).toEqual(missing)
    expect(questions.filter((q) => q.startsWith('Which')).sort()).toEqual(underspecified)
    expect(questions.filter((q) => q.startsWith('No pinned'))).toEqual(gaps)
    expect(questions).toHaveLength(missing.length + underspecified.length + gaps.length)

    // Alternatives: one per pattern not ruled out everywhere, refinements shown under their parent.
    const alternatives = created('core.Alternative')
    const altByRef = new Map(alternatives.map((a) => [a.id, a]))
    const actual = r.comparison
      .filter((e) => e.alternative)
      .map((e) => {
        const alt = altByRef.get(e.alternative as string) as (typeof alternatives)[number]
        const basis = alt.attributes.basis as {
          covers: string[]
          ruledOut: string[]
          disclosed: { worsens: string[]; underspecified: string[] }
        }
        const ruledOutIn = e.contexts
          .filter((v) => v.verdict === 'conditionsNotMet')
          .map((v) => ({
            scenario: names.get(v.scenario),
            element: names.get(v.element as string),
          }))
        return {
          item: e.name,
          covers: basis.covers.length,
          ruledOut: basis.ruledOut.length,
          ...(ruledOutIn.length > 0 ? { ruledOutIn } : {}),
          ...(e.refinedBy.length > 0 ? { refinedBy: e.refinedBy.map((x) => x.name) } : {}),
          ...(e.constraints.length > 0
            ? { constraints: e.constraints.map((c) => c.statement) }
            : {}),
          worsens: basis.disclosed.worsens,
          underspecified: basis.disclosed.underspecified.length > 0,
        }
      })
      .sort((a, b) => (a.item < b.item ? -1 : 1))
    expect(actual).toEqual(expectedRun.alternatives)
    expect(created('core.Decision')).toHaveLength(1)

    // Checks pass by construction; the run's proposal is the only output, and it waits for a person.
    expect(r.checks.length).toBe(6 * alternatives.length)
    expect(r.checks.filter((c) => !c.passed && c.severity === 'mandatory')).toHaveLength(
      expectedRun.checks.mandatoryFailures,
    )
    expect(r.checks.filter((c) => !c.passed && c.severity === 'advisory')).toHaveLength(
      expectedRun.checks.advisoryFailures,
    )
    expect(proposal.status).toBe('pending')
    expect(proposal.rationale).toContain(r.id)

    // The same inputs and revisions give the same outputs, in this store and in a fresh one.
    const again = run(ctx, input)
    expect(again.outputSha256).toBe(r.outputSha256)
    const other = setup()
    expect(run(other, multiGame(other).input).outputSha256).toBe(r.outputSha256)
  })

  it('commits as a person, and the alternatives can then be accepted through the gate', () => {
    const ctx = setup()
    const { input } = multiGame(ctx)
    const r = run(ctx, input)
    const commit = unwrap(
      ctx.services.commitProposal(ctx.owner, { proposalId: r.proposal as string }),
    )
    const runAfter = unwrap(
      ctx.services.getMethodRun(ctx.owner, { projectId: input.projectId, id: r.id }),
    )
    expect(runAfter.proposalStatus).toBe('committed')
    const lockstep = r.comparison.find((e) => e.name === 'Deterministic lockstep')
    const altId = lockstep?.alternative as string
    const decision = ctx.store
      .view(input.projectId, commit.revision)
      .listObjects({ types: ['core.Decision'] })[0] as ObjectVersion
    const accept = unwrap(
      ctx.services.proposeChange(ctx.owner, {
        projectId: input.projectId,
        baseRevision: commit.revision,
        ops: [
          { op: 'setDecisionStatus', id: altId, status: 'accepted', rationale: 'chosen' },
          { op: 'setDecisionStatus', id: decision.id, status: 'accepted', rationale: 'chosen' },
        ],
        rationale: 'accept',
      }),
    )
    expect(accept.checks?.every((c) => c.passed)).toBe(true)
    unwrap(ctx.services.commitProposal(ctx.owner, { proposalId: accept.proposalId }))
  })
})
