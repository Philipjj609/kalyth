import type { DecisionSummary, ImpactResult, ObjectVersion } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { ALT_A, ALT_B, CRUD_PY, DECISION, ITEM, id, MODELS_PY, PROJECT } from '../test/navigator.ts'
import { claim, obj, rel } from '../test/records.ts'
import { compareAlternatives, compareReach } from './compare.ts'

const change = (n: number, target: string, label: string, text: string) => ({
  relationId: id('rel', n),
  target,
  label,
  change: text,
})

function openDecision(): DecisionSummary {
  return {
    id: DECISION,
    title: 'Tenancy model',
    question: 'How should tenants be isolated?',
    status: 'open',
    statusRationale: null,
    basis: 'inferred',
    alternatives: [
      {
        id: ALT_A,
        title: 'Tenant column',
        summary: 'Add tenant_id to every table.',
        status: 'proposed',
        directChanges: [
          change(301, ITEM, 'Item', 'Add a tenant_id column.'),
          change(302, MODELS_PY, 'app/models.py', 'Filter by tenant in the base query.'),
        ],
      },
      {
        id: ALT_B,
        title: 'Schema per tenant',
        summary: 'One schema each.',
        status: 'proposed',
        directChanges: [
          change(303, ITEM, 'Item', 'Move to a per-tenant schema.'),
          change(304, CRUD_PY, 'app/crud.py', 'Switch the search path per request.'),
        ],
      },
    ],
    decides: [],
  }
}

function lookup() {
  const altA = obj(
    'core.Alternative',
    { title: 'Tenant column', summary: 'x', tradeoffs: 'Cheap; a missed filter leaks data.' },
    {
      id: ALT_A,
      claim: claim('inferred', { confidence: { level: 'medium', rationale: 'Common pattern.' } }),
    },
  )
  const altB = obj('core.Alternative', { title: 'Schema per tenant', summary: 'y' }, { id: ALT_B })
  const decision = obj('core.Decision', { title: 'Tenancy model', question: 'q' }, { id: DECISION })
  const q1 = obj('core.Question', {
    text: 'How many tenants in a year?',
    inquiryRole: 'decision-sensitive',
    status: 'answered',
    answer: 'About forty.',
  })
  const hybrid = obj('core.Alternative', { title: 'Hybrid', summary: 'z' }, { id: id('obj', 205) })
  const q2 = obj('core.Question', {
    text: 'Does the ORM support schemas?',
    inquiryRole: 'blocking',
  })
  const retired = obj(
    'core.Question',
    { text: 'Old question', inquiryRole: 'exploratory' },
    { lifecycle: 'retired' },
  )
  const objects: ObjectVersion[] = [altA, altB, decision, q1, q2, retired, hybrid]
  return {
    objectById: new Map(objects.map((o) => [o.id, o])),
    relations: [
      rel('concerns', q1, decision, 'inferred'),
      rel('concerns', q2, altB, 'inferred'),
      rel('concerns', retired, altB, 'inferred'),
      rel('combines', hybrid, altA, 'inferred'),
      rel('combines', hybrid, altB, 'inferred'),
    ],
    hybrid,
    q1,
    q2,
  }
}

describe('comparing alternatives', () => {
  it('lines up each alternative with its trade-offs, claim, targets and questions', () => {
    const model = lookup()
    const c = compareAlternatives(openDecision(), model)
    expect(c.alternatives[0]).toMatchObject({
      id: ALT_A,
      tradeoffs: 'Cheap; a missed filter leaks data.',
      basis: 'inferred',
      confidence: { level: 'medium' },
      targets: [ITEM, MODELS_PY],
      questions: [],
    })
    expect(c.alternatives[1]).toMatchObject({ id: ALT_B, tradeoffs: null, confidence: null })
    expect(c.alternatives[1]?.questions.map((q) => q.text)).toEqual([
      'Does the ORM support schemas?',
    ])
    expect(c.questions).toEqual([
      expect.objectContaining({
        text: 'How many tenants in a year?',
        status: 'answered',
        answer: 'About forty.',
      }),
    ])
  })

  it('names the alternatives a hybrid combines', () => {
    const model = lookup()
    const decision = openDecision()
    decision.alternatives.push({
      id: model.hybrid.id,
      title: 'Hybrid',
      summary: 'z',
      status: 'proposed',
      directChanges: [change(305, ITEM, 'Item', 'Both.')],
    })
    const c = compareAlternatives(decision, model)
    expect(c.alternatives[2]?.combines).toEqual([ALT_A, ALT_B])
    expect(c.alternatives[0]?.combines).toEqual([])
  })

  it('builds a change matrix with shared changes first', () => {
    const c = compareAlternatives(openDecision(), lookup())
    expect(c.changes).toEqual([
      {
        target: ITEM,
        label: 'Item',
        cells: ['Add a tenant_id column.', 'Move to a per-tenant schema.'],
        shared: true,
      },
      {
        target: CRUD_PY,
        label: 'app/crud.py',
        cells: [null, 'Switch the search path per request.'],
        shared: false,
      },
      {
        target: MODELS_PY,
        label: 'app/models.py',
        cells: ['Filter by tenant in the base query.', null],
        shared: false,
      },
    ])
  })
})

describe('comparing reach', () => {
  const element = (n: number, seed: string, label: string) => ({
    id: id('obj', n),
    type: 'software.Module',
    label,
    depth: 1,
    seed,
    path: [],
  })
  const result = (seeds: string[], elements: ReturnType<typeof element>[]): ImpactResult => ({
    projectId: PROJECT,
    revision: 4,
    seeds,
    elements,
    truncated: false,
  })

  it('names what only one alternative reaches, once every traversal is in', () => {
    const shared = element(501, ITEM, 'app/api/items.py')
    const a = result([ITEM], [shared, element(502, ITEM, 'app/api/users.py')])
    const b = result([ITEM], [shared, element(503, ITEM, 'app/db.py')])
    const [ra, rb] = compareReach([a, b])
    expect(ra).toMatchObject({ total: 2, only: [{ label: 'app/api/users.py' }] })
    expect(rb).toMatchObject({ total: 2, only: [{ label: 'app/db.py' }] })
    // While one traversal loads, its reach is unknown and nothing is called unique yet.
    expect(compareReach([a, undefined])).toEqual([
      { total: 2, only: [], truncated: false },
      undefined,
    ])
  })
})
