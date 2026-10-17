import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Situation } from '../api/situation.ts'
import { parseAlternativesProposal } from '../model/navigator.ts'
import {
  ALT_A,
  ALT_B,
  alternativesOps,
  DECISION,
  ITEM,
  id,
  impactResult,
  MODELS_PY,
  PROJECT,
  QUESTION,
} from '../test/navigator.ts'
import { AlternativesView, type ElementLookup, ImpactList } from './ProposedOutput.tsx'
import { GroundingReportPanel, ModelCallsPanel } from './RunReport.tsx'
import { SituationView } from './SituationPanel.tsx'

/** Visible text of static markup, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const lookup: ElementLookup = {
  nameOf: (id) => (id === ITEM ? 'Item' : id === MODELS_PY ? 'app/models.py' : undefined),
  typeOf: (id) =>
    id === ITEM ? 'software.DataEntity' : id === MODELS_PY ? 'software.Module' : undefined,
}

describe('grounding report', () => {
  it('shows valid citations out of total and every rejection with reason and ref', () => {
    const html = renderToStaticMarkup(
      <GroundingReportPanel
        status="completed"
        grounding={{
          citations: 9,
          validCitations: 7,
          itemsKept: 3,
          itemsRejected: [
            { item: 'alternative 2', reason: 'quote not found in excerpt', ref: 'E4' },
            { item: 'question 1', reason: 'reference was not in context', ref: 'E99' },
            { item: 'statement 3', reason: 'no valid citation for a claim about code' },
          ],
        }}
      />,
    )
    const text = textOf(html)
    expect(text).toContain('Valid citations 7 of 9')
    expect(text).toContain('Items kept 3')
    expect(text).toContain('Items rejected 3')
    expect(text).toContain('3 items rejected and not proposed')
    expect(text).toContain('alternative 2 quote not found in excerpt E4')
    expect(text).toContain('question 1 reference was not in context E99')
    expect(text).toContain('statement 3 no valid citation for a claim about code none')
    expect(html).toContain('tone-danger')
  })

  it('says so when nothing was rejected, and before grounding ran', () => {
    const clean = textOf(
      renderToStaticMarkup(
        <GroundingReportPanel
          status="completed"
          grounding={{ citations: 2, validCitations: 2, itemsKept: 2, itemsRejected: [] }}
        />,
      ),
    )
    expect(clean).toContain('No item was rejected.')
    expect(
      textOf(renderToStaticMarkup(<GroundingReportPanel status="running" grounding={null} />)),
    ).toContain('Citations are checked when the model has answered.')
  })

  it('escapes model-controlled text instead of interpreting it', () => {
    const html = renderToStaticMarkup(
      <GroundingReportPanel
        status="completed"
        grounding={{
          citations: 1,
          validCitations: 0,
          itemsKept: 0,
          itemsRejected: [
            { item: '<img src=x onerror=alert(1)>', reason: 'bad', ref: '<b>E1</b>' },
          ],
        }}
      />,
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>E1</b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('model calls', () => {
  it('lists purpose, model, attempt, outcome, tokens, cost, latency and issues', () => {
    const text = textOf(
      renderToStaticMarkup(
        <ModelCallsPanel
          totalMicroUsd={2_345}
          calls={[
            {
              purpose: 'alternatives',
              provider: 'nebius',
              model: 'nemotron-super',
              attempt: 2,
              outcome: 'schema_invalid',
              inputTokens: 1204,
              outputTokens: null,
              reservedMicroUsd: 9_000,
              costMicroUsd: 2_345,
              latencyMs: 1830,
              issues: ['alternatives: expected at least 2 items'],
            },
          ]}
        />,
      ),
    )
    expect(text).toContain('1 call · $0.0023 total')
    expect(text).toContain(
      'alternatives nemotron-super nebius 2 Outcome: Schema invalid 1,204 in · ? out $0.0023 reserved $0.0090 1.83 s alternatives: expected at least 2 items',
    )
  })
})

describe('impact list', () => {
  it('groups by type with depth and a readable typed path', () => {
    const text = textOf(
      renderToStaticMarkup(<ImpactList result={impactResult()} nameOf={() => undefined} />),
    )
    expect(text).toContain('3 elements at r4 from 1 direct change')
    expect(text).toContain('Module 2')
    expect(text).toContain('depth 1 app/models.py Item <-contains (defines)- app/models.py')
    expect(text).toContain(
      'depth 2 app/crud.py Item <-contains (defines)- app/models.py <-dependsOn- app/crud.py',
    )
    expect(text).toContain('Data entity 1 direct Item')
    expect(text.indexOf('Module 2')).toBeLessThan(text.indexOf('Data entity 1'))
    expect(text).not.toContain('cut the traversal short')
  })

  it('warns when the traversal was truncated', () => {
    const text = textOf(
      renderToStaticMarkup(
        <ImpactList result={{ ...impactResult(), truncated: true }} nameOf={() => undefined} />,
      ),
    )
    expect(text).toContain('The depth or node limit cut the traversal short')
  })
})

describe('alternatives viewer', () => {
  it('shows the decision question, each alternative with its direct changes, and the questions', () => {
    const output = parseAlternativesProposal(alternativesOps('nebius'))
    const text = textOf(
      renderToStaticMarkup(
        <AlternativesView
          output={output}
          lookup={lookup}
          renderImpact={() => <span>IMPACT</span>}
        />,
      ),
    )
    expect(text).toContain('How should tenants be isolated?')
    expect(text).toContain('Tenancy model')
    expect(text).not.toContain('Mock output')
    const b = text.indexOf('Alternative 1')
    const a = text.indexOf('Alternative 2')
    expect(b).toBeGreaterThan(-1)
    expect(text.slice(b, a)).toContain('Database per tenant')
    expect(text.slice(b, a)).toContain('None proposed.')
    const altA = text.slice(a)
    expect(altA).toContain('Tenant column')
    expect(altA).toContain('Add tenant_id to every table.')
    expect(altA).toContain('Trade-offs Cheap; every query must filter.')
    expect(altA).toContain('Confidence: medium. Two modules already scope by owner.')
    expect(altA).toContain('3 citations')
    expect(altA).toContain('Direct changes 2')
    expect(altA).toContain('Data entity Item 1 citation Add a tenant_id column.')
    expect(altA).toContain('Module app/models.py 2 citations Filter by tenant in the base query.')
    expect(text.match(/IMPACT/g)).toHaveLength(2)
    expect(text).toContain('Open questions 1')
    expect(text).toContain('Inquiry role: Blocking Do tenants share users?')
  })

  it('marks mock output on the decision, every alternative and every question', () => {
    const output = parseAlternativesProposal(alternativesOps('mock'))
    const text = textOf(renderToStaticMarkup(<AlternativesView output={output} lookup={lookup} />))
    // Decision header, two alternatives and one question.
    expect(text.match(/Mock output/g)).toHaveLength(4)
  })

  it('says when the proposal holds nothing to show', () => {
    const output = parseAlternativesProposal([])
    expect(textOf(renderToStaticMarkup(<AlternativesView output={output} lookup={lookup} />))).toBe(
      'The proposal holds no decision, alternatives or questions.',
    )
  })

  it('shows the decision as accepted, with the accepted alternative highlighted', () => {
    const output = parseAlternativesProposal(alternativesOps('nebius'))
    const statuses: Record<string, string> = {
      [DECISION]: 'accepted',
      [ALT_A]: 'accepted',
      [ALT_B]: 'rejected',
    }
    const html = renderToStaticMarkup(
      <AlternativesView
        output={output}
        lookup={lookup}
        statusOf={(i) => statuses[i]}
        renderDecide={(alt) => <span>DECIDE {alt.title}</span>}
        notice={<span>NOTICE</span>}
      />,
    )
    const text = textOf(html)
    expect(text).toContain('Decision status: Accepted')
    expect(text).toContain('NOTICE')
    const cards = html.split('<article').slice(1)
    const card = (title: string) => cards.find((c) => c.includes(title)) ?? ''
    expect(card('Tenant column')).toContain('tone-success')
    expect(textOf(`<article${card('Tenant column')}`)).toContain('Decision status: Accepted')
    expect(card('Database per tenant')).not.toContain('ring-2')
    expect(textOf(`<article${card('Database per tenant')}`)).toContain('Decision status: Rejected')
    expect(text).toContain('DECIDE Tenant column')
    expect(text).toContain('DECIDE Database per tenant')
  })
})

describe('situation', () => {
  const situation: Situation = {
    projectId: PROJECT,
    revision: 13,
    openDecisions: [
      {
        id: DECISION,
        title: 'Tenancy model',
        alternatives: [
          { id: ALT_A, title: 'Tenant column', status: 'proposed' },
          { id: ALT_B, title: 'Database per tenant', status: 'withdrawn' },
        ],
      },
    ],
    openQuestions: [
      { id: QUESTION, text: 'Do tenants share users?', inquiryRole: 'blocking', concerns: [ITEM] },
    ],
    pendingProposals: [
      {
        id: id('prp', 5),
        proposedBy: id('pcp', 9),
        origin: 'model',
        createdAt: '2026-10-16T10:00:00.000Z',
        operations: 9,
        rationale: 'Alternatives for: add multi-tenancy',
      },
    ],
    freshness: { current: 40, stale: 3, 'derived-stale': 2 },
    staleClaims: [
      {
        id: MODELS_PY,
        kind: 'object',
        type: 'software.Module',
        basis: 'observed',
        status: 'stale',
        staleEvidence: [id('evd', 1)],
        reason: 'models.py changed in the latest snapshot',
      },
    ],
  }

  it('lists open decisions with alternatives, questions, pending proposals and stale counts', () => {
    const inspected: string[] = []
    const text = textOf(
      renderToStaticMarkup(
        <SituationView
          situation={situation}
          nameOf={lookup.nameOf}
          onInspect={(i) => inspected.push(i)}
          reviewLink={(p) => <a href={`?proposal=${p}`}>Review</a>}
        />,
      ),
    )
    expect(text).toContain(
      'Open decisions 1 Tenancy model Tenant column Decision status: Proposed Database per tenant Decision status: Withdrawn',
    )
    expect(text).toContain(
      'Open questions 1 Inquiry role: Blocking Do tenants share users? about Item',
    )
    expect(text).toContain(
      'Pending proposals 1 Alternatives for: add multi-tenancy Origin: Model 9 operations',
    )
    expect(text).toContain('Review')
    expect(text).toContain('Stale claims 5')
    expect(text).toContain('Freshness: Stale 3')
    expect(text).toContain('Freshness: Derived stale 2')
    expect(text).toContain('app/models.py models.py changed in the latest snapshot')
  })

  it('says when there is nothing open', () => {
    const text = textOf(
      renderToStaticMarkup(
        <SituationView
          situation={{
            ...situation,
            openDecisions: [],
            openQuestions: [],
            pendingProposals: [],
            freshness: {},
            staleClaims: [],
          }}
          nameOf={() => undefined}
        />,
      ),
    )
    expect(text).toBe(
      'Open decisions 0 None open. Open questions 0 None open. Pending proposals 0 Nothing waiting for review. Stale claims 0 Freshness not reported.',
    )
  })
})
