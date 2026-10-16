import type { ResolvedOperation } from '@kalyth/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { claim, obj, rel, resetIds } from '../test/records.ts'
import { humanize, relativeTime, shortId, typePlural } from './format.ts'
import { objectLabel, objectShortLabel } from './labels.ts'
import { describeOps, evidenceLocation, opCounts } from './ops.ts'
import { buildRows, DEFAULT_FILTERS, filterRows, sortRows } from './records.ts'
import { basisMeta, objectTypeMeta, relationMeta } from './semantics.ts'

beforeEach(resetIds)

const SHA = 'b1125d8839482cb7bbae603ddc6d0081bf87532e'

describe('labels and formatting', () => {
  it('labels objects from their attributes, including unknown types', () => {
    expect(objectLabel(obj('software.Endpoint', { method: 'GET', path: '/items' }))).toBe(
      'GET /items',
    )
    expect(objectLabel(obj('core.Decision', { title: 'Auth?' }))).toBe('Auth?')
    expect(objectLabel(obj('acme.Gizmo', { label: 'Widget' }))).toBe('Widget')
    const bare = obj('acme.Gizmo')
    expect(objectLabel(bare)).toBe(shortId(bare.id))
    expect(objectShortLabel(obj('software.Module', { path: 'a/b/c.py' }))).toEqual({
      label: 'c.py',
      context: 'a/b',
    })
  })

  it('formats ids, names and plurals', () => {
    expect(shortId('obj_0192aaaa0000700080000000003f9a2c')).toBe('obj…3f9a2c')
    expect(humanize('DataEntity')).toBe('Data entity')
    expect(humanize('dependsOn')).toBe('Depends on')
    expect(typePlural('software.Library', 3)).toBe('3 libraries')
    expect(typePlural('software.Module', 1)).toBe('1 module')
    expect(relativeTime('2026-10-16T10:00:00Z', Date.parse('2026-10-16T12:00:00Z'))).toBe(
      '2 hours ago',
    )
  })

  it('has a label, tone and line style for every basis, and a fallback for unknown ones', () => {
    expect(basisMeta('observed').dash).toBeUndefined()
    expect(basisMeta('inferred').dash).toBeDefined()
    expect(basisMeta('stated').dash).not.toBe(basisMeta('inferred').dash)
    expect(basisMeta('telepathic').label).toBe('Telepathic')
    expect(relationMeta('dependsOn').color).toBe('var(--k-rel-dependsOn)')
    expect(relationMeta('poweredBy').color).toBe('var(--k-rel-other)')
    expect(objectTypeMeta('acme.Gizmo').accent).toBe('var(--k-type-other)')
  })
})

describe('record rows', () => {
  function rows() {
    const a = obj('software.Module', { path: 'a.py' })
    const b = obj('software.Module', { path: 'b.py' }, { stance: 'toBe' })
    const lib = obj('software.Library', { name: 'zod' })
    const r = rel('dependsOn', a, lib, 'inferred', {
      claim: claim('inferred', { confidence: { level: 'high', rationale: 'x' } }),
    })
    const freshness = new Map([
      [
        a.id,
        {
          id: a.id,
          kind: 'object' as const,
          type: '',
          basis: '',
          status: 'stale' as const,
          staleEvidence: [],
          reason: '',
        },
      ],
    ])
    return { a, b, lib, r, rows: buildRows([a, b, lib], [r], freshness) }
  }

  it('builds rows for objects and relations', () => {
    const { rows: all, r } = rows()
    expect(all).toHaveLength(4)
    const relation = all.find((x) => x.id === r.id)
    expect(relation).toMatchObject({ kind: 'relation', label: 'a.py → zod', confidence: 'high' })
    expect(all.find((x) => x.label === 'a.py')?.freshness).toBe('stale')
  })

  it('filters by kind, facets and text', () => {
    const { rows: all } = rows()
    expect(filterRows(all, { ...DEFAULT_FILTERS, kind: 'relation' })).toHaveLength(1)
    expect(filterRows(all, { ...DEFAULT_FILTERS, stance: 'toBe' }).map((x) => x.label)).toEqual([
      'b.py',
    ])
    expect(filterRows(all, { ...DEFAULT_FILTERS, basis: 'inferred' })).toHaveLength(1)
    expect(filterRows(all, { ...DEFAULT_FILTERS, text: 'ZOD' })).toHaveLength(2)
    expect(filterRows(all, { ...DEFAULT_FILTERS, freshness: 'none' })).toHaveLength(3)
  })

  it('sorts by column in both directions', () => {
    const { rows: all } = rows()
    expect(sortRows(all, 'label', 'asc').map((x) => x.label)).toEqual([
      'a.py',
      'a.py → zod',
      'b.py',
      'zod',
    ])
    expect(sortRows(all, 'freshness', 'asc')[0]?.label).toBe('a.py')
    expect(sortRows(all, 'type', 'desc')[0]?.kind).toBe('relation')
  })
})

describe('proposal operations', () => {
  it('describes operations with names from the proposal and the model', () => {
    const existing = obj('software.Container', { name: 'backend' })
    const ops: ResolvedOperation[] = [
      {
        op: 'createObject',
        id: 'obj_new',
        type: 'software.Module',
        stance: 'asIs',
        attributes: { path: 'x.py' },
        claim: claim('observed'),
      },
      {
        op: 'createRelation',
        id: 'rel_new',
        type: 'contains',
        from: existing.id,
        to: 'obj_new',
        stance: 'asIs',
        properties: {},
        claim: claim('observed'),
      },
      { op: 'updateObject', id: existing.id, set: { technology: 'Go', description: null } },
      {
        op: 'recordEvidence',
        id: 'evd_1',
        source: {
          kind: 'sourceSpan',
          repo: 'acme/app',
          commit: SHA,
          path: 'x.py',
          blobSha: SHA,
          span: { startLine: 3, endLine: 9 },
        },
        excerpt: null,
        collectedBy: { tool: 't', toolVersion: '1' },
        collectedAt: '2026-10-16T00:00:00.000Z',
      },
    ]
    const names = new Map([[existing.id, 'backend']])
    const lines = describeOps(ops, (id) => names.get(id))
    expect(lines.map((l) => [l.verb, l.subject])).toEqual([
      ['Create', 'Module “x.py”'],
      ['Relate', 'backend —contains→ x.py'],
      ['Update', 'backend'],
      ['Record evidence', 'x.py:3-9'],
    ])
    expect(lines[2]?.detail).toBe('technology → "Go", description → removed')
    expect(lines[3]?.detail).toBe('acme/app @ b1125d88')
    expect(opCounts(ops)).toEqual([
      ['createObject', 1],
      ['updateObject', 1],
      ['createRelation', 1],
      ['recordEvidence', 1],
    ])
  })

  it('formats every evidence source kind', () => {
    expect(
      evidenceLocation({ kind: 'document', uri: 'docs/adr/1.md', locator: '§2' }).primary,
    ).toBe('docs/adr/1.md (§2)')
    expect(
      evidenceLocation({
        kind: 'external',
        uri: 'https://example.com',
        retrievedAt: '2026-10-01T00:00:00.000Z',
      }).secondary,
    ).toBe('retrieved 2026-10-01')
  })
})
