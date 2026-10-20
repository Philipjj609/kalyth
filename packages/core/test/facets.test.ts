import type {
  ClaimFreshness,
  FreshnessStatus,
  ObjectVersion,
  RelationVersion,
} from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { decisionFacets } from '../src/kernel/facets.ts'

const claim = (coverage?: string) => ({
  basis: coverage ? ('observed' as const) : ('inferred' as const),
  supports: [],
  contradictedBy: [],
  derivedFrom: [],
  ...(coverage
    ? { observation: { tool: 'kalyth-git-verifier', toolVersion: '0.2.0', coverage } }
    : {}),
})
const obj = (
  id: string,
  type: string,
  attributes: Record<string, string>,
  coverage?: string,
): ObjectVersion => ({
  id,
  type,
  typeVersion: 1,
  stance: 'toBe',
  lifecycle: 'active',
  attributes,
  claim: claim(coverage),
  revision: 1,
  retiredReason: null,
})
const rel = (id: string, type: string, from: string, to: string): RelationVersion => ({
  id,
  type,
  typeVersion: 1,
  from,
  to,
  stance: 'toBe',
  lifecycle: 'active',
  properties: {},
  claim: claim(),
  revision: 1,
  retiredReason: null,
})
const fresh = (id: string, status: FreshnessStatus): [string, ClaimFreshness] => [
  id,
  {
    id,
    kind: 'relation',
    type: 'impacts',
    basis: 'inferred',
    status,
    staleEvidence: [],
    reason: status,
  },
]

const base = [
  obj('d', 'core.Decision', { title: 'Add a title filter', status: 'accepted' }),
  obj('a1', 'core.Alternative', { title: 'Filter in the API', status: 'accepted' }),
  obj('a2', 'core.Alternative', { title: 'Filter in the browser', status: 'rejected' }),
  obj('ep', 'software.Endpoint', { method: 'GET', path: '/items/' }),
  obj('ui', 'software.Module', { path: 'frontend/items.tsx' }),
]
const links = [
  rel('r1', 'alternativeOf', 'a1', 'd'),
  rel('r2', 'alternativeOf', 'a2', 'd'),
  rel('c1', 'impacts', 'a1', 'ep'),
  rel('c2', 'impacts', 'a2', 'ui'),
]
const labelOf = (id: string) => ({ ep: 'GET /items/', ui: 'frontend/items.tsx' })[id] ?? id
const facets = (
  objects: ObjectVersion[],
  relations: RelationVersion[],
  freshness: [string, ClaimFreshness][] = [],
  paths: Record<string, string[]> = {},
) =>
  decisionFacets(
    'd',
    new Map(objects.map((o) => [o.id, o])),
    relations,
    new Map(freshness),
    labelOf,
    (id) => paths[id] ?? [],
  )

describe('decision facets (ADR 0023)', () => {
  it('counts only the accepted alternative’s changes, and says when they need review', () => {
    expect(facets(base, links).freshness).toEqual({ status: 'unchecked', changes: 1, stale: [] })
    expect(facets(base, links, [fresh('c1', 'current')]).freshness.status).toBe('current')
    // The rejected alternative's change going stale does not matter to the accepted decision.
    expect(
      facets(base, links, [fresh('c1', 'current'), fresh('c2', 'stale')]).freshness.status,
    ).toBe('current')
    const stale = facets(base, links, [fresh('c1', 'current'), fresh('ep', 'stale')]).freshness
    expect(stale).toMatchObject({
      status: 'stale',
      stale: [{ relationId: 'c1', target: 'ep', label: 'GET /items/', status: 'stale' }],
    })
    expect(stale.stale[0]?.reason).toBe('GET /items/ no longer matches the source')
  })

  it('keeps implementation and verification apart, and allows either to be partial', () => {
    const t1 = obj('t1', 'core.Task', { title: 'API filter', status: 'completed' })
    const t2 = obj('t2', 'core.Task', { title: 'Docs', status: 'ready' })
    const report = obj('rep1', 'core.ExecutionReport', { outcome: 'succeeded' })
    const pass = obj('ver1', 'core.Verification', { outcome: 'pass' }, 'Commits 84c5a9e..96fbcbe.')
    const tasks = [
      rel('i1', 'implements', 't1', 'd'),
      rel('i2', 'implements', 't2', 'a1'),
      rel('p1', 'reports', 'rep1', 't1'),
      rel('v1', 'verifies', 'ver1', 'rep1'),
    ]
    const both = facets([...base, t1, t2, report, pass], [...links, ...tasks])
    expect(both.implementation).toEqual({
      state: 'partial',
      tasks: [
        { id: 't1', title: 'API filter', status: 'completed' },
        { id: 't2', title: 'Docs', status: 'ready' },
      ],
      touched: 0,
      changes: 1,
    })
    expect(both.verification).toEqual({ state: 'partial', coverage: 'Commits 84c5a9e..96fbcbe.' })

    const onlyOne = facets(
      [...base, t1, report, pass],
      [...links, ...tasks.slice(0, 1), ...tasks.slice(2)],
    )
    expect(onlyOne.implementation.state).toBe('complete')
    expect(onlyOne.verification.state).toBe('passed')

    const inReview = { ...t1, attributes: { ...t1.attributes, status: 'review' } }
    const fail = obj('ver2', 'core.Verification', { outcome: 'fail' })
    const failed = facets(
      [...base, inReview, report, fail],
      [
        ...links,
        rel('i1', 'implements', 't1', 'd'),
        rel('p1', 'reports', 'rep1', 't1'),
        rel('v2', 'verifies', 'ver2', 'rep1'),
      ],
    )
    expect(failed.implementation.state).toBe('reported')
    expect(failed.verification).toEqual({ state: 'failed', coverage: null })
    expect(facets(base, links).implementation).toEqual({
      state: 'none',
      tasks: [],
      touched: 0,
      changes: 1,
    })
  })

  it('counts the changes whose target the verified reports touched (ADR 0024)', () => {
    // The open decision counts both alternatives' changes: the endpoint and the UI module.
    const open = base.map((o) =>
      o.id === 'd' || o.id === 'a1' || o.id === 'a2'
        ? { ...o, attributes: { ...o.attributes, status: o.id === 'd' ? 'open' : 'proposed' } }
        : o,
    )
    const paths = {
      ep: ['backend/app/api/routes/items.py'],
      ui: ['frontend/items.tsx'],
    }
    const task = obj('t1', 'core.Task', { title: 'API filter', status: 'review' })
    const report = (id: string, files: string[]) => ({
      ...obj(id, 'core.ExecutionReport', { outcome: 'succeeded' }),
      attributes: { outcome: 'succeeded', filesChanged: files },
    })
    const verdict = (id: string, outcome: string) =>
      obj(id, 'core.Verification', { outcome }, 'Commits checked.')
    const linked = (reportId: string, verificationId: string) => [
      rel('i1', 'implements', 't1', 'd'),
      rel(`p-${reportId}`, 'reports', reportId, 't1'),
      rel(`v-${verificationId}`, 'verifies', verificationId, reportId),
    ]

    // A passing report that changed the endpoint's file (as typed before paths were normalised).
    const passed = facets(
      [
        ...open,
        task,
        report('rep1', ['backend\\app\\api\\routes\\items.py']),
        verdict('ver1', 'pass'),
      ],
      [...links, ...linked('rep1', 'ver1')],
      [],
      paths,
    ).implementation
    expect(passed).toMatchObject({ state: 'reported', touched: 1, changes: 2 })

    // The same files under a failed verification touch nothing.
    const failed = facets(
      [...open, task, report('rep1', ['backend/app/api/routes/items.py']), verdict('ver1', 'fail')],
      [...links, ...linked('rep1', 'ver1')],
      [],
      paths,
    ).implementation
    expect(failed).toMatchObject({ touched: 0, changes: 2 })

    // Once an alternative is accepted, only its changes count.
    const accepted = facets(
      [...base, task, report('rep1', ['frontend/items.tsx']), verdict('ver1', 'pass')],
      [...links, ...linked('rep1', 'ver1')],
      [],
      paths,
    ).implementation
    expect(accepted).toMatchObject({ touched: 0, changes: 1 })
  })
})
