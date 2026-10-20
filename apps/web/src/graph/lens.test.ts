import type { DecisionSummary, ImpactedElement, ObjectVersion } from '@kalyth/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { obj, rel, resetIds } from '../test/records.ts'
import {
  chooseAlternative,
  decisionMarks,
  focusSet,
  impactCaption,
  impactMarks,
  isDimmed,
  lensDescription,
  revisionMarks,
} from './lens.ts'
import { projectGraph } from './projection.ts'

beforeEach(resetIds)

/** A system with two containers; `api` holds two modules and an entity, `web` one module. */
function model() {
  const system = obj('software.System', { name: 'Shop' })
  const api = obj('software.Container', { name: 'api' })
  const web = obj('software.Container', { name: 'web' })
  const routes = obj('software.Module', { path: 'api/routes.py' })
  const models = obj('software.Module', { path: 'api/models.py' })
  const item = obj('software.DataEntity', { name: 'Item' })
  const client = obj('software.Module', { path: 'web/client.ts' })
  const org = obj('software.DataEntity', { name: 'Organisation' }, { stance: 'toBe' })
  const objects = [system, api, web, routes, models, item, client, org]
  const relations = [
    rel('contains', system, api),
    rel('contains', system, web),
    rel('contains', api, routes),
    rel('contains', api, models),
    rel('contains', models, item),
    rel('contains', web, client),
    rel('dependsOn', routes, models),
    rel('reads', routes, item),
    rel('dependsOn', client, routes),
    rel('references', item, org, 'inferred', { stance: 'toBe' }),
  ]
  const byId = new Map<string, ObjectVersion>(objects.map((o) => [o.id, o]))
  return { objects, relations, byId, system, api, web, routes, models, item, client, org }
}

function alternative(id: string, targets: string[], status = 'proposed') {
  return {
    id,
    title: `Alternative ${id}`,
    summary: '',
    status,
    directChanges: targets.map((target, i) => ({
      relationId: `rel_${String(i).padStart(32, '0')}`,
      target,
      label: target,
      change: `change ${i + 1}`,
    })),
  }
}

function decision(
  id: string,
  status: string,
  alternatives: ReturnType<typeof alternative>[],
  decides: string[] = [],
): DecisionSummary {
  return {
    id,
    title: `Decision ${id}`,
    question: '?',
    status,
    statusRationale: null,
    basis: 'stated',
    alternatives,
    decides: decides.map((d) => ({ id: d, label: d })),
    facets: {
      freshness: { status: 'unchecked', changes: 0, stale: [] },
      implementation: { state: 'none', tasks: [] },
      verification: { state: 'none', coverage: null },
    },
  }
}

const impacted = (id: string, depth: number, seed: string): ImpactedElement => ({
  id,
  type: 'software.Module',
  label: id,
  depth,
  seed,
  path: [],
})

describe('revisionMarks', () => {
  it('counts claims that need review at the node that stands for them', () => {
    const m = model()
    const status: Record<string, string> = {
      [m.item.id]: 'stale',
      [m.routes.id]: 'derived-stale',
      [m.client.id]: 'weakened',
      [m.models.id]: 'current',
      [m.system.id]: 'unknown',
    }
    const readRelation = m.relations.find((r) => r.type === 'reads')
    if (readRelation) status[readRelation.id] = 'stale'
    const collapsed = projectGraph(m.objects, m.relations, {
      collapsed: new Set([m.api.id, m.web.id]),
    })
    const marks = revisionMarks(collapsed, m.relations, (id) => status[id])
    // item, routes and the read inside api; client inside web.
    expect(marks.byNode.get(m.api.id)).toBe(3)
    expect(marks.byNode.get(m.web.id)).toBe(1)
    expect(marks.drawn).toBe(4)
    expect(marks.byNode.has(m.system.id)).toBe(false)

    const open = projectGraph(m.objects, m.relations)
    const fine = revisionMarks(open, m.relations, (id) => status[id])
    expect(fine.byNode.get(m.item.id)).toBe(1)
    // A relation's claim counts at its source.
    expect(fine.byNode.get(m.routes.id)).toBe(2)
    expect(fine.byNode.get(m.client.id)).toBe(1)
    expect(fine.drawn).toBe(4)
  })
})

describe('impactMarks', () => {
  it('numbers direct changes in the alternative order, and marks what impact reaches', () => {
    const m = model()
    const p = projectGraph(m.objects, m.relations)
    const alt = alternative('A', [m.item.id, m.org.id, m.routes.id, m.item.id])
    const marks = impactMarks(
      p,
      alt,
      [
        impacted(m.item.id, 0, m.item.id),
        impacted(m.routes.id, 1, m.item.id),
        impacted(m.client.id, 2, m.item.id),
        impacted(m.models.id, 1, m.item.id),
      ],
      m.byId,
    )
    expect(marks.numbers.get(m.item.id)).toEqual([1, 4])
    expect(marks.numbers.get(m.org.id)).toEqual([2])
    expect(marks.numbers.get(m.routes.id)).toEqual([3])
    // Routes is changed directly, so only client and models are "reached".
    expect([...marks.reached].sort()).toEqual([m.client.id, m.models.id].sort())
    expect(marks.summary).toEqual({ changes: 4, newElements: 1, reached: 2 })
  })

  it('puts the numbers of hidden members on their collapsed holder', () => {
    const m = model()
    const p = projectGraph(m.objects, m.relations, { collapsed: new Set([m.api.id]) })
    const marks = impactMarks(p, alternative('A', [m.item.id, m.routes.id]), undefined, m.byId)
    expect(marks.numbers.get(m.api.id)).toEqual([1, 2])
    expect(marks.reached.size).toBe(0)
  })

  it('summarises an alternative in a caption', () => {
    expect(impactCaption('A4', { changes: 8, newElements: 1, reached: 12 }, true)).toBe(
      'A4: 8 direct changes, 1 new element, reaches 12 more',
    )
    expect(impactCaption('A1', { changes: 1, newElements: 0, reached: 0 }, false)).toBe(
      'A1: 1 direct change',
    )
  })
})

describe('chooseAlternative', () => {
  const d1 = decision('obj_d1', 'rejected', [alternative('obj_a1', [])])
  const d2 = decision('obj_d2', 'open', [alternative('obj_a2', []), alternative('obj_a3', [])])
  const d3 = decision('obj_d3', 'accepted', [
    alternative('obj_a4', []),
    alternative('obj_a5', [], 'accepted'),
  ])

  it('shows the alternative asked for, with its key', () => {
    const chosen = chooseAlternative([d1, d2, d3], 'obj_a5')
    expect([chosen?.decision.id, chosen?.alternative.id, chosen?.index]).toEqual([
      'obj_d3',
      'obj_a5',
      1,
    ])
  })

  it('falls back to the first open or accepted decision, preferring its accepted alternative', () => {
    expect(chooseAlternative([d1, d2, d3], undefined)?.alternative.id).toBe('obj_a2')
    expect(chooseAlternative([d1, d3], 'obj_a1')?.alternative.id).toBe('obj_a5')
    expect(chooseAlternative([d1], undefined)).toBeNull()
  })
})

describe('decisionMarks', () => {
  it('tags what open and accepted decisions change', () => {
    const m = model()
    const p = projectGraph(m.objects, m.relations)
    const open = decision('obj_d1', 'open', [
      alternative('obj_a1', [m.item.id]),
      alternative('obj_a2', [m.routes.id]),
    ])
    const accepted = decision(
      'obj_d2',
      'accepted',
      [alternative('obj_a3', [m.client.id]), alternative('obj_a4', [m.item.id], 'accepted')],
      [m.web.id],
    )
    const rejected = decision('obj_d3', 'rejected', [alternative('obj_a5', [m.models.id])])
    const marks = decisionMarks(p, [open, rejected, accepted])
    expect(marks.tags.get(m.item.id)).toEqual(['D1', 'D2'])
    expect(marks.tags.get(m.routes.id)).toEqual(['D1'])
    expect(marks.tags.get(m.web.id)).toEqual(['D2'])
    expect(marks.tags.has(m.client.id)).toBe(false)
    expect(marks.tags.has(m.models.id)).toBe(false)
    expect(marks.legend.map((l) => [l.key, l.id, l.elements])).toEqual([
      ['D1', 'obj_d1', 2],
      ['D2', 'obj_d2', 2],
    ])
  })
})

describe('focusSet', () => {
  it('keeps nodes within the hops of the selection, following drawn edges', () => {
    const m = model()
    const p = projectGraph(m.objects, m.relations, { lift: false })
    expect(focusSet(p, m.client.id, 0)).toBeNull()
    expect(focusSet(p, undefined, 1)).toBeNull()
    const one = focusSet(p, m.client.id, 1)
    // The selection, its neighbour and the frames around them.
    expect([...(one ?? [])].sort()).toEqual(
      [m.client.id, m.routes.id, m.web.id, m.api.id, m.system.id].sort(),
    )
    const two = focusSet(p, m.client.id, 2)
    expect(two?.has(m.item.id)).toBe(true)
  })

  it('brings everything inside a selected open holder, and never dims open frames', () => {
    const m = model()
    const p = projectGraph(m.objects, m.relations, { exactFor: m.api.id })
    const focus = focusSet(p, m.api.id, 1)
    for (const id of [m.api.id, m.routes.id, m.models.id, m.item.id])
      expect(focus?.has(id)).toBe(true)
    expect(isDimmed(focus, { id: m.system.id, expanded: true })).toBe(false)
    expect(isDimmed(focus, { id: m.org.id })).toBe(true)
    expect(isDimmed(null, { id: m.org.id })).toBe(false)
  })
})

describe('lensDescription', () => {
  it('names the lens state of a node', () => {
    expect(
      lensDescription('impact', { changeNumbers: [2], alternativeKey: 'A4', stale: true }),
    ).toBe('change 2 of A4, stale')
    expect(lensDescription('impact', { changeNumbers: [1, 3, 5], alternativeKey: 'A2' })).toBe(
      'changes 1, 3 and 5 of A2',
    )
    expect(lensDescription('impact', { reached: true, alternativeKey: 'A1', proposed: true })).toBe(
      'proposed, reached by A1',
    )
    expect(lensDescription('freshness', { revisions: 3, stale: true })).toBe('3 stale claims')
    expect(lensDescription('basis', { basisLabel: 'Inferred' })).toBe('inferred')
    expect(lensDescription('decisions', { decisionTags: ['D1', 'D2'] })).toBe(
      'changed by D1 and D2',
    )
  })
})
