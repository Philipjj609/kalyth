import type { ResolvedOperation } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALT_A,
  ALT_B,
  alternativesOps,
  CRUD_PY,
  DECISION,
  ITEM,
  id,
  impactResult,
  MODELS_PY,
  navigatorStatus,
  QUESTION,
} from '../test/navigator.ts'
import { claim } from '../test/records.ts'
import {
  budgetUsed,
  budgetWarnings,
  citationSummary,
  exactMicroUsd,
  formatMicroUsd,
  groupImpact,
  hasMockOutput,
  impactLabeller,
  impactPathText,
  impactSeeds,
  parseAlternativesProposal,
  parseSummaryProposal,
  runRefetchInterval,
  stepText,
} from './navigator.ts'

describe('micro-USD formatting', () => {
  it('shows four decimals from integer micro-dollars', () => {
    expect(formatMicroUsd(0)).toBe('$0.0000')
    expect(formatMicroUsd(1_000_000)).toBe('$1.0000')
    expect(formatMicroUsd(1_234_567)).toBe('$1.2346')
    expect(formatMicroUsd(5_000_000_000)).toBe('$5,000.0000')
    expect(formatMicroUsd(100)).toBe('$0.0001')
    expect(formatMicroUsd(37)).toBe('$0.0000')
  })

  it('rounds half away from zero without floating-point drift', () => {
    expect(formatMicroUsd(50)).toBe('$0.0001')
    expect(formatMicroUsd(49)).toBe('$0.0000')
    expect(formatMicroUsd(1_005_050)).toBe('$1.0051')
    // 0.1 + 0.2 style drift cannot occur: 300_000 micro-USD is exactly $0.3000.
    expect(formatMicroUsd(100_000 + 200_000)).toBe('$0.3000')
  })

  it('handles negative remainders and non-finite input', () => {
    expect(formatMicroUsd(-1_500)).toBe('-$0.0015')
    expect(formatMicroUsd(-10)).toBe('$0.0000')
    expect(formatMicroUsd(Number.NaN)).toBe('—')
  })

  it('gives the exact amount for titles', () => {
    expect(exactMicroUsd(37)).toBe('$0.000037 (37 micro-USD)')
    expect(exactMicroUsd(1_234_567)).toBe('$1.234567 (1,234,567 micro-USD)')
    expect(exactMicroUsd(-2)).toBe('-$0.000002 (-2 micro-USD)')
  })
})

describe('budget warnings', () => {
  const withBudget = (
    budget: Partial<ReturnType<typeof navigatorStatus>['budget']>,
    paid = true,
  ) => {
    const s = navigatorStatus()
    return {
      provider: { ...s.provider, paid },
      budget: { ...s.budget, ...budget },
    }
  }

  it('warns when a paid provider has no cap, but not for a free one', () => {
    expect(budgetWarnings(withBudget({ capMicroUsd: 0 }))).toEqual([
      { tone: 'danger', text: 'No budget cap is set, so every paid call is refused.' },
    ])
    expect(budgetWarnings(withBudget({ capMicroUsd: 0 }, false))).toEqual([])
    expect(budgetUsed(withBudget({ capMicroUsd: 0 }).budget)).toBeNull()
  })

  it('reports the highest threshold reached, and an exhausted cap', () => {
    const thresholds = [
      { fraction: 0.5, reached: true },
      { fraction: 0.8, reached: true },
    ]
    expect(
      budgetWarnings(
        withBudget({ capMicroUsd: 1_000_000, remainingMicroUsd: 150_000, thresholds }),
      ),
    ).toEqual([{ tone: 'caution', text: '80% of the budget cap is spent or reserved.' }])
    expect(
      budgetWarnings(
        withBudget({
          capMicroUsd: 1_000_000,
          remainingMicroUsd: 400_000,
          thresholds: [{ fraction: 0.5, reached: true }],
        }),
      ),
    ).toEqual([{ tone: 'warning', text: '50% of the budget cap is spent or reserved.' }])
    expect(
      budgetWarnings(withBudget({ capMicroUsd: 1_000_000, remainingMicroUsd: -20, thresholds })),
    ).toEqual([
      {
        tone: 'danger',
        text: 'The budget cap is used up. Paid calls are refused until it is raised.',
      },
    ])
    expect(
      budgetUsed(
        withBudget({ capMicroUsd: 1_000_000, spentMicroUsd: 200_000, reservedMicroUsd: 50_000 })
          .budget,
      ),
    ).toBe(0.25)
  })
})

describe('run polling and summaries', () => {
  it('polls about once a second only while a run is running', () => {
    expect(runRefetchInterval({ status: 'running' })).toBe(1000)
    expect(runRefetchInterval({ status: 'completed' })).toBe(false)
    expect(runRefetchInterval({ status: 'failed' })).toBe(false)
    expect(runRefetchInterval(undefined)).toBe(false)
  })

  it('summarises citations', () => {
    expect(citationSummary(null)).toBe('—')
    expect(
      citationSummary({ citations: 0, validCitations: 0, itemsKept: 1, itemsRejected: [] }),
    ).toBe('no citations')
    expect(
      citationSummary({ citations: 9, validCitations: 7, itemsKept: 3, itemsRejected: [] }),
    ).toBe('7 of 9 valid')
  })
})

describe('impact paths', () => {
  it('writes each hop in the relation’s own direction, marking definitional containment', () => {
    expect(stepText({ type: 'dependsOn', direction: 'forward', rule: 'relation' })).toBe(
      '-dependsOn->',
    )
    expect(stepText({ type: 'dependsOn', direction: 'reverse', rule: 'relation' })).toBe(
      '<-dependsOn-',
    )
    expect(stepText({ type: 'contains', direction: 'reverse', rule: 'definition' })).toBe(
      '<-contains (defines)-',
    )
  })

  it('renders a readable typed path from the seed', () => {
    const result = impactResult()
    const labelOf = impactLabeller(result, () => undefined)
    const crud = result.elements.find((e) => e.id === CRUD_PY)
    expect(crud && impactPathText(crud, labelOf)).toBe(
      'Item <-contains (defines)- app/models.py <-dependsOn- app/crud.py',
    )
    const seed = result.elements.find((e) => e.id === ITEM)
    expect(seed && impactPathText(seed, labelOf)).toBe('Item')
  })

  it('labels from the result, then the model, then the short id', () => {
    const labelOf = impactLabeller(impactResult(), (i) => (i === DECISION ? 'Tenancy' : undefined))
    expect(labelOf(MODELS_PY)).toBe('app/models.py')
    expect(labelOf(DECISION)).toBe('Tenancy')
    expect(labelOf(id('obj', 999))).toBe('obj…0003e7')
  })

  it('groups by type in model order, nearest first', () => {
    const groups = groupImpact(impactResult())
    expect(groups.map((g) => [g.type, g.elements.map((e) => e.label)])).toEqual([
      ['software.Module', ['app/models.py', 'app/crud.py']],
      ['software.DataEntity', ['Item']],
    ])
  })
})

describe('reading a run’s proposal', () => {
  it('matches alternatives, direct changes and questions to the decision by id', () => {
    const parsed = parseAlternativesProposal(alternativesOps())
    expect(parsed.mock).toBe(true)
    expect(parsed.decision).toMatchObject({
      id: DECISION,
      title: 'Tenancy model',
      question: 'How should tenants be isolated?',
    })
    expect(parsed.alternatives.map((a) => a.id)).toEqual([ALT_B, ALT_A])
    const a = parsed.alternatives.find((x) => x.id === ALT_A)
    expect(a).toMatchObject({
      title: 'Tenant column',
      summary: 'Add tenant_id to every table.',
      tradeoffs: 'Cheap; every query must filter.',
      citations: 3,
    })
    expect(a?.claim.confidence).toEqual({
      level: 'medium',
      rationale: 'Two modules already scope by owner.',
    })
    expect(a?.changes).toEqual([
      {
        relationId: id('rel', 303),
        targetId: ITEM,
        change: 'Add a tenant_id column.',
        citations: 1,
        mock: true,
      },
      {
        relationId: id('rel', 304),
        targetId: MODELS_PY,
        change: 'Filter by tenant in the base query.',
        citations: 2,
        mock: true,
      },
    ])
    expect(a && impactSeeds(a)).toEqual([ITEM, MODELS_PY])
    expect(parsed.alternatives.find((x) => x.id === ALT_B)?.changes).toEqual([])
    expect(parsed.questions).toMatchObject([
      { id: QUESTION, text: 'Do tenants share users?', inquiryRole: 'blocking', linked: true },
    ])
  })

  it('puts alternatives that are not linked to the decision last instead of dropping them', () => {
    const ops = alternativesOps('nebius').filter(
      (o) => !(o.op === 'createRelation' && o.id === id('rel', 302)),
    )
    const parsed = parseAlternativesProposal(ops)
    expect(parsed.mock).toBe(false)
    expect(parsed.alternatives.map((a) => a.id)).toEqual([ALT_A, ALT_B])
  })

  it('tolerates a proposal without a decision', () => {
    const parsed = parseAlternativesProposal([])
    expect(parsed).toEqual({
      decision: null,
      decisionId: null,
      alternatives: [],
      questions: [],
      mock: false,
    })
  })

  it('reads a refinement: alternatives for a decision already in the model, and hybrids', () => {
    const hybrid = id('obj', 205)
    const first = alternativesOps()[0]
    if (first?.op !== 'createObject') throw new Error('fixture changed')
    const claim = first.claim
    const link = (n: number, type: string, to: string): ResolvedOperation => ({
      op: 'createRelation',
      id: id('rel', n),
      type,
      from: hybrid,
      to,
      stance: 'toBe',
      properties: {},
      claim,
    })
    const ops: ResolvedOperation[] = [
      ...alternativesOps().filter((o) => !(o.op === 'createObject' && o.type === 'core.Decision')),
      {
        op: 'createObject',
        id: hybrid,
        type: 'core.Alternative',
        stance: 'toBe',
        attributes: { title: 'Column, with big tenants apart', summary: 's', tradeoffs: 't' },
        claim,
      },
      link(306, 'alternativeOf', DECISION),
      link(307, 'combines', ALT_A),
      link(308, 'combines', ALT_B),
    ]
    const parsed = parseAlternativesProposal(ops)
    expect(parsed.decision).toBeNull()
    expect(parsed.decisionId).toBe(DECISION)
    expect(parsed.alternatives.find((a) => a.id === hybrid)?.combines).toEqual([ALT_A, ALT_B])
    expect(parsed.alternatives.find((a) => a.id === ALT_A)?.combines).toEqual([])
    expect(parsed.questions[0]?.linked).toBe(true)
  })

  it('reads summary statements and what they concern', () => {
    const assertion = id('obj', 501)
    const ops: ResolvedOperation[] = [
      {
        op: 'createObject',
        id: assertion,
        type: 'core.Assertion',
        stance: 'asIs',
        attributes: { statement: 'The module defines the Item model.' },
        claim: claim('inferred', {
          model: { provider: 'mock', model: 'm' },
          supports: [{ allOf: [id('evd', 7)] }],
        }),
      },
      {
        op: 'createRelation',
        id: id('rel', 502),
        type: 'concerns',
        from: assertion,
        to: MODELS_PY,
        stance: 'asIs',
        properties: {},
        claim: claim('inferred'),
      },
    ]
    expect(parseSummaryProposal(ops)).toMatchObject([
      {
        id: assertion,
        statement: 'The module defines the Item model.',
        concerns: [MODELS_PY],
        citations: 1,
        mock: true,
      },
    ])
    expect(hasMockOutput(ops)).toBe(true)
    expect(hasMockOutput(alternativesOps('nebius'))).toBe(false)
  })
})
