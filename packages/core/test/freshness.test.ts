import type { EvidenceRecord, ObjectVersion } from '@kalyth/contracts'
import { describe, expect, it } from 'vitest'
import { assessFreshness } from '../src/index.ts'

const sha = (c: string) => c.repeat(40)
const evidence = (id: string, path: string, blob: string, repo = 'r'): EvidenceRecord => ({
  id,
  source: {
    kind: 'sourceSpan',
    repo,
    commit: sha('c'),
    path,
    blobSha: blob,
    span: { startLine: 1, endLine: 1 },
  },
  excerpt: null,
  collectedBy: { tool: 't', toolVersion: '1' },
  collectedAt: '2026-10-16T00:00:00.000Z',
})
const object = (
  id: string,
  supports: string[][],
  extra: Partial<ObjectVersion> = {},
): ObjectVersion => ({
  id,
  type: 'software.Module',
  typeVersion: 1,
  stance: 'asIs',
  lifecycle: 'active',
  attributes: {},
  claim: {
    basis: 'observed',
    supports: supports.map((allOf) => ({ allOf })),
    contradictedBy: [],
    derivedFrom: [],
  },
  revision: 1,
  retiredReason: null,
  ...extra,
})
const snapshot: ObjectVersion = {
  ...object('snap', []),
  type: 'core.SourceSnapshot',
  attributes: {
    repo: 'r',
    commit: sha('d'),
    coverage: 'c',
    files: { 'a.py': sha('1'), 'b.py': sha('2') },
  },
}

describe('claim freshness (R2 support semantics)', () => {
  const ev = new Map(
    [
      evidence('e_a_fresh', 'a.py', sha('1')),
      evidence('e_b_stale', 'b.py', sha('9')),
      evidence('e_gone', 'gone.py', sha('3')),
      evidence('e_other_repo', 'x.py', sha('4'), 'elsewhere'),
    ].map((e) => [e.id, e]),
  )
  const statusOf = (objects: ObjectVersion[]) =>
    Object.fromEntries(
      assessFreshness([snapshot, ...objects], [], ev).claims.map((c) => [c.id, c.status]),
    )

  it('distinguishes current, weakened and stale by support group', () => {
    const s = statusOf([
      object('current', [['e_a_fresh']]),
      object('weakened', [['e_b_stale'], ['e_a_fresh']]),
      object('stale_joint', [['e_a_fresh', 'e_b_stale']]),
      object('stale_deleted', [['e_gone']]),
    ])
    expect(s).toMatchObject({
      current: 'current',
      weakened: 'weakened',
      stale_joint: 'stale',
      stale_deleted: 'stale',
    })
  })

  it('reports unknown without a snapshot and not-applicable without evidence', () => {
    const s = statusOf([object('unknown', [['e_other_repo']]), object('stated', [])])
    expect(s).toMatchObject({ unknown: 'unknown', stated: 'not-applicable' })
  })

  it('propagates staleness transitively along derivedFrom, never repairing it', () => {
    const base = object('base', [['e_b_stale']])
    const mid = object('mid', [], {
      claim: { basis: 'inferred', supports: [], contradictedBy: [], derivedFrom: ['base'] },
    })
    const top = object('top', [['e_a_fresh']], {
      claim: {
        basis: 'inferred',
        supports: [{ allOf: ['e_a_fresh'] }],
        contradictedBy: [],
        derivedFrom: ['mid'],
      },
    })
    expect(statusOf([top, mid, base])).toMatchObject({
      base: 'stale',
      mid: 'derived-stale',
      top: 'derived-stale',
    })
  })
})
