import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseAlternativesProposal } from '../model/navigator.ts'
import { alternativesOps, ITEM, impactResult, MODELS_PY } from '../test/navigator.ts'
import { AlternativesView, type ElementLookup, ImpactList } from './ProposedOutput.tsx'
import { GroundingReportPanel, ModelCallsPanel } from './RunReport.tsx'

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
})
