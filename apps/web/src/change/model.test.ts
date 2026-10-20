import type { DecisionSummary, NavigatorRun, Proposal } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { claim, obj, rel } from '../test/records.ts'
import { withoutHandles } from '../views/shared.tsx'
import { changeItems, lead, nextStep, openQuestions, pendingRuns, tradeoffLevels } from './model.ts'

const facets = (over: Partial<DecisionSummary['facets']> = {}): DecisionSummary['facets'] => ({
  freshness: { status: 'current', changes: 3, stale: [] },
  implementation: { state: 'none', tasks: [] },
  verification: { state: 'none', coverage: null },
  ...over,
})

const decision = (over: Partial<DecisionSummary> = {}): DecisionSummary => ({
  id: `obj_${'d'.repeat(32)}`,
  title: 'Add multi-tenancy',
  question: 'How should organisations be enforced?',
  status: 'open',
  statusRationale: null,
  basis: 'inferred',
  alternatives: [
    {
      id: `obj_${'a'.repeat(32)}`,
      title: 'A',
      summary: 's',
      status: 'proposed',
      directChanges: [],
    },
    {
      id: `obj_${'b'.repeat(32)}`,
      title: 'B',
      summary: 's',
      status: 'proposed',
      directChanges: [],
    },
  ],
  decides: [],
  facets: facets(),
  ...over,
})

describe('the next step of a change', () => {
  const state = (d: DecisionSummary, decisiveOpen = 0) => ({
    decision: d,
    decisiveOpen,
    questionsOpen: decisiveOpen,
    hasPackage: false,
  })

  it('puts stale evidence first, whatever else is due', () => {
    const d = decision({
      facets: facets({
        freshness: {
          status: 'stale',
          changes: 3,
          stale: [
            {
              relationId: `rel_${'1'.repeat(32)}`,
              target: `obj_${'1'.repeat(32)}`,
              label: 'User',
              status: 'stale',
              reason: 'x',
            },
          ],
        },
      }),
    })
    expect(nextStep(state(d, 2))).toMatchObject({
      tone: 'attention',
      text: 'Review 1 change whose evidence moved',
    })
  })

  it('asks for the deciding questions before the comparison while a decision is open', () => {
    expect(nextStep(state(decision(), 2))).toMatchObject({ stage: 'questions', tone: 'action' })
    expect(nextStep(state(decision()))).toMatchObject({
      stage: 'decide',
      text: 'Compare the alternatives and accept one',
    })
  })

  it('follows the facets once accepted, from hand-off to reconciliation', () => {
    const accepted = (state: DecisionSummary['facets']['implementation']['state']) =>
      nextStep({
        decision: decision({
          status: 'accepted',
          facets: facets({ implementation: { state, tasks: [] } }),
        }),
        decisiveOpen: 0,
        questionsOpen: 0,
        hasPackage: false,
      }).stage
    expect(accepted('none')).toBe('handoff')
    expect(accepted('planned')).toBe('work')
    expect(accepted('reported')).toBe('work')
    expect(accepted('complete')).toBe('reconcile')
  })
})

describe('reading what the model wrote', () => {
  it('reads explicit trade-off levels and leaves the rest unknown', () => {
    expect(
      tradeoffLevels(
        'Cost: high — new model. Risk: medium. Reversibility: low. Operational burden: low.',
      ),
    ).toEqual([
      { label: 'Cost', level: 'high' },
      { label: 'Risk', level: 'medium' },
      { label: 'Reversibility', level: 'low' },
      { label: 'Migration', level: null },
      { label: 'Operations', level: 'low' },
    ])
  })

  it('keeps the first sentences of a summary, and removes handles from prose', () => {
    expect(lead('One. Two. Three.')).toBe('One. Two.')
    expect(withoutHandles('Across User (N1) and Item (N2) entities.')).toBe(
      'Across User and Item entities.',
    )
  })
})

describe('the changes in a project', () => {
  const run = (over: Partial<NavigatorRun>): NavigatorRun =>
    ({
      id: `nav_${'1'.repeat(32)}`,
      projectId: `prj_${'1'.repeat(32)}`,
      input: { kind: 'alternatives', request: 'Add audit logging', focus: [] },
      status: 'completed',
      requestedBy: `pcp_${'1'.repeat(32)}`,
      baseRevision: 1,
      startedAt: '2026-10-20T10:00:00.000Z',
      finishedAt: '2026-10-20T10:00:01.000Z',
      calls: [],
      costMicroUsd: 0,
      grounding: null,
      output: null,
      proposalId: `prp_${'1'.repeat(32)}`,
      error: null,
      ...over,
    }) as NavigatorRun
  const proposal = (status: Proposal['status']) =>
    ({ id: `prp_${'1'.repeat(32)}`, status, ops: [] }) as unknown as Proposal

  it('lists a run awaiting review first, then decisions that need a person', () => {
    const items = changeItems(
      [
        decision({
          status: 'accepted',
          facets: facets({ implementation: { state: 'complete', tasks: [] } }),
        }),
        decision({ id: `obj_${'e'.repeat(32)}`, title: 'Soft delete' }),
      ],
      [run({})],
      [proposal('pending')],
      () => 1,
    )
    expect(items.map((i) => [i.ref.kind, i.title])).toEqual([
      ['run', 'Add audit logging'],
      ['decision', 'Soft delete'],
      ['decision', 'Add multi-tenancy'],
    ])
    expect(items[1]?.status).toBe('Open · 2 alternatives · 1 question open')
    expect(pendingRuns([run({})], [proposal('committed')])).toEqual([])
  })

  it('counts the open questions about a decision and its alternatives', () => {
    const d = obj('core.Decision', { title: 'd', question: 'q' })
    const a = obj('core.Alternative', { title: 'a', summary: 's' })
    const q1 = obj('core.Question', {
      text: 'one',
      inquiryRole: 'decision-sensitive',
      status: 'open',
    })
    const q2 = obj('core.Question', { text: 'two', inquiryRole: 'exploratory', status: 'answered' })
    const q3 = obj('core.Question', { text: 'three', inquiryRole: 'exploratory' })
    const objects = [d, a, q1, q2, q3]
    const relations = [
      rel('alternativeOf', a, d),
      rel('concerns', q1, d),
      rel('concerns', q2, d),
      rel('concerns', q3, a),
    ]
    const model = { objectById: new Map(objects.map((o) => [o.id, o])), relations }
    expect(openQuestions(model, d.id).map((q) => q.attributes.text)).toEqual(['one', 'three'])
    expect(claim().basis).toBe('observed')
  })
})
